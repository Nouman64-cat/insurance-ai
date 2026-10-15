"""Unit tests for the Stage B claims engine (services/claim_engine.py).

Pure logic only — no database. Run with:
    docker compose exec tenant-service python test_claim_engine.py
"""

from datetime import date, datetime, timedelta
from uuid import uuid4

from services import claim_engine as eng
from services import insurer_config as cfg
from shared.models.core import Claim, ClaimProcess, ClaimStatusEnum

TODAY = date(2027, 6, 1)
START = date(2025, 1, 10)


def _ev(day, etype, to, frm=None, **detail):
    return {"at": datetime(day.year, day.month, day.day, 10, 0), "event_type": etype, "from_status": frm,
            "to_status": to, "detail": detail}


# ── working days + SLA ────────────────────────────────────────────────────────

def test_working_days_skip_weekends_and_holidays():
    fri = date(2027, 5, 7)                                         # a Friday
    assert fri.weekday() == 4
    assert eng.add_working_days(fri, 1, set()) == date(2027, 5, 10)    # Monday
    assert eng.add_working_days(fri, 7, set()) == date(2027, 5, 18)
    assert eng.add_working_days(fri, 1, {date(2027, 5, 10)}) == date(2027, 5, 11)
    assert eng.working_days_between(fri, date(2027, 5, 14), set()) == 5
    assert eng.working_days_between(date(2027, 5, 14), fri, set()) == -5


def test_sla_clock_starts_with_complete_documents():
    assert eng.sla_state(docs_complete_at=None, decision_at=None, today=TODAY)["state"] == "not_started"
    done = datetime(2027, 5, 7, 9)
    s = eng.sla_state(docs_complete_at=done, decision_at=None, today=date(2027, 5, 10), sla_days=7)
    assert s["due_date"] == date(2027, 5, 18) and s["state"] == "on_track"
    assert eng.sla_state(docs_complete_at=done, decision_at=None, today=date(2027, 5, 18), sla_days=7)["state"] == "at_risk"
    assert eng.sla_state(docs_complete_at=done, decision_at=None, today=date(2027, 5, 19), sla_days=7)["state"] == "breached"
    assert eng.sla_state(docs_complete_at=done, decision_at=datetime(2027, 5, 12), today=TODAY, sla_days=7)["state"] == "met"
    assert eng.sla_state(docs_complete_at=done, decision_at=datetime(2027, 5, 25), today=TODAY, sla_days=7)["state"] == "breached"


# ── coverage timeline: cover on the EVENT date, not today's status ────────────

def _lapse_reinstate_events():
    return [
        _ev(date(2024, 12, 20), "proposal_status_change", "Approved", "UnderReview"),
        _ev(START, "PaymentConfirmed", "Active", "PendingPayment"),
        _ev(date(2025, 11, 20), "PolicyEnteredGrace", "GracePeriod", "Active"),
        _ev(date(2026, 2, 1), "PolicyLapsed", "Lapsed", "GracePeriod", grace_until="2025-12-25"),
        _ev(date(2026, 6, 1), "PolicyReinstated", "Active", "Lapsed"),
    ]


def test_timeline_has_two_periods_with_a_gap():
    p = eng.coverage_timeline(_lapse_reinstate_events(), effective_date=START, status_now="Active")
    assert [(x["from"], x["to"]) for x in p] == [(START, date(2025, 12, 26)), (date(2026, 6, 1), None)]
    assert p[0]["ended_by"] == "Lapsed" and p[1]["started_by"] == "PolicyReinstated"


def test_lapse_takes_effect_at_end_of_grace_not_when_the_monitor_ran():
    p = eng.coverage_timeline(_lapse_reinstate_events(), effective_date=START, status_now="Active")
    assert eng.covered_on(p, date(2025, 12, 25)) is not None       # last day of grace still covered
    assert eng.covered_on(p, date(2025, 12, 26)) is None           # first uncovered day
    assert eng.covered_on(p, date(2026, 1, 20)) is None            # the monitor only ran 1 Feb — still uncovered
    assert eng.covered_on(p, date(2026, 6, 1)) is not None         # reinstatement day covered
    assert eng.covered_on(p, date(2024, 12, 1)) is None


def test_grace_period_counts_as_cover():
    p = eng.coverage_timeline(_lapse_reinstate_events(), effective_date=START, status_now="Active")
    assert eng.covered_on(p, date(2025, 12, 1)) is not None


