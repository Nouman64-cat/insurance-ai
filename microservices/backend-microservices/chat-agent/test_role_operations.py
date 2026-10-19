"""Role operations (role_operations.py): RBAC, input guardrails and the exact
backend calls, against synthetic in-memory services. Nothing here pays, waives
or changes a real record."""
from __future__ import annotations

import httpx
import pytest

import graph
from permission import MUTATING_TOOLS, SAFE_TOOLS, STEP_LABELS, get_tools_for_role, is_role_allowed
from role_operations import EXIT_MANAGERS, ROLE_OPERATION_TOOLS, SUPERADMIN_ONLY, TOOL_ROLES
from skills.selector import select
from test_claims_commission_tools import FakeClient as _FakeClient, _call
from tool_executor import ChoiceNeeded

NAMES = [t.name for t in ROLE_OPERATION_TOOLS]
ROLES = ["SuperAdmin", "Admin", "Underwriter", "Agent", "CustomerService", "Viewer", "ClaimsManager",
         "ClaimsAdjuster", "Finance", "Medical Underwriter", "Financial Underwriter", "SomeRoleNobodyDefined"]


class FakeClient(_FakeClient):
    async def patch(self, url, json=None, **kw):
        return self._reply("PATCH", url, json, **kw)


POLICY = {"id": "p-1", "policy_number": "PL-2026-0001", "status": "Active", "customer_name": "Sara Khan", "customer_id": "cu-1"}
CASE = {"caseld": "k-1", "caseNumber": "CASE-2026-0001", "applicant_name": "Sara Khan", "on_hold": False}
POLICIES = {("GET", "/policies"): [POLICY]}
CASES = {("GET", "/cases"): [CASE], ("GET", "/cases/k-1/detail"): {"policy": {"id": "p-1", "status": "UnderReview"}}}


def service(**routes):
    return FakeClient({**POLICIES, **CASES, **{tuple(k.split(" ", 1)): v for k, v in routes.items()}})


REF = {"policy_number": "PL-2026-0001"}
CASE_REF = {"case_number": "CASE-2026-0001"}


# ── Registration and RBAC ────────────────────────────────────────────────────

@pytest.mark.parametrize("name", NAMES)
def test_every_operation_is_registered_classified_and_labelled(name):
    assert (name in MUTATING_TOOLS) != (name in SAFE_TOOLS)
    assert name in STEP_LABELS and name in TOOL_ROLES


@pytest.mark.parametrize("role", ROLES)
@pytest.mark.parametrize("name", NAMES)
def test_grants_are_exactly_the_mirrored_router_roles(name, role):
    from permission import AGENT_ACQUISITION_TOOLS
    expected = role in TOOL_ROLES[name] and (role != 'Agent' or name in AGENT_ACQUISITION_TOOLS)
    assert is_role_allowed(name, role) == expected
    assert is_role_allowed(name, role, "mobile") == expected


def test_no_read_only_or_finance_role_can_mutate_through_an_operation():
    for name in NAMES:
        if name in MUTATING_TOOLS:
            for role in ("Viewer", "Finance", "SomeRoleNobodyDefined"):
                assert not is_role_allowed(name, role), (name, role)
    assert SUPERADMIN_ONLY == {"manage_branch"}
    assert not is_role_allowed("waive_agent_confidential_report", "Medical Underwriter")
    assert is_role_allowed("waive_medical_examination", "Medical Underwriter")
    assert not is_role_allowed("make_counter_offer", "Agent")
    assert not is_role_allowed("record_counter_offer_response", "Agent")


def test_handler_rechecks_role_and_validates_before_any_call():
    client = service()
    assert _call("hold_underwriting_case", {**CASE_REF, "reason": "Awaiting ID"}, client, "Agent")["error_code"] == "forbidden"
    bad = _call("set_premium_autopay", {**REF, "enabled": "maybe"}, client, "Underwriter")
    assert bad["error_code"] == "validation"
    assert client.calls == []


