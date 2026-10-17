"""Unit tests for the Stage B exit engine (services/exit_engine.py).

Pure logic only — no database. Run with:
    docker compose exec tenant-service python test_exit_engine.py
"""

from datetime import date, datetime, timedelta
from uuid import uuid4

from services import exit_engine as eng
from services import insurer_config as cfg
from shared.models.core import PolicyExit

TODAY = date(2031, 10, 12)
EFFECTIVE = date(2021, 10, 12)
RULES = cfg.exit_rules("Waseela Zindagi")


# ── value maths ───────────────────────────────────────────────────────────────

def test_completed_years():
    assert eng.completed_years(EFFECTIVE, date(2023, 10, 11)) == 1
    assert eng.completed_years(EFFECTIVE, date(2023, 10, 12)) == 2
    assert eng.completed_years(EFFECTIVE, date(2021, 1, 1)) == 0 and eng.completed_years(None, TODAY) == 0


def test_fund_value_nets_the_allocation_charge_and_grows_with_time():
    f = eng.fund_value([(date(2030, 10, 12), 100_000.0)], date(2031, 10, 12), {**RULES, "allocation_pct": 95, "assumed_growth_pct": 4})
    assert f["premiums_paid"] == 100_000.0 and f["invested"] == 95_000.0
    assert f["value"] == round(95_000 * 1.04 ** (365 / 365), 2) and f["growth"] == round(f["value"] - 95_000, 2)


def test_fund_value_ignores_future_and_empty_contributions():
    f = eng.fund_value([(date(2032, 1, 1), 50_000.0), (date(2031, 1, 1), 0.0)], date(2031, 10, 12), RULES)
    assert f["value"] == 0 and f["premiums_paid"] == 0


def test_surrender_factor_follows_the_schedule():
    assert eng.surrender_factor(1, RULES) is None                   # below the minimum
    assert eng.surrender_factor(2, RULES) == 50.0
    assert eng.surrender_factor(4, RULES) == 70.0
    assert eng.surrender_factor(6, RULES) == 80.0                   # largest key ≤ years
    assert eng.surrender_factor(25, RULES) == 100.0


def test_loan_balance_is_simple_interest_less_repayments():
    b = eng.loan_balance(100_000.0, 10.0, date(2030, 10, 12), 0.0, date(2031, 10, 12))
    assert b == {"interest": 10_000.0, "balance": 110_000.0}
    assert eng.loan_balance(100_000.0, 10.0, date(2030, 10, 12), 20_000.0, date(2031, 10, 12))["balance"] == 90_000.0
    assert eng.loan_balance(1_000.0, 10.0, date(2032, 1, 1), 0.0, date(2031, 1, 1))["interest"] == 0.0


def _contribs(n=10, amt=100_000.0):
    return [(date(2021 + i, 10, 12), amt) for i in range(n)]


def _settle(t="Maturity", **kw):
    base = dict(exit_type=t, valuation_date=TODAY, contributions=_contribs(), effective_date=EFFECTIVE, sum_assured=5_000_000.0,
                rules={**RULES, "withholding_pct": 0.0, "maturity_guarantee_pct": 0.0}, loans=[])
    base.update(kw)
    return eng.calculate_settlement(**base)


def test_maturity_pays_the_fund_value():
    s = _settle()
    expected = eng.fund_value(_contribs(), TODAY, RULES)["value"]
    assert s["gross"] == expected and s["net"] == expected and s["payable"] is True and s["lines"][0]["label"] == "Fund value at maturity"


def test_maturity_guarantee_floors_the_proceeds():
    s = _settle(rules={**RULES, "maturity_guarantee_pct": 100.0, "withholding_pct": 0.0})
    assert s["gross"] == 5_000_000.0 and any("guaranteed minimum" in ln["label"] for ln in s["lines"])


