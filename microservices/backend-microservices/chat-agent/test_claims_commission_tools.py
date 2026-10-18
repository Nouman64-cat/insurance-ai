"""Claims-workflow and commission-administration tools (claim_workflow_tools.py,
commission_tools.py).

The invariants under test: a register-only claim is offered adoption rather than
failing; a repeated click never writes twice; a business-rule 403 reaches the user
verbatim; nothing is reported as sent or paid unless it was; and the role gates
keep money release with managers and commission administration with Admins.

Run with:  python -m pytest services/chat-agent/test_claims_commission_tools.py -q
"""

from __future__ import annotations

import asyncio
from urllib.parse import urlparse

import httpx
import pytest

from permission import is_role_allowed
from tool_executor import ChoiceNeeded, Ctx, ExecCtx, _HANDLERS

TENANT = "t1"


class FakeClient:
    def __init__(self, routes=None):
        self.routes = routes or {}
        self.calls: list[dict] = []

    def _reply(self, method, url, body=None, **kw):
        path = urlparse(url).path.removeprefix(f"/tenants/{TENANT}")
        self.calls.append({"method": method, "path": path, "body": body, "params": kw.get("params")})
        value = self.routes.get((method, path), [] if method == "GET" else {})
        status, payload = value if isinstance(value, tuple) else (200, value)
        return httpx.Response(status, json=payload, request=httpx.Request(method, url))

    async def get(self, url, **kw):
        return self._reply("GET", url, **kw)

    async def post(self, url, json=None, **kw):
        return self._reply("POST", url, json, **kw)

    async def put(self, url, json=None, **kw):
        return self._reply("PUT", url, json, **kw)

    def writes(self):
        return [c for c in self.calls if c["method"] != "GET"]


def _call(name, args, client, role="Admin"):
    ctx = Ctx(client=client, tenant_id=TENANT, exec_ctx=ExecCtx(tenant_id=TENANT, jwt_token="x" * 40, role=role))
    return asyncio.run(_HANDLERS[name](args, ctx))


# ── Claims workflow ──────────────────────────────────────────────────────────

CLAIM = {"id": "c-1", "claim_number": "CLM-2026-0001", "claimant_name": "Sara Khan", "policy_id": "p-1",
         "policy_number": "PL-2026-0001", "status": "Under Investigation"}
WS_PATH = "/policies/p-1/claims-management/c-1"


def _workspace(**over):
    ws = {
        "claim": {"id": "c-1", "claim_number": "CLM-2026-0001", "status": "Under Investigation",
                  "claimed_amount": 900000, "approved_amount": None},
        "process": {"category": "Death", "category_label": "Death", "event": {"date": "2026-09-01", "cause": "Natural / illness"}},
        "eligibility": {"status": "Eligible", "result": {}},
        "documents": {"items": [{"key": "death_cert", "label": "Death certificate", "required": True, "status": "Requested"}],
                      "progress": {"required": 1, "received": 0}},
        "investigation": {}, "assessment": {"result": {"payable": 900000}}, "decision": {"requires_manager": True, "manager_limit": 500000},
        "sla": {}, "settlement": {"payees": [], "payouts": []}, "closure": {}, "stages": [],
        "can": {"decide": True},
    }
    for k, v in over.items():
        ws[k] = {**ws[k], **v} if isinstance(v, dict) and isinstance(ws.get(k), dict) else v
    return ws


def _claim_routes(ws=None, extra=None):
    r = {("GET", "/claims"): [CLAIM], ("GET", "/claims/c-1"): CLAIM,
         ("GET", WS_PATH): ws if ws is not None else _workspace()}
    r.update(extra or {})
    return r


def test_register_only_claim_is_offered_adoption_not_an_error():
    client = FakeClient(_claim_routes(extra={("GET", WS_PATH): (409, {"detail": "no workflow record"})}))
    out = _call("get_claim_workflow", {"claim_number": "CLM-2026-0001"}, client)
    assert out["error_code"] == "not_in_workflow"
    assert any("Adopt claim CLM-2026-0001" in a["payload"] for a in out["quick_actions"])


