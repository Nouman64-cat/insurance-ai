"""Specialist underwriting subagents: routing, permissions, the confirm gates, and the journey's stage 4."""
import asyncio
import base64
import json
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.messages import HumanMessage

import journey
import specialist_review_tools as srt
from permission import is_role_allowed
from specialist_router import coordinator_node, route_coordinator
from tool_executor import Ctx, ExecCtx, _HANDLERS


def state(text, role="Admin", previous=None):
    return {"messages": [HumanMessage(content=text)], "user_role": role, "active_specialist": previous}


@pytest.mark.parametrize("text,role,previous,expected", [
    ("Show my reviews", "Medical Underwriter", None, "medical_underwriting"),
    ("Show claims dashboard", "Medical Underwriter", None, "medical_underwriting"),  # their role is one track
    ("Run AI financial underwriting for Zain", "Financial Underwriter", None, "financial_underwriting"),
    ("Compile final underwriting for APP-2026-19A187", "Admin", None, "final_underwriting"),
    ("Assign the medical review of Zain Ahmad", "Admin", None, "final_underwriting"),
    ("Show the specialist reviews for Zain", "Underwriter", None, "final_underwriting"),
    ("yes", "Admin", "final_underwriting", "final_underwriting"),
    ("Underwrite Ahmed", "Admin", None, "underwriting"),
    ("Compile final underwriting", "Viewer", None, "underwriting"),  # not the compile agent; read-only tools
])
def test_routing(text, role, previous, expected):
    update = coordinator_node(state(text, role, previous))
    assert update["active_specialist"] == expected
    assert route_coordinator(update) == {
        "medical_underwriting": "medical_underwriting_agent", "financial_underwriting": "financial_underwriting_agent",
        "final_underwriting": "final_underwriting_agent", "underwriting": "underwriting_agent",
    }.get(expected, "general_agent")


def test_flag_turns_the_subagents_off(monkeypatch):
    monkeypatch.setenv("TRACK_SPECIALISTS_ENABLED", "false")
    assert coordinator_node(state("Compile final underwriting for APP-1"))["active_specialist"] != "final_underwriting"
    assert coordinator_node(state("Show my reviews", "Medical Underwriter"))["active_specialist"] != "medical_underwriting"


@pytest.mark.parametrize("tool,role,allowed", [
    ("run_ai_medical_underwriting", "Medical Underwriter", True),
    ("run_ai_financial_underwriting", "Medical Underwriter", False),
    ("run_ai_financial_underwriting", "Financial Underwriter", True),
    ("run_insurance_history_check", "Financial Underwriter", True),
    ("record_underwriting_review", "Financial Underwriter", True),
    ("approve_case", "Medical Underwriter", False),
    ("compile_final_underwriting", "Underwriter", True),
    ("compile_final_underwriting", "Medical Underwriter", False),
    ("get_specialist_reviews", "CustomerService", False),  # medical rationale stays with underwriting roles
    ("get_specialist_reviews", "Viewer", False),
    ("list_my_underwriting_reviews", "Viewer", False),
    ("assign_underwriting_track", "Admin", True),
])
def test_permissions(tool, role, allowed):
    assert is_role_allowed(tool, role) is allowed


# ── Handlers, against a fake tenant service ──────────────────────────────────

class Response:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class FakeService:
    """Routes '<METHOD> <path suffix>' to (status, body); records every call."""
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    async def _do(self, method, url, **kw):
        self.calls.append((method, url, kw.get("json")))
        for key, value in self.routes.items():
            m, suffix = key.split(" ", 1)
            if m == method and url.endswith(suffix):
                return Response(*value) if isinstance(value, tuple) else Response(200, value)
        return Response(404, {"detail": f"no route {method} {url}"})

    async def get(self, url, **kw): return await self._do("GET", url, **kw)
    async def post(self, url, **kw): return await self._do("POST", url, **kw)
    async def put(self, url, **kw): return await self._do("PUT", url, **kw)


def token(sub="user-1"):
    payload = base64.urlsafe_b64encode(json.dumps({"sub": sub}).encode()).decode().rstrip("=")
    return f"x.{payload}.y"


def ctx(service, role):
    return Ctx(client=service, tenant_id="t1", exec_ctx=ExecCtx(tenant_id="t1", jwt_token=token(), role=role))