def test_surrender_applies_the_factor_for_the_completed_years():
    s = _settle("Surrender", valuation_date=date(2025, 10, 12))         # 4 completed years → 70%
    fund = eng.fund_value([c for c in _contribs() if c[0] <= date(2025, 10, 12)], date(2025, 10, 12), RULES)["value"]
    assert s["surrender_factor"] == 70.0 and s["gross"] == round(fund * 0.7, 2)
    assert s["lines"][1]["amount"] == -round(fund - s["gross"], 2)       # the charge is shown, as a negative


def test_surrender_below_the_minimum_years_is_refused():
    try:
        _settle("Surrender", valuation_date=date(2022, 6, 1))
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "completed years" in str(exc)


def test_no_benefit_for_expiry_and_corporate():
    for t in ("Expiry", "CorporateExpiry", "DeathClaimClosure"):
        s = _settle(t)
        assert s["gross"] == 0 and s["net"] == 0 and s["payable"] is False


def test_loans_arrears_and_recoverables_are_deducted():
    loans = [{"id": "l1", "reference": "LN-1", "balance": 250_000.0}]
    s = _settle(loans=loans, premium_arrears=30_000.0, recoverables=[{"label": "Overpaid commission", "amount": 5_000.0, "note": "recovered"}])
    assert s["total_deductions"] == 285_000.0 and [d["kind"] for d in s["deductions"]] == ["loan", "arrears", "recoverable"]
    assert s["net"] == round(s["gross"] - 285_000.0, 2)


def test_withholding_applies_after_deductions():
    s = _settle(loans=[{"id": "l", "reference": "", "balance": 100_000.0}], rules={**RULES, "withholding_pct": 10.0})
    assert s["tax"] == round((s["gross"] - 100_000.0) * 0.10, 2) and s["net"] == round(s["gross"] - 100_000.0 - s["tax"], 2)


def test_deductions_larger_than_the_value_leave_nothing_and_record_the_shortfall():
    s = _settle(loans=[{"id": "l", "reference": "", "balance": 10_000_000.0}])
    assert s["net"] == 0 and s["payable"] is False and s["shortfall"] == round(10_000_000.0 - s["gross"], 2)


def test_negative_recoverable_is_refused():
    try:
        _settle(recoverables=[{"label": "x", "amount": -5}])
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


# ── detection + timing ────────────────────────────────────────────────────────

def test_exit_type_detection():
    assert eng.detect_exit_type(profile="Savings", is_group=False, closed_by_claim=False) == "Maturity"
    assert eng.detect_exit_type(profile="Protection", is_group=False, closed_by_claim=False) == "Expiry"
    assert eng.detect_exit_type(profile="Group", is_group=True, closed_by_claim=False) == "CorporateExpiry"
    assert eng.detect_exit_type(profile="Savings", is_group=False, closed_by_claim=True) == "DeathClaimClosure"


def test_profiles_come_from_the_product_type():
    assert cfg.exit_profile("Waseela Zindagi", "SAVINGS") == "Savings"
    assert cfg.exit_profile("Salary Protection Plan", "TERM_LIFE") == "Protection"
    assert cfg.exit_profile("Family Health Floater", "FAMILY_FLOATER") == "Protection"
    assert cfg.exit_profile("Group Life", "GROUP_LIFE") == "Group"


def test_maturity_timing_window():
    mat = date(2031, 10, 12)
    assert eng.timing(mat, date(2031, 1, 1), 90)["state"] == "Upcoming"
    assert eng.timing(mat, date(2031, 8, 1), 90)["state"] == "InWindow"
    assert eng.timing(mat, mat, 90)["state"] == "Reached" and eng.timing(mat, mat + timedelta(days=5), 90)["days_until"] == -5
    assert eng.timing(mat, date(2031, 1, 1), 90)["window_opens_on"] == date(2031, 7, 14)


# ── eligibility ───────────────────────────────────────────────────────────────

def _elig(**kw):
    base = dict(exit_type="Maturity", status="Active", today=TODAY, maturity_date=date(2031, 10, 12), profile="Savings",
                effective_date=EFFECTIVE, free_look_end=EFFECTIVE + timedelta(days=14), open_claims=0, open_renewal_no=None,
                open_reinstatement_no=None, extension_allowed=False, rules=RULES)
    base.update(kw)
    return eng.evaluate_eligibility_facts(**base)