def test_cancelled_policy_ends_cover():
    ev = [_ev(START, "PaymentConfirmed", "Active"), _ev(date(2026, 3, 1), "PolicyCancelled", "Cancelled", "Active")]
    p = eng.coverage_timeline(ev, effective_date=START, status_now="Cancelled")
    assert eng.covered_on(p, date(2026, 2, 28)) and not eng.covered_on(p, date(2026, 3, 1))


def test_future_dated_inception_starts_on_effective_date():
    ev = [_ev(date(2025, 1, 1), "PaymentConfirmed", "Active")]
    p = eng.coverage_timeline(ev, effective_date=date(2025, 2, 1), status_now="Active")
    assert p[0]["from"] == date(2025, 2, 1)


def test_policy_without_events_falls_back_to_effective_date():
    p = eng.coverage_timeline([], effective_date=START, status_now="Active")
    assert p == [{"from": START, "to": None, "started_by": "Inception", "ended_by": None}]
    assert eng.coverage_timeline([], effective_date=START, status_now="Lapsed") == []


# ── eligibility ───────────────────────────────────────────────────────────────

RIDERS = [{"id": "r1", "name": "Accidental Death Benefit (ADB)", "sum_assured": 5_000_000.0, "status": "Active",
           "added_on": date(2025, 6, 1), "removed_on": None},
          {"id": "r2", "name": "Accidental Death & Disability (ADD)", "sum_assured": 4_000_000.0, "status": "Active",
           "added_on": date(2025, 6, 1), "removed_on": None}]


def _elig(**kw):
    periods = eng.coverage_timeline(_lapse_reinstate_events(), effective_date=START, status_now="Active")
    base = dict(category="Death", event_date=date(2025, 8, 1), reported_date=date(2025, 8, 10), today=TODAY, periods=periods,
                policy_status="Active", maturity_date=date(2045, 1, 10), insurance_type="TERM_LIFE", coverage_amount=10_000_000.0,
                riders=RIDERS, covered_relationship="Self", cause="Natural / illness")
    base.update(kw)
    return eng.evaluate_eligibility_facts(**base)


def _failed(r):
    return {c["key"] for c in r["checks"] if not c["passed"]}


def test_death_while_in_force_is_valid_even_though_policy_later_lapsed():
    r = _elig(event_date=date(2025, 12, 10), policy_status="Lapsed",
              periods=eng.coverage_timeline(_lapse_reinstate_events()[:4], effective_date=START, status_now="Lapsed"))
    assert "coverage" not in _failed(r)
    assert r["benefit"]["available"] and r["benefit"]["sum_assured"] == 10_000_000.0


def test_event_during_the_lapse_gap_is_ineligible_with_the_dates_in_the_reason():
    r = _elig(event_date=date(2026, 3, 15), reported_date=date(2026, 3, 20))
    assert r["status"] == "Ineligible" and "coverage" in _failed(r)
    detail = next(c for c in r["checks"] if c["key"] == "coverage")["detail"]
    assert "2025-12-26" in detail and "2026-05-31" in detail


def test_event_before_cover_began_is_ineligible():
    r = _elig(event_date=date(2024, 12, 31), reported_date=date(2025, 1, 5))
    assert r["status"] == "Ineligible" and "before cover began" in next(c for c in r["checks"] if c["key"] == "coverage")["detail"]


def test_event_after_maturity_is_ineligible():
    r = _elig(event_date=date(2026, 7, 1), maturity_date=date(2026, 6, 30), reported_date=date(2026, 7, 2))
    assert "term" in _failed(r)


def test_future_event_date_is_invalid():
    assert "event_date" in _failed(_elig(event_date=date(2027, 12, 1), reported_date=date(2027, 6, 1)))


def test_free_look_cancellation_means_no_cover_ever():
    assert _elig(free_look_cancelled=True)["status"] == "Ineligible"


def test_health_product_has_no_death_benefit():
    r = _elig(insurance_type="HEALTH_CASH", riders=[])
    assert r["status"] == "Ineligible" and "benefit" in _failed(r)


