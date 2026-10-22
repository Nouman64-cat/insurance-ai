"""Durable risk evaluation outcomes, owned by the risk-engine PostgreSQL schema.

Medical/underwriting results belong here, never in generic idempotency receipts.
A failed or abandoned LLM attempt is uncertain and requires operator reconciliation;
Kafka redelivery must not silently spend money on a second attempt.
"""
import os
from sqlalchemy import MetaData, Table, Column, DateTime, text, select
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.engine import make_url
from shared.idempotency import reserve, complete, fail, fingerprint
from shared.idempotency.models import metadata as receipt_metadata

metadata = MetaData()
results = Table('evaluation_results', metadata,
    Column('id', UUID(as_uuid=True), primary_key=True),
    Column('tenant_id', UUID(as_uuid=True), nullable=False, index=True),
    Column('result_json', JSONB, nullable=False),
    Column('created_at', DateTime(timezone=True), nullable=False, server_default=text('now()')))
_store = None


class EvaluationJobs:
    def __init__(self, engine):
        self.engine = engine

    async def run(self, *, tenant_id, operation_id, content, evaluate):
        async with self.engine.begin() as conn:
            reservation = await reserve(conn, scope_id=f'tenant:{tenant_id}', operation='risk.kafka.evaluate',
                key=str(operation_id), request_hash=fingerprint(content, actor_id='risk.kafka.consumer'),
                lease_seconds=int(os.getenv('RISK_EVALUATION_LEASE_SECONDS', '900')))
            if reservation.replay:
                return (await conn.execute(select(results.c.result_json).where(
                    results.c.id == reservation.id, results.c.tenant_id == tenant_id))).scalar_one()
        # No database connection or transaction remains open during LLM calls.
        try:
            outcome = await evaluate()
        except Exception:
            async with self.engine.begin() as conn:
                await fail(conn, reservation, uncertain=True, error_code='EVALUATION_OUTCOME_UNKNOWN')
            raise
        # A crash before this commit leaves PROCESSING for reconciliation. A crash
        # after it can replay the stored result without calling any LLM again.
        async with self.engine.begin() as conn:
            await conn.execute(results.insert().values(id=reservation.id, tenant_id=tenant_id, result_json=outcome))
            await complete(conn, reservation, http_status=200, response={'result_id': str(reservation.id)},
                           resource_type='risk_evaluation_result', resource_id=reservation.id)
        return outcome


async def initialize():
    """Startup migration; runtime HTTP/consumer handlers never perform DDL."""
    global _store
    if _store is not None:
        return _store
    url = os.environ.get('RISK_DATABASE_URL') or os.environ['DATABASE_URL']
    owner_url = os.environ.get('RISK_MIGRATION_DATABASE_URL') or url
    owner = create_async_engine(owner_url, connect_args={'server_settings': {'search_path': 'risk_engine'}})
    try:
        async with owner.begin() as conn:
            await conn.execute(text('CREATE SCHEMA IF NOT EXISTS risk_engine'))
            await conn.run_sync(receipt_metadata.create_all)
            await conn.run_sync(metadata.create_all)
            role = make_url(url).username
            if role:
                quoted = conn.sync_connection.dialect.identifier_preparer.quote_identifier(role)
                await conn.execute(text(f'GRANT USAGE ON SCHEMA risk_engine TO {quoted}'))
                await conn.execute(text(f'GRANT SELECT, INSERT, UPDATE ON idempotency_records TO {quoted}'))
                await conn.execute(text(f'GRANT SELECT, INSERT ON evaluation_results TO {quoted}'))
    finally:
        await owner.dispose()
    engine = create_async_engine(url, connect_args={'server_settings': {'search_path': 'risk_engine'}})
    _store = EvaluationJobs(engine)
    return _store


def get_store():
    if _store is None:
        raise RuntimeError('Risk evaluation database has not been initialized')
    return _store


async def close():
    global _store
    if _store is not None:
        await _store.engine.dispose()
        _store = None