def _failed(r):
    return {c["key"] for c in r["checks"] if not c["passed"] and c["severity"] != "info"}


def test_clean_maturity_is_eligible():
    r = _elig()
    assert r["status"] == "Eligible" and r["maturity_reached"]


def test_a_lapsed_savings_policy_must_be_reinstated_first():
    r = _elig(status="Lapsed")
    assert r["status"] == "Ineligible" and "Reinstatement" in next(c for c in r["checks"] if c["key"] == "status")["detail"]


def test_an_open_claim_blocks_every_benefit_exit():
    for t in ("Maturity", "Expiry", "Surrender"):
        assert "claims" in _failed(_elig(exit_type=t, open_claims=1, maturity_date=date(2040, 1, 1) if t == "Surrender" else date(2031, 10, 12)))


def test_an_open_contract_renewal_means_the_extension_is_being_finalised():
    r = _elig(open_renewal_no="RW-2031-00001")
    assert r["status"] == "Ineligible" and "extension" in _failed(r)
    assert "RW-2031-00001" in next(c for c in r["checks"] if c["key"] == "extension")["detail"]


def test_expiry_before_the_end_of_term_is_informational_only():
    r = _elig(exit_type="Expiry", profile="Protection", today=date(2031, 9, 1))
    assert r["status"] == "Eligible" and not r["maturity_reached"]
    assert next(c for c in r["checks"] if c["key"] == "maturity")["severity"] == "info"


def test_a_lapsed_protection_policy_can_still_expire():
    assert _elig(exit_type="Expiry", profile="Protection", status="Lapsed")["status"] == "Eligible"
    assert _elig(exit_type="Expiry", profile="Protection", status="Cancelled")["status"] == "Ineligible"


def _surr(**kw):
    base = dict(exit_type="Surrender", today=date(2026, 10, 12), maturity_date=date(2031, 10, 12))
    base.update(kw)
    return _elig(**base)


def test_surrender_of_a_savings_policy_after_the_minimum_years():
    assert _surr()["status"] == "Eligible"


def test_surrender_is_refused_for_protection_only_products():
    r = _surr(profile="Protection")
    assert "product" in _failed(r) and "no cash or surrender value" in next(c for c in r["checks"] if c["key"] == "product")["detail"]


def test_surrender_inside_the_free_look_window_points_to_cancellation():
    r = _surr(today=EFFECTIVE + timedelta(days=5), effective_date=EFFECTIVE)
    assert "free_look" in _failed(r) and "min_years" in _failed(r)


def test_surrender_needs_the_minimum_completed_years():
    r = _surr(today=date(2022, 10, 12))
    assert "min_years" in _failed(r)


def test_a_policy_at_maturity_is_a_maturity_not_a_surrender():
    assert "not_matured" in _failed(_surr(today=date(2031, 10, 12)))


def test_corporate_certificate_closes_only_when_the_master_policy_ended_unrenewed():
    base = dict(exit_type="CorporateExpiry", profile="Group", master_expiry=date(2031, 10, 1))
    assert _elig(**base)["status"] == "Eligible"
    assert "master_expired" in _failed(_elig(**{**base, "master_expiry": date(2032, 1, 1)}))
    busy = _elig(**base, group_renewal_status="Quoted")
    assert busy["status"] == "Ineligible" and "renewal" in _failed(busy)
    assert _elig(**base, group_renewal_status="Declined")["status"] == "Eligible"


def test_death_claim_closure_needs_the_claim_resolved():
    base = dict(exit_type="DeathClaimClosure", status="Cancelled")
    assert _elig(**base)["status"] == "Eligible"
    assert "claim_resolved" in _failed(_elig(**base, claim_open_after_closure=1))
    assert "status" in _failed(_elig(exit_type="DeathClaimClosure", status="Active"))


# ── documents + consent ───────────────────────────────────────────────────────

