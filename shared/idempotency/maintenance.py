"""Operational upkeep and health for idempotency records.

* `cleanup_once`  erases expired replay bodies in bounded batches (identity rows stay: an expired key never re-authorizes a repeat).
* `run`           the periodic loop a service starts at boot (IDEMPOTENCY_CLEANUP_INTERVAL_SECONDS, default 3600; 0 turns it off).
* `status`        what an operator needs: counts by status, attempts stuck past their lease, unknown outcomes waiting for a decision,
                  and the replay-body backlog. Safe to expose on a health endpoint: it carries no keys, scopes or business data.
"""
import asyncio
import logging
import os

from sqlalchemy import func, select, text

from .core import expire_responses
from .models import idempotency_records as records

log = logging.getLogger('idempotency.maintenance')


async def cleanup_once(engine, *, batch=1000, max_batches=50):
    """Returns how many replay bodies were erased in this pass."""
    total = 0
    for _ in range(max_batches):
        async with engine.begin() as conn:
            n = await expire_responses(conn, limit=batch)
        total += n
        if n < batch:
            break
    if total:
        log.info('idempotency_cleanup erased_bodies=%s', total)
    return total


async def status(engine):
    async with engine.connect() as conn:
        by_status = dict((await conn.execute(select(records.c.status, func.count()).group_by(records.c.status))).all())
        stuck = (await conn.execute(select(func.count()).where(records.c.status == 'PROCESSING', records.c.lease_expires_at < text('clock_timestamp()')))).scalar_one()
        oldest = (await conn.execute(select(func.extract('epoch', text('clock_timestamp()') - func.min(records.c.updated_at)))
                                     .where(records.c.status == 'UNKNOWN'))).scalar_one()
        backlog = (await conn.execute(select(func.count()).where(records.c.status == 'COMPLETED', records.c.expires_at < text('clock_timestamp()'),
                                                                 records.c.response_json.is_not(None)))).scalar_one()
    return {'records': by_status, 'processing_past_lease': stuck, 'unknown_awaiting_decision': by_status.get('UNKNOWN', 0),
            'oldest_unknown_seconds': int(oldest) if oldest is not None else None, 'expired_bodies_pending_cleanup': backlog}


async def run(stop_event, engine):
    interval = int(os.getenv('IDEMPOTENCY_CLEANUP_INTERVAL_SECONDS', '3600'))
    if interval <= 0:
        return
    while not stop_event.is_set():
        try:
            await cleanup_once(engine)
        except Exception:                      # upkeep must never take the service down; the next pass retries
            log.exception('idempotency_cleanup_failed')
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass
