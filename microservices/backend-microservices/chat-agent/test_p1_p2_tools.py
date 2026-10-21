"""P1/P2 servicing, service-desk and workflow tools, and the matured Phase 1
tools (microservices/frontend-microservices/docs/agent-scenarios/chatbot-maturity-roadmap.md).

The invariants under test: one record or a choice; reads before writes so a
repeated click changes nothing; queued/estimated/requested is never reported
as sent/paid/done; and gates are never bypassed.

Run with:  python -m pytest services/chat-agent/test_p1_p2_tools.py -q
"""

from __future__ import annotations

import asyncio
import json
from urllib.parse import urlparse

import httpx
import pytest

from tool_executor import ChoiceNeeded, Ctx, ExecCtx, _HANDLERS

TENANT = "t1"


class FakeClient:
    def __init__(self, routes=None):
        self.routes = routes or {}
        self.calls: list[dict] = []

    def _reply(self, method, url, body=None, **kw):
        path = urlparse(url).path.removeprefix(f"/tenants/{TENANT}")
        self.calls.append({"method": method, "path": path, "body": body, "headers": kw.get("headers") or {},
                           "params": kw.get("params")})
        value = self.routes.get((method, path), [] if method == "GET" else {})
        status, payload = value if isinstance(value, tuple) else (200, value)
        return httpx.Response(status, json=payload, request=httpx.Request(method, url))

    async def get(self, url, **kw):
        return self._reply("GET", url, **kw)

    async def post(self, url, json=None, **kw):
        return self._reply("POST", url, json, **kw)

    async def patch(self, url, json=None, **kw):
        return self._reply("PATCH", url, json, **kw)

    def writes(self):
        return [c for c in self.calls if c["method"] != "GET"]


def _ctx(client, role="Admin", platform="web"):
    return Ctx(client=client, tenant_id=TENANT,
               exec_ctx=ExecCtx(tenant_id=TENANT, jwt_token="x" * 40, role=role, platform=platform, operation_id="test-tool-call-1"))


def _run(coro):
    return asyncio.run(coro)


def _call(name, args, client, role="Admin"):
    return _run(_HANDLERS[name](args, _ctx(client, role)))


POLICY = {"id": "p-1", "policy_number": "PL-2026-0001", "customer_id": "c-1", "customer_name": "Ali Khan",
          "product_name": "Term", "status": "Active", "case_number": "CASE-2026-AAA111", "created_at": "2026-10-01"}
POLICIES = [POLICY, {**POLICY, "id": "p-2", "policy_number": "PL-2026-0002", "customer_id": "c-2"}]


def _routes(extra=None):
    r = {("GET", "/policies"): POLICIES}
    r.update(extra or {})
    return r


# ── Policy resolution ────────────────────────────────────────────────────────

def test_two_policyholders_with_one_name_is_a_choice():
    with pytest.raises(ChoiceNeeded) as exc:
        _call("get_premium_schedule", {"policyholder_name": "Ali Khan"}, FakeClient(_routes()))
    assert len(exc.value.quick_actions) == 2


def test_unknown_policy_number_never_falls_back():
    with pytest.raises(LookupError, match="No other policy"):
        _call("get_premium_schedule", {"policy_number": "PL-2026-9999"}, FakeClient(_routes()))


# ── Delivery & onboarding ────────────────────────────────────────────────────

def _onboarding(jobs, email="a@b.c", steps=None):
    return {"automatic_delivery": jobs, "contact": {"email": email}, "steps": steps or {}, "progress": {}}


def test_retry_with_nothing_failed_sends_nothing():
    client = FakeClient(_routes({("GET", "/policies/p-1/onboarding"): _onboarding(
        {"WelcomeKit": {"status": "Completed"}, "IssuanceEmail": {"status": "Completed"}})}))
    res = _call("retry_failed_delivery", {"policy_number": "PL-2026-0001"}, client)
    assert res["result"]["reason"] == "nothing_failed" and not client.writes()


def test_retry_is_queued_not_reported_as_sent():
    client = FakeClient(_routes({
        ("GET", "/policies/p-1/onboarding"): _onboarding({"IssuanceEmail": {"status": "Retry", "error": "SMTP"}}),
        ("POST", "/policies/p-1/onboarding/delivery/retry"): {"requeued": ["IssuanceEmail"]},
    }))
    res = _call("retry_failed_delivery", {"policy_number": "PL-2026-0001"}, client)
    assert res["result"]["status"] == "queued" and "nothing is reported as sent" in res["message"]


def test_portal_account_in_use_is_never_replaced():
    steps = {"portal": {"done": True, "status": "Active", "must_reset": False, "username": "ali"}}
    client = FakeClient(_routes({("GET", "/policies/p-1/onboarding"): _onboarding({}, steps=steps)}))
    res = _call("provision_portal_access", {"policy_number": "PL-2026-0001"}, client)
    assert res["result"]["reason"] == "already_active" and not client.writes()


def test_password_reset_needs_a_reason():
    client = FakeClient(_routes({("GET", "/policies/p-1/onboarding"): _onboarding({})}))
    res = _call("provision_portal_access", {"policy_number": "PL-2026-0001", "reset_password": True}, client)
    assert res["error_code"] == "reason_required" and not client.writes()


# ── Premiums ─────────────────────────────────────────────────────────────────

def test_failed_reminder_email_is_reported_as_failed():
    client = FakeClient(_routes({
        ("GET", "/policies/p-1/premiums"): {"installments": [
            {"id": "s-2", "installment_no": 2, "outstanding": 500, "payable": 500, "state": "grace", "due_date": "2026-10-01"}]},
        ("POST", "/policies/p-1/premiums/s-2/remind"): {"reminder": {"channel": "Email", "to": "a@b.c", "delivered": False}},
    }))
    res = _call("send_premium_reminder", {"policy_number": "PL-2026-0001"}, client)
    assert res["success"] is False and res["error_code"] == "delivery_failed"
    assert client.writes()[0]["body"]["kind"] == "GraceWarning"


# ── Endorsements ─────────────────────────────────────────────────────────────

ENDORSE_OV = {"can_endorse": True, "sum_assured": 1_000_000, "address": {"address": "1 Mall Rd", "city": "Lahore"},
              "contact": {}, "beneficiaries": [{"name": "Sara", "share_pct": 100}], "riders": [], "history": []}


def test_endorsement_matching_the_policy_changes_nothing():
    client = FakeClient(_routes({("GET", "/policies/p-1/endorsements"): ENDORSE_OV}))
    res = _call("submit_policy_endorsement", {"policy_number": "PL-2026-0001", "endorsement_type": "address",
                                              "address": "1 Mall Rd", "city": "Lahore"}, client)
    assert res["result"]["reason"] == "already_applied" and not client.writes()


def test_nominee_shares_must_total_100():
    client = FakeClient(_routes({("GET", "/policies/p-1/endorsements"): ENDORSE_OV}))
    res = _call("submit_policy_endorsement", {
        "policy_number": "PL-2026-0001", "endorsement_type": "nominees",
        "beneficiaries_json": json.dumps([{"name": "A", "relationship": "Son", "share_pct": 60}])}, client)
    assert res["error_code"] == "validation" and "100%" in res["error"] and not client.writes()


def test_preview_never_writes():
    client = FakeClient(_routes({("GET", "/policies/p-1/endorsements"): ENDORSE_OV,
                                 ("GET", "/policies/p-1/endorsements/quote"): {"current_premium": 10, "new_premium": 12, "delta": 2}}))
    res = _call("preview_policy_endorsement", {"policy_number": "PL-2026-0001", "endorsement_type": "sum_assured",
                                               "new_sum_assured": 2_000_000}, client)
    assert res["result"]["premium_impact"]["delta"] == 2 and not client.writes()


def test_agent_cannot_apply_a_contract_change():
    from permission import is_role_allowed
    assert not is_role_allowed("submit_policy_endorsement", "Agent")
    assert not is_role_allowed("preview_policy_endorsement", "Agent")
    assert not is_role_allowed("preview_policy_endorsement", "Agent", "mobile")


# ── Renewal / reinstatement / exit ───────────────────────────────────────────