def test_unknown_fields_are_never_forwarded():
    client = service(**{"POST /cases/k-1/hold": {"caseNumber": CASE["caseNumber"]}})
    _call("hold_underwriting_case", {**CASE_REF, "reason": "Awaiting ID copy", "tenant_id": "other", "url": "http://evil"}, client, "Underwriter")
    assert client.writes() == [{"method": "POST", "path": "/cases/k-1/hold", "body": {"reason": "Awaiting ID copy"}, "params": None}]


# ── Renewal ──────────────────────────────────────────────────────────────────

def _renewal(**can):
    return {"case": {"id": "r-1", "renewal_no": "RN-1", "status": "Open", "is_open": True, "due_date": "2026-11-01",
                     "can": {"notice": True, "pay": False, "reconcile": False, **can}, "stages": []}}


def test_renewal_without_an_open_case_changes_nothing():
    client = service(**{"GET /policies/p-1/renewals": {"case": None, "eligibility": {"eligible": True}}})
    r = _call("progress_policy_renewal", {**REF, "action": "send_notice"}, client, "Underwriter")
    assert r["error_code"] == "no_open_case" and not client.writes()


def test_renewal_step_the_case_does_not_allow_is_refused_without_a_write():
    client = service(**{"GET /policies/p-1/renewals": _renewal()})
    r = _call("progress_policy_renewal", {**REF, "action": "complete"}, client, "Underwriter")
    assert r["error_code"] == "not_ready" and not client.writes()


def test_renewal_payment_needs_a_real_reference_and_confirmation_and_is_recorded_manually():
    client = service(**{"GET /policies/p-1/renewals": _renewal(pay=True), "POST /policies/p-1/renewals/r-1/payment": _renewal()})
    for args in ({}, {"payment_method": "Cash"}, {"payment_method": "Cash", "payment_reference": "RCPT-77"}):
        assert not _call("progress_policy_renewal", {**REF, "action": "record_payment", **args}, client, "Underwriter")["success"]
    assert not client.writes()
    r = _call("progress_policy_renewal", {**REF, "action": "record_payment", "payment_method": "Cash",
                                          "payment_reference": "RCPT-77", "payment_confirmed": True}, client, "Underwriter")
    assert r["success"]
    assert client.writes()[0]["body"] == {"method": "Cash", "reference": "RCPT-77", "manual": True}


def test_risk_decision_needs_the_underwriters_rationale():
    client = service(**{"GET /policies/p-1/renewals": _renewal(risk_decide=True)})
    r = _call("progress_policy_renewal", {**REF, "action": "record_risk_decision", "decision": "Decline"}, client, "Underwriter")
    assert r["error_code"] == "missing_details" and not client.writes()


# ── Reinstatement ────────────────────────────────────────────────────────────

QUESTIONS = [{"key": "hospitalised", "text": "Hospitalised since lapse?", "adverse_if": True, "needs_details": True}]


def test_declaration_is_never_answered_for_the_signer():
    client = service(**{"GET /policies/p-1/reinstatement": {"case": {"id": "ri-1", "case_no": "RI-1", "status": "Open"},
                                                              "declaration_questions": QUESTIONS}})
    r = _call("progress_reinstatement", {**REF, "action": "record_declaration", "signed_by": "Sara", "signature_confirmed": True},
              client, "Underwriter")
    assert r["error_code"] == "missing_details" and r["questions"] == QUESTIONS and not client.writes()
    client.routes[("POST", "/policies/p-1/reinstatement/ri-1/declaration")] = {"case": {"status": "Open"}}
    r = _call("progress_reinstatement", {**REF, "action": "record_declaration", "answers": {"hospitalised": False},
                                         "signed_by": "Sara", "signature_confirmed": True}, client, "Underwriter")
    assert r["success"] and client.writes()[0]["body"]["answers"] == {"hospitalised": False}