def test_maturity_and_surrender_have_their_own_forms_and_the_others_need_none():
    assert "claim_form" in {d["key"] for d in eng.build_documents("Maturity")}
    assert "surrender_form" in {d["key"] for d in eng.build_documents("Surrender")}
    assert eng.build_documents("Expiry") == [] and eng.build_documents("CorporateExpiry") == []


def test_consent_needs_every_declaration_a_signer_and_a_method():
    keys = [d["key"] for d in eng.declarations_for("Surrender")]
    full = {"declarations": [{"key": k, "accepted": True} for k in keys], "by": "Ayesha", "method": "Signed form"}
    assert eng.consent_complete("Surrender", full)
    assert not eng.consent_complete("Surrender", {**full, "declarations": full["declarations"][:-1]})
    assert not eng.consent_complete("Surrender", {**full, "by": ""}) and not eng.consent_complete("Surrender", None)
    assert eng.consent_complete("Expiry", None)                      # nothing to consent to


def test_surrender_declarations_cover_loss_of_cover_and_charges():
    text = " ".join(d["text"] for d in eng.declarations_for("Surrender")).lower()
    assert "ends all cover" in text and "charges" in text and "tax" in text


# ── controls ──────────────────────────────────────────────────────────────────

def test_dual_control_applies_above_the_limit_except_for_superadmin():
    assert eng.needs_dual_control(2_000_000.0, RULES, "Admin") is True
    assert eng.needs_dual_control(500_000.0, RULES, "Admin") is False
    assert eng.needs_dual_control(2_000_000.0, RULES, "SuperAdmin") is False


def test_reconciliation_matches_the_authorised_payment_to_the_verified_payee():
    ok = eng.reconcile_exit(net=1_000.0, payee_name="Ayesha Mirza", payouts=[{"amount": 1_000.0, "payee_name": "Ayesha Mirza", "reference": "SUR-1", "status": "Settled"}])
    assert ok["status"] == "Matched" and ok["variance"] == 0
    short = eng.reconcile_exit(net=1_000.0, payee_name="Ayesha Mirza", payouts=[{"amount": 900.0, "payee_name": "Ayesha Mirza", "reference": "SUR-1", "status": "Settled"}])
    assert short["status"] == "Exception" and short["variance"] == -100.0
    wrong = eng.reconcile_exit(net=1_000.0, payee_name="Ayesha Mirza", payouts=[{"amount": 1_000.0, "payee_name": "Someone Else", "reference": "SUR-1", "status": "Settled"}])
    assert wrong["status"] == "Exception"
    assert eng.reconcile_exit(net=1.0, payee_name="A", payouts=[])["status"] == "Exception"


# ── stage projection ──────────────────────────────────────────────────────────

def _case(t="Maturity", **kw):
    c = PolicyExit(tenant_id=uuid4(), policy_id=uuid4(), exit_no="EX-2031-00001", exit_type=t, status="Open",
                   maturity_date=date(2031, 10, 12))
    for k, v in kw.items():
        setattr(c, k, v)
    return c


def _states(rows):
    return {r["key"]: r["state"] for r in rows}


def _labels(rows):
    return {r["key"]: r["label"] for r in rows}


NOW = datetime(2031, 10, 12, 10)


def _full_docs():
    d = eng.build_documents("Maturity")
    for x in d:
        x["status"] = "Received"
    return d


def _consent(t="Maturity"):
    return {"declarations": [{"key": d["key"], "accepted": True} for d in eng.declarations_for(t)], "by": "Ayesha", "method": "Signed form"}


def test_seven_steps_in_the_order_of_the_workflow():
    rows = eng.project_stages(_case())
    assert [r["title"] for r in rows] == ["Identify upcoming maturity", "Check renewal or extension", "Verify eligibility & financials",
                                          "Collect documents & consent", "Calculate final settlement", "Authorize & disburse", "Close policy & archive"]


