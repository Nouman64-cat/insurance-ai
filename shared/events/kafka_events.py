"""
Canonical Pydantic event envelopes for Kafka topics.

Imported by both the API Gateway (producer) and the Risk Engine (consumer)
to guarantee the on-wire JSON contract never drifts between services.

Topics
------
insurance.proposal.submitted.v1      →  ProposalSubmittedEvent
insurance.risk.evaluated.v1          →  RiskEvaluatedEvent
insurance.artifact.ocr.requested.v1  →  ArtifactOCRRequestedEvent
"""

from datetime import datetime, timezone
from typing import List
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


# ── Shared primitive for UTC-aware timestamps ─────────────────────────────────

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ─────────────────────────────────────────────────────────────────────────────
# Topic: insurance.proposal.submitted.v1
# ─────────────────────────────────────────────────────────────────────────────

class ApplicantPayload(BaseModel):
    cnic: str
    dob: str                  # YYYY-MM-DD
    gender: str
    occupation: str
    declared_income: int      # annual PKR


class PolicyPayload(BaseModel):
    product_name: str
    coverage_amount: int      # PKR
    term_years: int


class ProposalPayload(BaseModel):
    proposal_id: UUID
    applicant: ApplicantPayload
    policy: PolicyPayload


class ProposalSubmittedEvent(BaseModel):
    event_id: UUID = Field(default_factory=uuid4)
    event_type: str = "ProposalSubmitted"
    timestamp: datetime = Field(default_factory=_utcnow)
    tenant_id: UUID
    payload: ProposalPayload


# ─────────────────────────────────────────────────────────────────────────────
# Topic: insurance.risk.evaluated.v1
# ─────────────────────────────────────────────────────────────────────────────

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
