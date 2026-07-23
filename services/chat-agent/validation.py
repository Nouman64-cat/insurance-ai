"""Input validation + normalization for tool args, run before a tool executes.

Two jobs:
  1. Auto-fix trivially fixable formats the user/LLM got slightly wrong
     (13 raw CNIC digits -> XXXXX-XXXXXXX-X, loose date -> YYYY-MM-DD) so the
     user is never bothered for something we can infer.
  2. For genuinely wrong/incomplete values, return a human-readable error so
     permission_gate can *ask the user for the correct value* up front —
     instead of sending bad data to tenant-service and surfacing its raw
     Pydantic validation error in the chat.
"""

from __future__ import annotations

import re
from datetime import datetime

_CNIC_FORMATTED = re.compile(r"^\d{5}-\d{7}-\d$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

_DATE_FORMATS = (
    "%Y-%m-%d", "%d-%m-%Y", "%m/%d/%Y", "%d/%m/%Y", "%Y/%m/%d",
    "%m %d %Y", "%d %m %Y", "%d %b %Y", "%d %B %Y", "%B %d %Y", "%b %d, %Y",
)


def normalize_cnic(value):
    """Accept 13 raw digits or an already-formatted CNIC; format to
    XXXXX-XXXXXXX-X. Anything else is a real error the user must correct."""
    if _CNIC_FORMATTED.match(str(value)):
        return str(value), None
    digits = re.sub(r"\D", "", str(value))
    if len(digits) == 13:
        return f"{digits[:5]}-{digits[5:12]}-{digits[12]}", None
    return str(value), (
        f"'{value}' isn't a valid CNIC — it must be 13 digits "
        "(e.g. 42101-1234567-8)."
    )


def normalize_date(value):
    s = str(value).strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d"), None
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s).strftime("%Y-%m-%d"), None
    except ValueError:
        pass
    return s, f"'{value}' isn't a valid date — please give it as YYYY-MM-DD (e.g. 1990-05-14)."


def validate_email(value):
    if _EMAIL.match(str(value)):
        return str(value), None
    return str(value), f"'{value}' isn't a valid email address (e.g. name@example.com)."


# Per-tool field -> normalizer. Only fields present (and non-empty) are checked;
# optional fields left blank are skipped.
_FIELD_VALIDATORS = {
    "add_customer": {"cnic": normalize_cnic, "date_of_birth": normalize_date},
    "update_customer": {"cnic": normalize_cnic},
    "delete_customer": {"cnic": normalize_cnic},
    "add_user": {"email": validate_email},
    "create_proposal": {"cnic": normalize_cnic},
    "create_case": {"cnic": normalize_cnic},
    "run_risk_assessment": {"cnic": normalize_cnic},
    "get_case_details": {"cnic": normalize_cnic},
    "get_document_checklist": {"cnic": normalize_cnic},
    "get_risk_assessment": {"cnic": normalize_cnic},
    "update_case_status": {"cnic": normalize_cnic},
    "assign_case": {"cnic": normalize_cnic},
    "add_case_comment": {"cnic": normalize_cnic},
    "delete_case": {"cnic": normalize_cnic},
    "upload_document": {"cnic": normalize_cnic},
}


def validate_and_normalize(tool_name: str, args: dict) -> tuple[dict, list[str]]:
    """Returns (normalized_args, errors). `errors` is empty when every present
    field is valid (possibly after auto-fixing)."""
    validators = _FIELD_VALIDATORS.get(tool_name, {})
    normalized = dict(args)
    errors: list[str] = []
    for field, fn in validators.items():
        value = normalized.get(field)
        if value in (None, ""):
            continue
        fixed, err = fn(value)
        if err:
            errors.append(err)
        else:
            normalized[field] = fixed
    return normalized, errors