def test_manager_limit_403_is_relayed_verbatim():
    msg = "Approving a claim above PKR 500,000 (or one already referred) needs a claims manager — use 'Refer to manager'."
    client = FakeClient(_claim_routes(extra={("POST", WS_PATH + "/decision"): (403, {"detail": msg})}))
    out = _call("decide_claim", {"claim_number": "CLM-2026-0001", "decision": "Approve"}, client, role="ClaimsAdjuster")
    assert out == {"success": False, "error": msg, "error_code": "forbidden", "retryable": False}


def test_rejection_without_reason_writes_nothing():
    client = FakeClient(_claim_routes())
    out = _call("decide_claim", {"claim_number": "CLM-2026-0001", "decision": "Reject"}, client)
    assert out["needs_user_input"] and not client.writes()


def test_missing_decision_is_a_choice():
    with pytest.raises(ChoiceNeeded):
        _call("decide_claim", {"claim_number": "CLM-2026-0001"}, FakeClient(_claim_routes()))


def test_decide_chips_offer_referral_above_manager_limit():
    out = _call("get_claim_workflow", {"claim_number": "CLM-2026-0001"}, FakeClient(_claim_routes()))
    labels = [a["label"] for a in out["quick_actions"]]
    assert labels[0] == "Refer to manager" and "Approve PKR 900,000" in labels


def test_waive_resolves_document_by_label():
    client = FakeClient(_claim_routes(extra={("POST", WS_PATH + "/documents/death_cert/waive"): _workspace()}))
    _call("update_claim_document", {"claim_number": "CLM-2026-0001", "action": "waive", "document": "death certificate",
                                    "reason": "Burial certificate accepted instead"}, client, role="ClaimsManager")
    assert [w["path"] for w in client.writes()] == [WS_PATH + "/documents/death_cert/waive"]


def test_waive_needs_no_reason_but_sending_back_does():
    client = FakeClient(_claim_routes(extra={("POST", WS_PATH + "/documents/death_cert/waive"): _workspace()}))
    out = _call("update_claim_document", {"claim_number": "CLM-2026-0001", "action": "waive", "document": "death certificate"},
                client, role="ClaimsManager")
    assert out["success"] and [w["path"] for w in client.writes()] == [WS_PATH + "/documents/death_cert/waive"]
    client = FakeClient(_claim_routes())
    out = _call("update_claim_document", {"claim_number": "CLM-2026-0001", "action": "reject", "document": "death certificate"},
                client, role="ClaimsManager")
    assert not out["success"] and "sent back" in out["error"] and not client.writes()


def test_already_disbursed_claim_is_not_paid_twice():
    ws = _workspace(settlement={"disbursed_at": "2026-10-01T10:00:00", "paid_total": 900000})
    client = FakeClient(_claim_routes(ws))
    out = _call("disburse_claim_settlement", {"claim_number": "CLM-2026-0001"}, client, role="ClaimsManager")
    assert out["success"] and "already been paid" in out["message"] and not client.writes()


def test_undelivered_closure_letter_is_not_reported_as_sent():
    closed = _workspace(claim={"status": "Closed"}, closure={"outcome": "Settled", "confirmation": {}})
    client = FakeClient(_claim_routes(closed, {("POST", WS_PATH + "/confirmation/send"): {"sent_to": "a@b.c", "delivered": False}}))
    out = _call("close_claim_file", {"claim_number": "CLM-2026-0001"}, client)
    assert "NOT sent" in out["message"]
    assert [w["path"] for w in client.writes()] == [WS_PATH + "/confirmation/send"]


POLICY = {"id": "p-1", "policy_number": "PL-2026-0001", "customer_id": "cu-1", "customer_name": "Ali Khan", "status": "Active"}
OVERVIEW = {
    "policy": {"policy_number": "PL-2026-0001", "customer_name": "Ali Khan", "customer_cnic": "3520212345671"},
    "coverage": {"periods": [], "in_force_today": True},
    "benefits": [{"category": "Death", "label": "Death", "available": True},
                 {"category": "Disability", "label": "Disability", "available": False}],
    "claims": [{"claim_number": "CLM-2026-0001", "category": "Death", "event_date": "2026-09-01", "has_workflow": True}],
    "options": {"causes": ["Natural / illness", "Accident"]},
}