QUEUE = [{"id": "case-1", "reference": "CASE-2026-ABC", "customer_name": "Zain Ahmad", "customer_cnic": "21715-4604779-6",
          "product_name": "Salary Protection Plan", "closed": False, "on_hold": False,
          "review": {"status": "IN_REVIEW", "assigned_user_id": "user-1"}}]


def run(name, args, service, role):
    return asyncio.run(_HANDLERS[name](args, ctx(service, role)))


def test_specialist_finds_the_application_by_app_reference_or_cnic():
    service = FakeService({"GET /underwriting/reviews": QUEUE})
    assert asyncio.run(srt._resolve_review({"case_number": "APP-2026-ABC"}, ctx(service, "Medical Underwriter")))["id"] == "case-1"
    assert asyncio.run(srt._resolve_review({"cnic": "2171546047796"}, ctx(service, "Medical Underwriter")))["id"] == "case-1"


def test_review_decision_needs_a_rationale_then_a_confirm():
    service = FakeService({"GET /underwriting/reviews": QUEUE, "PUT /underwriting-tracks/medical": {"status": "CLEARED"}})
    args = {"applicant_name": "Zain Ahmad", "decision": "CLEARED"}
    assert run("record_underwriting_review", args, service, "Medical Underwriter")["status"] == "NeedsRationale"
    preview = run("record_underwriting_review", {**args, "rationale": "Normal panel"}, service, "Medical Underwriter")
    assert preview["status"] == "Preview" and "confirm=true" in preview["quick_actions"][0]["payload"]
    assert not [c for c in service.calls if c[0] == "PUT"]  # nothing recorded without the confirm
    done = run("record_underwriting_review", {**args, "rationale": "Normal panel", "confirm": True}, service, "Medical Underwriter")
    assert done["success"]
    put = [c for c in service.calls if c[0] == "PUT"][0]
    assert put[2] == {"status": "CLEARED", "note": "Normal panel", "assigned_user_id": "user-1"}


def test_specialist_cannot_send_the_other_tracks_questionnaire():
    service = FakeService({"GET /underwriting/reviews": QUEUE})
    res = run("send_e_application_questionnaire", {"applicant_name": "Zain", "part": "financial"}, service, "Medical Underwriter")
    assert not res["success"] and not [c for c in service.calls if c[0] == "POST"]


def test_ai_medical_waits_for_reports_previews_then_records_on_confirm():
    exam = {"status": "Required", "required_tests": [{"code": "CBC", "name": "Complete Blood Count"}, {"code": "ECG", "name": "ECG"}],
            "reports": [{"test_code": "CBC", "status": "Accepted"}]}
    service = FakeService({"GET /underwriting/reviews": QUEUE, "GET /medical-exam": exam})
    waiting = run("run_ai_medical_underwriting", {"applicant_name": "Zain"}, service, "Medical Underwriter")
    assert waiting["status"] == "WaitingForReports" and "ECG" in waiting["message"]

    exam["reports"].append({"test_code": "ECG", "status": "Accepted"})
    service.routes["POST /medical-exam/ai-review"] = {"tests": {"CBC": {"value": "14.8", "readable": True, "abnormal": False},
                                                                "ECG": {"value": "normal", "readable": True, "abnormal": False}}}
    service.routes["POST /medical-exam/result"] = {"outcome": "Normal", "suggested_loading_pct": 0, "abnormal_findings": []}
    preview = run("run_ai_medical_underwriting", {"applicant_name": "Zain"}, service, "Medical Underwriter")
    assert preview["status"] == "Preview" and not [c for c in service.calls if c[1].endswith("/medical-exam/result")]
    done = run("run_ai_medical_underwriting", {"applicant_name": "Zain", "confirm": True}, service, "Medical Underwriter")
    assert done["status"] == "Recorded"
    assert [c for c in service.calls if c[1].endswith("/medical-exam/result")][0][2] == {"results": {"CBC": "14.8", "ECG": "normal"}}


def test_ai_financial_reports_the_backend_blockers():
    service = FakeService({"GET /underwriting/reviews": QUEUE,
                           "POST /financial-underwriting/run": (409, {"detail": "Not ready for AI financial underwriting: Run and clear the insurance history check."})})
    res = run("run_ai_financial_underwriting", {"applicant_name": "Zain"}, service, "Financial Underwriter")
    assert res["status"] == "NotReady" and "insurance history" in res["message"]


CASES = [{"caseld": "case-1", "caseNumber": "CASE-2026-ABC", "customer_name": "Zain Ahmad", "customer_cnic": "21715-4604779-6"}]