def test_accidental_death_needs_a_rider_attached_before_the_event():
    ok = _elig(category="AccidentalDeath", cause="Accident", event_date=date(2025, 8, 1))
    assert ok["status"] in ("Eligible", "Referred") and ok["benefit"]["source"] == "Rider" and ok["benefit"]["sum_assured"] == 5_000_000.0
    early = _elig(category="AccidentalDeath", cause="Accident", event_date=date(2025, 3, 1), reported_date=date(2025, 3, 5))
    assert "benefit" in _failed(early) and "attached on 2025-06-01" in next(c for c in early["checks"] if c["key"] == "benefit")["detail"]
    none = _elig(category="AccidentalDeath", cause="Accident", riders=[])
    assert "benefit" in _failed(none)


def test_accidental_death_requires_accident_cause():
    assert "cause" in _failed(_elig(category="AccidentalDeath", cause="Natural / illness"))


def test_exhausted_rider_does_not_respond():
    claimed = [{**RIDERS[1], "status": "Claimed"}]
    assert "benefit" in _failed(_elig(category="Disability", riders=claimed))


def test_removed_rider_does_not_respond_after_removal():
    gone = [{**RIDERS[1], "removed_on": date(2025, 7, 1)}]
    assert "benefit" in _failed(_elig(category="Disability", riders=gone, event_date=date(2025, 8, 1)))
    assert "benefit" not in _failed(_elig(category="Disability", riders=gone, event_date=date(2025, 6, 15), reported_date=date(2025, 6, 20)))


def test_individual_policy_covers_the_life_assured_only():
    assert "insured_person" in _failed(_elig(covered_relationship="Spouse"))
    assert "insured_person" not in _failed(_elig(covered_relationship="Spouse", category="Hospitalization",
                                                insurance_type="FAMILY_FLOATER", is_floater=True, riders=[]))


def test_contestable_event_is_referred_not_rejected():
    r = _elig(event_date=date(2025, 5, 1), reported_date=date(2025, 5, 5))
    assert r["status"] == "Referred" and r["contestable"] and "contestable" in _failed(r)
    late = _elig(event_date=date(2025, 12, 1), reported_date=date(2025, 12, 5))
    assert late["contestable"] is True            # still within 730 days of inception


def test_outside_contestability_is_clean():
    ev = [_ev(START, "PaymentConfirmed", "Active")]
    p = eng.coverage_timeline(ev, effective_date=START, status_now="Active")
    r = _elig(periods=p, event_date=date(2027, 5, 1), reported_date=date(2027, 5, 3))
    assert r["status"] == "Eligible" and not r["contestable"]


def test_reinstatement_restarts_the_contestability_clock():
    r = _elig(event_date=date(2026, 8, 1), reported_date=date(2026, 8, 3), last_reinstatement_date=date(2026, 6, 1))
    assert r["contestable"] is True


def test_late_report_and_duplicate_are_review_points():
    r = _elig(event_date=date(2025, 8, 1), reported_date=date(2026, 1, 1), duplicate_count=1)
    assert {"late_report", "duplicate"} <= _failed(r) and r["status"] == "Referred"


def test_suicide_inside_the_exclusion_period_is_flagged():
    r = _elig(cause="Suicide", event_date=date(2025, 8, 1))
    assert "exclusion" in _failed(r)


def test_hospital_waiting_period_for_illness_only():
    base = dict(category="Hospitalization", insurance_type="FAMILY_FLOATER", is_floater=True, riders=[],
                event_date=date(2025, 1, 25), reported_date=date(2025, 1, 30))
    assert "waiting_period" in _failed(_elig(**base, cause="Natural / illness"))
    assert "waiting_period" not in _failed(_elig(**base, cause="Accident"))


def test_arrears_at_event_are_information_not_a_failure():
    r = _elig(arrears_at_event=45_000.0)
    assert r["status"] != "Ineligible" and any(c["key"] == "arrears" and c["severity"] == "info" for c in r["checks"])


def test_contract_renewable_product_needs_a_renewed_period():
    out = _elig(contract_period={"renewable": True, "ok": False, "detail": "The contract period ended on 2025-07-01 and was not renewed."})
    assert "renewed_period" in _failed(out)


def test_prior_death_benefit_blocks():
    assert "prior_claim" in _failed(_elig(prior_death_settled=True))


# ── checklist ─────────────────────────────────────────────────────────────────

def _keys(items):
    return {d["key"] for d in items}


def test_individual_death_from_illness_checklist():
    k = _keys(eng.build_checklist(category="Death", segment="Individual", cause="Natural / illness", claimant_is_nominee=True, contestable=False))
    assert {"claim_form", "claimant_cnic", "deceased_cnic", "death_certificate", "medical_records", "bank_details", "policy_doc"} <= k
    assert not ({"police_report", "postmortem", "legal_heir", "prior_treatment", "employer_cert"} & k)


