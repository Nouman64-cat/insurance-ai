"""Hash-chain verification.

verify_chain() re-reads a chain from the database and recomputes it from scratch. It never trusts a stored hash:

  * every event's hash is recalculated from its stored content (EVENT_HASH_MISMATCH if the content was edited);
  * every previous_hash must equal the stored hash of the event before it (PREVIOUS_HASH_MISMATCH; EVENTS_REORDERED
    when that hash belongs to an event at a different position; GENESIS_MISMATCH for the first event);
  * sequence numbers must run 1,2,3... without gaps (SEQUENCE_GAP when a record is missing from the middle);
  * tenant and environment must match the chain's;
  * at the end of the chain, the last sequence and hash must equal the stored chain head
    (CHAIN_HEAD_SEQUENCE_MISMATCH when records are missing from the end or the head was moved,
     CHAIN_HEAD_HASH_MISMATCH when the head hash was changed).

The first violation found is reported with the sequence number and diagnostic details. The whole run reads one
REPEATABLE READ snapshot, so events committed while it runs cannot cause a false alarm.

A bounded range (from_sequence > 1) needs trusted_previous_hash, the hash of the event just before the range, obtained
from somewhere independent of the database being checked; the chain head is compared only if the range reaches it.

What this cannot detect: someone with write access who rewrites the *entire* chain (every event hash and the chain
head). That needs a trust anchor outside the database: Stage 2 (signed checkpoints).
"""
import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import select, text

from app import db
from app.config import settings
from app.models import chains, events, verification_runs
from app.services import hash_chain

log = logging.getLogger("audit.verify")

VALID = "VALID"
INVALID = "INVALID"

CHAIN_NOT_FOUND = "CHAIN_NOT_FOUND"
CHAIN_IDENTITY_MISMATCH = "CHAIN_IDENTITY_MISMATCH"
ENVIRONMENT_MISMATCH = "ENVIRONMENT_MISMATCH"
TENANT_MISMATCH = "TENANT_MISMATCH"
GENESIS_MISMATCH = "GENESIS_MISMATCH"
SEQUENCE_GAP = "SEQUENCE_GAP"
PREVIOUS_HASH_MISMATCH = "PREVIOUS_HASH_MISMATCH"
EVENTS_REORDERED = "EVENTS_REORDERED"
EVENT_HASH_MISMATCH = "EVENT_HASH_MISMATCH"
UNSUPPORTED_HASH_VERSION = "UNSUPPORTED_HASH_VERSION"
CANONICALIZATION_ERROR = "CANONICALIZATION_ERROR"
CHAIN_HEAD_SEQUENCE_MISMATCH = "CHAIN_HEAD_SEQUENCE_MISMATCH"
CHAIN_HEAD_HASH_MISMATCH = "CHAIN_HEAD_HASH_MISMATCH"

_ADVISORY_LOCK = 74_210_378  # scheduled verification: one replica at a time


@dataclass
class VerificationResult:
    chain_id: str
    tenant_id: Optional[UUID]
    status: str = VALID
    total_events_checked: int = 0
    first_invalid_sequence: Optional[int] = None
    reason: Optional[str] = None
    details: dict = field(default_factory=dict)
    from_sequence: int = 1
    to_sequence: Optional[int] = None
    head_sequence: int = 0
    stored_head_hash: Optional[str] = None
    calculated_hash: Optional[str] = None      # hash of the last event verified
    head_checked: bool = False
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: Optional[datetime] = None
    duration_ms: int = 0

    def invalid(self, reason: str, sequence: Optional[int], **details) -> "VerificationResult":
        self.status, self.reason, self.first_invalid_sequence, self.details = INVALID, reason, sequence, details
        return self

    def to_api(self) -> dict:
        return {
            "tenant_id": str(self.tenant_id) if self.tenant_id else None,
            "chain_id": self.chain_id,
            "status": self.status,
            "total_events_checked": self.total_events_checked,
            "first_invalid_sequence": self.first_invalid_sequence,
            "reason": self.reason,
            "details": self.details,
            "from_sequence": self.from_sequence,
            "to_sequence": self.to_sequence,
            "head_sequence": self.head_sequence,
            "stored_head_hash": self.stored_head_hash,
            "calculated_hash": self.calculated_hash,
            "head_checked": self.head_checked,
            "verified_at": hash_chain.format_timestamp(self.finished_at or self.started_at),
            "duration_ms": self.duration_ms,
        }