def test_open_renewal_is_not_opened_twice():
    client = FakeClient(_routes({("GET", "/policies/p-1/renewals"): {"case": {"is_open": True, "renewal_no": "RN-1"},
                                                                    "eligibility": {"eligible": True}}}))
    res = _call("submit_policy_renewal", {"policy_number": "PL-2026-0001"}, client)
    assert res["result"]["reason"] == "already_open" and not client.writes()


def test_ineligible_reinstatement_is_refused():
    client = FakeClient(_routes({("GET", "/policies/p-1/reinstatement"): {
        "case": None, "eligibility": {"eligible": False, "outcome": "not_required", "message": "Policy is Active"}}}))
    res = _call("submit_reinstatement_request", {"policy_number": "PL-2026-0001"}, client)
    assert res["error_code"] == "not_eligible" and not client.writes()


def test_exit_needs_the_customers_instruction():
    client = FakeClient(_routes())
    res = _call("submit_policy_exit_request", {"policy_number": "PL-2026-0001", "exit_type": "surrender",
                                               "customer_confirmed": False}, client)
    assert res["error_code"] == "confirmation_required" and not client.writes()


def test_free_look_after_the_window_is_refused():
    client = FakeClient(_routes({("GET", "/policies/p-1/free-look"): {"is_open": False, "cancelled": False,
                                                                     "free_look_end_date": "2026-09-01"}}))
    res = _call("submit_policy_exit_request", {"policy_number": "PL-2026-0001", "exit_type": "free_look_cancellation",
                                               "customer_confirmed": True}, client)
    assert res["error_code"] == "window_closed" and not client.writes()


def test_free_look_cancellation_does_not_claim_the_refund_was_paid():
    client = FakeClient(_routes({
        ("GET", "/policies/p-1/free-look"): {"is_open": True, "cancelled": False, "refund_amount": 900},
        ("POST", "/policies/p-1/free-look/cancel"): {"cancelled": True, "cancellation": {"refund_amount": 900}},
    }))
    res = _call("submit_policy_exit_request", {"policy_number": "PL-2026-0001", "exit_type": "free_look_cancellation",
                                               "customer_confirmed": True}, client)
    assert "has not been paid" in res["message"]


# ── Service requests & tickets ───────────────────────────────────────────────

def test_same_request_twice_uses_the_same_idempotency_key():
    client = FakeClient({("POST", "/request-management/v1/requests"): {"id": "r-1", "reference_no": "REQ-1", "title": "x"}})
    args = {"request_type": "general", "title": "Fix DOB", "description": "Date of birth is wrong on file",
            "category": "DATA_FIX"}
    _call("create_service_request", args, client)
    _call("create_service_request", args, client)
    keys = [c["headers"]["Idempotency-Key"] for c in client.calls if c["path"].endswith("/requests") and c["method"] == "POST"]
    assert len(keys) == 2 and keys[0] == keys[1]


def test_submitted_request_is_not_resubmitted():
    detail = {"id": "r-1", "reference_no": "REQ-1", "review_status": "IN_REVIEW", "version": 3}
    client = FakeClient({("GET", "/request-management/v1/requests"): {"items": [detail]},
                         ("GET", "/request-management/v1/requests/r-1"): detail})
    res = _call("submit_service_request", {"request_reference": "REQ-1"}, client)
    assert res["result"]["reason"] == "already_submitted" and not client.writes()


def test_approved_but_unapplied_change_is_not_called_done():
    detail = {"id": "r-1", "reference_no": "REQ-1", "title": "Fix email", "review_status": "APPROVED",
              "execution_status": "FAILED", "type": {"executes": True}, "execution": {"last_error": "record changed"}}
    client = FakeClient({("GET", "/request-management/v1/requests"): {"items": [detail]},
                         ("GET", "/request-management/v1/requests/r-1"): detail,
                         ("GET", "/request-management/v1/requests/r-1/timeline"): []})
    res = _call("get_service_request", {"request_reference": "REQ-1"}, client)
    assert "not applied yet" in res["message"]