def test_accident_adds_police_documents_and_drops_medical_records():
    k = _keys(eng.build_checklist(category="Death", segment="Individual", cause="Accident", claimant_is_nominee=True, contestable=False))
    assert {"police_report", "postmortem"} <= k and "medical_records" not in k


def test_non_nominee_claimant_needs_legal_heir_certificate_and_contestable_needs_prior_records():
    k = _keys(eng.build_checklist(category="Death", segment="Individual", cause="Natural / illness", claimant_is_nominee=False, contestable=True))
    assert {"legal_heir", "prior_treatment"} <= k


def test_group_claim_uses_the_group_form_and_employer_certificate():
    items = eng.build_checklist(category="Death", segment="Corporate", cause="Natural / illness", claimant_is_nominee=True, contestable=False)
    form = next(d for d in items if d["key"] == "claim_form")
    assert "Group Life" in form["label"] and "employer_cert" in _keys(items)
    ind = next(d for d in eng.build_checklist(category="Death", segment="Individual", cause=None, claimant_is_nominee=True, contestable=False) if d["key"] == "claim_form")
    assert "Group" not in ind["label"]


def test_each_category_has_its_own_forms():
    assert any("Accidental" in d["label"] for d in eng.build_checklist(category="AccidentalDeath", segment="Individual", cause="Accident", claimant_is_nominee=True, contestable=False))
    assert "medical_certificate" in _keys(eng.build_checklist(category="Disability", segment="Individual", cause=None, claimant_is_nominee=True, contestable=False))
    h = _keys(eng.build_checklist(category="Hospitalization", segment="Family", cause=None, claimant_is_nominee=True, contestable=False))
    assert {"discharge_summary", "hospital_bills", "investigation_reports"} <= h and "policy_doc" not in h


def test_optional_documents_do_not_hold_up_the_claim():
    items = eng.build_checklist(category="Hospitalization", segment="Individual", cause=None, claimant_is_nominee=True, contestable=False)
    for d in items:
        if d["required"]:
            d["status"] = "Received"
    p = eng.documents_progress(items)
    assert p["complete"] and p["required"] < p["total"] and eng.outstanding_documents(items) == []


def test_merge_documents_never_resets_a_received_one():
    first = eng.build_checklist(category="Disability", segment="Individual", cause=None, claimant_is_nominee=True, contestable=False)
    first[0]["status"] = "Received"
    again = eng.merge_documents(first, eng.build_checklist(category="Disability", segment="Individual", cause="Accident", claimant_is_nominee=True, contestable=False))
    assert again[0]["status"] == "Received" and "accident_report" in _keys(again)


# ── benefit assessment ────────────────────────────────────────────────────────

def _benefit(sa=10_000_000.0, source="Base cover"):
    return {"available": True, "source": source, "label": "Base cover — Death Claim", "sum_assured": sa, "rider_id": None}


def test_death_benefit_less_premium_unpaid_at_event():
    a = eng.assess_benefit(category="Death", claimed_amount=10_000_000.0, benefit=_benefit(), arrears_at_event=45_000.0)
    assert a["gross"] == 10_000_000.0 and a["payable"] == 9_955_000.0
    assert a["deductions"] == [{"label": "Premium unpaid at the event date", "amount": 45_000.0}]


def test_payable_never_exceeds_the_amount_claimed():
    a = eng.assess_benefit(category="Death", claimed_amount=8_000_000.0, benefit=_benefit())
    assert a["payable"] == 8_000_000.0 and a["capped_by"] == "amount claimed"


def test_disability_pays_the_assessed_percentage_of_the_rider():
    a = eng.assess_benefit(category="Disability", claimed_amount=4_000_000.0, benefit=_benefit(4_000_000.0, "Rider"), disability_pct=25)
    assert a["payable"] == 1_000_000.0
    for bad in (None, 0, 101, -5):
        try:
            eng.assess_benefit(category="Disability", claimed_amount=1, benefit=_benefit(), disability_pct=bad)
            raise AssertionError("expected ValueError")
        except ValueError:
            pass


