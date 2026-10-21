"""Short-transaction orchestration for external providers.

Providers MUST support lookup by the stable business reference. A timeout or crash
is not a rejection. Lookup must be authoritative before an UNKNOWN operation can
be retried. This does not promise exactly-once provider execution.
"""
import hashlib
from dataclasses import dataclass
from typing import Protocol
from sqlalchemy import select
from .core import IdempotencyError, complete, fail, fingerprint, reconcile, reserve
from .models import idempotency_records as records


@dataclass(frozen=True)
class ProviderResult:
    # COMPLETED | NOT_EXECUTED | UNKNOWN; these are evidence, not retry advice.
    state: str
    reference: str
    receipt: dict | None = None


class Provider(Protocol):
    async def submit(self, reference: str, payload: dict) -> ProviderResult: ...
    async def lookup(self, reference: str) -> ProviderResult: ...


def provider_reference(scope_id, operation, business_id):
    if not business_id:
        raise ValueError('An immutable business obligation ID is required')
    return 'GIA-' + hashlib.sha256(f'{scope_id}\0{operation}\0{business_id}'.encode()).hexdigest()[:40]


async def execute_external(engine, provider, *, scope_id, operation, key, business_id, actor_id,
                           payload, receipt_fields, http_status=200):
    """Persist intent, call outside a transaction, then persist a safe receipt.

    `business_id` identifies one provider obligation across different client keys.
    The owning service MUST also enforce its business uniqueness constraint. A
    provider implementation must reject reuse of a reference with changed inputs.
    """
    request_hash = fingerprint({'business_id': business_id, 'payload': payload}, actor_id=actor_id)
    reference = provider_reference(scope_id, operation, business_id)
    try:
        async with engine.begin() as conn:
            reservation = await reserve(conn, scope_id=scope_id, operation=operation, key=key, request_hash=request_hash)
        if reservation.replay:
            return reservation.http_status, reservation.response
    except IdempotencyError as exc:
        if exc.code != 'IDEMPOTENCY_RECONCILIATION_REQUIRED':
            raise
        async with engine.connect() as conn:
            row = (await conn.execute(select(records).where(records.c.scope_id == scope_id,
                records.c.operation == operation, records.c.idempotency_key == key))).mappings().one()
        # No DB connection remains checked out while consulting the provider.
        try:
            result = await provider.lookup(reference)
        except Exception:
            raise IdempotencyError('IDEMPOTENCY_RECONCILIATION_REQUIRED', retry_after=5) from None
        receipt = approved_receipt(result, reference, receipt_fields)
        async with engine.begin() as conn:
            await reconcile(conn, row['id'], expected_token=row['lease_token'], response=receipt,
                http_status=http_status, definitely_not_executed=result.state == 'NOT_EXECUTED')
        if result.state == 'COMPLETED':
            return http_status, receipt
        # A known non-execution becomes FAILED; the next retry may reserve it.
        raise IdempotencyError('PROVIDER_NOT_EXECUTED' if result.state == 'NOT_EXECUTED'
                               else 'IDEMPOTENCY_RECONCILIATION_REQUIRED', retry_after=5)
    try:
        result = await provider.submit(reference, payload)
        receipt = approved_receipt(result, reference, receipt_fields)
    except Exception:
        async with engine.begin() as conn:
            await fail(conn, reservation, uncertain=True, error_code='PROVIDER_OUTCOME_UNKNOWN')
        raise IdempotencyError('IDEMPOTENCY_RECONCILIATION_REQUIRED', retry_after=5) from None
    async with engine.begin() as conn:
        if result.state == 'COMPLETED':
            await complete(conn, reservation, http_status=http_status, response=receipt)
        else:
            await fail(conn, reservation, uncertain=result.state != 'NOT_EXECUTED',
                       error_code='PROVIDER_NOT_EXECUTED' if result.state == 'NOT_EXECUTED' else 'PROVIDER_OUTCOME_UNKNOWN')
    if result.state != 'COMPLETED':
        raise IdempotencyError('PROVIDER_NOT_EXECUTED' if result.state == 'NOT_EXECUTED'
                               else 'IDEMPOTENCY_RECONCILIATION_REQUIRED', retry_after=5)
    return http_status, receipt


def approved_receipt(result, reference, fields):
    if result.reference != reference or result.state not in ('COMPLETED', 'NOT_EXECUTED', 'UNKNOWN'):
        raise ValueError('Provider returned invalid reconciliation evidence')
    if result.state != 'COMPLETED':
        return None
    if not isinstance(result.receipt, dict) or set(result.receipt) - set(fields):
        raise ValueError('Unreviewed provider receipt schema')
    return result.receipt
