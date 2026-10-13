"""Unit tests for the Stage B reinstatement engine (services/reinstatement_engine.py).

Pure logic only — no database. Run with:
    docker compose exec tenant-service python test_reinstatement_engine.py
"""

from datetime import date, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

from services import insurer_config
from services import reinstatement_engine as eng
from shared.models.core import PolicyReinstatement

TODAY = date(2026, 10, 13)
RULES = insurer_config.reinstatement_rules("Life Save And Assure")


def _elig(**kw):
    base = dict(status="Lapsed", today=TODAY, lapse_date=TODAY - timedelta(days=40), rules=RULES)
    base.update(kw)
    return eng.evaluate_eligibility_facts(**base)


# ── eligibility ───────────────────────────────────────────────────────────────

def test_lapsed_policy_is_eligible():
    r = _elig()
    assert r["outcome"] == "eligible" and r["eligible"] and not r["blockers"]
    assert r["days_lapsed"] == 40


def test_active_needs_no_reinstatement():
    assert _elig(status="Active")["outcome"] == "not_required"


def test_grace_period_goes_to_collection():
    assert _elig(status="GracePeriod")["outcome"] == "use_collection"


def test_cancelled_is_rejected():
    r = _elig(status="Cancelled")
    assert r["outcome"] == "blocked" and not r["eligible"]


def test_other_statuses_are_blocked():
    assert _elig(status="Quoted")["outcome"] == "blocked"


def test_window_expired_blocks():
    r = _elig(lapse_date=TODAY - timedelta(days=RULES["window_days"] + 1))
    assert r["outcome"] == "blocked"
    assert any(c["key"] == "window" for c in r["blockers"])


def test_window_is_configurable_per_product():
    short = {**RULES, "window_days": 30}
    assert _elig(rules=short)["outcome"] == "blocked"      # 40 days lapsed > 30
    assert _elig(rules={**RULES, "window_days": 60})["outcome"] == "eligible"


def test_matured_policy_blocks():
    r = _elig(maturity_date=TODAY - timedelta(days=1))
    assert r["outcome"] == "blocked" and any(c["key"] == "contract_term" for c in r["blockers"])


def test_open_claim_blocks():
    r = _elig(open_claims=1)
    assert r["outcome"] == "blocked" and any(c["key"] == "claims" for c in r["blockers"])


def test_surrender_blocks():
    assert _elig(surrender_events=1)["outcome"] == "blocked"


def test_open_case_is_resumed_not_duplicated():
    r = _elig(active_case_no="RN-2026-00001")
    assert r["outcome"] == "resume" and not r["eligible"]


def test_hard_blocker_wins_over_resume():
    assert _elig(active_case_no="RN-1", open_claims=1)["outcome"] == "blocked"


def test_product_override_merges_over_default():
    insurer_config.REINSTATEMENT_PRODUCT_RULES["demo product"] = {"window_days": 10}
    try:
        assert insurer_config.reinstatement_rules("Demo Product")["window_days"] == 10
        assert insurer_config.reinstatement_rules("Demo Product")["medical_evidence_days"] == RULES["medical_evidence_days"]
    finally:
        insurer_config.REINSTATEMENT_PRODUCT_RULES.pop("demo product")


# ── arrears ───────────────────────────────────────────────────────────────────

def _sched(due_offset, due=25_000.0, paid=0.0, status="Pending", no=1):
    return SimpleNamespace(
        id=uuid4(), due_date=TODAY + timedelta(days=due_offset), amount_due=due, amount_paid=paid,
        status=status, installment_no=no,
    )


def test_arrears_picks_unpaid_past_due_only():
    rows = [_sched(-120, status="Paid", paid=25_000, no=1), _sched(-45, no=2), _sched(-15, no=3), _sched(30, no=4)]
    a = eng.compute_arrears_lines(rows, TODAY, RULES)
    assert [l["installment_no"] for l in a["lines"]] == [2, 3]
    assert a["premiums"] == 50_000.0


