"""P0 evidence, recovery and availability tools
(docs/agent-scenarios/chatbot-maturity-roadmap.md).

Covers the behaviours the roadmap makes non-negotiable: one application or a
choice — never someone else's; an AI medical reading never records anything;
incomplete reviews are refused; email outcomes are reported as they happened;
a resume retries only the failed step; and a mistyped API address is told apart
from an unreachable device.

Run with:  python -m pytest services/chat-agent/test_p0_tools.py -q
"""

from __future__ import annotations

import asyncio
import json
from urllib.parse import urlparse

import httpx
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

import operations
import support_tools
from tool_executor import ChoiceNeeded, Ctx, ExecCtx, _HANDLERS

TENANT = "t1"

CASES = [
    {"caseld": "k-1", "caseNumber": "APP-2026-6DF236", "applicant_name": "Ahmed Khan", "customer_id": "c-1",
     "policy_id": "p-1", "customer_cnic": "35202-1111111-1"},
    {"caseld": "k-2", "caseNumber": "APP-2026-AAAAAA", "applicant_name": "Ahmed Khan", "customer_id": "c-2",
     "policy_id": "p-2", "customer_cnic": "35202-2222222-2"},
    {"caseld": "k-3", "caseNumber": "CASE-2026-B00001", "applicant_name": "Sara Malik", "customer_id": "c-3",
     "policy_id": "p-3", "customer_cnic": "35202-3333333-3"},
]

ORDER = {
    "status": "Invited",
    "required_tests": [{"code": "FBS", "name": "Fasting Blood Sugar"}, {"code": "HIV", "name": "HIV Screening"}],
    "reports": [
        {"id": "r-1", "test_code": "FBS", "file_name": "fbs.pdf", "status": "Accepted"},
        {"id": "r-2", "test_code": "HIV", "file_name": "hiv.jpg", "status": "Re-submission Requested"},
    ],
}


class FakeClient:
    def __init__(self, routes=None):
        self.routes = routes or {}
        self.calls: list[tuple[str, str, object]] = []

    def _reply(self, method, url, body=None):
        path = urlparse(url).path.removeprefix(f"/tenants/{TENANT}")
        self.calls.append((method, path, body))
        value = self.routes.get((method, path), [] if method == "GET" else {})
        status, payload = value if isinstance(value, tuple) else (200, value)
        return httpx.Response(status, json=payload, request=httpx.Request(method, url))

    async def get(self, url, **kw):
        return self._reply("GET", url)

    async def post(self, url, json=None, **kw):
        return self._reply("POST", url, json)

    async def patch(self, url, json=None, **kw):
        return self._reply("PATCH", url, json)


def _ctx(client, role="Underwriter"):
    return Ctx(client=client, tenant_id=TENANT, exec_ctx=ExecCtx(tenant_id=TENANT, jwt_token="", role=role))


def _run(coro):
    return asyncio.run(coro)


def _base_routes(extra=None):
    routes = {("GET", "/cases"): CASES, ("GET", "/cases/k-1/medical-exam"): ORDER}
    routes.update(extra or {})
    return routes


# ── Resolving the application ────────────────────────────────────────────────

def test_two_applicants_with_one_name_is_a_choice_not_a_guess():
    client = FakeClient(_base_routes())
    try:
        _run(_HANDLERS["get_medical_report_status"]({"applicant_name": "Ahmed Khan"}, _ctx(client)))
    except ChoiceNeeded as exc:
        labels = [a["label"] for a in exc.quick_actions]
        assert any("APP-2026-6DF236" in l for l in labels) and any("APP-2026-AAAAAA" in l for l in labels)
    else:
        raise AssertionError("picked one of two matching applications")


def test_unknown_reference_never_falls_back_to_another_record():
    client = FakeClient(_base_routes())
    try:
        _run(_HANDLERS["get_medical_report_status"]({"case_number": "APP-2026-ZZZZZZ"}, _ctx(client)))
    except LookupError as exc:
        assert "not found" in str(exc) and "no other application" in str(exc)
    else:
        raise AssertionError("an unknown reference resolved to a record")