def test_cover_is_not_restored_while_the_case_reports_blockers():
    client = service(**{"GET /policies/p-1/reinstatement": {"case": {"id": "ri-1", "status": "Approved", "can_restore": False,
                                                                       "restore_blockers": ["Arrears unpaid"]}}})
    r = _call("progress_reinstatement", {**REF, "action": "restore_cover"}, client, "Underwriter")
    assert r["error_code"] == "not_ready" and "Arrears unpaid" in r["message"] and not client.writes()


# ── Exit ─────────────────────────────────────────────────────────────────────

def _exit(**can):
    return {"case": {"case": {"id": "x-1", "exit_no": "EX-1", "status": "Open", "is_open": True}, "can": can,
                     "disbursement": {"methods": ["Bank Transfer"]}, "stages": []}}


def test_exit_authorisation_is_kept_with_claims_managers_and_admins():
    client = service(**{"GET /policies/p-1/exit": _exit(authorize=True)})
    r = _call("progress_policy_exit", {**REF, "action": "authorize_settlement"}, client, "ClaimsAdjuster")
    assert r["error_code"] == "forbidden" and not client.writes()
    assert "ClaimsAdjuster" not in EXIT_MANAGERS
    client.routes[("POST", "/policies/p-1/exit/x-1/settlement/authorize")] = _exit()
    assert _call("progress_policy_exit", {**REF, "action": "authorize_settlement"}, client, "ClaimsManager")["success"]
    assert client.writes()[0]["path"] == "/policies/p-1/exit/x-1/settlement/authorize"


def test_exit_payee_and_payout_need_customer_evidence_and_an_offered_method():
    client = service(**{"GET /policies/p-1/exit": _exit(verify_payee=True, disburse=True)})
    assert not _call("progress_policy_exit", {**REF, "action": "verify_payee"}, client, "ClaimsManager")["success"]
    assert not _call("progress_policy_exit", {**REF, "action": "disburse_settlement", "payout_method": "JazzCash"}, client,
                     "ClaimsManager")["success"]
    assert not client.writes()


# ── Premium operations ───────────────────────────────────────────────────────

BILLING = {"installments": [{"id": "s-1", "installment_no": 1, "status": "Paid", "outstanding": 0},
                            {"id": "s-2", "installment_no": 2, "status": "Overdue", "outstanding": 5000, "payable": 5250,
                             "due_date": "2026-10-01"}],
           "summary": {"paid": 1, "total": 2, "total_outstanding": 5250, "in_grace": True}, "autopay_enabled": False}


def test_collection_offers_outstanding_instalments_and_skips_paid_ones():
    client = service(**{"GET /policies/p-1/premiums": BILLING})
    with pytest.raises(ChoiceNeeded) as choice:
        _call("record_premium_collection", REF, client, "Underwriter")
    assert len(choice.value.quick_actions) == 1
    r = _call("record_premium_collection", {**REF, "installment_no": 1, "payment_method": "Cash", "payment_reference": "R1",
                                            "payment_confirmed": True}, client, "Underwriter")
    assert r["result"]["status"] == "skipped" and not client.writes()


def test_collection_records_only_a_confirmed_manual_receipt():
    client = service(**{"GET /policies/p-1/premiums": BILLING, "POST /policies/p-1/premiums/s-2/collect": BILLING})
    assert not _call("record_premium_collection", {**REF, "installment_no": 2, "payment_method": "Cash", "payment_reference": "R2"},
                     client, "Underwriter")["success"]
    assert not client.writes()
    assert _call("record_premium_collection", {**REF, "installment_no": 2, "payment_method": "BankTransfer",
                                               "payment_reference": "R2", "payment_confirmed": True}, client, "Underwriter")["success"]
    assert client.writes()[0]["body"] == {"method": "BankTransfer", "reference": "R2", "manual": True}