def test_hospitalization_inadmissible_lines_copay_and_remaining_limit():
    a = eng.assess_benefit(category="Hospitalization", claimed_amount=500_000.0, benefit=_benefit(1_000_000.0),
                           deductions=[{"label": "Cosmetic procedure", "amount": 100_000}], copay_pct=10)
    assert a["payable"] == 360_000.0                       # (500k − 100k) − 10% co-pay
    capped = eng.assess_benefit(category="Hospitalization", claimed_amount=500_000.0, benefit=_benefit(), copay_pct=0, remaining_limit=120_000.0)
    assert capped["payable"] == 120_000.0 and capped["capped_by"] == "remaining annual limit"


def test_negative_deduction_and_missing_benefit_are_rejected():
    for kw in ({"deductions": [{"label": "x", "amount": -1}]},):
        try:
            eng.assess_benefit(category="Death", claimed_amount=1, benefit=_benefit(), **kw)
            raise AssertionError("expected ValueError")
        except ValueError:
            pass
    try:
        eng.assess_benefit(category="Death", claimed_amount=1, benefit={"available": False})
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


# ── investigation ─────────────────────────────────────────────────────────────

def _inv(**kw):
    base = dict(category="Death", eligibility={"contestable": False, "reviews": []}, event_date=date(2027, 3, 1),
                reported_date=date(2027, 3, 5), cover_start=START, duplicate_flag=False, fraud_probability=0.02,
                nominee_mismatch=False, claimed_amount=10_000_000.0)
    base.update(kw)
    return eng.investigation_flags(**base)


def test_clean_old_claim_needs_no_investigation():
    r = _inv()
    assert not r["requires_investigation"] and [f["code"] for f in r["flags"]] == ["high_value"]


def test_early_contestable_death_requires_investigation():
    r = _inv(event_date=date(2025, 6, 1), eligibility={"contestable": True, "reviews": []})
    assert r["requires_investigation"] and {"contestable", "early_claim"} <= {f["code"] for f in r["flags"]}


def test_duplicate_or_fraud_score_requires_investigation():
    assert _inv(duplicate_flag=True)["requires_investigation"]
    assert _inv(fraud_probability=0.85)["requires_investigation"]
    assert not _inv(nominee_mismatch=True)["requires_investigation"]       # medium only


# ── payees ────────────────────────────────────────────────────────────────────

CLAIMANT = {"name": "Sana Ahmed", "cnic": "3520212345671", "relationship": "Spouse"}


def test_split_amounts_absorbs_rounding_in_the_last_payee():
    parts = eng.split_amounts(100.0, [33.33, 33.33, 33.34])
    assert round(sum(parts), 2) == 100.0 and parts[-1] == round(100.0 - parts[0] - parts[1], 2)


def test_death_benefit_is_split_between_nominees_and_minors_are_paid_via_guardian():
    ben = [{"name": "Sana Ahmed", "cnic": "3520212345671", "relationship": "Spouse", "share_pct": 60.0, "is_minor": False},
           {"name": "Adil Ahmed", "cnic": None, "relationship": "Child", "share_pct": 40.0, "is_minor": True, "guardian_name": "Sana Ahmed"}]
    p = eng.derive_payees(category="Death", approved_amount=1_000_000.0, beneficiaries=ben, nominee_name=None,
                          nominee_relationship=None, claimant=CLAIMANT, covered_person_name="Omar Ahmed")
    assert [x["amount"] for x in p] == [600_000.0, 400_000.0] and p[1]["name"] == "Sana Ahmed" and p[1]["beneficiary_name"] == "Adil Ahmed"


def test_fall_back_to_the_single_nominee_then_the_claimant():
    n = eng.derive_payees(category="Death", approved_amount=500.0, beneficiaries=[], nominee_name="Hina", nominee_relationship="Wife",
                          claimant=CLAIMANT, covered_person_name="X")
    assert len(n) == 1 and n[0]["name"] == "Hina" and n[0]["amount"] == 500.0
    c = eng.derive_payees(category="Hospitalization", approved_amount=500.0, beneficiaries=[], nominee_name="Hina",
                          nominee_relationship="Wife", claimant=CLAIMANT, covered_person_name="X")
    assert c[0]["name"] == "Sana Ahmed"                     # non-death benefits go to the claimant, not the nominee


def _payee(**kw):
    base = {"name": "Sana Ahmed", "cnic": "35202-1234567-1", "iban": "PK36SCBL0000001123456702", "bank_name": "Standard Chartered",
            "account_title": "SANA AHMED", "is_minor": False}
    base.update(kw)
    return base