def test_legacy_case_reference_resolves_to_the_same_application():
    client = FakeClient({("GET", "/cases"): CASES, ("GET", "/cases/k-3/medical-exam"): {"status": "NotRequired"}})
    res = _run(_HANDLERS["get_medical_report_status"]({"case_number": "APP-2026-B00001"}, _ctx(client)))
    assert res["entity"]["id"] == "k-3" and res["state"]["gate_satisfied"]


# ── Medical reports ──────────────────────────────────────────────────────────

def test_report_status_separates_processed_and_rejected_reports():
    client = FakeClient(_base_routes())
    res = _run(_HANDLERS["get_medical_report_status"]({"case_number": "APP-2026-6DF236"}, _ctx(client)))
    states = {r["code"]: r["state"] for r in res["requirements"]}
    assert states == {"FBS": "accepted", "HIV": "rejected"}
    assert res["state"]["ready_for_review"] is False
    assert res["entity"] == {**res["entity"], "id": "k-1", "reference": "APP-2026-6DF236"}
    review = next(a for a in res["quick_actions"] if a["actionType"] == "uw_requirements")
    assert json.loads(review["payload"])["caseId"] == "k-1"


def test_agents_never_see_medical_findings():
    done = {**ORDER, "status": "Completed", "outcome": "Adverse", "suggested_loading_pct": 50,
            "abnormal_findings": [{"label": "FBS", "value": "180", "finding": "Diabetic range"}]}
    client = FakeClient(_base_routes({("GET", "/cases/k-1/medical-exam"): done}))
    res = _run(_HANDLERS["get_medical_report_status"]({"case_number": "APP-2026-6DF236"}, _ctx(client, "Agent")))
    assert "Diabetic" not in res["message"] and "result" not in res


def test_ai_reading_records_nothing():
    review = {"tests": {"FBS": {"value": "92 mg/dL", "abnormal": False, "evidence": "FBS 92", "readable": True},
                        "HIV": {"value": None, "readable": False}}}
    client = FakeClient(_base_routes({("POST", "/cases/k-1/medical-exam/ai-review"): review}))
    res = _run(_HANDLERS["read_medical_reports"]({"case_number": "APP-2026-6DF236"}, _ctx(client)))
    assert res["result"]["recorded"] is False and res["result"]["unreadable"] == ["HIV Screening"]
    assert not any(c[1].endswith("/medical-exam/result") for c in client.calls)


def test_review_without_staff_confirmation_is_refused():
    client = FakeClient(_base_routes())
    res = _run(_HANDLERS["record_medical_review"](
        {"case_number": "APP-2026-6DF236", "results_json": '{"FBS": "92"}', "staff_reviewed": False}, _ctx(client)))
    assert res["success"] is False and res["error_code"] == "review_required"
    assert client.calls == []


def test_incomplete_review_is_refused():
    client = FakeClient(_base_routes())
    res = _run(_HANDLERS["record_medical_review"](
        {"case_number": "APP-2026-6DF236", "results_json": '{"FBS": "92 mg/dL"}', "staff_reviewed": True},
        _ctx(client)))
    assert res["error_code"] == "incomplete_results" and "HIV Screening" in res["error"]
    assert not any(c[0] == "POST" for c in client.calls)


def test_complete_review_is_saved_by_test_code():
    saved = {"status": "Completed", "outcome": "Normal", "abnormal_findings": [], "suggested_loading_pct": 0}
    client = FakeClient(_base_routes({("POST", "/cases/k-1/medical-exam/result"): saved}))
    res = _run(_HANDLERS["record_medical_review"](
        {"case_number": "APP-2026-6DF236", "staff_reviewed": True,
         "results_json": '{"fasting blood sugar": "92 mg/dL", "HIV": "Non-reactive"}'}, _ctx(client)))
    assert res["success"] and res["state"]["gate_satisfied"]
    body = next(c[2] for c in client.calls if c[1].endswith("/medical-exam/result"))
    assert body == {"results": {"FBS": "92 mg/dL", "HIV": "Non-reactive"}}