def _policy_routes(extra=None):
    r = {("GET", "/policies"): [POLICY], ("GET", "/policies/p-1/claims-management"): OVERVIEW}
    r.update(_claim_routes())
    r.update(extra or {})
    return r


def test_intimation_without_category_offers_only_covered_benefits():
    with pytest.raises(ChoiceNeeded) as exc:
        _call("intimate_claim", {"policy_number": "PL-2026-0001"}, FakeClient(_policy_routes()))
    assert [a["label"] for a in exc.value.quick_actions] == ["Death"]


def test_repeated_intimation_for_same_event_registers_nothing():
    client = FakeClient(_policy_routes())
    out = _call("intimate_claim", {"policy_number": "PL-2026-0001", "category": "Death", "cause": "Natural / illness",
                                   "event_date": "2026-09-01", "claimed_amount": 900000, "claimant_name": "Sara Khan"}, client)
    assert "already open" in out["message"] and not client.writes()


def test_invalid_event_date_offers_a_date_picker_and_registers_nothing():
    client = FakeClient(_policy_routes())
    out = _call("intimate_claim", {"policy_number": "PL-2026-0001", "category": "Death", "cause": "Natural / illness",
                                   "event_date": "20206-10-17", "claimed_amount": 900000, "claimant_name": "Sara Khan"}, client)
    assert "isn't a valid date" in out["error"] and not client.writes()
    [picker] = out["quick_actions"]
    assert picker["actionType"] == "date" and "{value}" in picker["payload"] and picker["max"]


def test_hospital_claim_defaults_claimant_to_policyholder():
    client = FakeClient(_policy_routes({("POST", "/policies/p-1/claims-management"): _workspace()}))
    _call("intimate_claim", {"policy_number": "PL-2026-0001", "category": "Hospitalization",
                             "event_date": "2026-10-01", "claimed_amount": 120000, "hospital_name": "Shifa"}, client)
    body = client.writes()[0]["body"]
    assert body["claimant_name"] == "Ali Khan" and body["claimant_cnic"] == "3520212345671"
    assert body["event_details"] == {"hospital_name": "Shifa"}


# ── Commission administration ────────────────────────────────────────────────

AGREEMENTS = [
    {"id": "a-1", "code": "AGENCY-STD", "version": 1, "name": "Agency standard", "first_year_pct": "25.0000",
     "renewal_pct": "5.0000", "effective_from": "2026-01-01", "effective_to": None, "status": "APPROVED"},
    {"id": "a-2", "code": "AGENCY-STD", "version": 2, "name": "Agency standard", "first_year_pct": "30.0000",
     "renewal_pct": "5.0000", "effective_from": "2026-11-01", "effective_to": None, "status": "DRAFT"},
]
PAYEES = [{"id": "s-1", "name": "Bilal Ahmed", "code": "AG-001", "channel": "AGENT", "active": True},
          {"id": "s-2", "name": "Bilal Shah", "code": "AG-002", "channel": "AGENT", "active": True}]


def _commission_routes(extra=None):
    r = {("GET", "/commissions/agreements"): AGREEMENTS, ("GET", "/commissions/payees"): PAYEES,
         ("GET", "/policies"): [POLICY], ("GET", "/commissions/policies/p-1/assignments"): []}
    r.update(extra or {})
    return r


def test_maker_checker_403_is_relayed_verbatim():
    msg = "A different administrator must approve this agreement"
    client = FakeClient(_commission_routes({("POST", "/commissions/agreements/a-2/approve"): (403, {"detail": msg})}))
    out = _call("approve_commission_agreement", {"code": "agency-std"}, client)
    assert out["error"] == msg


