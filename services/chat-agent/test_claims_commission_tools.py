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


def test_assignment_uses_the_approved_version_only():
    client = FakeClient(_commission_routes({("PUT", "/commissions/policies/p-1/assignments"): []}))
    _call("assign_policy_producers", {"policy_number": "PL-2026-0001", "payee_name": "AG-001", "agreement_code": "AGENCY-STD"}, client)
    assert client.writes()[0]["body"] == {"producers": [{"source_id": "s-1", "agreement_id": "a-1", "split_pct": "100"}]}


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

def test_money_release_stays_with_claims_managers():
    for tool in ("authorize_claim_disbursement", "disburse_claim_settlement", "override_claim_eligibility"):
        assert not is_role_allowed(tool, "ClaimsAdjuster") and is_role_allowed(tool, "ClaimsManager")
    for tool in ("intimate_claim", "assess_claim_benefit", "decide_claim", "verify_claim_payees"):
        assert is_role_allowed(tool, "ClaimsAdjuster")
    assert not is_role_allowed("decide_claim", "Underwriter") and is_role_allowed("get_claim_workflow", "Underwriter")


def test_commission_administration_is_admin_only_but_agents_see_their_own_earnings():
    for role in ("Agent", "Underwriter", "Viewer", "ClaimsManager"):
        for tool in ("list_commission_agreements", "list_commission_exceptions", "assign_policy_producers"):
            assert not is_role_allowed(tool, role), f"{role} may run {tool}"
    for platform in ("web", "mobile"):
        assert is_role_allowed("explain_commission_earning", "Agent", platform)
        assert is_role_allowed("get_agent_statement", "Agent", platform)