# ── Missing documents ────────────────────────────────────────────────────────

def _docreq(email_status):
    return {"requirements": [{"document_type": "CNIC", "state": "received", "files": []},
                             {"document_type": "Salary Slip", "state": "missing", "files": []}],
            "link_path": "/documents/tok", "url": "http://portal/documents/tok", "expires_at": "2026-11-01",
            "emailed_to": "a@b.c" if email_status != "no_email" else None, "email_status": email_status}


def test_failed_email_is_never_reported_as_sent():
    client = FakeClient(_base_routes({("POST", "/customers/c-1/policies/p-1/document-request/send"): _docreq("failed")}))
    res = _run(_HANDLERS["request_missing_documents"]({"case_number": "APP-2026-6DF236"}, _ctx(client)))
    assert res["result"]["email_status"] == "failed"
    assert "could not be sent" in res["message"] and "Emailed" not in res["message"]
    assert "http://portal/documents/tok" in res["message"]
    upload = json.loads(res["quick_actions"][0]["payload"])
    assert upload["case_id"] == "k-1" and upload["document_types"] == ["Salary Slip"]


# ── Linking a file ───────────────────────────────────────────────────────────

def test_rejected_file_cannot_satisfy_a_requirement():
    routes = _base_routes({
        ("GET", "/cases/k-1/document-checklist"): {"required": ["CNIC", "Salary Slip"], "missing": ["Salary Slip"]},
        ("GET", "/cases/k-1/artifacts"): [{"id": "a-1", "file_name": "scan.pdf", "document_type": "Other",
                                           "status": "Re-submission Requested"}],
    })
    client = FakeClient(routes)
    res = _run(_HANDLERS["link_document_to_requirement"](
        {"case_number": "APP-2026-6DF236", "document_type": "salary slip", "file_name": "scan.pdf"}, _ctx(client)))
    assert res["error_code"] == "evidence_rejected"
    assert not any(c[0] == "PATCH" for c in client.calls)


def test_file_is_relinked_to_the_canonical_requirement_name():
    routes = _base_routes({
        ("GET", "/cases/k-1/document-checklist"): {"required": ["CNIC", "Salary Slip"], "missing": []},
        ("GET", "/cases/k-1/artifacts"): [{"id": "a-1", "file_name": "scan.pdf", "document_type": "Other",
                                           "status": "Accepted"}],
    })
    client = FakeClient(routes)
    res = _run(_HANDLERS["link_document_to_requirement"](
        {"case_number": "APP-2026-6DF236", "document_type": "salary slip", "file_name": "SCAN.pdf"}, _ctx(client)))
    assert res["success"], res
    assert ("PATCH", "/artifacts/a-1", {"document_type": "Salary Slip"}) in client.calls


# ── Operations ───────────────────────────────────────────────────────────────

def _thread(*steps):
    msgs = [HumanMessage(content="go")]
    for call_id, name, args, result in steps:
        msgs.append(AIMessage(content="", tool_calls=[{"id": call_id, "name": name, "args": args}]))
        if result is not None:
            msgs.append(ToolMessage(content=json.dumps(result), tool_call_id=call_id, name=name))
    return msgs


def test_status_lists_completed_and_failed_steps():
    state = {"messages": _thread(
        ("c1", "create_proposal", {"cnic": "1"}, {"success": True, "message": "Proposal created"}),
        ("c2", "run_compliance_screening", {"cnic": "1"},
         {"success": False, "error": "unreachable", "error_code": "unreachable", "retryable": True}),
    )}
    res = operations.operation_status_result(state, {})
    assert [o["status"] for o in res["operations"]] == ["completed", "failed"]
    assert res["resumable"][0]["operation_id"] == "c2"


