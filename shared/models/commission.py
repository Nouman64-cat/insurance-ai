"""Persistent commission earnings. Legacy `commissions` rows are not migrated guesses."""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import Column, JSON, Numeric, UniqueConstraint
from sqlmodel import Field, SQLModel


class CommissionAgreement(SQLModel, table=True):
    __tablename__ = "commission_agreements"
    __table_args__ = (UniqueConstraint("tenant_id", "code", "version", name="uq_comm_agreement_version"),)
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True)
    code: str = Field(max_length=80)
    version: int = Field(ge=1)
    name: str = Field(max_length=255)
    # Explicit contractual basis: receipt base includes fees/duty, excludes surcharge.
    basis: str = Field(default="RECEIPT_BASE", max_length=40)
    first_year_pct: Decimal = Field(sa_column=Column(Numeric(7, 4), nullable=False))
    renewal_pct: Decimal = Field(sa_column=Column(Numeric(7, 4), nullable=False))
    effective_from: date
    effective_to: Optional[date] = None
    status: str = Field(default="DRAFT", max_length=20)
    created_by: UUID = Field(foreign_key="users.id")
    approved_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    approved_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class CommissionAssignment(SQLModel, table=True):
    __tablename__ = "commission_assignments"
    __table_args__ = (UniqueConstraint("tenant_id", "policy_id", "source_id", name="uq_comm_policy_source"),)
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True)
    policy_id: UUID = Field(foreign_key="policies.id", index=True)
    source_id: UUID = Field(foreign_key="acquisition_sources.id")
    agreement_id: UUID = Field(foreign_key="commission_agreements.id")
    split_pct: Decimal = Field(sa_column=Column(Numeric(7, 4), nullable=False))
    created_by: UUID = Field(foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)


class CommissionAccrual(SQLModel, table=True):
    __tablename__ = "commission_accruals"
    __table_args__ = (UniqueConstraint("tenant_id", "receipt_id", name="uq_comm_receipt"),)
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True)
    policy_id: UUID = Field(foreign_key="policies.id", index=True)
    receipt_id: UUID = Field(foreign_key="premium_receipts.id")
    status: str = Field(default="EXCEPTION", max_length=20)
    reason: Optional[str] = Field(default=None, max_length=500)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class CommissionEarning(SQLModel, table=True):
    __tablename__ = "commission_earnings"
    __table_args__ = (UniqueConstraint("accrual_id", "source_id", name="uq_comm_allocation"),)
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True)
    accrual_id: UUID = Field(foreign_key="commission_accruals.id")
    policy_id: UUID = Field(foreign_key="policies.id", index=True)
    receipt_id: UUID = Field(foreign_key="premium_receipts.id")
    source_id: UUID = Field(foreign_key="acquisition_sources.id", index=True)
    agreement_id: UUID = Field(foreign_key="commission_agreements.id")
    basis_amount: Decimal = Field(sa_column=Column(Numeric(18, 2), nullable=False))
    gross_amount: Decimal = Field(sa_column=Column(Numeric(18, 2), nullable=False))
    rate_pct: Decimal = Field(sa_column=Column(Numeric(7, 4), nullable=False))
    split_pct: Decimal = Field(sa_column=Column(Numeric(7, 4), nullable=False))
    policy_year: int
    snapshot: dict = Field(sa_column=Column(JSON, nullable=False))
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class CommissionPlanRule(SQLModel, table=True):
    """One approved contract per plan/effective period. Immutable once linked."""
    __tablename__ = 'commission_plan_rules'
    __table_args__ = (UniqueConstraint('tenant_id', 'plan_id', 'agreement_id', name='uq_comm_plan_agreement'),)
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key='tenants.id', index=True)
    plan_id: UUID = Field(foreign_key='insurance_plans.id', index=True)
    agreement_id: UUID = Field(foreign_key='commission_agreements.id')
    created_by: UUID = Field(foreign_key='users.id')
    created_at: datetime = Field(default_factory=datetime.utcnow)


class CommissionDisbursement(SQLModel, table=True):
    __tablename__ = 'commission_disbursements'
    __table_args__ = (UniqueConstraint('tenant_id', 'payment_reference', name='uq_comm_payment_reference'),)
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key='tenants.id', index=True)
    status: str = Field(default='DRAFT', max_length=20, index=True)
    gross_amount: Decimal = Field(sa_column=Column(Numeric(18, 2), nullable=False))
    created_by: UUID = Field(foreign_key='users.id')
    approved_by: Optional[UUID] = Field(default=None, foreign_key='users.id')
    paid_by: Optional[UUID] = Field(default=None, foreign_key='users.id')
    payment_reference: Optional[str] = Field(default=None, max_length=150)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    submitted_at: Optional[datetime] = None
    approved_at: Optional[datetime] = None
    paid_at: Optional[datetime] = None


class CommissionDisbursementItem(SQLModel, table=True):
    __tablename__ = 'commission_disbursement_items'
    __table_args__ = (UniqueConstraint('batch_id', 'earning_id', name='uq_comm_batch_earning'),)
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    batch_id: UUID = Field(foreign_key='commission_disbursements.id', index=True)
    earning_id: UUID = Field(foreign_key='commission_earnings.id', index=True)
    # Released on rejection/cancellation; history keeps the original earning_id.
    reserved_earning_id: Optional[UUID] = Field(default=None, foreign_key='commission_earnings.id', unique=True)
    gross_amount: Decimal = Field(sa_column=Column(Numeric(18, 2), nullable=False))


class CommissionDisbursementEvent(SQLModel, table=True):
    __tablename__ = 'commission_disbursement_events'
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    batch_id: UUID = Field(foreign_key='commission_disbursements.id', index=True)
    actor_id: UUID = Field(foreign_key='users.id')
    action: str = Field(max_length=30)
    detail: Optional[str] = Field(default=None, max_length=500)
    created_at: datetime = Field(default_factory=datetime.utcnow)
