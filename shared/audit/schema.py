"""The audit event contract shared by every producer and the Audit Service.

An AuditIntent is what a service says happened. It is *not* the stored record: the Audit Service turns an intent into
a ledger event by adding the environment, the chain, the authoritative sequence number and the SHA-256 hashes. A
producer therefore never needs to know about chains, and Kafka delivery order never decides ledger order.

Kafka topic: insurance.audit.events.v1  (key = tenant id, or "platform" for system events).

Intents are sanitized when they are built (see shared/audit/sanitize.py), so credentials, tokens and raw document or
medical content never leave the producing service, and the Audit Service sanitizes again on receipt.
"""
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from shared.audit.sanitize import clean_text, sanitize_mapping

AUDIT_EVENTS_TOPIC = "insurance.audit.events.v1"
SCHEMA_VERSION = 1
PLATFORM_KEY = "platform"

# Outcomes
SUCCESS = "SUCCESS"
FAILURE = "FAILURE"
DENIED = "DENIED"
OUTCOMES = (SUCCESS, FAILURE, DENIED)

# Actor types
USER = "USER"
SYSTEM = "SYSTEM"
AI_AGENT = "AI_AGENT"
CUSTOMER = "CUSTOMER"
SERVICE = "SERVICE"
ACTOR_TYPES = (USER, SYSTEM, AI_AGENT, CUSTOMER, SERVICE)

# Modules (the audit coverage areas)
ADMINISTRATION = "administration"
CUSTOMERS_LEADS = "customers_leads"
UNDERWRITING = "underwriting"
AI_AGENTS = "ai_agents"
DOCUMENTS = "documents"
POLICIES = "policies"
PAYMENTS = "payments"
CLAIMS = "claims"
CUSTOMER_SERVICE = "customer_service"
MODULES = (ADMINISTRATION, CUSTOMERS_LEADS, UNDERWRITING, AI_AGENTS, DOCUMENTS, POLICIES, PAYMENTS, CLAIMS, CUSTOMER_SERVICE)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class AuditIntent(BaseModel):
    schema_version: int = SCHEMA_VERSION
    source_service: str = Field(min_length=1, max_length=64)
    # Stable identifier of this audit intent in the producing service (the outbox row id). The Audit Service
    # deduplicates on (source_service, source_event_id), so redelivery and retries are harmless.
    source_event_id: str = Field(min_length=1, max_length=128)
    tenant_id: Optional[UUID] = None            # None = platform-level (system) event
    occurred_at: datetime = Field(default_factory=utcnow)

    actor_id: Optional[str] = Field(default=None, max_length=128)
    actor_type: str = USER
    actor_role: Optional[str] = Field(default=None, max_length=64)

    module: str = Field(min_length=1, max_length=48)
    action: str = Field(min_length=1, max_length=96)           # e.g. "policy.issued"
    entity_type: str = Field(min_length=1, max_length=64)
    entity_id: Optional[str] = Field(default=None, max_length=128)
    case_id: Optional[str] = Field(default=None, max_length=128)
    correlation_id: Optional[str] = Field(default=None, max_length=128)

    previous_value: Optional[dict[str, Any]] = None
    new_value: Optional[dict[str, Any]] = None
    outcome: str = SUCCESS
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("occurred_at")
    @classmethod
    def _utc(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    @field_validator("actor_type")
    @classmethod
    def _actor_type(cls, value: str) -> str:
        value = value.upper()
        if value not in ACTOR_TYPES:
            raise ValueError(f"actor_type must be one of {ACTOR_TYPES}")
        return value

    @field_validator("outcome")
    @classmethod
    def _outcome(cls, value: str) -> str:
        value = value.upper()
        if value not in OUTCOMES:
            raise ValueError(f"outcome must be one of {OUTCOMES}")
        return value

    @field_validator("module", "action", "entity_type")
    @classmethod
    def _identifier(cls, value: str) -> str:
        return clean_text(value, 96).strip()

    @field_validator("previous_value", "new_value", "metadata", mode="before")
    @classmethod
    def _sanitize(cls, value: Any) -> Any:
        if value is None:
            return None
        return sanitize_mapping(value)

    @property
    def chain_key(self) -> str:
        return str(self.tenant_id) if self.tenant_id else PLATFORM_KEY