def test_resume_retries_only_the_failed_step():
    state = {"messages": _thread(
        ("c1", "create_proposal", {"cnic": "1"}, {"success": True}),
        ("c2", "run_compliance_screening", {"cnic": "1"}, {"success": False, "error": "x", "retryable": True}),
    )}
    plan = operations.plan_resume(state, {})
    assert plan["tool"] == "run_compliance_screening" and plan["args"] == {"cnic": "1"}


def test_completed_step_is_never_resumed():
    state = {"messages": _thread(("c1", "create_proposal", {"cnic": "1"}, {"success": True}))}
    plan = operations.plan_resume(state, {"operation_id": "c1"})
    assert plan["error"]["skipped"] is True


def test_failure_already_recovered_is_not_retried_again():
    state = {"messages": _thread(
        ("c1", "run_compliance_screening", {"cnic": "1"}, {"success": False, "error": "x"}),
        ("c2", "run_compliance_screening", {"cnic": "1"}, {"success": True}),
    )}
    assert operations.resumable_failures(operations.operations_from_messages(state["messages"])) == []
    assert operations.plan_resume(state, {"operation_id": "c1"})["error"]["skipped"] is True


def test_timed_out_mutation_needs_a_state_check_before_retry():
    state = {"messages": _thread(
        ("c1", "issue_policy", {"cnic": "1"},
         {"success": False, "error": "slow", "error_code": "timeout", "retryable": True, "outcome_unknown": True}),
    )}
    assert operations.plan_resume(state, {})["error"]["error_code"] == "outcome_unknown"
    assert operations.plan_resume(state, {"state_verified": True})["tool"] == "issue_policy"


# ── Connectivity ─────────────────────────────────────────────────────────────

def test_extra_leading_digit_in_lan_address_is_spotted():
    problems = support_tools.check_api_url("http://110.47.153.234:8010", "mobile_agent_app")
    assert any("typo of 10.47.153.234" in p for p in problems)


def test_localhost_on_a_phone_is_flagged():
    problems = support_tools.check_api_url("http://localhost:8010", "mobile_agent_app")
    assert any("phone itself" in p for p in problems)


def test_correct_lan_address_has_no_problems():
    assert support_tools.check_api_url("http://10.47.153.234:8010", "mobile_agent_app") == []


def _healthy(monkeypatch):
    async def fake(keys):
        return {k: {"status": "healthy", "latency_ms": 12} for k in keys}
    monkeypatch.setattr(support_tools, "check_services", fake)


def test_timeout_with_mistyped_address_is_diagnosed_as_misconfiguration(monkeypatch):
    _healthy(monkeypatch)
    res = _run(_HANDLERS["diagnose_connection"](
        {"symptom": "server took too long to process sign in failed", "app": "mobile_agent_app",
         "client_api_url": "http://110.47.153.234:8010"}, _ctx(FakeClient(), "Agent")))
    assert res["diagnosis"] == "misconfigured_api_url"
    assert "expo start -c" in res["message"]


def test_timeout_with_healthy_server_points_at_the_device(monkeypatch):
    _healthy(monkeypatch)
    res = _run(_HANDLERS["diagnose_connection"](
        {"symptom": "The server took too long to respond.", "app": "mobile_agent_app"}, _ctx(FakeClient(), "Agent")))
    assert res["diagnosis"] == "device_cannot_reach_gateway"


def test_wrong_password_is_not_blamed_on_the_network(monkeypatch):
    _healthy(monkeypatch)
    res = _run(_HANDLERS["diagnose_connection"]({"symptom": "Invalid credentials"}, _ctx(FakeClient(), "Agent")))
    assert res["diagnosis"] == "invalid_credentials"


def test_down_gateway_wins_over_the_symptom(monkeypatch):
    async def fake(keys):
        return {k: {"status": "unreachable" if k == "api_gateway" else "healthy"} for k in keys}
    monkeypatch.setattr(support_tools, "check_services", fake)
    res = _run(_HANDLERS["diagnose_connection"]({"symptom": "Invalid credentials"}, _ctx(FakeClient(), "Agent")))
    assert res["diagnosis"] == "service_unavailable"


