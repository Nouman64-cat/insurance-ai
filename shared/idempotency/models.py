"""Service-owned PostgreSQL metadata. Use the owning service's schema/search_path."""
from sqlalchemy import (MetaData, Table, Column, String, Integer, DateTime, CheckConstraint,
                        UniqueConstraint, Index, text)
from sqlalchemy.dialects.postgresql import UUID, JSONB

metadata = MetaData()
idempotency_records = Table(
    'idempotency_records', metadata,
    Column('id', UUID(as_uuid=True), primary_key=True),
    Column('scope_id', String(160), nullable=False),
    Column('idempotency_key', String(128), nullable=False),
    Column('operation', String(160), nullable=False),
    Column('request_hash', String(64), nullable=False),
    Column('status', String(16), nullable=False),
    Column('http_status', Integer), Column('response_json', JSONB(none_as_null=True)),
    Column('resource_type', String(80)), Column('resource_id', String(128)),
    Column('attempt_count', Integer, nullable=False, server_default='1'),
    Column('created_at', DateTime(timezone=True), nullable=False, server_default=text('now()')),
    Column('updated_at', DateTime(timezone=True), nullable=False, server_default=text('now()')),
    Column('completed_at', DateTime(timezone=True)), Column('expires_at', DateTime(timezone=True), nullable=False),
    Column('last_error_code', String(80)), Column('lease_token', UUID(as_uuid=True)),
    Column('lease_expires_at', DateTime(timezone=True)),
    UniqueConstraint('scope_id', 'operation', 'idempotency_key', name='uq_idempotency_operation'),
    CheckConstraint("status IN ('PROCESSING','COMPLETED','FAILED','UNKNOWN')", name='ck_idempotency_status'),
    CheckConstraint('attempt_count > 0', name='ck_idempotency_attempts'),
    Index('ix_idempotency_expiry', 'expires_at'),
    Index('ix_idempotency_recovery', 'status', 'lease_expires_at'),
)
