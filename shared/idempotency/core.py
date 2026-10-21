"""Durable operation identities; never infer identity from payload equality.

All methods use the caller's transaction. Database-only mutations MUST share that
transaction with reserve/complete. Durable external work MUST commit reserve before
network I/O, then complete with the returned fencing token in a short transaction.
"""
import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select, update, text
from sqlalchemy.dialects.postgresql import insert
from .models import idempotency_records as records

log = logging.getLogger('idempotency')
KEY = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:-]{7,127}\Z', re.ASCII)


class IdempotencyError(Exception):
    def __init__(self, code, status=409, retry_after=None):
        self.code, self.status, self.retry_after = code, status, retry_after
        super().__init__(code)


def validate_key(key):
    if not isinstance(key, str) or not KEY.fullmatch(key):
        raise IdempotencyError('IDEMPOTENCY_KEY_INVALID', 400)
    return key


def fingerprint(content, *, actor_id):
    # Includes the authenticated actor, path parameters and query in HTTP adapters.
    # No JWT or sensitive request body is retained; only this digest is persisted.
    encoded = json.dumps(jsonable_encoder({'actor': str(actor_id), 'request': content}),
                         sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


@dataclass(frozen=True)
class Reservation:
    id: UUID
    token: UUID | None
    replay: bool = False
    http_status: int | None = None
    response: object = None


async def reserve(conn, *, scope_id, operation, key, request_hash, retention_days=30, lease_seconds=120):
    validate_key(key)
    if not scope_id or len(scope_id) > 160 or not operation or len(operation) > 160:
        raise ValueError('Explicit bounded scope and operation are required')
    if retention_days < 1 or lease_seconds < 1:
        raise ValueError('Retention and lease must be positive')
    lock = int.from_bytes(hashlib.sha256(json.dumps([scope_id, operation, key]).encode()).digest()[:8], 'big', signed=True)
    if not (await conn.execute(text('SELECT pg_try_advisory_xact_lock(:key)'), {'key': lock})).scalar_one():
        raise IdempotencyError('IDEMPOTENCY_PROCESSING', retry_after=2)
    # Database time avoids clock skew between application replicas.
    now = (await conn.execute(text('SELECT clock_timestamp()'))).scalar_one()
    rid, token = uuid4(), uuid4()
    inserted = (await conn.execute(insert(records).values(
        id=rid, scope_id=scope_id, operation=operation, idempotency_key=key, request_hash=request_hash,
        status='PROCESSING', lease_token=token, lease_expires_at=now + timedelta(seconds=lease_seconds),
        expires_at=now + timedelta(days=retention_days), created_at=now, updated_at=now,
    ).on_conflict_do_nothing(index_elements=['scope_id', 'operation', 'idempotency_key']).returning(records.c.id))).first()
    if inserted:
        log.info('idempotency_reserved operation=%s', operation)
        return Reservation(rid, token)
    row = (await conn.execute(select(records).where(records.c.scope_id == scope_id,
        records.c.operation == operation, records.c.idempotency_key == key).with_for_update())).mappings().one()
    if row['request_hash'] != request_hash:
        raise IdempotencyError('IDEMPOTENCY_CONFLICT')
    if row['status'] == 'COMPLETED':
        if row['response_json'] is None:
            raise IdempotencyError('IDEMPOTENCY_RESPONSE_EXPIRED')
        log.info('idempotency_replayed operation=%s', operation)
        return Reservation(row['id'], None, True, row['http_status'], row['response_json'])
    if row['status'] == 'UNKNOWN':
        raise IdempotencyError('IDEMPOTENCY_RECONCILIATION_REQUIRED', retry_after=5)
    if row['status'] == 'PROCESSING':
        # An abandoned external attempt may have succeeded. Never blindly take it
        # over: the provider must first be queried using the original reference.
        if row['lease_expires_at'] is None or row['lease_expires_at'] <= now:
            raise IdempotencyError('IDEMPOTENCY_RECONCILIATION_REQUIRED', retry_after=5)
        raise IdempotencyError('IDEMPOTENCY_PROCESSING', retry_after=2)
    # FAILED means the owner explicitly established that no side effect occurred.
    await conn.execute(update(records).where(records.c.id == row['id']).values(
        status='PROCESSING', lease_token=token, lease_expires_at=now + timedelta(seconds=lease_seconds),
        updated_at=now, attempt_count=records.c.attempt_count + 1, last_error_code=None))
    return Reservation(row['id'], token)


async def complete(conn, reservation, *, http_status, response, resource_type=None, resource_id=None):
    if reservation.replay or not reservation.token:
        raise ValueError('A live reservation is required')
    if not 200 <= http_status < 300:
        raise ValueError('Only successful, explicitly approved responses may be cached')
    payload = jsonable_encoder(response)
    if len(json.dumps(payload, allow_nan=False).encode()) > 65536:
        raise ValueError('Replay response exceeds 64 KiB; use a resource receipt')
    result = await conn.execute(update(records).where(records.c.id == reservation.id,
        records.c.lease_token == reservation.token, records.c.status == 'PROCESSING').values(
        status='COMPLETED', http_status=http_status, response_json=payload,
        resource_type=resource_type, resource_id=str(resource_id) if resource_id is not None else None,
        completed_at=text('clock_timestamp()'), updated_at=text('clock_timestamp()'), lease_expires_at=None,
        last_error_code=None))
    if result.rowcount != 1:
        raise IdempotencyError('IDEMPOTENCY_FENCE_LOST')


async def fail(conn, reservation, *, uncertain, error_code):
    if not re.fullmatch('[A-Z0-9_]{1,80}', error_code):
        raise ValueError('Use a safe error code, never exception text')
    result = await conn.execute(update(records).where(records.c.id == reservation.id,
        records.c.lease_token == reservation.token, records.c.status == 'PROCESSING').values(
        status='UNKNOWN' if uncertain else 'FAILED', last_error_code=error_code,
        updated_at=text('clock_timestamp()'), lease_expires_at=None))
    if result.rowcount != 1:
        raise IdempotencyError('IDEMPOTENCY_FENCE_LOST')


async def reconcile(conn, reservation_id, *, expected_token, response=None, http_status=200, definitely_not_executed=False):
    """Only a provider adapter with definitive evidence may call this.

    Rotate the fence so an old worker cannot overwrite the reconciled result.
    Missing/ambiguous provider results must leave UNKNOWN unchanged.
    """
    row = (await conn.execute(select(records).where(records.c.id == reservation_id).with_for_update())).mappings().one()
    now = (await conn.execute(text('SELECT clock_timestamp()'))).scalar_one()
    if row['lease_token'] != expected_token or row['status'] not in ('UNKNOWN', 'PROCESSING'):
        raise IdempotencyError('IDEMPOTENCY_FENCE_LOST')
    if row['status'] == 'PROCESSING' and row['lease_expires_at'] and row['lease_expires_at'] > now:
        raise IdempotencyError('IDEMPOTENCY_PROCESSING', retry_after=2)
    token = uuid4()
    await conn.execute(update(records).where(records.c.id == reservation_id).values(
        lease_token=token, status='PROCESSING', updated_at=now))
    reservation = Reservation(reservation_id, token)
    if definitely_not_executed:
        await fail(conn, reservation, uncertain=False, error_code='PROVIDER_CONFIRMED_NOT_EXECUTED')
    elif response is not None:
        await complete(conn, reservation, http_status=http_status, response=response)
    else:
        await fail(conn, reservation, uncertain=True, error_code='PROVIDER_OUTCOME_UNKNOWN')


async def expire_responses(conn, *, limit=1000):
    """Erase replay bodies in bounded batches; keep permanent identity tombstones.

    Expiry never authorizes a repeated financial operation. UNKNOWN/PROCESSING
    records are excluded. Business resource constraints must also be retained.
    """
    ids = select(records.c.id).where(records.c.status == 'COMPLETED',
        records.c.expires_at < text('clock_timestamp()'), records.c.response_json.is_not(None)
    ).limit(limit).with_for_update(skip_locked=True)
    return (await conn.execute(update(records).where(records.c.id.in_(ids)).values(response_json=None))).rowcount