def test_identical_draft_is_not_created_twice():
    client = FakeClient(_commission_routes())
    out = _call("create_commission_agreement", {"code": "AGENCY-STD", "name": "Agency standard", "first_year_pct": 30,
                                                "renewal_pct": 5, "effective_from": "2026-11-01"}, client)
    assert "already exists" in out["message"] and not client.writes()


def test_new_terms_become_the_next_version():
    client = FakeClient(_commission_routes({("POST", "/commissions/agreements"): {**AGREEMENTS[1], "id": "a-3", "version": 3}}))
    _call("create_commission_agreement", {"code": "AGENCY-STD", "name": "Agency standard", "first_year_pct": 35,
                                          "renewal_pct": 5}, client)
    assert client.writes()[0]["body"]["version"] == 3


def test_ambiguous_producer_is_a_choice():
    with pytest.raises(ChoiceNeeded):
        _call("assign_policy_producers", {"policy_number": "PL-2026-0001", "payee_name": "Bilal",
                                          "agreement_code": "AGENCY-STD"}, FakeClient(_commission_routes()))


def test_split_must_total_100_before_anything_is_written():
    client = FakeClient(_commission_routes())
    out = _call("assign_policy_producers", {"policy_number": "PL-2026-0001", "producers_json":
                '[{"payee": "AG-001", "agreement_code": "AGENCY-STD", "split_pct": 60},'
                ' {"payee": "AG-002", "agreement_code": "AGENCY-STD", "split_pct": 30}]'}, client)
    assert "90%" in out["error"] and not client.writes()


def test_assignment_sends_producers_only_rates_come_from_the_rule_engine():
    client = FakeClient(_commission_routes({("PUT", "/commissions/policies/p-1/assignments"): []}))
    _call("assign_policy_producers", {"policy_number": "PL-2026-0001", "payee_name": "AG-001"}, client)
    assert client.writes()[0]["body"] == {"producers": [{"source_id": "s-1", "split_pct": "100"}]}


def test_reconcile_for_one_policy_sends_only_its_receipts():
    exceptions = [{"policy_id": "p-1", "receipt_id": "r-1", "reason": "No producer agreement assigned to this policy"},
                  {"policy_id": "p-9", "receipt_id": "r-9", "reason": "No producer agreement assigned to this policy"}]
    client = FakeClient(_commission_routes({("GET", "/commissions/exceptions"): exceptions,
                                            ("POST", "/commissions/reconcile"): [{"status": "POSTED"}]}))
    out = _call("reconcile_commission_receipts", {"policy_number": "PL-2026-0001"}, client)
    assert client.writes()[0]["body"] == {"receipt_ids": ["r-1"]}
    assert "1 posted" in out["message"]


def test_earning_explanation_shows_the_arithmetic_and_never_says_paid():
    earning = {"basis_amount": "10000.00", "gross_amount": "1500.00", "rate_pct": "25.0000", "split_pct": "60.0000",
               "policy_year": 1, "snapshot": {"policy_number": "PL-2026-0001", "payee_name": "Bilal Ahmed",
                                              "receipt_no": "R-1", "agreement_code": "AGENCY-STD", "agreement_version": 1}}
    client = FakeClient({("GET", "/commissions/earnings"): {"items": [earning]}})
    out = _call("explain_commission_earning", {"policy_number": "pl-2026-0001"}, client, role="Agent")
    assert "PKR 10,000.00 × 25% × 60% split = **PKR 1,500.00**" in out["message"]
    assert "paid" not in out["message"].replace("no tax or payment", "").lower()


# ── Role gates ───────────────────────────────────────────────────────────────

def test_settlement_authority_matches_backend_separation_of_duties():
    assert is_role_allowed("disburse_claim_settlement", "Finance")
    assert not is_role_allowed("disburse_claim_settlement", "ClaimsManager")
    for tool in ("authorize_claim_disbursement", "override_claim_eligibility"):
        assert not is_role_allowed(tool, "ClaimsAdjuster") and is_role_allowed(tool, "ClaimsManager")
    for tool in ("intimate_claim", "assess_claim_benefit", "decide_claim", "verify_claim_payees"):
        assert is_role_allowed(tool, "ClaimsAdjuster")
    assert not is_role_allowed("decide_claim", "Underwriter") and is_role_allowed("get_claim_workflow", "Underwriter")


