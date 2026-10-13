"""The request types Request Management supports.

A type decides who may submit it, who may review it, what its proposal contains (a strict schema), which record it
refers to (validated against the owning service with the requester's own token) and whether approval leads to an
execution in another service. Adding a type means adding a RequestType here; there is no free-form type.

Initial types:
  general                      A decision only. Approval records the decision; nothing is executed.
  customer_profile_correction  Proposed changes to an allowlisted set of customer fields (shared/requests/
                               customer_corrections.py). Approval queues an execution: tenant-service applies the
                               correction if the record still matches what was reviewed.
  commission_dispute           Refers to a real commission earning. Approval records the resolution only; it never
                               changes the ledger or creates a payout (that needs a supported commission operation).
"""
import hashlib
import json
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from app.errors import ApiError, validation
from app.identity import Identity
from app import tenant_client
from shared.requests.customer_corrections import FIELDS as CORRECTABLE_FIELDS
from shared.requests.customer_corrections import CorrectionValueError, current_value, validate_changes


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# ── Payload schemas ──────────────────────────────────────────────────────────

GENERAL_CATEGORIES = ("ACCESS", "DATA_FIX", "PROCESS_EXCEPTION", "DOCUMENT", "OTHER")


class GeneralPayload(Strict):
    category: Literal["ACCESS", "DATA_FIX", "PROCESS_EXCEPTION", "DOCUMENT", "OTHER"]
    description: str = Field(min_length=10, max_length=5000)
    desired_outcome: Optional[str] = Field(default=None, max_length=2000)


class CorrectionPayload(Strict):
    customer_id: UUID
    changes: dict[str, Optional[str]] = Field(min_length=1, max_length=len(CORRECTABLE_FIELDS))
    reason: str = Field(min_length=10, max_length=2000)

    @field_validator("changes")
    @classmethod
    def allowlisted(cls, value: dict) -> dict:
        try:
            return validate_changes(value)
        except CorrectionValueError as exc:
            raise ValueError(str(exc))


DISPUTE_KINDS = ("AMOUNT", "RATE", "SPLIT", "MISSING_RECEIPT", "OTHER")


class DisputePayload(Strict):
    earning_id: UUID
    dispute_kind: Literal["AMOUNT", "RATE", "SPLIT", "MISSING_RECEIPT", "OTHER"]
    claimed_amount: Optional[Decimal] = Field(default=None, ge=0, max_digits=18, decimal_places=2)
    explanation: str = Field(min_length=10, max_length=5000)


# ── What submission resolves ─────────────────────────────────────────────────

@dataclass
class Subject:
    kind: str = "NONE"                 # NONE | CUSTOMER | COMMISSION_EARNING | POLICY | CASE
    id: Optional[UUID] = None
    label: Optional[str] = None
    branch_id: Optional[UUID] = None
    snapshot: Optional[dict] = None    # values captured at submission ("before" values, the disputed amounts)


@dataclass
class RequestType:
    code: str
    label: str
    description: str
    submit_roles: frozenset[str]
    review_roles: frozenset[str]
    payload_model: type[BaseModel]
    executes: bool = False
    operation: Optional[str] = None
    # Decision resolutions a reviewer chooses from (commission disputes); empty: none asked for.
    approve_resolutions: tuple[str, ...] = ()
    reject_resolutions: tuple[str, ...] = ()
    default_sla_hours: int = 72
    extras: dict = field(default_factory=dict)

    def parse(self, payload: Any, *, partial: bool) -> dict:
        """Validate a proposal. Drafts may be incomplete (`partial`), but never contain unknown or disallowed fields."""
        if not isinstance(payload, dict):
            raise validation("The proposal must be an object")
        if len(json.dumps(payload, default=str)) > 20_000:
            raise validation("The proposal is too large")
        if partial:
            allowed = set(self.payload_model.model_fields)
            unknown = sorted(set(payload) - allowed)
            if unknown:
                raise validation(f"Unknown fields: {', '.join(unknown)}")
            if self.code == "customer_profile_correction" and payload.get("changes"):
                try:
                    validate_changes(payload["changes"])
                except CorrectionValueError as exc:
                    raise validation(str(exc))
            return payload
        try:
            model = self.payload_model.model_validate(payload)
        except ValidationError as exc:
            problems = [{"field": ".".join(str(p) for p in e["loc"]), "message": e["msg"].removeprefix("Value error, ")} for e in exc.errors()]
            raise validation("The proposal is incomplete or invalid", fields=problems)
        return json.loads(model.model_dump_json())

    async def resolve_subject(self, identity: Identity, payload: dict) -> Subject:
        return Subject(branch_id=identity.branch_id)