def test_arrears_adds_late_surcharge_and_fee():
    rows = [_sched(-45, no=2)]
    a = eng.compute_arrears_lines(rows, TODAY, {**RULES, "fee_amount": 500.0, "interest_pct_annual": 0.0})
    line = a["lines"][0]
    assert line["surcharge"] == 500.0            # 2% of 25,000, installment is past grace
    assert a["fee"] == 500.0 and a["total"] == 25_000 + 500 + 500


def test_arrears_simple_interest():
    rows = [_sched(-73, no=2)]                   # exactly 73/365 = 0.2 year
    a = eng.compute_arrears_lines(rows, TODAY, {**RULES, "interest_pct_annual": 10.0, "fee_amount": 0.0})
    assert a["lines"][0]["interest"] == round(25_000 * 0.10 * 0.2, 2)


def test_arrears_partially_paid_installment():
    rows = [_sched(-45, paid=10_000.0, no=2)]
    a = eng.compute_arrears_lines(rows, TODAY, {**RULES, "fee_amount": 0.0})
    assert a["lines"][0]["premium"] == 15_000.0


def test_arrears_nothing_owed():
    a = eng.compute_arrears_lines([], TODAY, {**RULES, "fee_amount": 0.0})
    assert a["lines"] == [] and a["total"] == 0.0


# ── assessment ────────────────────────────────────────────────────────────────

def _clean():
    return {"answers": {q["key"]: (not q["adverse_if"]) for q in insurer_config.REINSTATEMENT_DECLARATION_QUESTIONS},
            "details": {}}


def test_clean_short_lapse_is_straight_through():
    r = eng.assess(declaration=_clean(), lapse_days=40, age=30, sum_assured=2_000_000, rules=RULES)
    assert r["recommendation"] == "StraightThrough" and not r["evidence"]


def test_extended_lapse_needs_review():
    r = eng.assess(declaration=_clean(), lapse_days=120, age=30, sum_assured=2_000_000, rules=RULES)
    assert r["recommendation"] == "Review"


def test_long_lapse_over_nml_requires_medical():
    r = eng.assess(declaration=_clean(), lapse_days=200, age=30, sum_assured=28_000_000, rules=RULES)
    assert r["recommendation"] == "EvidenceRequired"
    assert [e["key"] for e in r["evidence"]] == ["medical_exam"] and r["evidence"][0]["required"]


def test_long_lapse_under_nml_does_not_require_medical():
    r = eng.assess(declaration=_clean(), lapse_days=200, age=30, sum_assured=1_000_000, rules=RULES)
    assert not any(e["key"] == "medical_exam" for e in r["evidence"])


def test_unknown_age_is_most_conservative():
    r = eng.assess(declaration=_clean(), lapse_days=200, age=None, sum_assured=100_000, rules=RULES)
    assert any(e["key"] == "medical_exam" for e in r["evidence"])


def test_hospitalisation_refers_and_asks_for_records():
    d = _clean()
    d["answers"]["hospitalised"] = True
    d["details"]["hospitalised"] = "appendectomy"
    r = eng.assess(declaration=d, lapse_days=20, age=30, sum_assured=1_000_000, rules=RULES)
    assert r["recommendation"] == "Refer"
    assert any(e["key"] == "medical_records" and e["required"] for e in r["evidence"])
    assert eng.adverse_answers(d) == ["hospitalised"]


def test_not_in_good_health_is_adverse():
    d = _clean()
    d["answers"]["good_health"] = False
    assert eng.adverse_answers(d) == ["good_health"]
    assert eng.assess(declaration=d, lapse_days=20, age=30, sum_assured=1, rules=RULES)["recommendation"] == "Refer"


def test_medium_answer_is_review_only():
    d = _clean()
    d["answers"]["tobacco_change"] = True
    assert eng.assess(declaration=d, lapse_days=20, age=30, sum_assured=1_000_000, rules=RULES)["recommendation"] == "Review"