def test_non_admins_do_not_see_internal_service_urls(monkeypatch):
    _healthy(monkeypatch)
    res = _run(_HANDLERS["get_service_health"]({}, _ctx(FakeClient(), "Agent")))
    assert all("url" not in r for r in res["services"])
    res = _run(_HANDLERS["get_service_health"]({}, _ctx(FakeClient(), "Admin")))
    assert all("url" in r for r in res["services"])


def test_failed_server_side_probe_never_blames_a_correct_address(monkeypatch):
    """Docker Desktop containers often cannot reach the host's LAN IP, so a probe
    failure from the server is not evidence that the address is wrong."""
    _healthy(monkeypatch)

    async def unreachable(raw):
        return {"status": "timeout"}
    monkeypatch.setattr(support_tools, "_probe_client_url", unreachable)
    res = _run(_HANDLERS["diagnose_connection"](
        {"symptom": "took too long", "app": "mobile_agent_app", "client_api_url": "http://10.47.153.234:8010"},
        _ctx(FakeClient(), "Agent")))
    assert res["diagnosis"] == "device_cannot_reach_gateway"
    assert res["result"]["client_url_reachable_from_server"] is None
    assert "not the server's current" not in res["message"]


def test_completed_review_marks_every_test_reviewed():
    done = {**ORDER, "status": "Completed", "outcome": "Normal", "results": {"standard_panel": "normal"}}
    client = FakeClient(_base_routes({("GET", "/cases/k-1/medical-exam"): done}))
    res = _run(_HANDLERS["get_medical_report_status"]({"case_number": "APP-2026-6DF236"}, _ctx(client)))
    assert {r["state"] for r in res["requirements"]} == {"reviewed"} and res["state"]["gate_satisfied"]


# ── Through permission_gate ─────────────────────────────────────────────────

def _gate_state(messages, role="Underwriter"):
    return {"messages": messages, "tenant_id": TENANT, "jwt_token": "", "user_role": role, "platform": "web"}


def test_resume_through_the_gate_reruns_only_the_failed_step(monkeypatch):
    import graph
    ran = []

    async def fake_execute(name, args, ctx):
        ran.append((name, args))
        return {"success": True, "message": "Screening clear"}
    monkeypatch.setattr(graph, "execute_tool", fake_execute)
    msgs = _thread(
        ("c1", "create_proposal", {"cnic": "35202-1111111-1"}, {"success": True}),
        ("c2", "run_compliance_screening", {"cnic": "35202-1111111-1"}, {"success": False, "error": "x", "retryable": True}),
        ("c3", "resume_operation", {}, None),
    )
    cmd = _run(graph._permission_gate(_gate_state(msgs)))
    assert ran == [("run_compliance_screening", {"cnic": "35202-1111111-1"})]
    reply = json.loads(cmd.update["messages"][0].content)
    assert cmd.update["messages"][0].tool_call_id == "c3"
    assert reply["operation"] == {"id": "c2", "retry_of": "c2", "tool": "run_compliance_screening", "status": "completed"}


def test_resume_rechecks_the_target_tools_permission(monkeypatch):
    import graph

    async def never(*a, **kw):
        raise AssertionError("executed a step the role may not run")
    monkeypatch.setattr(graph, "execute_tool", never)
    msgs = _thread(
        ("c1", "issue_policy", {"cnic": "1"}, {"success": False, "error": "x", "retryable": True}),
        ("c2", "resume_operation", {}, None),
    )
    cmd = _run(graph._permission_gate(_gate_state(msgs, role="Agent")))
    assert json.loads(cmd.update["messages"][0].content)["error_code"] == "forbidden"


def test_operation_status_through_the_gate(monkeypatch):
    import graph
    msgs = _thread(
        ("c1", "create_proposal", {"cnic": "1"}, {"success": True, "message": "ok"}),
        ("c2", "get_operation_status", {}, None),
    )
    cmd = _run(graph._permission_gate(_gate_state(msgs)))
    reply = json.loads(cmd.update["messages"][0].content)
    assert [o["operation_id"] for o in reply["operations"]] == ["c1"]
