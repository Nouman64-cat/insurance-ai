"""Unit tests for the Stage B renewal engine (services/renewal_engine.py).

Pure logic only — no database. Run with:
    docker compose exec tenant-service python test_renewal_engine.py
"""

from datetime import date, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

from services import insurer_config
from services import renewal_engine as eng
from shared.models.core import PolicyRenewal

TODAY = date(2026, 10, 13)
EFFECTIVE = date(2026, 10, 12)
RULES = insurer_config.renewal_rules("Some Product")
CONTRACT_RULES = {**RULES, "contract_renewable": True}


def _row(due, amount=180_000.0, paid=0.0, status="Pending", freq="Annual", no=1):
    return SimpleNamespace(id=uuid4(), due_date=due, amount_due=amount, amount_paid=paid, status=status,
                           billing_frequency=freq, installment_no=no, payment_reference="JC-1" if status == "Paid" else None,
                           reminder_count=0, paid_at=None)


# ── dates ─────────────────────────────────────────────────────────────────────

def test_add_months_clamps_day():
    assert eng.add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert eng.add_months(date(2028, 1, 31), 1) == date(2028, 2, 29)
    assert eng.add_months(date(2026, 11, 15), 3) == date(2027, 2, 15)
    assert eng.add_years(date(2024, 2, 29), 1) == date(2025, 2, 28)


# ── cycle planning ────────────────────────────────────────────────────────────

def test_annual_policy_next_cycle_is_one_year_on():
    c = eng.plan_premium_cycle(rows=[_row(EFFECTIVE, status="Paid", paid=180_000)], effective_date=EFFECTIVE,
                               maturity_date=date(2046, 10, 12), annual_premium=180_000.0, today=TODAY)
    assert c["due_date"] == date(2027, 10, 12) and c["amount"] == 180_000.0
    assert c["in_ledger"] is False and c["installment_no"] == 2 and c["frequency"] == "Annual"


def test_unpaid_ledger_row_is_the_cycle():
    pending = _row(date(2026, 12, 1), amount=45_000.0, no=3)
    paid = _row(EFFECTIVE, status="Paid", paid=45_000.0, freq="Quarterly", no=1)
    c = eng.plan_premium_cycle(rows=[paid, pending], effective_date=EFFECTIVE, maturity_date=None,
                               annual_premium=180_000.0, today=TODAY)
    assert c["in_ledger"] is True and c["schedule_id"] == pending.id and c["due_date"] == pending.due_date


def test_partly_paid_row_shows_outstanding_only():
    r = _row(date(2026, 12, 1), amount=45_000.0, paid=15_000.0, status="Pending", freq="Quarterly")
    c = eng.plan_premium_cycle(rows=[r], effective_date=EFFECTIVE, maturity_date=None, annual_premium=180_000.0, today=TODAY)
    assert c["amount"] == 30_000.0


def test_quarterly_grid_does_not_duplicate_the_seeded_year():
    # Issuance seeds 365//4 = 91-day spacing, so the last seeded row is ~day 273.
    rows = [_row(EFFECTIVE + timedelta(days=91 * i), amount=45_000.0, status="Paid", paid=45_000.0,
                 freq="Quarterly", no=i + 1) for i in range(4)]
    c = eng.plan_premium_cycle(rows=rows, effective_date=EFFECTIVE, maturity_date=date(2046, 10, 12),
                               annual_premium=180_000.0, today=TODAY)
    assert c["due_date"] == date(2027, 10, 12)          # anniversary, not a day or two after day 273
    assert c["amount"] == 45_000.0 and c["installment_no"] == 5


def test_monthly_next_is_next_month():
    rows = [_row(add := eng.add_months(EFFECTIVE, i), amount=15_000.0, status="Paid", paid=15_000.0,
                 freq="Monthly", no=i + 1) for i in range(12)]
    c = eng.plan_premium_cycle(rows=rows, effective_date=EFFECTIVE, maturity_date=None, annual_premium=180_000.0, today=TODAY)
    assert c["due_date"] == date(2027, 10, 12) and c["amount"] == 15_000.0


def test_term_complete_when_next_due_reaches_maturity():
    c = eng.plan_premium_cycle(rows=[_row(date(2030, 10, 12), status="Paid", paid=180_000)], effective_date=EFFECTIVE,
                               maturity_date=date(2031, 10, 12), annual_premium=180_000.0, today=TODAY)
    assert c == {"term_complete": True}


