"""The chat's RBAC for the Medical Underwriter, Financial Underwriter and Claims Manager, and the identity it runs on:
the role comes from the signed-in user (tenant-service /auth/me), never from the request body, and a conversation
is only continued or resumed by the user who started it."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from permission import is_role_allowed
from routers import chat


@pytest.mark.parametrize("role, allowed, refused", [
    ("Medical Underwriter",
     {"list_my_underwriting_reviews", "start_my_review", "send_e_application_questionnaire", "run_ai_medical_underwriting",
      "record_underwriting_review", "get_medical_report_status", "navigate_to_page"},
     {"run_ai_financial_underwriting", "run_insurance_history_check", "get_commission_ledger", "get_agent_statement",
      "list_claims", "get_claims_dashboard", "list_users", "list_rule_sets", "approve_case", "compile_final_underwriting",
      "assign_underwriting_track", "get_specialist_reviews", "authorize_claim_disbursement"}),
    ("Financial Underwriter",
     {"list_my_underwriting_reviews", "start_my_review", "send_e_application_questionnaire", "run_ai_financial_underwriting",
      "run_insurance_history_check", "record_underwriting_review"},
     {"run_ai_medical_underwriting", "get_medical_report_status", "get_commission_summary", "list_claims", "list_users",
      "approve_case", "compile_final_underwriting", "issue_claim_payout"}),
    ("ClaimsManager",
     {"get_claims_dashboard", "list_claims", "register_claim", "decide_claim", "authorize_claim_disbursement",
      "disburse_claim_settlement", "issue_claim_payout", "refer_claim_to_reinsurance", "override_claim_eligibility"},
     {"assign_case", "resume_member_workflow", "approve_case", "run_ai_medical_underwriting", "run_ai_financial_underwriting",
      "record_underwriting_review", "compile_final_underwriting", "create_proposal", "add_user", "get_commission_ledger"}),
])
def test_role_allow_lists(role, allowed, refused):
    assert {t for t in allowed if not is_role_allowed(t, role)} == set()
    assert {t for t in refused if is_role_allowed(t, role)} == set()


def test_money_release_stays_with_the_claims_manager():
    for tool in ("authorize_claim_disbursement", "disburse_claim_settlement", "issue_claim_payout"):
        assert is_role_allowed(tool, "ClaimsManager") and not is_role_allowed(tool, "ClaimsAdjuster")


def test_no_role_is_not_admin():
    assert not is_role_allowed("approve_case", "") and not is_role_allowed("add_user", "")


def _graph(values):
    return SimpleNamespace(aget_state=AsyncMock(return_value=SimpleNamespace(values=values, tasks=(), next=())))


def test_stream_uses_the_verified_role_not_the_one_the_browser_sends():
    from schemas import ChatStreamRequest
    seen = {}

    async def consume(graph, config, input_):
        seen.update(input_)
        yield "data: {}\n\n"

    me = {"id": "u-med", "tenant_id": "t1", "role_name": "Medical Underwriter", "is_active": True, "status": "ACTIVE"}
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(graph=_graph({}))))
    body = ChatStreamRequest(thread_id="th-1", message="show commissions", role="Admin")
    with patch.object(chat, "voice_user", AsyncMock(return_value=me)), patch.object(chat, "_consume", consume):
        response = asyncio.run(chat.chat_stream(body, request, x_tenant_id="t1", authorization="Bearer tok"))
        asyncio.run(_drain(response))
    assert seen["user_role"] == "Medical Underwriter" and seen["user_id"] == "u-med"


async def _drain(response):
    async for _ in response.body_iterator:
        pass


def test_unauthenticated_chat_is_refused():
    with pytest.raises(HTTPException) as error:
        asyncio.run(chat._caller("", "t1"))
    assert error.value.status_code == 401


def test_another_users_thread_is_never_continued_or_resumed():
    me = {"id": "u-claims", "tenant_id": "t1", "role_name": "ClaimsManager"}
    owned = SimpleNamespace(values={"user_id": "u-admin", "tenant_id": "t1", "user_role": "Admin"})
    assert chat._owner_mismatch(owned, me)
    assert not chat._owner_mismatch(SimpleNamespace(values={"user_id": "u-claims"}), me)
    assert not chat._owner_mismatch(SimpleNamespace(values={}), me)                       # a new conversation
    # Threads saved before ownership was recorded: same tenant and role only.
    assert chat._owner_mismatch(SimpleNamespace(values={"tenant_id": "t1", "user_role": "Admin"}), me)
    assert chat._owner_mismatch(SimpleNamespace(values={"tenant_id": "t2", "user_role": "ClaimsManager"}), me)
    assert not chat._owner_mismatch(SimpleNamespace(values={"tenant_id": "t1", "user_role": "ClaimsManager"}), me)

    from schemas import ChatResumeRequest
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(graph=_graph(owned.values))))
    with patch.object(chat, "voice_user", AsyncMock(return_value=me)):
        response = asyncio.run(chat.chat_resume(ChatResumeRequest(thread_id="th-admin", resume_value="yes"), request,
                                                x_tenant_id="t1", authorization="Bearer tok"))
    assert response.status_code == 403


def test_voice_tool_calls_use_the_verified_role():
    from schemas import ExecuteToolRequest
    me = {"id": "u-fin", "tenant_id": "t1", "role_name": "Financial Underwriter"}
    with patch.object(chat, "voice_user", AsyncMock(return_value=me)), patch.object(chat, "execute_tool", AsyncMock()) as run:
        out = asyncio.run(chat.chat_execute_tool(ExecuteToolRequest(name="get_commission_ledger", args={}, role="Admin"),
                                                 x_tenant_id="t1", authorization="Bearer tok"))
    assert out["success"] is False and not run.await_count


def test_claims_manager_is_always_with_the_claims_specialist():
    from langchain_core.messages import HumanMessage
    from specialist_router import coordinator_node, route_coordinator
    for text in ("can you do customer acquisition?", "add a new customer", "hello", "show commissions"):
        state = {"user_role": "ClaimsManager", "messages": [HumanMessage(text)]}
        out = coordinator_node(state)
        assert out["active_specialist"] == "claims", text
        assert route_coordinator({**state, **out}) == "claims_agent"
    # other roles keep keyword routing
    assert coordinator_node({"user_role": "Admin", "messages": [HumanMessage("add a new customer")]}).get("active_specialist") != "claims"


def test_claims_managers_assistant_declines_everything_but_claims():
    from claims_specialist import CLAIMS_TOOLS, claims_prompt
    manager = claims_prompt(CLAIMS_TOOLS, "en", "ClaimsManager")
    assert "help ONLY with claims" in manager and "customer acquisition" in manager and "do not say you can do it" in manager
    assert "help ONLY with claims" not in claims_prompt(CLAIMS_TOOLS, "en", "Admin")


@pytest.mark.parametrize("role, ok, refused", [
    ("Medical Underwriter", ["underwriting", "case/abc", "profile"], ["claims/dashboard", "admin/leads", "cases", "commissions", "dashboard"]),
    ("Financial Underwriter", ["underwriting", "case/abc?tab=documents"], ["claims", "proposal", "admin/users"]),
    ("ClaimsManager", ["claims", "claims/dashboard", "claims/register", "claims/CLM-2026-001"], ["underwriting", "admin/leads", "cases", "dashboard"]),
])
def test_navigation_stays_inside_the_roles_workspace(role, ok, refused):
    from pages import page_allowed
    assert [r for r in ok if not page_allowed(role, r)] == []
    assert [r for r in refused if page_allowed(role, r)] == []
    assert page_allowed("Admin", "claims/dashboard") and page_allowed("Agent", "admin/leads")


def test_navigation_tools_refuse_pages_and_records_outside_the_workspace():
    from tool_executor import _HANDLERS, ExecCtx
    from pages import page_for_record_for
    ctx = SimpleNamespace(exec_ctx=ExecCtx(tenant_id="t", jwt_token="", role="Medical Underwriter"), tenant_id="t")
    out = asyncio.run(_HANDLERS["navigate_to_page"]({"page_name": "claims/dashboard"}, ctx))
    assert out["success"] is False and "isn't part of your workspace" in out["error"] and "Underwriting" in out["error"]
    assert asyncio.run(_HANDLERS["navigate_to_page"]({"page_name": "underwriting"}, ctx))["success"]
    out = asyncio.run(_HANDLERS["show_record"]({"record_type": "claim", "identifier": "CLM-2026-001"}, ctx))
    assert out["success"] is False and out["error_code"] == "forbidden"
    out = asyncio.run(_HANDLERS["search_records"]({"query": "Zainab", "record_type": "customer"}, ctx))
    assert out["success"] is False and out["error_code"] == "forbidden"
    assert page_for_record_for("case", "Medical Underwriter").route == "underwriting"   # not Applications
    assert page_for_record_for("customer", "ClaimsManager") is None