async def verify_chain(chain_id: str, *, from_sequence: int = 1, to_sequence: Optional[int] = None,
                       trusted_previous_hash: Optional[str] = None, batch_size: Optional[int] = None,
                       engine=None) -> VerificationResult:
    """Verify a chain (or a bounded range of it). Raises ValueError for an invalid request (for instance a range that
    starts after the genesis without a trusted starting hash); an integrity problem is a result, not an exception."""
    if from_sequence < 1:
        raise ValueError("from_sequence must be at least 1")
    if from_sequence > 1 and not trusted_previous_hash:
        raise ValueError("trusted_previous_hash is required to verify a range that does not start at sequence 1")
    if to_sequence is not None and to_sequence < from_sequence:
        raise ValueError("to_sequence must not be before from_sequence")
    batch_size = batch_size or settings.verify_batch
    engine = engine or db.engine()
    started = time.monotonic()

    async with engine.connect() as conn:
        await conn.execution_options(isolation_level="REPEATABLE READ", postgresql_readonly=True)
        chain = (await conn.execute(select(chains).where(chains.c.chain_id == chain_id))).first()
        if chain is None:
            result = VerificationResult(chain_id=chain_id, tenant_id=None, from_sequence=from_sequence, to_sequence=to_sequence)
            return _finish(result.invalid(CHAIN_NOT_FOUND, None), started)
        environment_id = (await conn.execute(text("SELECT environment_id FROM environment"))).scalar_one()
        result = VerificationResult(chain_id=chain_id, tenant_id=chain.tenant_id, from_sequence=from_sequence, to_sequence=to_sequence,
                                    head_sequence=chain.head_sequence, stored_head_hash=chain.head_hash)

        if chain.environment_id != environment_id:
            return _finish(result.invalid(ENVIRONMENT_MISMATCH, 0, chain_environment=str(chain.environment_id),
                                          database_environment=str(environment_id)), started)
        if hash_chain.chain_id_for(chain.environment_id, chain.tenant_id) != chain.chain_id:
            return _finish(result.invalid(CHAIN_IDENTITY_MISMATCH, 0), started)
        genesis = hash_chain.genesis_hash(chain.chain_id)
        if chain.genesis_hash != genesis:
            return _finish(result.invalid(GENESIS_MISMATCH, 0, stored=chain.genesis_hash, expected=genesis), started)

        previous_hash = genesis if from_sequence == 1 else trusted_previous_hash.lower()  # type: ignore[union-attr]
        expected = from_sequence
        cursor = from_sequence - 1
        while True:
            stmt = (select(events).where(events.c.chain_id == chain_id, events.c.sequence_number > cursor)
                    .order_by(events.c.sequence_number).limit(batch_size))
            if to_sequence is not None:
                stmt = stmt.where(events.c.sequence_number <= to_sequence)
            rows = (await conn.execute(stmt)).all()
            if not rows:
                break
            for row in rows:
                problem = await _check_event(conn, chain, row, expected, previous_hash, genesis, from_sequence)
                if problem is not None:
                    reason, sequence, details = problem
                    result.calculated_hash = previous_hash
                    return _finish(result.invalid(reason, sequence, **details), started)
                previous_hash = row.current_hash
                expected += 1
                result.total_events_checked += 1
            cursor = rows[-1].sequence_number
            await asyncio.sleep(0)  # let other tasks run between batches

        result.calculated_hash = previous_hash
        last_sequence = expected - 1
        if to_sequence is None or to_sequence >= chain.head_sequence:
            result.head_checked = True
            if last_sequence != chain.head_sequence:
                first_bad = min(last_sequence, chain.head_sequence) + 1
                return _finish(result.invalid(CHAIN_HEAD_SEQUENCE_MISMATCH, first_bad, last_verified_sequence=last_sequence,
                                              stored_head_sequence=chain.head_sequence), started)
            if previous_hash != chain.head_hash:
                return _finish(result.invalid(CHAIN_HEAD_HASH_MISMATCH, chain.head_sequence, calculated=previous_hash,
                                              stored_head_hash=chain.head_hash), started)
        return _finish(result, started)


