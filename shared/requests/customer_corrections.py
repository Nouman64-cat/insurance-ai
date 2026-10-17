"""The customer fields a Request Management profile correction may change.

Shared by request-management-service (validates proposals, snapshots "before"
values) and tenant-service (applies an approved correction). Anything not listed
here can't be changed through a request: identity (name, CNIC, date of birth,
gender), tenant and ownership (branch, assigned agent, acquisition source),
underwriting inputs (income, occupation, smoker status, height, weight) and
status fields stay with their existing screens and controls.

Adding a field is a policy decision: add it here, with a validator, and document
it in services/request-management-service/README.md.
"""

import re
from dataclasses import dataclass
from typing import Any, Callable, Optional

PROVINCES = (
    "Punjab", "Sindh", "Khyber Pakhtunkhwa", "Balochistan", "Gilgit-Baltistan",
    "Azad Jammu & Kashmir", "Islamabad Capital Territory",
)
MARITAL_STATUSES = ("Single", "Married", "Divorced", "Widowed")

_PHONE = re.compile(r"^\+?[0-9][0-9 \-]{6,18}[0-9]$")
_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,}$")
_POSTAL = re.compile(r"^[0-9A-Za-z \-]{3,10}$")


class CorrectionValueError(ValueError):
    pass


def _text(max_len: int, pattern: Optional[re.Pattern] = None, label: str = "value") -> Callable[[Any], Optional[str]]:
    def check(value: Any) -> Optional[str]:
        if value is None:
            return None
        if not isinstance(value, str):
            raise CorrectionValueError(f"{label} must be text")
        value = value.strip()
        if value == "":
            return None
        if len(value) > max_len:
            raise CorrectionValueError(f"{label} is longer than {max_len} characters")
        if pattern and not pattern.match(value):
            raise CorrectionValueError(f"{label} is not valid")
        return value
    return check


def _choice(options: tuple[str, ...], label: str) -> Callable[[Any], Optional[str]]:
    def check(value: Any) -> Optional[str]:
        if value is None or value == "":
            return None
        if value not in options:
            raise CorrectionValueError(f"{label} must be one of: {', '.join(options)}")
        return value
    return check


@dataclass(frozen=True)
class CorrectableField:
    key: str                 # stable name used in requests, e.g. "contact.email"
    label: str
    column: Optional[str]    # a Customer column, or None when stored in details
    details_path: Optional[tuple[str, str]]  # (section, key) inside Customer.details
    validate: Callable[[Any], Optional[str]]


FIELDS: dict[str, CorrectableField] = {f.key: f for f in (
    CorrectableField("contact.mobile_number", "Mobile number", None, ("contact", "mobile_number"), _text(20, _PHONE, "Mobile number")),
    CorrectableField("contact.email", "Email", None, ("contact", "email"), _text(254, _EMAIL, "Email")),
    CorrectableField("contact.emergency_contact_name", "Emergency contact", None, ("contact", "emergency_contact_name"), _text(120, None, "Emergency contact")),
    CorrectableField("address.street_address", "Street address", None, ("address", "street_address"), _text(300, None, "Street address")),
    CorrectableField("address.postal_code", "Postal code", None, ("address", "postal_code"), _text(10, _POSTAL, "Postal code")),
    CorrectableField("city", "City", "city", None, _text(100, None, "City")),
    CorrectableField("province", "Province", "province", None, _choice(PROVINCES, "Province")),
    CorrectableField("marital_status", "Marital status", "marital_status", None, _choice(MARITAL_STATUSES, "Marital status")),
)}

MAX_FIELDS_PER_REQUEST = len(FIELDS)


def current_value(customer: dict, key: str) -> Optional[str]:
    """The field's value in a customer record (the tenant-service JSON shape or a row dict)."""
    field = FIELDS[key]
    if field.column:
        value = customer.get(field.column)
        value = getattr(value, "value", value)   # enums
    else:
        section, name = field.details_path  # type: ignore[misc]
        value = ((customer.get("details") or {}).get(section) or {}).get(name)
    if isinstance(value, str):
        value = value.strip() or None
    return value


def validate_changes(changes: dict) -> dict[str, Optional[str]]:
    """Proposed {field: new value}, checked against the allowlist. Raises CorrectionValueError."""
    if not isinstance(changes, dict) or not changes:
        raise CorrectionValueError("Propose at least one field change")
    unknown = sorted(set(changes) - set(FIELDS))
    if unknown:
        raise CorrectionValueError(f"These fields can't be corrected through a request: {', '.join(unknown)}")
    return {key: FIELDS[key].validate(value) for key, value in changes.items()}