def test_valid_payee_passes_all_checks():
    r = eng.payee_checks(_payee(), recorded_cnic="3520212345671")
    assert not r["blockers"] and not r["reviews"]


def test_bad_iban_cnic_or_missing_bank_block_verification():
    assert {c["key"] for c in eng.payee_checks(_payee(iban="PK12345"))["blockers"]} == {"iban"}
    assert "cnic" in {c["key"] for c in eng.payee_checks(_payee(cnic="123"))["blockers"]}
    assert "bank" in {c["key"] for c in eng.payee_checks(_payee(bank_name=""))["blockers"]}
    assert "cnic_match" in {c["key"] for c in eng.payee_checks(_payee(), recorded_cnic="3520299999999")["blockers"]}


def test_account_title_mismatch_is_a_review_point():
    r = eng.payee_checks(_payee(account_title="Kamran Traders"))
    assert not r["blockers"] and [c["key"] for c in r["reviews"]] == ["account_title"]
    assert not eng.payee_checks(_payee(account_title="Ahmed, Sana"))["reviews"]      # word order does not matter


def test_minor_without_guardian_is_blocked():
    assert "guardian" in {c["key"] for c in eng.payee_checks(_payee(is_minor=True, guardian_name=None))["blockers"]}


# ── settlement reconciliation ─────────────────────────────────────────────────

def _payout(amount, ref, name="Sana Ahmed", status="Settled"):
    return {"amount": amount, "reference_number": ref, "payee_name": name, "status": status}


def test_matching_disbursement_reconciles():
    r = eng.reconcile_settlement(approved_amount=1_000.0, payees=[{"name": "Sana Ahmed", "amount": 1_000.0}],
                                 payouts=[_payout(1_000.0, "PAY-1")], claim_status="Settled", settlement_amount=1_000.0)
    assert r["status"] == "Matched" and r["variance"] == 0


def test_short_missing_or_duplicate_payments_are_exceptions():
    payees = [{"name": "Sana Ahmed", "amount": 600.0}, {"name": "Adil Ahmed", "amount": 400.0}]
    short = eng.reconcile_settlement(approved_amount=1_000.0, payees=payees, payouts=[_payout(600.0, "A"), _payout(300.0, "B", "Adil Ahmed")],
                                     claim_status="Settled", settlement_amount=900.0)
    assert short["status"] == "Exception" and short["variance"] == -100.0
    assert eng.reconcile_settlement(approved_amount=1.0, payees=[], payouts=[], claim_status="Approved", settlement_amount=None)["status"] == "Exception"
    dup = eng.reconcile_settlement(approved_amount=2_000.0, payees=[{"name": "Sana Ahmed", "amount": 2_000.0}],
                                   payouts=[_payout(1_000.0, "X"), _payout(1_000.0, "X")], claim_status="Settled", settlement_amount=2_000.0)
    assert any(c["key"] == "references" and not c["passed"] for c in dup["checks"])


def test_a_guardian_paid_twice_reconciles_each_payout_to_its_own_payee():
    payees = [{"name": "Sana Ahmed", "amount": 600.0}, {"name": "Sana Ahmed", "amount": 400.0}]      # herself + her minor child
    good = eng.reconcile_settlement(approved_amount=1_000.0, payees=payees, payouts=[_payout(600.0, "A"), _payout(400.0, "B")],
                                    claim_status="Settled", settlement_amount=1_000.0)
    assert good["status"] == "Matched"
    swapped = eng.reconcile_settlement(approved_amount=1_000.0, payees=payees, payouts=[_payout(600.0, "A"), _payout(400.0, "A")],
                                       claim_status="Settled", settlement_amount=1_000.0)
    assert swapped["status"] == "Exception"                                   # duplicate reference
    wrong = eng.reconcile_settlement(approved_amount=1_000.0, payees=payees, payouts=[_payout(500.0, "A"), _payout(500.0, "B")],
                                     claim_status="Settled", settlement_amount=1_000.0)
    assert wrong["status"] == "Exception" and any(c["key"] == "payees" and not c["passed"] for c in wrong["checks"])


def test_settlement_total_disagreement_is_review_only():
    r = eng.reconcile_settlement(approved_amount=1_000.0, payees=[{"name": "Sana Ahmed", "amount": 1_000.0}],
                                 payouts=[_payout(1_000.0, "P")], claim_status="Settled", settlement_amount=900.0)
    assert r["status"] == "Matched" and len(r["reviews"]) == 1