def test_commission_administration_is_admin_only_but_agents_see_their_own_earnings():
    for role in ("Agent", "Underwriter", "Viewer", "ClaimsManager"):
        for tool in ("get_customer_commission_setup", "list_commission_agreements", "list_commission_exceptions", "assign_policy_producers"):
            assert not is_role_allowed(tool, role), f"{role} may run {tool}"
    for platform in ("web", "mobile"):
        assert is_role_allowed("explain_commission_earning", "Agent", platform)
        assert is_role_allowed("get_agent_statement", "Agent", platform)


def test_quick_lead_commission_setup_uses_customer_uuid_without_cnic_or_writes():
    customer = {'id': 'quick-uuid', 'name': 'QA Quick Lead', 'cnic': None}
    setup = {'customer': {**customer, 'assigned_agent_name': 'Bilal Ahmed', 'acquisition_source_name': 'Bilal Ahmed'},
             'policies': [], 'has_more': False, 'approved_agreement_count': 0}
    client = FakeClient({('GET', '/customers'): [customer], ('GET', '/commissions/setup'): setup})
    out = _call('get_customer_commission_setup', {'customer_id': 'quick-uuid'}, client)
    assert 'Assigned agent: Bilal Ahmed' in out['message']
    assert 'No individual policy' in out['message']
    assert client.calls[-1]['params'] == {'customer_id': 'quick-uuid'}
    assert not client.writes()


def test_commission_setup_does_not_choose_first_same_name_customer():
    client = FakeClient({('GET', '/customers'): [{'id': 'a', 'name': 'Ali'}, {'id': 'b', 'name': 'Ali'}]})
    with pytest.raises(ChoiceNeeded):
        _call('get_customer_commission_setup', {'customer_name': 'Ali'}, client)
    assert len(client.calls) == 1 and not client.writes()


# ── Register FNOL offers only what the policy covers ─────────────────────────

DEATH_ONLY = {"benefits": [
    {"category": "Death", "label": "Death Claim", "available": True},
    {"category": "AccidentalDeath", "label": "Accidental Death Claim", "available": False},
    {"category": "Disability", "label": "Disability Claim", "available": False},
    {"category": "Hospitalization", "label": "Hospitalization / Reimbursement", "available": False,
     "detail": "This product has no hospitalization / reimbursement benefit and no rider covering it."},
]}
LIFE_POLICY = {"id": "p-1", "policy_number": "PL-2026-0001", "customer_name": "Hassan Baig", "status": "Active",
               "product_name": "Life Protection Plus", "coverage_amount": 29800000}


def _fnol_routes(overview=DEATH_ONLY):
    return {("GET", "/policies"): [LIFE_POLICY], ("GET", "/policies/p-1/claims-management"): overview}


def test_death_only_policy_is_not_offered_hospital_claim_types():
    out = _call("register_claim", {"policy_number": "PL-2026-0001"}, FakeClient(_fnol_routes()), role="ClaimsAdjuster")
    # The one covered type is picked, so the next question is the cause of death — never Hospitalization/Surgery.
    assert "cause of death" in out["error"]
    assert [a["label"] for a in out["quick_actions"]] == ["Natural / illness", "Accident", "Suicide", "Other unnatural"]
    assert all("Death Claim" in a["payload"] for a in out["quick_actions"])


def test_uncovered_claim_type_is_refused_with_the_reason():
    client = FakeClient(_fnol_routes())
    out = _call("register_claim", {"policy_number": "PL-2026-0001", "claim_type": "Surgery", "submitted_amount": 50000},
                client, role="ClaimsAdjuster")
    assert "Surgery is not covered" in out["error"] and "no hospitalization" in out["error"]
    assert [a["label"] for a in out["quick_actions"]] == ["Death Claim"] and not client.writes()


