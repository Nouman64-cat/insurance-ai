"""Anchored verification: Stage 1 hash-chain checks PLUS signed-checkpoint checks against independent trusted data.

Stage 1 asks "is this chain internally consistent?" and trusts the database for the answer. That cannot see an attacker who
rewrites the whole chain consistently. Stage 2 adds anchors the database cannot forge:

  * trusted checkpoints come from the protected store (signer-written, read-only here), not from PostgreSQL;
  * trusted public keys come from the registry file, itself a chain of signed statements;
  * every anchored checkpoint is checked for contiguous numbering, linkage to its predecessor, a valid Ed25519 signature by a
    trusted key that was active at the time, the right chain/tenant/environment, and that the ledger still contains the
    event it committed to (so rewriting or truncating anchored history is caught even if the rewritten chain is perfect);
  * the database's own copies must match the trusted ones; extra, missing or different rows are findings.

A checkpoint is never called verified because it matches the database alone. If trusted storage or the registry cannot be read
the result is VERIFICATION_FAILED, not VERIFIED. Limit: events newer than the last checkpoint are not yet anchored
(UNSIGNED_EVENTS_PENDING); an attacker with full host access to the signer's volumes and key is out of scope.
"""
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import text

from app import db
from app.checkpoints import repository as repo
from app.checkpoints.storage import TrustedStorage
from app.config import settings
from app.services import chain_verifier
from app.trust import key_registry
from app.verification import signature_verifier as sv
from app.verification.signature_verifier import Finding
from shared.audit import checkpoint as cp
from shared.audit.hashing import format_timestamp
from shared.audit.trust import RegistryError

log = logging.getLogger("audit.verify.anchored")


@dataclass
class AnchoredResult:
    chain_id: str
    tenant_id: Optional[str] = None
    state: str = sv.VERIFICATION_FAILED
    hash_chain_valid: Optional[bool] = None
    signatures_valid: Optional[bool] = None
    signer_trusted: Optional[bool] = None
    anchored: Optional[bool] = None
    pending_events: int = 0
    checkpoints_checked: int = 0
    last_checkpoint_number: Optional[int] = None
    findings: list[Finding] = field(default_factory=list)
    hash_chain: dict = field(default_factory=dict)
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    finished_at: Optional[datetime] = None
    duration_ms: int = 0

    def to_api(self) -> dict:
        return {
            "chain_id": self.chain_id, "tenant_id": self.tenant_id, "state": self.state,
            "hash_chain_valid": self.hash_chain_valid, "signatures_valid": self.signatures_valid, "signer_trusted": self.signer_trusted,
            "anchored": self.anchored, "pending_events": self.pending_events, "checkpoints_checked": self.checkpoints_checked,
            "last_checkpoint_number": self.last_checkpoint_number, "findings": [f.to_api() for f in self.findings],
            "hash_chain": self.hash_chain, "verified_at": format_timestamp(self.finished_at or self.started_at), "duration_ms": self.duration_ms,
        }


def _state(findings: list[Finding], pending: int) -> str:
    present = {f.state for f in findings}
    for state in sv.PRIORITY:
        if state in present:
            return state
    return sv.UNSIGNED_EVENTS_PENDING if pending else sv.VERIFIED