# ── stage projection ──────────────────────────────────────────────────────────

def _proc(**kw):
    p = ClaimProcess(tenant_id=uuid4(), policy_id=uuid4(), claim_id=uuid4(), category="Death", event_date=date(2027, 3, 1))
    for k, v in kw.items():
        setattr(p, k, v)
    return p


def _claim(status="New"):
    return Claim(tenant_id=uuid4(), policy_id=uuid4(), claim_type="Death Claim", submitted_amount=1.0, claim_number="CLM-2027-0001",
                 status=ClaimStatusEnum(status))


def _states(rows):
    return {r["key"]: r["state"] for r in rows}


def _labels(rows):
    return {r["key"]: r["label"] for r in rows}


def _docs(done=True):
    d = eng.build_checklist(category="Disability", segment="Individual", cause=None, claimant_is_nominee=True, contestable=False)
    if done:
        for x in d:
            x["status"] = "Received"
    return d


def test_fresh_claim_is_registered_and_waiting_for_eligibility():
    rows = eng.project_stages(_proc(), _claim())
    assert len(rows) == 7 and [r["title"] for r in rows][:2] == ["Claim intimation", "Eligibility verification"]
    assert _states(rows)["intimation"] == "complete" and _states(rows)["eligibility"] == "pending"


def test_ineligible_claim_can_only_be_rejected_and_skips_settlement():
    p = _proc(eligibility_status="Ineligible", eligibility_json={"message": "No cover"})
    rows = eng.project_stages(p, _claim("Triaged"))
    assert _states(rows)["eligibility"] == "exception" and _states(rows)["documents"] == "not_started"
    rej = eng.project_stages(_proc(eligibility_status="Ineligible", decision="Reject", decision_reason="No cover"), _claim("Declined"))
    assert _states(rej)["decision"] == "complete" and _labels(rej)["decision"] == "Rejected"
    assert _states(rej)["settlement"] == "skipped" and _states(rej)["closure"] == "action"


def test_documents_then_investigation_then_decision_in_order():
    p = _proc(eligibility_status="Eligible", documents_json=_docs(False))
    assert _states(eng.project_stages(p, _claim("Pending Documents")))["documents"] == "action"
    p.documents_json = _docs(True)
    rows = eng.project_stages(p, _claim("Under Investigation"))
    assert _states(rows)["documents"] == "complete" and _labels(rows)["assessment"] == "Assessment pending"
    p.investigation_json = {"requires_investigation": True}
    assert _labels(eng.project_stages(p, _claim("Under Investigation")))["assessment"] == "Investigation required"
    p.investigation_completed_at, p.assessed_at, p.assessment_json = datetime(2027, 5, 1), datetime(2027, 5, 1), {"payable": 5.0}
    rows = eng.project_stages(p, _claim("Under Investigation"))
    assert _states(rows)["assessment"] == "complete" and _labels(rows)["decision"] == "Awaiting decision"


def test_approved_claim_walks_through_settlement_steps():
    base = dict(eligibility_status="Eligible", documents_json=_docs(True), assessed_at=datetime(2027, 5, 1),
                assessment_json={"payable": 100.0}, decision="Approve", decision_amount=100.0)
    p = _proc(**base)
    assert _labels(eng.project_stages(p, _claim("Approved")))["settlement"] == "Verify payee"
    p.payees_verified_at = datetime(2027, 5, 2)
    assert _labels(eng.project_stages(p, _claim("Approved")))["settlement"] == "Authorize disbursement"
    p.authorized_at, p.authorized_amount = datetime(2027, 5, 2), 100.0
    assert _labels(eng.project_stages(p, _claim("Approved")))["settlement"] == "Disburse"
    assert _labels(eng.project_stages(p, _claim("Settled"), payout_total=100.0))["settlement"] == "Reconcile payment"
    p.reconciled_at = datetime(2027, 5, 3)
    rows = eng.project_stages(p, _claim("Settled"), payout_total=100.0)
    assert _labels(rows)["settlement"] == "Settled & reconciled" and _states(rows)["closure"] == "action"
    p.closure_outcome = "Settled"
    assert set(_states(eng.project_stages(p, _claim("Closed"), payout_total=100.0)).values()) == {"complete"}


def test_manager_referral_is_an_action_on_the_decision_row():
    p = _proc(eligibility_status="Eligible", documents_json=_docs(True), assessed_at=datetime(2027, 5, 1))
    assert _labels(eng.project_stages(p, _claim("Referred to Manager")))["decision"] == "Referred to manager"