def test_duplicate_ticket_comment_is_not_posted_twice():
    ticket = {"id": "abcdef12-0000-0000-0000-000000000000", "title": "x", "events": [{"body": "Called the customer"}]}
    client = FakeClient({("GET", "/customer-service/v1/tickets/abcdef12-0000-0000-0000-000000000000"): ticket})
    res = _call("add_ticket_comment", {"ticket_reference": ticket["id"], "comment": "Called the customer"}, client)
    assert res["result"]["reason"] == "duplicate" and not client.writes()


# ── Workflow ─────────────────────────────────────────────────────────────────

FAMILY = [
    {"caseld": "k-1", "caseNumber": "CASE-2026-F1", "customer_name": "Bilal", "customer_id": "c-1",
     "family_group_id": "f-1", "family_group_name": "Rizvi", "caseStatus": "New", "e_application_status": "NotSent"},
    {"caseld": "k-2", "caseNumber": "CASE-2026-F2", "customer_name": "Hina", "customer_id": "c-2",
     "family_group_id": "f-1", "family_group_name": "Rizvi", "caseStatus": "Under Review",
     "e_application_status": "Verified", "acr_status": "Submitted", "compliance_status": "Passed",
     "insurance_history_status": "Clear", "medical_exam_status": "Completed", "latest_ai_decision": "Approve"},
]


def test_member_matrix_reports_each_member_separately():
    res = _call("get_member_workflow_matrix", {"group_name": "rizvi"}, FakeClient({("GET", "/cases"): FAMILY}))
    stages = {m["member"]: m["stage"] for m in res["members"]}
    assert stages == {"Bilal": "Pre-Underwriting", "Hina": "Underwriting Decision"}


def test_resuming_a_member_never_decides_for_them():
    client = FakeClient({("GET", "/cases"): FAMILY})
    res = _call("resume_member_workflow", {"case_number": "CASE-2026-F2"}, client)
    assert res["result"]["status"] == "awaiting_user" and not client.writes()


def test_resuming_a_member_rechecks_the_steps_permission():
    res = _call("resume_member_workflow", {"case_number": "CASE-2026-F1"}, FakeClient({("GET", "/cases"): FAMILY}),
                role="Viewer")
    assert res["error_code"] == "forbidden"


def test_my_queue_never_falls_back_to_everyones():
    client = FakeClient({("GET", "/cases"): FAMILY, ("GET", "/auth/me"): (401, {"detail": "expired"})})
    res = _call("get_work_queue", {"queue": "applications", "mine": True}, client)
    assert res["unavailable_queues"] == ["applications"] and res["items"] == []


def test_evidence_request_respects_transitions():
    closed = [{**FAMILY[0], "caseStatus": "Closed"}]
    client = FakeClient({("GET", "/cases"): closed})
    res = _call("request_additional_evidence", {"case_number": "CASE-2026-F1", "evidence": ["ECG"]}, client)
    assert res["error_code"] == "illegal_transition" and not client.writes()


# ── Matured Phase 1 tools ────────────────────────────────────────────────────

def test_approval_is_blocked_by_open_gates():
    client = FakeClient({("GET", "/cases"): FAMILY})
    res = _call("approve_case", {"case_number": "CASE-2026-F1"}, client)
    assert res["error_code"] == "blocked" and not client.writes()


def test_unchanged_status_is_a_no_op():
    client = FakeClient({("GET", "/cases"): FAMILY})
    res = _call("update_case_status", {"case_number": "CASE-2026-F2", "new_status": "Under Review"}, client)
    assert res["skipped"] and not client.writes()


def test_duplicate_open_proposal_is_not_created():
    client = FakeClient({("GET", "/customers"): [{"id": "c-1", "name": "Ali Khan", "cnic": "35202-1111111-1"}],
                         ("GET", "/customers/c-1"): {"id": "c-1", "name": "Ali Khan", "cnic": "35202-1111111-1", "details": {}},
                         ("GET", "/customers/c-1/policies"): [{"id": "p-9", "product_name": "Term Life Plus",
                                                               "status": "Proposed", "created_at": "2026-10-01"}]})
    res = _call("create_proposal", {"cnic": "35202-1111111-1"}, client)
    assert res["result"]["reason"] == "open_proposal_exists" and not client.writes()


