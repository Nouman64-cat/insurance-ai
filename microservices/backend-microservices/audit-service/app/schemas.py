"""Request bodies. Responses are plain dicts built by the services (see query_service.event_to_api and
chain_verifier.VerificationResult.to_api)."""
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class VerificationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Which chain. A tenant administrator's request always means their own tenant's chain (a chain_id of any other
    # tenant is refused). A SuperAdmin names a chain_id, a tenant_id, or "platform".
    chain_id: Optional[str] = Field(default=None, max_length=128)
    tenant_id: Optional[str] = Field(default=None, max_length=64)

    # Optional bounded range. A range that does not start at 1 needs trusted_previous_hash: the hash of the event just
    # before from_sequence, taken from somewhere independent of this database.
    from_sequence: int = Field(default=1, ge=1)
    to_sequence: Optional[int] = Field(default=None, ge=1)
    trusted_previous_hash: Optional[str] = Field(default=None, pattern=r"^[0-9a-fA-F]{64}$")