def test_partial_approval_is_labelled():
    p = _proc(eligibility_status="Eligible", documents_json=_docs(True), assessed_at=datetime(2027, 5, 1),
              decision="PartialApprove", decision_amount=70.0)
    assert _labels(eng.project_stages(p, _claim("Partial Approval")))["decision"] == "Partially approved"


def test_override_of_an_ineligible_claim_lets_it_proceed():
    p = _proc(eligibility_status="Ineligible", eligibility_override_by="manager", eligibility_override_note="ex gratia", documents_json=_docs(False))
    rows = eng.project_stages(p, _claim("Triaged"))
    assert _labels(rows)["eligibility"] == "Overridden" and _states(rows)["documents"] == "action"



# ── product wording: Adamjee Life Protection Plus (one-year term, max PKR 2.5M) ─

LPP = cfg.claim_rules("Life Protection Plus")


def _lpp_periods():
    return [{"from": date(2026, 10, 13), "to": None, "started_by": "PaymentConfirmed", "ended_by": None}]


def _lpp(**kw):
    base = dict(periods=_lpp_periods(), event_date=date(2026, 10, 14), reported_date=date(2026, 10, 15), today=date(2026, 10, 15),
                coverage_amount=2_500_000.0, riders=[], maturity_date=date(2027, 10, 13), product_rules=LPP)
    base.update(kw)
    return _elig(**base)


def test_unknown_product_keeps_the_defaults():
    rules = cfg.claim_rules("Some Other Plan")
    assert rules["max_sum_assured"] is None and not rules["pre_existing_excluded"]
    assert rules["intimation_days"] == cfg.CLAIM_LATE_REPORT_DAYS


def test_sum_assured_above_the_plan_maximum_is_referred():
    r = _lpp(coverage_amount=29_800_000.0)
    assert "plan_limit" in _failed(r) and r["status"] == "Referred"
    assert "PKR 2,500,000" in next(c["detail"] for c in r["checks"] if c["key"] == "plan_limit")
    assert "plan_limit" not in _failed(_lpp())


def test_early_death_from_illness_needs_the_pre_existing_check():
    r = _lpp()
    assert "pre_existing" in _failed(r)
    flags = eng.investigation_flags(category="Death", eligibility=r, event_date=date(2026, 10, 14), reported_date=date(2026, 10, 15),
                                    cover_start=date(2026, 10, 13), duplicate_flag=False, fraud_probability=0.02,
                                    nominee_mismatch=False, claimed_amount=2_500_000.0)
    assert any(f["code"] == "pre_existing" and f["severity"] == "high" for f in flags["flags"])
    assert flags["requires_investigation"]
    assert "pre_existing" not in _failed(_lpp(cause="Accident"))


def test_suicide_is_excluded_for_the_whole_term_under_this_plan():
    r = _lpp(cause="Suicide", event_date=date(2027, 9, 1), reported_date=date(2027, 9, 2), today=date(2027, 9, 2))
    assert r["status"] == "Ineligible" and "exclusion" in {c["key"] for c in r["blockers"]}


def test_plan_asks_for_intimation_within_30_days():
    assert "late_report" in _failed(_lpp(event_date=date(2026, 10, 14), reported_date=date(2026, 11, 20), today=date(2026, 11, 20)))
    assert "late_report" not in _failed(_lpp(event_date=date(2026, 10, 14), reported_date=date(2026, 11, 10), today=date(2026, 11, 10)))


def test_plan_checklist_adds_its_own_documents_before_policy_and_bank():
    illness = eng.build_checklist(category="Death", segment="Individual", cause="Natural / illness",
                                  claimant_is_nominee=True, contestable=False, product_rules=LPP)
    keys = [d["key"] for d in illness]
    assert {"nominee_cnic", "medical_records", "prior_treatment"} <= set(keys)
    assert keys[-2:] == ["policy_doc", "bank_details"] and len(keys) == len(set(keys))
    accident = {d["key"] for d in eng.build_checklist(category="Death", segment="Individual", cause="Accident",
                                                      claimant_is_nominee=True, contestable=False, product_rules=LPP)}
    assert {"police_report", "postmortem", "rescue_report", "newspaper_cutting", "medical_records"} <= accident
    assert "prior_treatment" not in accident

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
