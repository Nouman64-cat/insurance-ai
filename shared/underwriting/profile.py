"""The normalized Underwriting Profile (brief §1).

build_profile() combines, into one structure:
  - Customer core fields (cnic/dob/gender/occupation/declared_income/
    is_smoker/height_cm/weight_kg — already typed columns, not a JSON blob)
  - CustomerEApplication (medical_questionnaire/family_history/
    lifestyle_habits/existing_insurance — the actual source of "rich medical/
    lifestyle data" in this codebase; Customer.details is NOT used here, it
    only ever held loose contact info in this repo)
  - AgentConfidentialReport (moral-hazard/financial underwriting opinion)
  - the requested Policy
  - document/OCR evidence already assembled by the caller
  - prior VerificationFinding-shaped dicts

This module takes and returns plain dicts/Pydantic models only — no SQLModel,
no DB session — so it can run unchanged inside risk-engine (which never
touches Postgres) and inside tenant-service (which assembles the dicts from
real rows before calling this).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from .occupation_hazard import classify_occupation_hazard


def _age_from_dob(dob_val: Any) -> Optional[int]:
    """Generic date math — not a business rule, so it is not duplicated from
    services/risk-engine/underwriting_rules.py (service-local, not importable
    from shared/); that module keeps owning the actual age *thresholds*."""
    if dob_val is None:
        return None
    try:
        if isinstance(dob_val, (date, datetime)):
            dob = dob_val.date() if isinstance(dob_val, datetime) else dob_val
        else:
            clean_str = str(dob_val).split("T")[0].strip()
            dob = datetime.strptime(clean_str, "%Y-%m-%d").date()
        return (date.today() - dob).days // 365
    except (ValueError, TypeError):
        return None


def _bmi(height_cm: Optional[float], weight_kg: Optional[float]) -> Optional[float]:
    if not height_cm or not weight_kg or height_cm <= 0:
        return None
    meters = height_cm / 100.0
    return round(weight_kg / (meters * meters), 1)


def _bmi_category(bmi: Optional[float]) -> Optional[str]:
    if bmi is None:
        return None
    if bmi < 18.5:
        return "Underweight"
    if bmi < 25:
        return "Normal"
    if bmi < 30:
        return "Overweight"
    return "Obese"


_MEDICAL_DOC_KEYWORDS = ("medical", "diagnos", "lab", "ecg", "physician", "health")
_FINANCIAL_DOC_KEYWORDS = ("salary", "income", "bank", "statement", "tax")
_IDENTITY_DOC_KEYWORDS = ("cnic", "identity", "passport", "id card")


def _classify_document(document_type: str) -> str:
    lowered = (document_type or "").lower()
    if any(kw in lowered for kw in _MEDICAL_DOC_KEYWORDS):
        return "medical"
    if any(kw in lowered for kw in _FINANCIAL_DOC_KEYWORDS):
        return "financial"
    if any(kw in lowered for kw in _IDENTITY_DOC_KEYWORDS):
        return "identity"
    return "other"


class UnderwritingProfile(BaseModel):
    """Each section is a plain dict rather than a nested strict model — the
    underlying sources (CustomerEApplication's JSON columns especially) have
    historically drifted in shape (see shared/models/core.py comments), and a
    rigid sub-schema here would just mean validation errors every time a
    caller sends one more/less key than expected. Derived/typed attributes
    that underwriting actually branches on are promoted to named keys within
    each section instead."""

    identity: Dict[str, Any] = Field(default_factory=dict)
    demographics: Dict[str, Any] = Field(default_factory=dict)
    occupation: Dict[str, Any] = Field(default_factory=dict)
    lifestyle: Dict[str, Any] = Field(default_factory=dict)
    medical_history: Dict[str, Any] = Field(default_factory=dict)
    financial: Dict[str, Any] = Field(default_factory=dict)
    beneficiary: Dict[str, Any] = Field(default_factory=dict)
    policy_request: Dict[str, Any] = Field(default_factory=dict)
    verified_facts: List[Dict[str, Any]] = Field(default_factory=list)
    document_evidence: List[Dict[str, Any]] = Field(default_factory=list)
    # Raw source snapshots, kept for auditability (brief §1's "keep raw source
    # data available") — never mutated once built.
    raw: Dict[str, Any] = Field(default_factory=dict)


def build_profile(
    customer: Dict[str, Any],
    policy: Dict[str, Any],
    *,
    e_application: Optional[Dict[str, Any]] = None,
    acr: Optional[Dict[str, Any]] = None,
    document_evidence: Optional[List[Dict[str, Any]]] = None,
    verified_facts: Optional[List[Dict[str, Any]]] = None,
) -> UnderwritingProfile:
    document_evidence = document_evidence or []
    verified_facts = verified_facts or []
    e_application = e_application or {}
    acr = acr or {}

    age = _age_from_dob(customer.get("dob"))
    height_cm = customer.get("height_cm")
    weight_kg = customer.get("weight_kg")
    bmi = _bmi(height_cm, weight_kg)

    declared_income = float(customer.get("declared_income") or 0)
    coverage_amount = float(policy.get("coverage_amount") or 0)
    coverage_to_income_ratio = (coverage_amount / declared_income) if declared_income > 0 else None

    # Pull verified income out of any financial document evidence. Declared
    # value is never overwritten — both are kept side by side (brief §2).
    verified_income = None
    employer_from_evidence = None
    identity_evidence: Dict[str, Any] = {}
    medical_findings: List[Any] = []
    has_medical_document = False
    has_financial_document = False
    has_identity_document = False

    for doc in document_evidence:
        kind = _classify_document(doc.get("document_type", ""))
        metadata = doc.get("extracted_metadata") or {}
        if kind == "medical":
            has_medical_document = True
            if metadata.get("conditions"):
                medical_findings.append(metadata)
        elif kind == "financial":
            has_financial_document = True
            if verified_income is None and metadata.get("verified_monthly_income") is not None:
                verified_income = float(metadata["verified_monthly_income"]) * 12
            if verified_income is None and metadata.get("verified_income") is not None:
                verified_income = float(metadata["verified_income"])
            employer_from_evidence = employer_from_evidence or metadata.get("employer")
        elif kind == "identity":
            has_identity_document = True
            identity_evidence = {**identity_evidence, **metadata}

    occupation = customer.get("occupation")
    hazard_level = classify_occupation_hazard(occupation)

    lifestyle_habits = e_application.get("lifestyle_habits") or {}
    is_smoker = customer.get("is_smoker")
    if is_smoker is None:
        is_smoker = lifestyle_habits.get("is_smoker")

    document_completeness = {
        "has_medical_document": has_medical_document,
        "has_financial_document": has_financial_document,
        "has_identity_document": has_identity_document,
    }

    return UnderwritingProfile(
        identity={
            "cnic": customer.get("cnic"),
            "name": customer.get("name"),
            "verification_status": "Verified" if has_identity_document else "Unverified",
            "evidence": identity_evidence,
        },
        demographics={
            "dob": customer.get("dob"),
            "age": age,
            "gender": customer.get("gender"),
            "marital_status": customer.get("marital_status"),
        },
        occupation={
            "declared": occupation,
            "hazard_level": hazard_level.value if hazard_level else None,
            "hazard_source": "deterministic" if hazard_level else "unclassified",
        },
        lifestyle={
            "is_smoker": is_smoker,
            "habits": lifestyle_habits,
        },
        medical_history={
            "bmi": bmi,
            "bmi_category": _bmi_category(bmi),
            "height_cm": height_cm,
            "weight_kg": weight_kg,
            "declared_conditions": (e_application.get("medical_questionnaire") or {}),
            "family_history": e_application.get("family_history") or {},
            "document_findings": medical_findings,
        },
        financial={
            "declared_income": declared_income,
            "verified_income": verified_income,
            "coverage_amount": coverage_amount,
            "coverage_to_income_ratio": coverage_to_income_ratio,
            "employer_declared": None,
            "employer_evidence": employer_from_evidence,
            "agent_income_opinion": acr.get("estimated_income_opinion"),
        },
        beneficiary={},
        policy_request={
            "product_name": policy.get("product_name"),
            "insurance_type": policy.get("insurance_type"),
            "coverage_amount": coverage_amount,
            "term_years": policy.get("term_years"),
            "dependent_dob": policy.get("dependent_dob"),
        },
        verified_facts=list(verified_facts),
        document_evidence=list(document_evidence),
        raw={
            "customer": customer,
            "policy": policy,
            "e_application": e_application,
            "acr": acr,
            "document_completeness": document_completeness,
        },
    )