def test_maturity_walks_through_every_step():
    c = _case(extension_decision="NotApplicable", eligibility_status="Eligible", eligibility_json={"message": "ok"})
    r = eng.project_stages(c)
    assert _labels(r)["extension"] == "No extension" and _states(r)["documents"] == "action" and _states(r)["settlement"] == "not_started"
    c.documents_json, c.consent_json = _full_docs(), _consent()
    r = eng.project_stages(c)
    assert _states(r)["documents"] == "complete" and _labels(r)["settlement"] == "Calculate settlement"
    c.calculated_at, c.net_payable, c.settlement_json = NOW, 900_000.0, {"payable": True}
    assert _labels(eng.project_stages(c))["settlement"] == "Awaiting acceptance"
    c.accepted_at = NOW
    r = eng.project_stages(c)
    assert _labels(r)["settlement"] == "Accepted" and _labels(r)["disbursement"] == "Verify payee"
    c.payee_verified_at = NOW
    assert _labels(eng.project_stages(c))["disbursement"] == "Authorize"
    c.authorized_at = NOW
    assert _labels(eng.project_stages(c))["disbursement"] == "Disburse"
    c.disbursed_at = NOW
    assert _labels(eng.project_stages(c))["disbursement"] == "Reconcile payment"
    c.reconciled_at = NOW
    r = eng.project_stages(c)
    assert _labels(r)["disbursement"] == "Paid & reconciled" and _labels(r)["closure"] == "Ready to close"
    c.status = "Completed"
    assert set(_states(eng.project_stages(c)).values()) == {"complete"}


def test_expiry_skips_paperwork_settlement_and_payment():
    c = _case("Expiry", extension_decision="NotApplicable", eligibility_status="Eligible")
    r = eng.project_stages(c)
    assert [_states(r)[k] for k in ("documents", "settlement", "disbursement")] == ["skipped"] * 3 and _labels(r)["closure"] == "Ready to close"


def test_corporate_expiry_skips_the_extension_row_too():
    r = eng.project_stages(_case("CorporateExpiry", eligibility_status="Eligible"))
    assert _states(r)["extension"] == "skipped" and _states(r)["settlement"] == "skipped"


def test_an_open_extension_stops_the_extension_row_and_shows_the_renewals_case():
    c = _case(extension_decision=None, extension_json={"open_renewal_no": "RW-2031-00002"})
    r = eng.project_stages(c)
    assert _states(r)["extension"] == "exception" and "RW-2031-00002" in next(x for x in r if x["key"] == "extension")["detail"]


def test_a_product_with_an_extension_option_asks_for_confirmation():
    assert _labels(eng.project_stages(_case(extension_decision=None)))["extension"] == "Confirm no extension"


def test_an_ineligible_exit_cannot_progress():
    r = eng.project_stages(_case(eligibility_status="Ineligible", eligibility_json={"message": "claim open"}, extension_decision="NotApplicable"))
    assert _states(r)["eligibility"] == "exception" and _states(r)["documents"] == "not_started" and _states(r)["closure"] == "not_started"


def test_a_declined_settlement_ends_the_case():
    c = _case(status="Declined", closed_reason="Customer rejected the amount", eligibility_status="Eligible", extension_decision="NotApplicable",
              calculated_at=NOW, net_payable=1.0, documents_json=_full_docs(), consent_json=_consent())
    r = eng.project_stages(c)
    assert _states(r)["settlement"] == "exception" and _states(r)["closure"] == "exception"


def test_a_settlement_wiped_out_by_deductions_skips_the_payment():
    c = _case(eligibility_status="Eligible", extension_decision="NotApplicable", calculated_at=NOW, accepted_at=NOW,
              settlement_json={"payable": False}, documents_json=_full_docs(), consent_json=_consent())
    r = eng.project_stages(c)
    assert _states(r)["disbursement"] == "skipped" and _labels(r)["closure"] == "Ready to close"


def test_death_claim_closure_has_only_the_closing_step():
    r = eng.project_stages(_case("DeathClaimClosure", eligibility_status="Eligible"))
    assert _states(r)["extension"] == "skipped" and _states(r)["documents"] == "skipped" and _labels(r)["closure"] == "Ready to close"


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
