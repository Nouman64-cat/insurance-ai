"""Required-document checklists, keyed by (insurance_type, case_type).

Underwriting checklists vary by plan type (e.g. a Child Education & Marriage
plan needs the dependent's birth certificate; other plans don't). Claim
checklists are cause-agnostic ("*") for v1 — death/accidental/maturity
sub-cases are deferred since there is no claim_type selection UI yet to key
off (see the plan-type-aware underwriting plan).
"""

from typing import Dict, List, Optional, Tuple

REQUIRED_DOCUMENTS: Dict[Tuple[str, str], List[str]] = {
    ("TERM_LIFE", "Underwriting"): ["CNIC", "Medical Report", "Salary Slip"],
    ("WHOLE_LIFE", "Underwriting"): ["CNIC", "Medical Report", "Salary Slip", "Bank Statement"],
    ("ENDOWMENT", "Underwriting"): ["CNIC", "Medical Report", "Salary Slip", "Bank Statement"],
    ("CHILD_EDUCATION_MARRIAGE", "Underwriting"): [
        "CNIC", "Salary Slip", "Bank Statement", "Child's Birth Certificate",
    ],
    ("*", "Claim"): ["CNIC", "Policy Form", "Bank Statement", "Claim Form"],
    ("*", "Inquiry"): [],
}


def get_required_documents(insurance_type: Optional[str], case_type: str) -> List[str]:
    if insurance_type is not None:
        specific = REQUIRED_DOCUMENTS.get((insurance_type, case_type))
        if specific is not None:
            return specific
    return REQUIRED_DOCUMENTS.get(("*", case_type), [])
