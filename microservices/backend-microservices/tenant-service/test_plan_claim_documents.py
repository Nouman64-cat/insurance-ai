"""A claim's document checklist comes from its plan's claims terms (insurance_plans.claims_terms).

Run: docker compose exec -T tenant-service python -m pytest -q test_plan_claim_documents.py
"""
from services import claim_engine as eng

TERMS = {"documents": {
    "death": {"required": ["Completed claim/claimant and physician statements", "Original policy documents",
                           "Attested CNIC copies for insured and nominee(s)", "Death certificate from the competent local authority"],
              "conditional": [{"document": "Hospital death certificate and medical records",
                               "condition": "Where applicable to the death and treatment history."},
                              {"document": "Attested police/FIR and post-mortem reports; rescue report and newspaper account",
                               "condition": "Accidental death; the claims department determines the relevant supporting evidence."}]},
    "disability": {"required": ["Disability claim form"],
                   "conditional": [{"document": "Police report", "condition": "Disability caused by an accident."}]},
}}


def _labels(**kw):
    args = dict(category="Death", segment="Individual", cause="Natural / illness", claimant_is_nominee=True, contestable=False)
    args.update(kw)
    return [d["label"] for d in eng.build_checklist(**args)]


def test_death_checklist_is_the_plans_own_list():
    natural = _labels(claims_terms=TERMS)
    assert natural[:4] == TERMS["documents"]["death"]["required"]
    assert "Hospital death certificate and medical records" in natural                     # illness → treatment records
    assert not any("FIR" in l for l in natural)
    assert "Payee bank account details / cancelled cheque" in natural                      # insurer's operational item kept
    assert "Death certificate (NADRA / union council)" not in natural                      # generic list not used
    accident = _labels(claims_terms=TERMS, cause="Accident")
    assert any("FIR" in l for l in accident) and "Hospital death certificate and medical records" not in accident


def test_operational_items_follow_the_claim():
    assert "Legal heir / succession certificate" in _labels(claims_terms=TERMS, claimant_is_nominee=False)
    assert "Prior treatment records (contestability review)" in _labels(claims_terms=TERMS, contestable=True)


def test_accidental_death_and_disability_use_the_plans_event():
    assert _labels(claims_terms=TERMS, category="AccidentalDeath", cause="Accident")[:4] == TERMS["documents"]["death"]["required"]
    disab = _labels(claims_terms=TERMS, category="Disability", cause="Accident")
    assert disab[0] == "Disability claim form" and "Police report" in disab


def test_plan_without_terms_keeps_the_generic_list():
    assert "Death certificate (NADRA / union council)" in _labels(claims_terms=None)
    assert "Death certificate (NADRA / union council)" in _labels(claims_terms={"documents": {"disability": TERMS["documents"]["disability"]}})
    assert eng.plan_claim_documents(TERMS, "Hospitalization") is None


def test_plan_condition_shown_as_the_reason():
    items = eng.build_checklist(category="Death", segment="Individual", cause="Accident", claimant_is_nominee=True,
                                contestable=False, claims_terms=TERMS)
    fir = next(d for d in items if "FIR" in d["label"])
    assert fir["required"] and fir["reason"].startswith("Accidental death")


def _review(track, **kw):
    docs = [{"label": "Death certificate from the competent local authority", "required": True, "status": "Received"},
            {"label": "Hospital death certificate and medical records", "required": True, "status": "Requested"},
            {"label": "Attested CNIC copies for insured and nominee(s)", "required": True, "status": "Waived"},
            {"label": "Payee bank account details / cancelled cheque", "required": True, "status": "Requested"},
            {"label": "Rescue report", "required": False, "status": "Requested"}]
    terms = {"exclusions": [{"summary": "Suicide."}, {"summary": "Pre-existing medical conditions."}],
             "waiting_periods": [{"summary": "Sickness hospitalization: 15 days.", "days": 15}]}
    args = dict(track=track, claims_terms=terms, documents=docs, contestable=True, review_submitted=False)
    args.update(kw)
    return eng.claim_review_requirements(**args)


def test_claim_review_is_checked_against_the_plan_not_the_policy():
    reqs, docs = _review("MEDICAL")
    assert [r["key"] for r in reqs] == ["documents", "claim_exclusions", "claim_waiting_periods", "claim_contestability"]
    assert not any(r["key"] in ("e_application", "insurance_history") for r in reqs)          # policy underwriting items gone
    assert [d["type"] for d in docs] == ["Death certificate from the competent local authority", "Hospital death certificate and medical records"]
    assert reqs[0]["status"] == "Outstanding" and reqs[0]["detail"] == "1 of 2 received"
    assert "Suicide." in reqs[1]["detail"] and reqs[1]["status"] == "Required"


def test_financial_review_gets_the_non_medical_documents_and_checks_complete_on_submission():
    reqs, docs = _review("FINANCIAL", review_submitted=True, contestable=False)
    assert [d["type"] for d in docs] == ["Attested CNIC copies for insured and nominee(s)", "Payee bank account details / cancelled cheque"]
    assert "Rescue report" not in [d["type"] for d in docs]                                   # optional items aren't requirements
    assert {r["key"]: r["status"] for r in reqs}["claim_exclusions"] == "Completed"
    assert "claim_contestability" not in {r["key"] for r in reqs}


def test_plan_without_terms_lists_documents_only():
    reqs, _ = _review("MEDICAL", claims_terms=None, contestable=False)
    assert [r["key"] for r in reqs] == ["documents"]


def test_explicit_claim_findings_complete_each_requirement_before_submission():
    reqs, _ = _review("FINANCIAL", checks={
        "claim_exclusions": {"finding": "Clear"},
        "claim_contestability": {"finding": "Resolved"},
        "claim_waiting_periods": {"finding": "Concern"},
    })
    states = {r["key"]: r["status"] for r in reqs}
    assert states["claim_exclusions"] == states["claim_contestability"] == "Completed"
    assert states["claim_waiting_periods"] == "Required"
