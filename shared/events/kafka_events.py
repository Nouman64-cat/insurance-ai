"""
Canonical Pydantic event envelopes for Kafka topics.

Imported by both the API Gateway (producer) and the Risk Engine (consumer)
to guarantee the on-wire JSON contract never drifts between services.

Topics
------
insurance.proposal.submitted.v1      →  ProposalSubmittedEvent
insurance.risk.evaluated.v1          →  RiskEvaluatedEvent
insurance.artifact.ocr.requested.v1  →  ArtifactOCRRequestedEvent
insurance.customer.created.v1       →  CustomerCreatedEvent
"""

from datetime import datetime, timezone
from typing import List, Optional
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


# ── Shared primitive for UTC-aware timestamps ─────────────────────────────────

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ─────────────────────────────────────────────────────────────────────────────
# Topic: insurance.proposal.submitted.v1
# ─────────────────────────────────────────────────────────────────────────────

class CustomerPayload(BaseModel):
    cnic: str
    dob: str                  # YYYY-MM-DD
    gender: str
    marital_status: Optional[str] = None
    occupation: str
    declared_income: int      # annual PKR


class PolicyPayload(BaseModel):
    product_name: str
    insurance_type: str
    coverage_amount: int      # PKR
    term_years: int
    dependent_name: Optional[str] = None
    dependent_dob: Optional[str] = None      # YYYY-MM-DD


class ProposalPayload(BaseModel):
    proposal_id: UUID
    customer: CustomerPayload
    policy: PolicyPayload
    # Rows the API Gateway persisted before publishing. Carried through the
    # whole round trip so the result consumer can attach the RiskAssessment to
    # the right Customer/Policy/Case instead of having to re-derive them — the
    # async path previously had no way back to them at all, so every result
    # published on insurance.risk.evaluated.v1 was silently discarded.
    # Optional so events produced by an older gateway still deserialise.
    customer_id: Optional[UUID] = None
    policy_id: Optional[UUID] = None
    case_id: Optional[UUID] = None


class ProposalSubmittedEvent(BaseModel):
    event_id: UUID = Field(default_factory=uuid4)
    event_type: str = "ProposalSubmitted"
    timestamp: datetime = Field(default_factory=_utcnow)
    tenant_id: UUID
    payload: ProposalPayload


# ─────────────────────────────────────────────────────────────────────────────
# Topic: insurance.risk.evaluated.v1
# ─────────────────────────────────────────────────────────────────────────────

RISK_EVALUATED_TOPIC = "insurance.risk.evaluated.v1"


class RiskScores(BaseModel):
    medical_score: int
    financial_score: int
    fraud_probability: float
    composite_risk_score: int


class RiskEvaluatedPayload(BaseModel):
    proposal_id: UUID
    scores: RiskScores
    ai_decision: str
    reasons: List[str]

    # Echoed straight back from ProposalPayload so the consumer can persist.
    tenant_id: Optional[UUID] = None
    customer_id: Optional[UUID] = None
    policy_id: Optional[UUID] = None
    case_id: Optional[UUID] = None

    # Extra-mortality loading implied by the composite score. Priced into the
    # contract at issuance, so it has to survive the hop.
    suggested_loading: Optional[float] = None

    # A proposal that failed deterministic validation produced no scores worth
    # storing; the consumer skips it rather than writing a junk assessment.
    is_valid: bool = True
    validation_errors: List[str] = Field(default_factory=list)

    medical_reasons: List[str] = Field(default_factory=list)
    financial_reasons: List[str] = Field(default_factory=list)
    fraud_reasons: List[str] = Field(default_factory=list)


class RiskEvaluatedEvent(BaseModel):
    event_id: UUID = Field(default_factory=uuid4)
    event_type: str = "RiskEvaluated"
    timestamp: datetime = Field(default_factory=_utcnow)
    correlation_id: UUID      # matches ProposalSubmittedEvent.event_id
    payload: RiskEvaluatedPayload


# ─────────────────────────────────────────────────────────────────────────────
# Topic: insurance.artifact.ocr.requested.v1
# ─────────────────────────────────────────────────────────────────────────────

class ArtifactOCRPayload(BaseModel):
    artifact_id: UUID
    tenant_id: UUID
    case_id: UUID
    s3_key: str       # full S3 object key to download and pass to OCR engine
    file_name: str
    mime_type: str


class ArtifactOCRRequestedEvent(BaseModel):
    event_id: UUID = Field(default_factory=uuid4)
    event_type: str = "ArtifactOCRRequested"
    timestamp: datetime = Field(default_factory=_utcnow)
    tenant_id: UUID
    payload: ArtifactOCRPayload


# ─────────────────────────────────────────────────────────────────────────────
# Topic: insurance.customer.created.v1
#
# Published by the tenant-service right after an Customer row commits.
# Consumed by the API Gateway's quote worker, which auto-generates a
# PremiumQuote (Policy + PremiumQuote rows) for every InsurancePlan the
# customer is eligible for, so a quotation is already sitting in the DB by
# the time an underwriter opens the Quotation page.
# ─────────────────────────────────────────────────────────────────────────────

CUSTOMER_CREATED_TOPIC = "insurance.customer.created.v1"


class CustomerCreatedPayload(BaseModel):
    customer_id: UUID
    cnic: Optional[str] = None
    name: str
    dob: Optional[str] = None                  # YYYY-MM-DD
    gender: Optional[str] = None
    marital_status: Optional[str] = None
    occupation: Optional[str] = None
    declared_income: Optional[float] = None    # annual PKR
    is_smoker: Optional[bool] = None
    height_cm: Optional[float] = None
    weight_kg: Optional[float] = None


class CustomerCreatedEvent(BaseModel):
    event_id: UUID = Field(default_factory=uuid4)
    event_type: str = "CustomerCreated"
    timestamp: datetime = Field(default_factory=_utcnow)
    tenant_id: UUID
    payload: CustomerCreatedPayload


# ─────────────────────────────────────────────────────────────────────────────
# Topic: insurance.policy.lifecycle.v1
#
# Published by the tenant-service after each policy lifecycle state transition
# commits (issuance, payment confirmation, lapse, cancellation, renewal, …).
# Consumers can decouple downstream side effects — notifications, document
# generation, ledger postings — from the transactional write path.
#
# event_type mirrors the PolicyEvent.event_type persisted in the audit log,
# e.g. "PolicyIssued", "PaymentConfirmed", "PolicyLapsed", "PolicyCancelled",
# "PolicyRenewed".
# ─────────────────────────────────────────────────────────────────────────────

POLICY_LIFECYCLE_TOPIC = "insurance.policy.lifecycle.v1"


class PolicyLifecyclePayload(BaseModel):
    policy_id: UUID
    policy_number: Optional[str] = None
    customer_id: Optional[UUID] = None
    from_status: Optional[str] = None
    to_status: Optional[str] = None
    actor: str = "system"
    detail: Optional[dict] = None


class PolicyLifecycleEvent(BaseModel):
    event_id: UUID = Field(default_factory=uuid4)
    event_type: str = "PolicyLifecycle"
    timestamp: datetime = Field(default_factory=_utcnow)
    tenant_id: UUID
    payload: PolicyLifecyclePayload