def test_no_ledger_no_plan():
    assert eng.plan_premium_cycle(rows=[], effective_date=EFFECTIVE, maturity_date=None, annual_premium=1, today=TODAY) is None


# ── premium vs contract renewal ───────────────────────────────────────────────

def test_ordinary_product_is_always_premium_renewal():
    assert eng.classify_cycle(RULES, date(2027, 10, 12), date(2027, 10, 12)) == eng.PREMIUM


def test_contract_product_renews_only_at_period_boundary():
    end = eng.current_period_end(EFFECTIVE, CONTRACT_RULES, [])
    assert end == date(2027, 10, 12)
    assert eng.classify_cycle(CONTRACT_RULES, date(2027, 4, 12), end) == eng.PREMIUM     # mid-period instalment
    assert eng.classify_cycle(CONTRACT_RULES, date(2027, 10, 12), end) == eng.CONTRACT   # boundary
    assert eng.current_period_end(EFFECTIVE, CONTRACT_RULES, [date(2027, 10, 12), date(2028, 10, 12)]) == date(2028, 10, 12)


def test_default_rules_follow_adamjee_one_month_notice():
    assert RULES["notice_days"] == 30 and RULES["contract_renewable"] is False


def test_timing_window():
    due = date(2027, 10, 12)
    assert eng.timing(due, TODAY, 30)["state"] == "Upcoming"
    assert eng.timing(due, date(2027, 9, 12), 30)["state"] == "InWindow"
    assert eng.timing(due, due, 30)["state"] == "Due"
    assert eng.timing(due, due + timedelta(days=3), 30)["state"] == "Overdue"
    assert eng.timing(due, TODAY, 30)["window_opens_on"] == date(2027, 9, 12)


# ── eligibility ───────────────────────────────────────────────────────────────

def _elig(**kw):
    base = dict(status="Active", renewal_type=eng.PREMIUM, due_date=date(2027, 10, 12), today=TODAY,
                maturity_date=date(2046, 10, 12), is_group_certificate=False, term_complete=False, age_at_due=40,
                rules=RULES, coverage_amount=28_000_000.0)
    base.update(kw)
    return eng.evaluate_eligibility_facts(**base)


def test_active_policy_is_eligible():
    r = _elig()
    assert r["outcome"] == "eligible" and r["eligible"]


def test_grace_period_policy_is_eligible():
    assert _elig(status="GracePeriod")["outcome"] == "eligible"


def test_lapsed_goes_to_reinstatement():
    assert _elig(status="Lapsed")["outcome"] == "use_reinstatement"


def test_group_certificate_points_to_master_policy():
    assert _elig(is_group_certificate=True)["outcome"] == "group_scheme"


def test_cancelled_and_other_statuses_blocked():
    assert _elig(status="Cancelled")["outcome"] == "blocked"
    assert _elig(status="Quoted")["outcome"] == "blocked"


def test_term_complete():
    assert _elig(term_complete=True)["outcome"] == "term_complete"


def test_contract_renewal_age_limit():
    ok = _elig(renewal_type=eng.CONTRACT, rules=CONTRACT_RULES, age_at_due=60)
    too_old = _elig(renewal_type=eng.CONTRACT, rules=CONTRACT_RULES, age_at_due=70)
    unknown = _elig(renewal_type=eng.CONTRACT, rules=CONTRACT_RULES, age_at_due=None)
    assert ok["eligible"] and too_old["outcome"] == "blocked" and unknown["outcome"] == "blocked"
    assert any(c["key"] == "age_limit" for c in too_old["blockers"])


def test_premium_renewal_ignores_age_limit():
    assert _elig(age_at_due=90)["eligible"]


def test_settled_death_claim_blocks_but_open_claim_only_reviews():
    assert _elig(fatal_claims=1)["outcome"] == "blocked"
    r = _elig(open_claims=2)
    assert r["eligible"] and len(r["reviews"]) == 1


def test_open_case_is_resumed():
    r = _elig(active_case_no="RW-2026-00001")
    assert r["outcome"] == "resume" and not r["eligible"]


# ── risk ──────────────────────────────────────────────────────────────────────

def test_premium_renewal_skips_risk_by_default():
    r = eng.evaluate_risk(renewal_type=eng.PREMIUM, rules=RULES, age_at_due=70, claims_in_period=3, open_claims=1)
    assert r["required"] is False and r["outcome"] == "NotRequired"


def test_product_can_require_reassessment_on_premium_renewals():
    rules = {**RULES, "reassessment_required": True}
    assert eng.evaluate_risk(renewal_type=eng.PREMIUM, rules=rules, age_at_due=30, claims_in_period=0, open_claims=0)["outcome"] == "Referred"


