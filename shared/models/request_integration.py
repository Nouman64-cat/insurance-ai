"""Tenant-service's record of profile corrections applied for Request Management.

Owned by tenant-service (it owns customers). One row per execution key: a correction
retried after a crash finds its row and returns the stored result instead of applying
the change twice. Request Management keeps its own copy of the request; this table
holds no foreign key to it (a different service, a different schema).
"""
from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import JSON, Column, UniqueConstraint
from sqlmodel import Field, SQLModel


class CustomerProfileCorrection(SQLModel, table=True):
    __tablename__ = "customer_profile_corrections"
    __table_args__ = (UniqueConstraint("execution_key", name="uq_customer_correction_execution"),)

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True)
    customer_id: UUID = Field(foreign_key="customers.id", index=True)
    execution_key: str = Field(max_length=200)
    request_id: UUID                      # Request Management's id, no FK across services
    revision_no: int
    requested_by: UUID                    # the requester (a user of this tenant)
    approved_by: UUID                     # the reviewer who approved the exact revision
    changes: dict = Field(sa_column=Column(JSON, nullable=False))   # {field: {"before": .., "after": ..}}
    payload_hash: str = Field(max_length=64)   # what was asked for under this key
    applied_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