async def verify_anchored(chain_id: str, *, storage: Optional[TrustedStorage] = None, engine=None) -> AnchoredResult:
    started = time.monotonic()
    result = AnchoredResult(chain_id)
    storage = storage or TrustedStorage(settings.checkpoint_directory)
    engine = engine or db.engine()
    findings = result.findings

    stage1 = await chain_verifier.verify_chain(chain_id, engine=engine)
    result.hash_chain = stage1.to_api()
    result.hash_chain_valid = stage1.status == chain_verifier.VALID
    if stage1.reason == chain_verifier.CHAIN_NOT_FOUND:
        findings.append(Finding(sv.VERIFICATION_FAILED, "CHAIN_NOT_FOUND", "no such chain"))
        return _finish(result, started)
    result.tenant_id = str(stage1.tenant_id) if stage1.tenant_id else None
    if not result.hash_chain_valid:
        findings.append(Finding(sv.INVALID_HASH_CHAIN, stage1.reason or "HASH_CHAIN_INVALID",
                                f"the SHA-256 hash chain is invalid at event {stage1.first_invalid_sequence}: {stage1.reason}"))

    async with engine.connect() as conn:
        env = str((await conn.execute(text("SELECT environment_id FROM environment"))).scalar_one())
        head = (await conn.execute(text("SELECT head_sequence FROM chains WHERE chain_id = :c"), {"c": chain_id})).scalar_one()
        db_rows = (await repo.list_checkpoints(conn, chain_id, limit=1_000_000, descending=False))[0]

    trusted: list[tuple[int, dict]] = []
    storage_ok = storage.available()
    registry = None
    try:
        registry = key_registry.load_registry(env, str(storage.root))
    except key_registry.RegistryUnavailable as exc:
        if db_rows or (storage_ok and storage.numbers(env, result.tenant_id)):
            findings.append(Finding(sv.VERIFICATION_FAILED, "TRUSTED_REGISTRY_UNAVAILABLE", str(exc)))
    except RegistryError as exc:
        findings.append(Finding(sv.UNTRUSTED_SIGNER, "TRUSTED_REGISTRY_INVALID", f"the trusted key registry is not a valid chain of trust: {exc}"))

    file_numbers: list[int] = storage.numbers(env, result.tenant_id) if storage_ok else []
    if not storage_ok and (db_rows or registry is not None):
        findings.append(Finding(sv.VERIFICATION_FAILED, "TRUSTED_STORAGE_UNAVAILABLE",
                                "the independent checkpoint store cannot be read, so checkpoints cannot be verified against trusted copies", source="trusted_storage"))

    if registry is not None and storage_ok:
        _check_numbering(file_numbers, "trusted_storage", findings)
        for n in file_numbers:
            envelope = storage.read(env, result.tenant_id, n)
            if envelope is None or envelope.get("unreadable"):
                findings.append(Finding(sv.MISSING_CHECKPOINT, "CHECKPOINT_FILE_UNREADABLE", f"checkpoint {n} in trusted storage is missing or unreadable", n, "trusted_storage"))
                continue
            trusted.append((n, envelope))
        _evaluate_trusted(trusted, registry, chain_id, env, result, findings)
        db_by_number = {r.checkpoint_number: r for r in db_rows}
        _compare_database(trusted, db_by_number, registry, chain_id, env, result.tenant_id, findings)
        await _check_anchors(engine, chain_id, trusted, head, findings)
    elif db_rows and registry is None and not any(f.code.startswith("TRUSTED_") for f in findings):
        findings.append(Finding(sv.VERIFICATION_FAILED, "NO_TRUSTED_REGISTRY", "database checkpoints exist but there is no trusted registry to verify them against"))

    result.checkpoints_checked = len(trusted)
    last = trusted[-1][1]["payload"] if trusted else None
    result.last_checkpoint_number = last["checkpoint_number"] if last else None
    result.pending_events = max(0, head - (last["end_sequence"] if last else 0))
    states = {f.state for f in findings}
    if trusted:
        result.signatures_valid = sv.INVALID_SIGNATURE not in states
        result.signer_trusted = sv.UNTRUSTED_SIGNER not in states
        result.anchored = not ({sv.CHECKPOINT_MISMATCH, sv.MISSING_CHECKPOINT, sv.VERIFICATION_FAILED} & states)
    return _finish(result, started)


def _check_numbering(numbers: list[int], source: str, findings: list[Finding]) -> None:
    for expected, n in enumerate(numbers, start=1):
        if n != expected:
            findings.append(Finding(sv.MISSING_CHECKPOINT, "CHECKPOINT_NUMBER_GAP", f"checkpoint {expected} is missing from the sequence", expected, source))
            return