def tracks(medical="CLEARED", financial="CLEARED"):
    def one(status):
        return {"status": status, "submitted": status in srt.FINAL, "reviewer": "Dr Mehreen", "note": "ok", "ai": None}
    return {"medical": one(medical), "financial": one(financial)}


def compile_service(medical="CLEARED", financial="CLEARED", acr="Submitted", pep="Passed"):
    return FakeService({"GET /cases": CASES, "GET /underwriting-tracks": tracks(medical, financial),
                        "GET /detail": {"pre_underwriting_status": {"acr": acr, "compliance": pep}}})


def test_compile_waits_for_all_four_inputs():
    res = run("compile_final_underwriting", {"case_number": "CASE-2026-ABC"}, compile_service(financial="IN_REVIEW", acr="Requested"), "Admin")
    assert res["status"] == "NotReady"
    assert "Financial review" in res["message"] and "Agent's Confidential Report" in res["message"]


def test_compile_previews_then_runs_the_risk_assessment_past_the_old_gates():
    service = compile_service(financial="REFERRED")
    preview = run("compile_final_underwriting", {"case_number": "CASE-2026-ABC"}, service, "Admin")
    assert preview["status"] == "Preview" and "human review" in preview["message"]
    risk = AsyncMock(return_value={"success": True, "message": "ran"})
    with patch.dict(_HANDLERS, {"run_risk_assessment": risk}):
        assert run("compile_final_underwriting", {"case_number": "CASE-2026-ABC", "confirm": True}, service, "Admin")["message"] == "ran"
    assert risk.call_args.args[0]["bypass_gates"] is True


# ── The journey's stage 4 ────────────────────────────────────────────────────

def journey_state():
    return {"journey_case_number": "CASE-2026-ABC", "journey_case_id": "case-1", "journey_audit": [], "user_role": "Admin",
            "tenant_id": "t1", "jwt_token": token()}


def fake_tools(responses):
    calls = []

    async def execute(name, args, ctx):
        calls.append((name, args))
        value = responses[name]
        return value(args) if callable(value) else value
    return execute, calls


def test_stage4_asks_who_takes_a_review_when_there_is_a_choice(monkeypatch):
    unassigned = tracks("PENDING", "PENDING")
    unassigned["medical"]["reviewer"] = None
    execute, calls = fake_tools({
        "get_specialist_reviews": {"success": True, "tracks": unassigned, "case_id": "case-1"},
        "list_track_underwriters": {"underwriters": [{"id": "u1", "full_name": "Dr A", "role": "Medical Underwriter"},
                                                     {"id": "u2", "full_name": "Dr B", "role": "Medical Underwriter"}]},
    })
    monkeypatch.setattr(journey, "execute_tool", execute)
    monkeypatch.setattr(journey, "is_demo", lambda: False)
    out = asyncio.run(journey.j_pre_underwriting(journey_state()))
    assert out["journey_outcome"] == "Awaiting Assignment"
    assert [c["id"] for c in out["journey_waiting_on"]["choices"]] == ["u1", "u2"]
    assert journey.route_after_specialists(out) == "j_finish"
    assert "assign_underwriting_track" not in [n for n, _ in calls]


def test_stage4_sends_both_questionnaires_and_waits_for_the_reviews(monkeypatch):
    execute, calls = fake_tools({
        "get_specialist_reviews": {"success": True, "tracks": tracks("IN_REVIEW", "IN_REVIEW"), "case_id": "case-1"},
        "send_e_application_questionnaire": {"success": True},
    })
    monkeypatch.setattr(journey, "execute_tool", execute)
    monkeypatch.setattr(journey, "is_demo", lambda: False)
    monkeypatch.setattr(journey, "_tsvc_get", AsyncMock(return_value={"status": "NotSent", "parts": {}}))
    out = asyncio.run(journey.j_pre_underwriting(journey_state()))
    assert out["journey_outcome"] == "Awaiting Specialist Reviews"
    assert sorted(a["part"] for n, a in calls if n == "send_e_application_questionnaire") == ["financial", "medical"]
    assert journey.route_resume({**journey_state(), **out}) == "j_pre_underwriting"