def test_a_settled_first_premium_is_never_charged_again():
    case = {**FAMILY[1], "caseStatus": "Approved", "ipp_status": "Realized", "policy_id": "p-1"}
    client = FakeClient({("GET", "/cases"): [case], ("GET", "/cases/k-2/detail"): {"policy":{"id":"p-1","status":"PendingPayment"}},
                         ("GET", "/policies/p-1/payments/prepaid"): {"settled":True},
                         ("GET", "/policies/p-1"): {"id": "p-1", "status": "PendingPayment"},
                         ("GET", "/customers/c-2/policies"): [{"id": "p-1", "status": "PendingPayment"}]})
    res = _call("confirm_policy_payment", {"case_number": "CASE-2026-F2"}, client)
    assert res.get("result", {}).get("reason") == "already_paid", res
    assert "__client_execute__" not in res


def test_rejected_file_does_not_count_as_received():
    client = FakeClient({("GET", "/cases"): FAMILY,
                         ("GET", "/cases/k-1/document-checklist"): {"required": ["CNIC"], "received": ["CNIC"], "missing": []},
                         ("GET", "/cases/k-1/artifacts"): [{"id": "a-1", "document_type": "CNIC",
                                                            "status": "Re-submission Requested"}]})
    res = _call("get_document_checklist", {"case_number": "CASE-2026-F1"}, client)
    assert res["checklist"]["missing"] == ["CNIC"] and "unreadable" in res["message"]


def test_recommendation_comes_from_state_not_keywords():
    res = _call("get_workflow_recommendation", {"case_number": "CASE-2026-F2", "action_context": "customer added"},
                FakeClient({("GET", "/cases"): FAMILY}))
    assert res["source"] == "application_state" and res["workflow_stage"] == "Underwriting Decision"


def test_search_outage_is_not_reported_as_no_results():
    class Down(FakeClient):
        async def get(self, url, **kw):
            raise httpx.ConnectError("down")
    res = _call("search_records", {"query": "Ali", "record_type": "customer"}, Down())
    assert res["success"] is False and res["error_code"] == "service_unavailable"


def test_work_queue_separates_age_from_lateness():
    rows = [{**FAMILY[0], "createdAt": "2026-01-01T00:00:00", "slaDeadline": "2099-01-01T00:00:00"},
            {**FAMILY[1], "caseNumber": "CASE-2026-F3", "createdAt": "2026-10-01T00:00:00", "slaDeadline": "2026-01-02T00:00:00"}]
    res = _call("get_work_queue", {"queue": "applications"}, FakeClient({("GET", "/cases"): rows}))
    overdue = {i["reference"]: i["overdue"] for i in res["items"]}
    assert overdue == {"CASE-2026-F1": False, "CASE-2026-F3": True} and res["overdue_count"] == 1
    assert res["items"][0]["reference"] == "CASE-2026-F3"      # overdue first, however young


def test_placeholder_email_never_reaches_a_live_policy():
    """A literal '<your-test-email>' was once applied to a policy as its contact."""
    from validation import validate_and_normalize
    for tool in ("preview_policy_endorsement", "submit_policy_endorsement"):
        _, errors = validate_and_normalize(tool, {"endorsement_type": "contact", "email": "your-test-email"})
        assert errors and "valid email" in errors[0]
        _, errors = validate_and_normalize(tool, {"endorsement_type": "contact", "email": "hamza@example.com"})
        assert not errors


def test_upfront_receipt_does_not_block_collection_of_the_issuance_balance():
    case = {**FAMILY[1], "caseStatus":"Approved", "ipp_status":"Realized", "policy_id":"p-1"}
    client = FakeClient({("GET","/cases"):[case], ("GET","/cases/k-2/detail"):{"policy":{"id":"p-1","status":"PendingPayment"}},
                         ("GET","/policies/p-1/payments/prepaid"):{"received":True,"amount":13302.9,"settled":False,"remaining_due":53211.6,"split":{"upfront_pct":20,"remaining_pct":80}}})
    result = _call("confirm_policy_payment",{"case_number":"CASE-2026-F2"},client)
    assert result["__client_execute__"] is True
    assert result["tool_call"]["name"] == "confirm_policy_payment"
    assert result["tool_call"]["args"]["policy"]["id"] == "p-1"
    assert not client.writes()