def test_clean_contract_renewal_is_stp():
    r = eng.evaluate_risk(renewal_type=eng.CONTRACT, rules=CONTRACT_RULES, age_at_due=40, claims_in_period=0, open_claims=0)
    assert r["required"] and r["outcome"] == "STP" and r["reasons"] == []


def test_claim_or_age_refers_to_underwriting():
    a = eng.evaluate_risk(renewal_type=eng.CONTRACT, rules=CONTRACT_RULES, age_at_due=40, claims_in_period=1, open_claims=0)
    b = eng.evaluate_risk(renewal_type=eng.CONTRACT, rules=CONTRACT_RULES, age_at_due=58, claims_in_period=0, open_claims=0)
    c = eng.evaluate_risk(renewal_type=eng.CONTRACT, rules=CONTRACT_RULES, age_at_due=40, claims_in_period=0, open_claims=1)
    assert a["outcome"] == b["outcome"] == c["outcome"] == "Referred"


# ── quote ─────────────────────────────────────────────────────────────────────

def test_quote_with_loading_and_instalment():
    q = eng.build_quote(current_annual=100_000, renewal_annual=110_000, loading_pct=25, frequency="Quarterly",
                        period_start=date(2027, 10, 12), period_end=date(2028, 10, 12))
    assert q["additional_annual"] == 27_500 and q["new_annual"] == 137_500
    assert q["instalment"] == 34_375 and q["change_pct"] == 37.5 and q["period_end"] == "2028-10-12"


# ── reconciliation ────────────────────────────────────────────────────────────

def _recon(**kw):
    base = dict(expected=180_000.0, schedule_status="Paid", schedule_amount_due=180_000.0, schedule_amount_paid=180_000.0,
                schedule_reference="JC-1", policy_status="Active", accrual_statuses=["POSTED"],
                receipts=[{"base_amount": 180_000.0, "surcharge_amount": 0.0, "total_amount": 180_000.0, "payment_reference": "JC-1"}])
    base.update(kw)
    return eng.reconcile_facts(**base)


def test_clean_payment_matches():
    r = _recon()
    assert r["status"] == "Matched" and r["variance"] == 0 and not r["reviews"]


def test_late_surcharge_is_explained_not_an_exception():
    r = _recon(receipts=[{"base_amount": 180_000.0, "surcharge_amount": 3_600.0, "total_amount": 183_600.0, "payment_reference": "JC-1"}])
    assert r["status"] == "Matched" and r["surcharge"] == 3_600.0 and r["received"] == 183_600.0


def test_short_payment_is_an_exception():
    r = _recon(receipts=[{"base_amount": 170_000.0, "surcharge_amount": 0.0, "total_amount": 170_000.0, "payment_reference": "JC-1"}])
    assert r["status"] == "Exception" and r["variance"] == -10_000.0
    assert any(c["key"] == "amount" and c["severity"] == "block" for c in r["checks"])


def test_duplicate_receipt_and_missing_receipt_are_exceptions():
    rc = {"base_amount": 90_000.0, "surcharge_amount": 0.0, "total_amount": 90_000.0, "payment_reference": "JC-1"}
    two = _recon(receipts=[rc, rc])
    assert two["status"] == "Matched"                                # part-receipts summing to the amount due are fine…
    assert any(c["key"] == "receipt" and c["severity"] == "review" for c in two["checks"])   # …but flagged for a look
    assert _recon(receipts=[])["status"] == "Exception"


def test_unpaid_or_lapsed_is_an_exception():
    assert _recon(schedule_status="Pending")["status"] == "Exception"
    assert _recon(policy_status="Lapsed")["status"] == "Exception"


def test_commission_problem_is_review_not_blocking():
    r = _recon(accrual_statuses=["EXCEPTION"])
    assert r["status"] == "Matched" and len(r["reviews"]) == 1


# ── stage projection ──────────────────────────────────────────────────────────

def _case(**kw):
    c = PolicyRenewal(tenant_id=uuid4(), policy_id=uuid4(), renewal_no="RW-2026-00001", renewal_type=eng.PREMIUM,
                      due_date=date(2027, 10, 12), status="Open", quoted_amount=180_000.0)
    for k, v in kw.items():
        setattr(c, k, v)
    return c


def _states(rows):
    return {r["key"]: r["state"] for r in rows}


def _labels(rows):
    return {r["key"]: r["label"] for r in rows}