def test_evidence_merge_never_resets_received():
    now = datetime(2026, 10, 13)
    first = eng.merge_evidence(None, [{"key": "medical_exam", "label": "Medical", "required": True}], now)
    first[0]["status"] = "Received"
    again = eng.merge_evidence(first, [{"key": "medical_exam", "label": "Medical", "required": True},
                                       {"key": "aps", "label": "APS", "required": False}], now)
    assert again[0]["status"] == "Received" and len(again) == 2
    assert [e["key"] for e in eng.required_evidence_outstanding(again)] == []


# ── workflow projection ───────────────────────────────────────────────────────

def _case(**kw):
    c = PolicyReinstatement(tenant_id=uuid4(), policy_id=uuid4(), case_no="RN-2026-00001",
                            lapse_date=TODAY - timedelta(days=40), total_payable=50_000.0,
                            arrears_calculated_at=datetime(2026, 10, 13))
    for k, v in kw.items():
        setattr(c, k, v)
    return c


def _states(case):
    return {s["key"]: s["state"] for s in eng.build_workflow(case)}


def test_fresh_case_waits_on_declaration():
    s = _states(_case())
    assert s["detect"] == s["request"] == s["arrears"] == "done"
    assert s["declaration"] == "current" and s["decision"] == "pending" and s["restore"] == "pending"


def test_outstanding_required_evidence_keeps_declaration_open():
    ev = eng.merge_evidence(None, [{"key": "medical_exam", "label": "Medical", "required": True}])
    s = _states(_case(declaration_signed_at=datetime(2026, 10, 13), evidence_json=ev))
    assert s["declaration"] == "current"


def test_approved_awaits_payment_then_restore():
    c = _case(declaration_signed_at=datetime(2026, 10, 13), assessed_at=datetime(2026, 10, 13),
              decision="Approve", status="Approved")
    s = _states(c)
    assert s["decision"] == "done" and s["payment"] == "current" and s["restore"] == "pending"
    c.payment_realized_at, c.payment_amount = datetime(2026, 10, 13), 50_000.0
    assert _states(c)["payment"] == "done" and _states(c)["restore"] == "current"
    assert all(eng.conditions(c).values())


def test_terms_must_be_accepted_before_payment_counts():
    c = _case(declaration_signed_at=datetime(2026, 10, 13), assessed_at=datetime(2026, 10, 13),
              decision="ApproveWithTerms", status="TermsOffered",
              payment_realized_at=datetime(2026, 10, 13), payment_amount=50_000.0)
    assert not eng.conditions(c)["terms"] and not eng.conditions(c)["decision"]
    c.status, c.terms_response = "Approved", "Accepted"
    assert all(eng.conditions(c).values())


def test_underpayment_is_not_enough():
    c = _case(declaration_signed_at=datetime(2026, 10, 13), decision="Approve", status="Approved",
              payment_realized_at=datetime(2026, 10, 13), payment_amount=49_999.0)
    assert not eng.conditions(c)["payment"]


def test_declined_case_closes_remaining_steps():
    s = _states(_case(status="Declined", decision="Decline"))
    assert s["decision"] == "done" and s["payment"] == "closed" and s["restore"] == "closed"


def test_reinstated_case_is_complete_through_restore():
    c = _case(declaration_signed_at=datetime(2026, 10, 13), assessed_at=datetime(2026, 10, 13),
              decision="Approve", status="Reinstated", payment_realized_at=datetime(2026, 10, 13),
              payment_amount=50_000.0, confirmation_generated_at=datetime(2026, 10, 13))
    assert set(_states(c).values()) == {"done"}


def test_case_view_hides_server_paths():
    ev = eng.merge_evidence(None, [{"key": "aps", "label": "APS", "required": True}])
    ev[0]["file_path"] = "/app/media/secret.pdf"
    view = eng.case_view(_case(evidence_json=ev))
    assert "file_path" not in view["evidence"][0] and view["evidence"][0]["has_file"] is True


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