def _evaluate_trusted(trusted: list[tuple[int, dict]], registry, chain_id: str, env: str, result: AnchoredResult, findings: list[Finding]) -> None:
    previous: Optional[dict] = None
    for number, envelope in trusted:
        found = sv.verify_envelope(envelope, registry, chain_id=chain_id, environment_id=env, tenant_id=result.tenant_id, source="trusted_storage")
        findings.extend(found)
        if any(f.code in ("ENVELOPE_INCONSISTENT", "CHECKPOINT_NOT_FOR_THIS_CHAIN") for f in found):
            previous = None
            continue
        p = envelope["payload"]
        want_prev = previous["checkpoint_hash"] if previous else cp.checkpoint_genesis_hash(chain_id)
        want_start = previous["payload"]["end_sequence"] + 1 if previous else 1
        if p["checkpoint_number"] != number or p["previous_checkpoint_hash"] != want_prev or p["start_sequence"] != want_start:
            findings.append(Finding(sv.CHECKPOINT_MISMATCH, "BROKEN_CHECKPOINT_CONTINUITY",
                                    f"checkpoint {number} does not follow checkpoint {number - 1} (link, numbering or range is broken)", number, "trusted_storage"))
        if previous is not None and p["created_at"] < previous["payload"]["created_at"]:
            findings.append(Finding(sv.CHECKPOINT_MISMATCH, "CHECKPOINT_TIME_REGRESSION",
                                    f"checkpoint {number} claims to have been created before checkpoint {number - 1} (backdated)", number, "trusted_storage"))
        previous = envelope


def _compare_database(trusted: list[tuple[int, dict]], db_by_number: dict, registry, chain_id: str, env: str, tenant: Optional[str], findings: list[Finding]) -> None:
    """The trusted copies decide. The database's copy must be identical; anything else is a finding."""
    trusted_numbers = {n for n, _ in trusted}

    def own_problems(row) -> list[Finding]:
        return sv.verify_envelope(repo.envelope_from_row(row), registry, chain_id=chain_id, environment_id=env, tenant_id=tenant, source="database")

    for number, envelope in trusted:
        row = db_by_number.get(number)
        if row is None:
            findings.append(Finding(sv.MISSING_CHECKPOINT, "CHECKPOINT_MISSING_FROM_DATABASE",
                                    f"checkpoint {number} exists in trusted storage but is missing from the database", number, "database"))
        elif repo.envelope_from_row(row) != envelope:
            findings.extend(own_problems(row))     # e.g. a forged signature, or a key the registry does not trust
            findings.append(Finding(sv.CHECKPOINT_MISMATCH, "DATABASE_COPY_DIFFERS",
                                    f"the database copy of checkpoint {number} differs from the trusted copy (substituted)", number, "database"))
    for number, row in db_by_number.items():
        if number in trusted_numbers:
            continue
        problems = own_problems(row)
        findings.extend(problems)
        if problems:   # not in the trusted store AND not validly signed: injected into the database
            findings.append(Finding(sv.CHECKPOINT_MISMATCH, "CHECKPOINT_NOT_IN_TRUSTED_STORAGE",
                                    f"checkpoint {number} is in the database but not in trusted storage and is not validly signed", number, "database"))
        else:          # validly signed, so the protected store lost its copy
            findings.append(Finding(sv.MISSING_CHECKPOINT, "CHECKPOINT_MISSING_FROM_TRUSTED_STORAGE",
                                    f"checkpoint {number} is in the database but its protected copy is missing from trusted storage", number, "trusted_storage"))


async def _check_anchors(engine, chain_id: str, trusted: list[tuple[int, dict]], head: int, findings: list[Finding]) -> None:
    ends = {env["payload"]["end_sequence"]: (n, env["payload"]["last_event_hash"]) for n, env in trusted if "payload" in env}
    if not ends:
        return
    async with engine.connect() as conn:
        rows = (await conn.execute(text("SELECT sequence_number, current_hash FROM events WHERE chain_id = :c AND sequence_number = ANY(:s)"),
                                   {"c": chain_id, "s": list(ends)})).all()
    found = {r.sequence_number: r.current_hash for r in rows}
    for end, (number, expected) in sorted(ends.items()):
        if end not in found:
            findings.append(Finding(sv.CHECKPOINT_MISMATCH, "CHAIN_TRUNCATED",
                                    f"event {end}, signed in checkpoint {number}, is no longer in the ledger (history was deleted or truncated; the ledger has {head} events)", number, "database"))
        elif found[end] != expected:
            findings.append(Finding(sv.CHECKPOINT_MISMATCH, "ANCHOR_EVENT_MISMATCH",
                                    f"event {end} no longer matches the hash signed in checkpoint {number}: history before this point was rewritten", number, "database"))