def test_waiver_needs_a_reason_and_autopay_is_idempotent():
    client = service(**{"GET /policies/p-1/premiums": BILLING})
    assert _call("waive_premium_installment", {**REF, "installment_no": 2}, client, "Underwriter")["error_code"] == "missing_details"
    assert _call("set_premium_autopay", {**REF, "enabled": False}, client, "Underwriter")["result"]["status"] == "skipped"
    assert not client.writes()


# ── Underwriting decisions ───────────────────────────────────────────────────

PENDING = {"offer_type": "Loading", "status": "Pending", "revised_loading_pct": 50, "valid_until": "2026-11-01"}


def test_counter_offer_needs_reason_and_never_silently_replaces_a_pending_one():
    client = service(**{"GET /policies/p-1/counter-offer": PENDING})
    assert not _call("make_counter_offer", {**CASE_REF, "offer_type": "Loading", "revised_loading_pct": 75}, client, "Underwriter")["success"]
    r = _call("make_counter_offer", {**CASE_REF, "offer_type": "Loading", "revised_loading_pct": 75, "reason": "BMI 38"}, client, "Underwriter")
    assert r["error_code"] == "missing_details" and not client.writes()


def test_counter_offer_response_must_come_from_the_customer():
    client = service(**{"GET /policies/p-1/counter-offer": PENDING, "POST /policies/p-1/counter-offer/accept": {"status": "AcceptedWithLoadings"}})
    assert not _call("record_counter_offer_response", {**CASE_REF, "accepted": True}, client, "Agent")["success"]
    assert not client.writes()
    assert _call("record_counter_offer_response", {**CASE_REF, "accepted": True, "customer_confirmed": True}, client, "Agent")["success"]
    assert client.writes()[0]["path"] == "/policies/p-1/counter-offer/accept"


def test_hold_is_skipped_when_already_held():
    client = FakeClient({("GET", "/cases"): [{**CASE, "on_hold": True, "hold_reason": "Fraud check"}]})
    r = _call("hold_underwriting_case", {**CASE_REF, "reason": "Another reason"}, client, "Underwriter")
    assert r["result"]["status"] == "skipped" and not client.writes()


def test_plan_change_previews_unless_applied():
    plans = [{"id": "pl-2", "name": "Life Secure"}]
    client = service(**{"GET /insurance-plans": plans, "POST /cases/k-1/change-plan": {"dry_run": True, "applied": False}})
    r = _call("change_case_plan", {**CASE_REF, "plan_name": "life secure", "coverage_amount": 2_000_000, "term_years": 10}, client, "Underwriter")
    assert r["result"]["status"] == "preview" and client.writes()[0]["body"]["dry_run"] is True


def test_reinsurance_referral_is_not_duplicated():
    ri = {"referral": {"status": "Submitted", "reinsurer": {"name": "Munich Re"}}, "panel": [], "cession": {}}
    client = service(**{"GET /policies/p-1/reinsurance": ri})
    r = _call("refer_policy_to_reinsurer", {**CASE_REF, "reinsurer": "munich"}, client, "Underwriter")
    assert r["result"]["status"] == "skipped" and not client.writes()


# ── Desks ────────────────────────────────────────────────────────────────────

def test_claim_authority_change_keeps_the_unnamed_limit():
    view = {"limits": [{"role_name": "ClaimsAdjuster", "approve_limit": 500000.0, "authorize_limit": 250000.0}]}
    client = service(**{"GET /claims/authority": view, "PUT /claims/authority": view})
    _call("set_claim_authority_limit", {"role_name": "ClaimsAdjuster", "approve_limit": "unlimited"}, client, "Admin")
    assert client.writes()[0]["body"] == {"role_name": "ClaimsAdjuster", "approve_limit": None, "authorize_limit": 250000.0}
    assert _call("set_claim_authority_limit", {"role_name": "ClaimsAdjuster"}, service(), "Admin")["error_code"] == "missing_details"