def test_unreadable_benefit_menu_does_not_block_fnol():
    out = _call("register_claim", {"policy_number": "PL-2026-0001"},
                FakeClient(_fnol_routes((500, {"detail": "down"}))), role="ClaimsAdjuster")
    assert [a["label"] for a in out["quick_actions"]] == ["Hospitalization", "Surgery", "Death Claim", "Reimbursement"]


# ── Life Protection Plus: early death claim and early surrender ──────────────

LPP_RULES = {"max_sum_assured": 2500000.0, "pre_existing_excluded": True, "suicide_excluded_any_time": True, "intimation_days": 30}


def test_fnol_on_term_plan_warns_about_plan_maximum_and_pre_existing_exclusion():
    policy = {**LIFE_POLICY, "effective_date": "2026-10-13"}
    overview = {**DEATH_ONLY, "rules": {"product": LPP_RULES}}
    client = FakeClient({("GET", "/policies"): [policy], ("GET", "/policies/p-1/claims-management"): overview,
                         ("POST", "/claims"): {"id": "c-4", "claim_number": "CLM-2026-0004", "status": "New",
                                               "is_contestable": True, "ai_recommendation": "REFER_TO_ADJUSTER"},
                         ("POST", "/policies/p-1/claims-management/c-4/adopt"): _workspace(
                             claim={"id": "c-4", "claim_number": "CLM-2026-0004", "status": "Pending Documents"},
                             eligibility={"status": "Referred"}, can={"decide": False})})
    out = _call("register_claim", {"policy_number": "PL-2026-0001", "submitted_amount": 29800000,
                                    "incident_date": "2026-10-14", "cause": "Natural / illness"}, client, role="ClaimsAdjuster")
    adopt = next(w for w in client.writes() if w["path"].endswith("/adopt"))
    assert adopt["body"] == {"category": "Death", "covered_person_relationship": "Self", "cause": "Natural / illness"}
    assert "Eligibility: **Referred**" in out["message"] and out["claim_workflow"]
    assert "Above the plan's maximum" in out["message"] and "PKR 2,500,000" in out["message"]
    assert "Early death claim" in out["message"] and "pre-existing" in out["message"]
    assert "suicide at any time" in out["message"]
    # Fresh FNOL: never jump to underwriting verdicts.
    assert not any("Resolve underwriting" in a["payload"] for a in out["quick_actions"])


TERM = {"id": "p-1", "policy_number": "PL-2026-0001", "customer_id": "cu-1", "customer_name": "Hassan Baig",
        "product_name": "Life Protection Plus", "status": "Active"}
NO_VALUE = {"indicative": {"surrender": {"available": False, "reason": "A protection-only product has no cash or surrender value."}}}


def _exit_routes(free_look, extra=None):
    r = {("GET", "/policies"): [TERM], ("GET", "/policies/p-1/free-look"): free_look, ("GET", "/policies/p-1/exit"): NO_VALUE}
    r.update(extra or {})
    return r


def test_term_plan_surrender_inside_free_look_offers_the_free_look_refund_and_opens_nothing():
    client = FakeClient(_exit_routes({"is_open": True, "free_look_end_date": "2026-10-27"}))
    out = _call("submit_policy_exit_request", {"policy_number": "PL-2026-0001", "exit_type": "surrender",
                                               "customer_confirmed": True, "reason": "No longer needed"}, client)
    assert out["error_code"] == "no_surrender_value" and "medical examination" in out["error"]
    assert out["quick_actions"][0]["label"] == "Cancel under free-look" and not client.writes()


def test_term_plan_after_free_look_says_nothing_is_returned_instead_of_pointing_to_surrender():
    client = FakeClient(_exit_routes({"is_open": False, "free_look_end_date": "2026-10-27"}))
    out = _call("submit_policy_exit_request", {"policy_number": "PL-2026-0001", "exit_type": "free_look_cancellation",
                                               "customer_confirmed": True}, client)
    assert "a surrender is the route" not in out["error"] and "returns nothing" in out["error"]