async def _check_event(conn, chain, row, expected: int, previous_hash: str, genesis: str, from_sequence: int):
    """None if the event is sound, else (reason, sequence, details)."""
    if row.sequence_number != expected:
        return SEQUENCE_GAP, expected, {"expected_sequence": expected, "found_sequence": row.sequence_number,
                                        "missing_events": row.sequence_number - expected}
    if row.environment_id != chain.environment_id:
        return ENVIRONMENT_MISMATCH, row.sequence_number, {"event_environment": str(row.environment_id)}
    if row.tenant_id != chain.tenant_id:
        return TENANT_MISMATCH, row.sequence_number, {"event_tenant": str(row.tenant_id) if row.tenant_id else None}
    if row.hash_version not in hash_chain.SUPPORTED_VERSIONS:
        return UNSUPPORTED_HASH_VERSION, row.sequence_number, {"hash_version": row.hash_version}
    if row.previous_hash != previous_hash:
        if row.sequence_number == 1 and from_sequence == 1:
            return GENESIS_MISMATCH, 1, {"stored_previous_hash": row.previous_hash, "expected": previous_hash}
        elsewhere = (await conn.execute(
            select(events.c.sequence_number).where(events.c.chain_id == chain.chain_id, events.c.current_hash == row.previous_hash)
            .limit(1))).scalar_one_or_none()
        details = {"stored_previous_hash": row.previous_hash, "expected_previous_hash": previous_hash}
        if elsewhere is not None and elsewhere != row.sequence_number - 1:
            details["references_sequence"] = elsewhere
            return EVENTS_REORDERED, row.sequence_number, details
        return PREVIOUS_HASH_MISMATCH, row.sequence_number, details
    try:
        calculated = hash_chain.compute_event_hash(chain.chain_id, row.sequence_number, previous_hash, row._mapping, row.hash_version)
    except hash_chain.CanonicalizationError as exc:
        return CANONICALIZATION_ERROR, row.sequence_number, {"error": str(exc)}
    if calculated != row.current_hash:
        return EVENT_HASH_MISMATCH, row.sequence_number, {"stored_hash": row.current_hash, "calculated_hash": calculated,
                                                          "event_id": str(row.event_id)}
    return None


def _finish(result: VerificationResult, started: float) -> VerificationResult:
    result.finished_at = datetime.now(timezone.utc)
    result.duration_ms = int((time.monotonic() - started) * 1000)
    return result


async def record_run(result: VerificationResult, trigger: str, requested_by: Optional[str] = None) -> Optional[UUID]:
    """Store a finished run in the (append-only) verification history. A chain that doesn't exist has no history."""
    if result.reason == CHAIN_NOT_FOUND:
        return None
    run_id = uuid4()
    async with db.transaction() as conn:
        await conn.execute(verification_runs.insert().values(
            run_id=run_id, chain_id=result.chain_id, tenant_id=result.tenant_id, trigger=trigger, requested_by=requested_by,
            started_at=result.started_at, finished_at=result.finished_at, duration_ms=result.duration_ms, status=result.status,
            from_sequence=result.from_sequence, to_sequence=result.to_sequence, head_sequence=result.head_sequence,
            total_events_checked=result.total_events_checked, first_invalid_sequence=result.first_invalid_sequence,
            reason=result.reason, details=result.details, head_checked=result.head_checked))
    return run_id


async def verify_all(trigger: str = "SCHEDULED", requested_by: Optional[str] = None) -> list[VerificationResult]:
    """Full verification of every chain, recorded in the history."""
    async with db.engine().connect() as conn:
        chain_ids = [r[0] for r in (await conn.execute(select(chains.c.chain_id).order_by(chains.c.created_at))).all()]
    results = []
    for chain_id in chain_ids:
        result = await verify_chain(chain_id)
        await record_run(result, trigger, requested_by)
        results.append(result)
        if result.status == INVALID:
            log.error("INTEGRITY VIOLATION chain=%s reason=%s first_invalid_sequence=%s details=%s",
                      chain_id, result.reason, result.first_invalid_sequence, result.details)
    return results


async def scheduler(stop: asyncio.Event) -> None:
    """Verify every chain on an interval. One replica at a time (a session advisory lock)."""
    log.info("scheduled verification every %ss", settings.verify_interval_seconds)
    try:
        await asyncio.wait_for(stop.wait(), timeout=settings.verify_initial_delay_seconds)  # let the service settle first
        return
    except asyncio.TimeoutError:
        pass
    while not stop.is_set():
        try:
            async with db.engine().connect() as lock_conn:
                got = (await lock_conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _ADVISORY_LOCK})).scalar_one()
                if got:
                    try:
                        results = await verify_all("SCHEDULED")
                        log.info("scheduled verification: %d chains, %d invalid", len(results),
                                 sum(1 for r in results if r.status == INVALID))
                    finally:
                        await lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _ADVISORY_LOCK})
                await lock_conn.commit()
        except Exception:
            log.exception("scheduled verification failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.verify_interval_seconds)
        except asyncio.TimeoutError:
            pass