def test_acknowledged_walk_in_lead_is_not_acknowledged_again():
    lead = {"id": "w-1", "reference": "WL-2026-0007", "customer_name": "Ali", "acknowledged_at": "2026-10-17T09:00:00"}
    client = service(**{"GET /walk-in-leads": [lead]})
    r = _call("acknowledge_walk_in_lead", {"lead_reference": "wl-2026-0007"}, client, "Agent")
    assert r["result"]["status"] == "skipped" and not client.writes()


def test_branch_update_uses_the_existing_branch_and_only_named_fields():
    client = service(**{"GET /branches": [{"id": "b-1", "branch_code": "LHR-01", "name": "Lahore", "city": "Lahore"}]})
    client.routes[("PATCH", "/branches/b-1")] = {"id": "b-1", "branch_code": "LHR-01", "name": "Lahore Main", "city": "Lahore"}
    assert _call("manage_branch", {"action": "update", "branch_code": "lhr-01", "name": "Lahore Main"}, client, "SuperAdmin")["success"]
    assert client.writes()[0]["body"] == {"name": "Lahore Main"}


# ── Specialist reach and skill selection ─────────────────────────────────────

@pytest.mark.parametrize("module,scope,domains,role,tool", [
    ("servicing_specialist", "SERVICING_TOOLS", "SERVICING_DOMAINS", "Underwriter", "progress_policy_renewal"),
    ("claims_specialist", "CLAIMS_TOOLS", "CLAIMS_DOMAINS", "ClaimsManager", "progress_policy_exit"),
    ("claims_specialist", "CLAIMS_TOOLS", "CLAIMS_DOMAINS", "ClaimsManager", "get_claim_authority_limits"),
    ("underwriting_specialist", "UNDERWRITING_TOOLS", "UNDERWRITING_DOMAINS", "Underwriter", "make_counter_offer"),
])
def test_specialists_bind_the_operations_their_roles_own(module, scope, domains, role, tool):
    from unittest.mock import patch
    mod = __import__(module)
    allowed = frozenset(t.name for t in get_tools_for_role(role) if t.name in getattr(mod, scope))

    class Bound:
        def bind_tools(self, tools, **kwargs):
            self.names = {t.name for t in tools}
            return self
    bound = Bound()
    with patch.dict(graph._LLM_CACHE, {}, clear=True), patch("graph.providers.build_chat", return_value=bound):
        graph._llm({"version": "ops-test", "primary": {}}, role, domains=getattr(mod, domains), tool_scope=allowed)
    assert tool in bound.names


def test_medical_track_can_waive_the_exam_and_see_claim_referrals():
    from track_specialists import DOMAINS, MEDICAL_TOOLS
    from toolsets import tool_names_for
    reach = {t.name for t in get_tools_for_role("Medical Underwriter") if t.name in MEDICAL_TOOLS} & tool_names_for(DOMAINS)
    assert {"waive_medical_examination", "list_claim_underwriting_referrals"} <= reach


@pytest.mark.parametrize("text,role,specialist,expected", [
    ("Record the renewal premium received", "Underwriter", "servicing", "renewal-processing"),
    ("Record the good health declaration for the reinstatement", "Underwriter", "servicing", "reinstatement-processing"),
    ("Authorise the surrender settlement", "ClaimsManager", "claims", "policy-exit-processing"),
    ("What is my approval limit", "ClaimsManager", "claims", "claims-authority"),
    ("Issue a counter offer with revised terms", "Underwriter", "underwriting", "underwriting-decisions"),
    ("Refer this case to the reinsurer for facultative terms", "Underwriter", "underwriting", "reinsurance-management"),
    ("Show my walk-in leads", "Agent", None, "agent-desk"),
    ("Create a new branch", "SuperAdmin", None, "branch-administration"),
])
def test_operation_skills_are_selected_for_their_roles(text, role, specialist, expected):
    assert expected in select(text, role, specialist=specialist)