def test_free_look_refund_passes_the_medical_exam_deduction_and_reports_it():
    client = FakeClient(_exit_routes({"is_open": True, "free_look_end_date": "2026-10-27", "refund_amount": 18000},
                                     {("POST", "/policies/p-1/free-look/cancel"):
                                      {"refund_amount": 15500, "premium_paid": 18000, "medical_exam_deduction": 2500}}))
    out = _call("submit_policy_exit_request", {"policy_number": "PL-2026-0001", "exit_type": "free_look_cancellation",
                                               "customer_confirmed": True, "medical_exam_deduction": 2500,
                                               "medical_exam_note": "Lab invoice 4471"}, client)
    assert client.writes()[0]["body"] == {"reason": None, "medical_exam_deduction": 2500.0, "medical_exam_note": "Lab invoice 4471"}
    assert "PKR 15,500" in out["message"] and "less PKR 2,500 medical examination" in out["message"]
    assert "has not been paid yet" in out["message"]


def test_register_only_death_claim_asks_only_the_cause_to_adopt():
    death = {**CLAIM, "claim_type": "Death Claim"}
    client = FakeClient(_claim_routes(extra={("GET", "/claims"): [death], ("GET", "/claims/c-1"): death,
                                             ("GET", WS_PATH): (409, {"detail": "no workflow record"})}))
    out = _call("get_claim_workflow", {"claim_number": "CLM-2026-0001"}, client)
    assert [a["label"] for a in out["quick_actions"]] == ["Natural / illness", "Accident", "Suicide", "Other unnatural"]
    assert all("as Death, cause:" in a["payload"] for a in out["quick_actions"])


def test_adopt_infers_the_benefit_from_the_register_type():
    death = {**CLAIM, "claim_type": "Death Claim"}
    client = FakeClient(_claim_routes(extra={("GET", "/claims"): [death], ("GET", "/claims/c-1"): death,
                                             ("GET", WS_PATH): (409, {"detail": "no workflow record"}),
                                             ("POST", WS_PATH + "/adopt"): _workspace()}))
    _call("adopt_claim_into_workflow", {"claim_number": "CLM-2026-0001", "cause": "Accident"}, client)
    assert client.writes()[0]["body"]["category"] == "Death"


def test_outstanding_documents_become_upload_buttons_bound_to_the_checklist_item():
    import json as _json
    ws = _workspace(can={"edit_documents": True})
    out = _call("get_claim_workflow", {"claim_number": "CLM-2026-0001"}, FakeClient(_claim_routes(ws)))
    upload = out["quick_actions"][0]
    assert upload["actionType"] == "upload" and upload["label"] == "Upload Death certificate"
    assert _json.loads(upload["payload"]) == {"document_type": "Death certificate", "checklist_key": "death_cert",
                                              "claim_id": "c-1", "claim_number": "CLM-2026-0001", "policy_id": "p-1"}


def test_a_claim_with_a_checklist_offers_document_management():
    import json as _json
    out = _call("get_claim_workflow", {"claim_number": "CLM-2026-0001"}, FakeClient(_claim_routes(_workspace(can={"edit_documents": True}))))
    manage = next(a for a in out["quick_actions"] if a["actionType"] == "claim_documents")
    assert _json.loads(manage["payload"]) == {"claim_id": "c-1", "claim_number": "CLM-2026-0001", "policy_id": "p-1"}


def test_missing_documents_come_from_the_workflow_checklist_not_the_register_list():
    ws = _workspace(claim={"status": "Under Investigation"},
                    documents={"items": [
                        {"key": "death_cert", "label": "Death certificate", "required": True, "status": "Received"},
                        {"key": "claim_form", "label": "Death Claim Form", "required": True, "status": "Waived", "note": "Branch form lost"}],
                        "progress": {"required": 2, "received": 2}},
                    stages=[{"n": 4, "key": "assessment", "title": "Investigation & assessment", "state": "action",
                             "label": "Investigation required", "detail": ""}])
    death = {**CLAIM, "claim_type": "Death Claim", "artifacts": []}
    out = _call("get_claim_document_checklist", {"claim_number": "CLM-2026-0001"},
                FakeClient(_claim_routes(ws, {("GET", "/claims"): [death], ("GET", "/claims/c-1"): death})))
    assert out["missing"] == [] and "document file is complete" in out["message"]
    assert "Hospital" not in out["message"] and "waived: Branch form lost" in out["message"]
    assert "Next: **Investigation & assessment — Investigation required**" in out["message"]