def test_stage4_continues_once_reviews_acr_and_pep_are_in(monkeypatch):
    execute, _ = fake_tools({"get_specialist_reviews": {"success": True, "tracks": tracks(), "case_id": "case-1"}})
    monkeypatch.setattr(journey, "execute_tool", execute)
    monkeypatch.setattr(journey, "is_demo", lambda: False)
    detail = {"status": "Submitted", "parts": {}, "pre_underwriting_status": {"acr": "Submitted", "compliance": "Passed"}}
    monkeypatch.setattr(journey, "_tsvc_get", AsyncMock(return_value=detail))
    out = asyncio.run(journey.j_pre_underwriting(journey_state()))
    assert out["journey_outcome"] is None and out["journey_pre_underwriting"]["medical_review"] == "CLEARED"
    assert journey.route_after_specialists(out) == "j_audit"


def test_final_lifecycle_does_not_reopen_specialists_owned_gates():
    from lifecycle import application_state, approval_blockers
    case = {"caseNumber":"APP-2026-C11F3A", "caseStatus":"Under Review", "medical_review":{"status":"CLEARED"}, "financial_review":{"status":"REFERRED"}, "acr_status":"Waived", "compliance_status":"Passed", "e_application_status":"Submitted"}
    state = application_state(case)
    assert state["stage"] == "Underwriting"
    assert "Compile final underwriting" in state["next_action"]["payload"]
    assert approval_blockers(case) == ["the AI risk assessment has not run"]
    assert approval_blockers({**case,"latest_ai_decision":"Human Review"}) == []
    incomplete = application_state({**case,"financial_review":{"status":"IN_REVIEW"}})
    assert incomplete["next_action"]["label"] == "Check specialist reviews"
    assert not any("E-App" in a["label"] for a in incomplete["allowed_actions"])


@pytest.mark.parametrize("saved_case,success", [("case-1",True),(None,False),("another-case",False)])
def test_journey_evaluation_is_bound_to_the_case(monkeypatch,saved_case,success):
    import httpx
    observed = []
    def reply(request):
        observed.append(json.loads(request.content))
        return httpx.Response(200,text='data: '+json.dumps({"type":"saved","data":{"case_id":saved_case,"ai_decision":"Human Review"}})+'\n\n')
    client = httpx.AsyncClient(transport=httpx.MockTransport(reply))
    monkeypatch.setattr(journey.httpx,"AsyncClient",lambda **kw:client)
    result = asyncio.run(journey._run_evaluation_directly({"id":"cust"},{"id":"pol"},ExecCtx(tenant_id="t1",jwt_token=token(),role="Admin"),"case-1"))
    assert observed[0]["case_id"] == "case-1"
    assert result["success"] is success


def test_unassigned_underwriters_block_pre_underwriting_before_any_link():
    from lifecycle import application_state
    pending = {"status": "PENDING", "assigned_user_id": None}
    case = {"caseNumber": "APP-2026-77760C", "caseStatus": "Pending Documents",
            "medical_review": pending, "financial_review": pending, "e_application_status": "Submitted"}
    state = application_state(case)
    assert state["blockers"][0].startswith("No Medical or Financial Underwriter assigned")
    assert [a["label"] for a in state["allowed_actions"]] == ["Assign Medical Underwriter", "Assign Financial Underwriter"]
    assert not any("E-App" in a["label"] for a in state["allowed_actions"])
    medical_done = application_state({**case, "medical_review": {"status": "PENDING", "assigned_user_id": "u1"}})
    assert [a["label"] for a in medical_done["allowed_actions"]] == ["Assign Financial Underwriter"]


def test_gate_refused_for_unassigned_underwriters_offers_the_assignment():
    import asyncio, httpx
    from unittest.mock import patch
    from tool_executor import execute_tool, _HANDLERS
    detail = {"code": "UNDERWRITERS_NOT_ASSIGNED", "missing_tracks": ["MEDICAL", "FINANCIAL"],
              "message": "Assign a Medical Underwriter and a Financial Underwriter to this case first."}
    async def refused(args, ctx):
        req = httpx.Request("POST", "http://t/e-application/invite")
        raise httpx.HTTPStatusError("409", request=req, response=httpx.Response(409, json={"detail": detail}, request=req))
    with patch.dict(_HANDLERS, {"verify_e_application": refused}):
        from tool_executor import ExecCtx
        out = asyncio.run(execute_tool("verify_e_application", {"case_number": "APP-2026-77760C"}, ExecCtx(tenant_id="t", jwt_token="")))
    assert out["error"] == detail["message"] and out["error_code"] == "conflict"
    assert [q["payload"] for q in out["quick_actions"]] == ["Assign the medical review of case APP-2026-77760C",
                                                            "Assign the financial review of case APP-2026-77760C"]