def test_upcoming_tracker_matches_the_design():
    rows = eng.project_stages(None, live_eligibility={"eligible": True, "message": "ok"})
    assert [r["title"] for r in rows] == ["Eligibility verified", "Renewal notice", "Premium collection",
                                          "Payment reconciliation", "Renewal confirmation"]
    assert [r["label"] for r in rows] == ["Complete", "Pending", "Awaiting payment", "Not started", "Not started"]


def test_ineligible_upcoming_cannot_collect():
    rows = eng.project_stages(None, live_eligibility={"eligible": False, "message": "no"})
    assert _states(rows)["eligibility"] == "exception" and _states(rows)["collection"] == "not_started"


def test_contract_tracker_adds_risk_and_acceptance_rows():
    rows = eng.project_stages(None, live_eligibility={"eligible": True}, risk_applies=True, acceptance_applies=True)
    assert [r["key"] for r in rows] == ["eligibility", "notice", "risk", "acceptance", "collection", "reconciliation", "confirmation"]


def test_open_premium_case_awaits_payment():
    rows = eng.project_stages(_case(), schedule=_row(date(2027, 10, 12)))
    assert _states(rows)["collection"] == "awaiting" and _states(rows)["notice"] == "pending"
    assert "risk" not in _states(rows) and "acceptance" not in _states(rows)


def test_notice_sent_completes_notice_row():
    rows = eng.project_stages(_case(notice_sent_at=datetime(2026, 10, 13), notice_channel="Email", notice_count=1))
    assert _states(rows)["notice"] == "complete"


def test_paid_then_reconciled_then_completed():
    paid = _row(date(2027, 10, 12), status="Paid", paid=180_000.0)
    s1 = eng.project_stages(_case(), schedule=paid)
    assert _labels(s1)["collection"] == "Collected" and _states(s1)["reconciliation"] == "pending"
    s2 = eng.project_stages(_case(reconciled_at=datetime(2026, 10, 13), reconciliation_json={"status": "Matched"}), schedule=paid)
    assert _labels(s2)["reconciliation"] == "Matched" and _labels(s2)["confirmation"] == "Ready to complete"
    s3 = eng.project_stages(_case(status="Completed", reconciled_at=datetime(2026, 10, 13),
                                  reconciliation_json={"status": "Matched"}, confirmation_generated_at=datetime(2026, 10, 13)), schedule=paid)
    assert set(_states(s3).values()) == {"complete", "skipped"} and _labels(s3)["notice"] == "Not sent"   # paid before any notice went out
    s4 = eng.project_stages(_case(status="Completed", notice_sent_at=datetime(2026, 10, 13), notice_channel="Email",
                                  notice_count=1, reconciled_at=datetime(2026, 10, 13), reconciliation_json={"status": "Matched"},
                                  confirmation_generated_at=datetime(2026, 10, 13)), schedule=paid)
    assert set(_states(s4).values()) == {"complete"}


def test_exception_shows_on_reconciliation_row():
    paid = _row(date(2027, 10, 12), status="Paid", paid=1.0)
    rows = eng.project_stages(_case(reconciliation_json={"status": "Exception"}), schedule=paid)
    assert _states(rows)["reconciliation"] == "exception"


def test_contract_case_gates_collection_on_risk_and_acceptance():
    base = dict(renewal_type=eng.CONTRACT, risk_required=True, acceptance_required=True)
    referred = eng.project_stages(_case(**base, risk_outcome="Referred", status="Referred"))
    assert _states(referred)["risk"] == "action" and _states(referred)["collection"] == "not_started"
    cleared = eng.project_stages(_case(**base, risk_outcome="STP"))
    assert _labels(cleared)["risk"] == "Cleared (STP)" and _states(cleared)["acceptance"] == "awaiting"
    assert _states(cleared)["collection"] == "not_started"
    accepted = eng.project_stages(_case(**base, risk_outcome="STP", accepted_at=datetime(2026, 10, 13)),
                                  schedule=_row(date(2027, 10, 12)))
    assert _states(accepted)["collection"] == "awaiting"


def test_declined_acceptance_closes_the_case_rows():
    rows = eng.project_stages(_case(renewal_type=eng.CONTRACT, risk_required=True, acceptance_required=True,
                                    risk_outcome="STP", status="Declined"))
    assert _states(rows)["acceptance"] == "exception"


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"PASS  {name}")
        except Exception as exc:   # noqa: BLE001
            failed += 1
            print(f"FAIL  {name}: {exc!r}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