def test_contestable_claim_offers_underwriting_referral_not_approval():
    from claim_workflow_tools import _actions, _summary
    ws = _workspace()
    ws["can"] = {**ws.get("can", {}), "decide": True, "approve": False, "refer_underwriting": True}
    ws["underwriting"] = {"required": True, "state": "not_referred", "case_number": None,
                          "message": "This claim is within the contestability period — refer it to Underwriting before deciding."}
    labels = [a["label"] for a in _actions(ws, "pol-1")]
    assert "Refer to Underwriting" in labels and not any(l.startswith("Approve") for l in labels)
    assert "contestability period" in _summary(ws)


def test_workflow_claim_referred_to_underwriting_reports_the_workflow_stage():
    ws = _workspace()
    ws["claim"]["status"] = "Re-Underwriting Required"
    ws["can"] = {**ws.get("can", {}), "decide": False, "approve": False, "refer_underwriting": False}
    ws["underwriting"] = {"required": True, "state": "in_review", "case_number": "UW-CLM-2026-0001-AB12",
                          "message": "Underwriting is reviewing this claim — the decision waits for their outcome."}
    client = FakeClient(_claim_routes(ws, extra={("POST", "/claims/c-1/re-underwrite"): {"status": "Re-Underwriting Required"}}))
    out = _call("refer_claim_to_underwriting", {"claim_number": "CLM-2026-0001", "referral_reason": "Contestable period"},
                client, role="ClaimsManager")
    assert out["success"] and "UW-CLM-2026-0001-AB12" in out["message"] and "decision waits" in out["message"]
    assert not any(a["label"].startswith("Approve") for a in out["quick_actions"])


def test_claim_summary_names_the_plan_terms():
    from claim_workflow_tools import _summary
    ws = _workspace()
    ws["plan_terms"] = {"plan": "Life Protection Plus", "from_plan": True, "exclusions": ["Suicide.", "Pre-existing medical conditions."],
                        "waiting_periods": [], "notification": None}
    text = _summary(ws)
    assert "Plan **Life Protection Plus** — documents per the plan's claim terms" in text and "Suicide" in text
    ws["plan_terms"] = {"plan": "Old Plan", "from_plan": False, "exclusions": [], "waiting_periods": []}
    assert "standard checklist" in _summary(ws)


@pytest.mark.parametrize("tool,path,args", [
    ("register_claim", "/claims", {"claim_type": "Death Claim", "submitted_amount": 200000,
                                  "incident_date": "2026-10-18", "cause": "Natural / illness"}),
    ("intimate_claim", "/policies/p-1/claims-management", {"category": "Death", "claimed_amount": 200000,
          "event_date": "2026-10-18", "cause": "Natural / illness", "claimant_name": "Ali Ahmad"}),
])
def test_duplicate_registration_conflict_never_adopts_or_opens_another_claim(tool, path, args):
    detail = "Claim CLM-2026-0001 already records this insured event. No new claim was registered."
    routes = _policy_routes() if tool == "intimate_claim" else _fnol_routes()
    client = FakeClient({**routes, ("POST", path): (409, {"detail": detail})})
    with pytest.raises(httpx.HTTPStatusError) as error:
        _call(tool, {"policy_number": "PL-2026-0001", **args}, client, role="ClaimsManager")
    assert error.value.response.status_code == 409
    assert error.value.response.json()["detail"] == detail
    assert len(client.writes()) == 1 and client.writes()[0]["path"] == path
