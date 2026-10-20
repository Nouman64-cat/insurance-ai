"""Table definitions (SQLAlchemy Core) for building queries. The SQL in ../migrations is the schema's source of truth;
these mirror it so queries are composed, not concatenated. Nothing here creates tables."""
from sqlalchemy import (BigInteger, Boolean, Column, DateTime, Integer, MetaData, SmallInteger, Table, Text)
from sqlalchemy.dialects.postgresql import JSONB, UUID

# No schema is named: every connection's search_path is the audit schema (see app/db.py).
metadata = MetaData()

environment = Table(
    "environment", metadata,
    Column("singleton", Boolean, primary_key=True),
    Column("environment_id", UUID(as_uuid=True), nullable=False),
    Column("created_at", DateTime(timezone=True)),
)

chains = Table(
    "chains", metadata,
    Column("chain_id", Text, primary_key=True),
    Column("scope", Text, nullable=False),
    Column("tenant_id", UUID(as_uuid=True)),
    Column("environment_id", UUID(as_uuid=True), nullable=False),
    Column("genesis_hash", Text, nullable=False),
    Column("head_sequence", BigInteger, nullable=False),
    Column("head_hash", Text, nullable=False),
    Column("created_at", DateTime(timezone=True)),
    Column("updated_at", DateTime(timezone=True)),
)

events = Table(
    "events", metadata,
    Column("event_id", UUID(as_uuid=True), primary_key=True),
    Column("chain_id", Text, nullable=False),
    Column("sequence_number", BigInteger, nullable=False),
    Column("tenant_id", UUID(as_uuid=True)),
    Column("environment_id", UUID(as_uuid=True), nullable=False),
    Column("occurred_at", DateTime(timezone=True), nullable=False),
    Column("recorded_at", DateTime(timezone=True), nullable=False),
    Column("actor_id", Text),
    Column("actor_type", Text, nullable=False),
    Column("actor_role", Text),
    Column("service_name", Text, nullable=False),
    Column("module", Text, nullable=False),
    Column("action", Text, nullable=False),
    Column("entity_type", Text, nullable=False),
    Column("entity_id", Text),
    Column("case_id", Text),
    Column("correlation_id", Text),
    Column("source_event_id", Text, nullable=False),
    Column("previous_value", JSONB(none_as_null=True)),
    Column("new_value", JSONB(none_as_null=True)),
    Column("outcome", Text, nullable=False),
    Column("metadata", JSONB, nullable=False),
    Column("previous_hash", Text, nullable=False),
    Column("current_hash", Text, nullable=False),
    Column("hash_version", SmallInteger, nullable=False),
)

dead_letters = Table(
    "dead_letters", metadata,
    Column("id", BigInteger, primary_key=True),
    Column("received_at", DateTime(timezone=True)),
    Column("topic", Text, nullable=False),
    Column("partition_id", Integer, nullable=False),
    Column("msg_offset", BigInteger, nullable=False),
    Column("message_key", Text),
    Column("raw_value", Text),
    Column("error_code", Text, nullable=False),
    Column("error_detail", Text),
)

verification_runs = Table(
    "verification_runs", metadata,
    Column("run_id", UUID(as_uuid=True), primary_key=True),
    Column("chain_id", Text, nullable=False),
    Column("tenant_id", UUID(as_uuid=True)),
    Column("trigger", Text, nullable=False),
    Column("requested_by", Text),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("finished_at", DateTime(timezone=True), nullable=False),
    Column("duration_ms", Integer, nullable=False),
    Column("status", Text, nullable=False),
    Column("from_sequence", BigInteger, nullable=False),
    Column("to_sequence", BigInteger),
    Column("head_sequence", BigInteger, nullable=False),
    Column("total_events_checked", BigInteger, nullable=False),
    Column("first_invalid_sequence", BigInteger),
    Column("reason", Text),
    Column("details", JSONB, nullable=False),
    Column("head_checked", Boolean, nullable=False),
)

EVENT_COLUMNS = [c.name for c in events.columns]