def _finish(result: AnchoredResult, started: float) -> AnchoredResult:
    result.state = _state(result.findings, result.pending_events)
    result.finished_at = datetime.now(timezone.utc)
    result.duration_ms = int((time.monotonic() - started) * 1000)
    return result


async def record_run(result: AnchoredResult, trigger: str, requested_by: Optional[str] = None) -> Optional[UUID]:
    if any(f.code == "CHAIN_NOT_FOUND" for f in result.findings):
        return None
    run_id = uuid4()
    async with db.transaction() as conn:
        await conn.execute(text("""
            INSERT INTO anchor_verification_runs (run_id, chain_id, tenant_id, trigger, requested_by, started_at, finished_at, duration_ms, state,
                hash_chain_valid, signatures_valid, signer_trusted, anchored, pending_events, checkpoints_checked, last_checkpoint_number, findings)
            VALUES (:id, :c, CAST(:t AS uuid), :trig, :by, :s, :f, :d, :state, :h, :sig, :tr, :a, :p, :n, :l, CAST(:fi AS jsonb))"""),
            {"id": run_id, "c": result.chain_id, "t": result.tenant_id, "trig": trigger, "by": requested_by, "s": result.started_at, "f": result.finished_at,
             "d": result.duration_ms, "state": result.state, "h": result.hash_chain_valid, "sig": result.signatures_valid, "tr": result.signer_trusted,
             "a": result.anchored, "p": result.pending_events, "n": result.checkpoints_checked, "l": result.last_checkpoint_number,
             "fi": json.dumps([f.to_api() for f in result.findings])})
        if result.state not in (sv.VERIFIED, sv.UNSIGNED_EVENTS_PENDING):
            await repo.add_alert(conn, result.chain_id, result.tenant_id, "VERIFICATION_" + result.state, "CRITICAL",
                                 f"Anchored verification of {result.chain_id} found {result.state}", {"findings": [f.to_api() for f in result.findings][:5]})
    return run_id


async def verify_all_anchored(trigger: str = "SCHEDULED", requested_by: Optional[str] = None) -> list[AnchoredResult]:
    async with db.engine().connect() as conn:
        chain_ids = [r[0] for r in (await conn.execute(text("SELECT chain_id FROM chains ORDER BY created_at"))).all()]
    results = []
    for chain_id in chain_ids:
        result = await verify_anchored(chain_id)
        await record_run(result, trigger, requested_by)
        if result.state not in (sv.VERIFIED, sv.UNSIGNED_EVENTS_PENDING):
            log.error("ANCHORED VERIFICATION %s chain=%s findings=%s", result.state, chain_id, [f.to_api() for f in result.findings][:3])
        results.append(result)
    return results


_ADVISORY_LOCK = 74_210_379     # scheduled anchored verification: one replica at a time


async def scheduler(stop) -> None:
    """Re-verify every chain against its signed checkpoints on the Stage 1 interval; failures are logged and alerted."""
    import asyncio
    try:
        await asyncio.wait_for(stop.wait(), timeout=settings.verify_initial_delay_seconds + 15)
        return
    except asyncio.TimeoutError:
        pass
    while not stop.is_set():
        try:
            async with db.engine().connect() as lock_conn:
                got = (await lock_conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _ADVISORY_LOCK})).scalar_one()
                if got:
                    try:
                        results = await verify_all_anchored("SCHEDULED")
                        log.info("scheduled anchored verification: %d chains, %d with problems", len(results),
                                 sum(1 for r in results if r.state not in (sv.VERIFIED, sv.UNSIGNED_EVENTS_PENDING)))
                    finally:
                        await lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _ADVISORY_LOCK})
                await lock_conn.commit()
        except Exception:
            log.exception("scheduled anchored verification failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.verify_interval_seconds)
        except asyncio.TimeoutError:
            pass