class GeneralType(RequestType):
    pass


class CorrectionType(RequestType):
    async def resolve_subject(self, identity: Identity, payload: dict) -> Subject:
        customer_id = UUID(payload["customer_id"])
        customer = await tenant_client.get_client().get_customer(identity.token, identity.tenant_id, customer_id)
        if not customer:
            raise ApiError(422, "SUBJECT_NOT_FOUND", "That customer doesn't exist or you don't have access to it.")
        before = {key: current_value(customer, key) for key in payload["changes"]}
        if all(before[key] == value for key, value in payload["changes"].items()):
            raise validation("The proposed values are the same as the customer's current values.")
        return Subject(
            kind="CUSTOMER", id=customer_id, label=customer.get("name"),
            branch_id=UUID(customer["branch_id"]) if customer.get("branch_id") else identity.branch_id,
            snapshot={"before": before, "customer_name": customer.get("name")},
        )


class DisputeType(RequestType):
    async def resolve_subject(self, identity: Identity, payload: dict) -> Subject:
        earning_id = UUID(payload["earning_id"])
        earning = await tenant_client.get_client().get_earning(identity.token, identity.tenant_id, earning_id)
        if not earning:
            raise ApiError(422, "SUBJECT_NOT_FOUND", "That commission earning doesn't exist or you don't have access to it.")
        keep = ("policy_id", "receipt_id", "source_id", "agreement_id", "basis_amount", "gross_amount", "rate_pct", "split_pct", "policy_year", "created_at")
        snapshot = {k: (str(earning[k]) if earning.get(k) is not None else None) for k in keep}
        return Subject(
            kind="COMMISSION_EARNING", id=earning_id,
            label=f"Earning {str(earning_id)[:8]} · PKR {snapshot.get('gross_amount')}",
            branch_id=identity.branch_id, snapshot=snapshot,
        )


TYPES: dict[str, RequestType] = {t.code: t for t in (
    GeneralType(
        code="general", label="General operational request",
        description="Ask the responsible team for a decision. Approval records the decision; it doesn't carry anything out.",
        submit_roles=frozenset({"Admin", "Underwriter", "ClaimsAdjuster", "ClaimsManager", "Agent", "Broker"}),
        review_roles=frozenset({"Admin", "Underwriter", "ClaimsManager"}),
        payload_model=GeneralPayload,
        extras={"categories": GENERAL_CATEGORIES},
    ),
    CorrectionType(
        code="customer_profile_correction", label="Customer profile correction",
        description="Correct a customer's contact or address details. Once approved, the customer record is updated if it hasn't changed since review.",
        submit_roles=frozenset({"Admin", "Underwriter", "Agent", "Broker"}),
        review_roles=frozenset({"Admin", "Underwriter"}),
        payload_model=CorrectionPayload,
        executes=True, operation="customer.profile_correction",
        extras={"fields": [{"key": f.key, "label": f.label} for f in CORRECTABLE_FIELDS.values()]},
    ),
    DisputeType(
        code="commission_dispute", label="Commission dispute",
        description="Dispute a commission earning. The outcome is recorded; any financial correction is made separately through the commission tools.",
        submit_roles=frozenset({"Admin", "Agent", "Broker"}),
        review_roles=frozenset({"Admin"}),
        payload_model=DisputePayload,
        approve_resolutions=("UPHELD", "PARTIALLY_UPHELD"),
        reject_resolutions=("NOT_UPHELD",),
        default_sla_hours=120,
        extras={"dispute_kinds": DISPUTE_KINDS},
    ),
)}


def get_type(code: str) -> RequestType:
    t = TYPES.get(code)
    if not t:
        raise validation(f"Unknown request type: {code}")
    return t


def content_hash(payload: dict) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def describe(t: RequestType) -> dict:
    return {
        "code": t.code, "label": t.label, "description": t.description, "executes": t.executes,
        "approve_resolutions": list(t.approve_resolutions), "reject_resolutions": list(t.reject_resolutions),
        "review_roles": sorted(t.review_roles), "default_sla_hours": t.default_sla_hours, **t.extras,
    }
