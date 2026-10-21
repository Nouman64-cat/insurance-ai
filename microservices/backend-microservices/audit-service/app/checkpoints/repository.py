"""SQL for checkpoints, scheduler state and alerts. Plain functions over the caller's connection."""
import json
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import text

from shared.audit.hashing import format_timestamp


def _dt(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)


def row_to_api(row: Any) -> dict:
    d = dict(row._mapping) if hasattr(row, "_mapping") else dict(row)
    return {
        "checkpoint_id": str(d["checkpoint_id"]), "chain_id": d["chain_id"], "tenant_id": str(d["tenant_id"]) if d["tenant_id"] else None,
        "environment_id": str(d["environment_id"]), "checkpoint_number": d["checkpoint_number"], "start_sequence": d["start_sequence"],
        "end_sequence": d["end_sequence"], "event_count": d["event_count"], "last_event_hash": d["last_event_hash"],
        "previous_checkpoint_hash": d["previous_checkpoint_hash"], "checkpoint_hash": d["checkpoint_hash"],
        "created_at": format_timestamp(d["created_at"]), "signer_id": d["signer_id"], "signing_key_id": d["signing_key_id"],
        "key_version": d["key_version"], "signature_algorithm": d["signature_algorithm"], "payload_version": d["payload_version"],
        "signature": d["signature"], "storage_path": d["storage_path"], "protected_at": format_timestamp(d["protected_at"]),
    }


async def insert_checkpoint(conn, envelope: dict, path: str) -> bool:
    """Record a signed, protected checkpoint. Returns False if this number is already recorded (another instance won)."""
    p = envelope["payload"]
    result = await conn.execute(text("""
        INSERT INTO checkpoints (checkpoint_id, chain_id, tenant_id, environment_id, checkpoint_number, start_sequence, end_sequence, event_count,
            last_event_hash, previous_checkpoint_hash, checkpoint_hash, created_at, signer_id, signing_key_id, key_version, signature_algorithm,
            payload_version, canonical_payload, signature, storage_path, protected_at)
        VALUES (CAST(:id AS uuid), :chain, CAST(:tenant AS uuid), CAST(:env AS uuid), :n, :s, :e, :c, :leh, :pch, :ch, :created, :signer, :kid, :kv, :alg,
            :pv, :canon, :sig, :path, now())
        ON CONFLICT (chain_id, checkpoint_number) DO NOTHING RETURNING checkpoint_id"""),
        {"id": p["checkpoint_id"], "chain": p["chain_id"], "tenant": p["tenant_id"], "env": p["environment_id"], "n": p["checkpoint_number"],
         "s": p["start_sequence"], "e": p["end_sequence"], "c": p["event_count"], "leh": p["last_event_hash"], "pch": p["previous_checkpoint_hash"],
         "ch": envelope["checkpoint_hash"], "created": _dt(p["created_at"]), "signer": p["signer_id"], "kid": p["signing_key_id"], "kv": p["key_version"],
         "alg": p["signature_algorithm"], "pv": p["payload_version"], "canon": envelope["canonical_payload"], "sig": envelope["signature"], "path": path})
    return result.first() is not None


async def last_checkpoint(conn, chain_id: str):
    return (await conn.execute(text("SELECT * FROM checkpoints WHERE chain_id = :c ORDER BY checkpoint_number DESC LIMIT 1"), {"c": chain_id})).first()


async def list_checkpoints(conn, chain_id: str, limit: int = 50, offset: int = 0, descending: bool = True) -> tuple[list, int]:
    order = "DESC" if descending else "ASC"
    total = (await conn.execute(text("SELECT count(*) FROM checkpoints WHERE chain_id = :c"), {"c": chain_id})).scalar_one()
    rows = (await conn.execute(text(f"SELECT * FROM checkpoints WHERE chain_id = :c ORDER BY checkpoint_number {order} LIMIT :l OFFSET :o"),
                               {"c": chain_id, "l": limit, "o": offset})).all()
    return rows, total


async def get_checkpoint(conn, checkpoint_id) -> Any:
    return (await conn.execute(text("SELECT * FROM checkpoints WHERE checkpoint_id = CAST(:i AS uuid)"), {"i": str(checkpoint_id)})).first()


def envelope_from_row(row: Any) -> dict:
    """Rebuild the envelope exactly as stored in the database row (to compare with the trusted file copy)."""
    d = row._mapping
    payload = json.loads(d["canonical_payload"])
    return {"format": 1, "payload": payload, "canonical_payload": d["canonical_payload"], "checkpoint_hash": d["checkpoint_hash"],
            "signature": d["signature"], "signing_key_id": d["signing_key_id"], "key_version": d["key_version"],
            "signature_algorithm": d["signature_algorithm"]}


# ── pending work and progress ───────────────────────────────────────────────────

DUE_QUERY = """
SELECT c.chain_id, c.tenant_id, c.head_sequence, COALESCE(k.end_sequence, 0) AS signed_end, k.checkpoint_number, k.created_at AS last_checkpoint_at,
       c.head_sequence - COALESCE(k.end_sequence, 0) AS pending,
       (SELECT e.recorded_at FROM events e WHERE e.chain_id = c.chain_id AND e.sequence_number = COALESCE(k.end_sequence, 0) + 1) AS oldest_unsigned_at
FROM chains c
LEFT JOIN LATERAL (SELECT end_sequence, checkpoint_number, created_at FROM checkpoints WHERE chain_id = c.chain_id ORDER BY checkpoint_number DESC LIMIT 1) k ON TRUE
{where}
ORDER BY c.chain_id"""


async def chain_progress(conn, chain_id: Optional[str] = None, tenant_id: Optional[str] = "__any__") -> list:
    where, params = "WHERE c.head_sequence > COALESCE(k.end_sequence, 0)", {}
    if chain_id:
        where, params = "WHERE c.chain_id = :c", {"c": chain_id}
    return (await conn.execute(text(DUE_QUERY.format(where=where)), params)).mappings().all()


def is_due(pending: int, oldest_unsigned_at: Optional[datetime], now: datetime, threshold: int, interval: float) -> bool:
    if pending <= 0:
        return False
    if pending >= threshold:
        return True
    return oldest_unsigned_at is not None and (now - oldest_unsigned_at).total_seconds() >= interval


# ── lease / retry state ─────────────────────────────────────────────────────────

async def ensure_state(conn, chain_id: str) -> None:
    await conn.execute(text("INSERT INTO checkpoint_state (chain_id) VALUES (:c) ON CONFLICT (chain_id) DO NOTHING"), {"c": chain_id})


async def acquire_lease(conn, chain_id: str, owner: str, now: datetime, lease_seconds: int) -> bool:
    """Exclusive right to checkpoint this chain for a while. Only one instance can hold it; an expired lease (a crashed
    worker) can be taken over; a chain in retry backoff is skipped until its time."""
    await ensure_state(conn, chain_id)
    row = (await conn.execute(text("""
        UPDATE checkpoint_state SET lease_owner = :o, lease_until = :until, last_attempt_at = :now, updated_at = :now
         WHERE chain_id = :c AND (lease_until IS NULL OR lease_until < :now) AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
        RETURNING chain_id"""),
        {"o": owner, "c": chain_id, "now": now, "until": datetime.fromtimestamp(now.timestamp() + lease_seconds, timezone.utc)})).first()
    return row is not None


async def release_success(conn, chain_id: str, owner: str, now: datetime) -> bool:
    """Clear the lease and failure state. Returns True if an alert had been open (the caller records the recovery)."""
    held = (await conn.execute(text("SELECT alert_open FROM checkpoint_state WHERE chain_id = :c AND lease_owner = :o FOR UPDATE"),
                               {"c": chain_id, "o": owner})).first()
    if held is None:
        return False
    await conn.execute(text("""
        UPDATE checkpoint_state SET lease_owner = NULL, lease_until = NULL, consecutive_failures = 0, next_attempt_at = NULL,
               last_error_code = NULL, last_error = NULL, alert_open = FALSE, updated_at = :now WHERE chain_id = :c"""), {"c": chain_id, "now": now})
    return bool(held.alert_open)


async def release_failure(conn, chain_id: str, owner: str, now: datetime, code: str, message: str, backoff_seconds: float) -> tuple[int, bool]:
    """Record a failed attempt, schedule the retry, release the lease. Returns (failures, alert_was_already_open)."""
    held = (await conn.execute(text("SELECT alert_open, consecutive_failures FROM checkpoint_state WHERE chain_id = :c AND lease_owner = :o FOR UPDATE"),
                               {"c": chain_id, "o": owner})).first()
    if held is None:
        return 0, True
    failures = held.consecutive_failures + 1
    await conn.execute(text("""
        UPDATE checkpoint_state SET lease_owner = NULL, lease_until = NULL, consecutive_failures = :f, next_attempt_at = :next,
               last_error_code = :code, last_error = :msg, alert_open = TRUE, updated_at = :now WHERE chain_id = :c"""),
        {"c": chain_id, "f": failures, "now": now, "code": code, "msg": message[:1000],
         "next": datetime.fromtimestamp(now.timestamp() + backoff_seconds, timezone.utc)})
    return failures, bool(held.alert_open)


async def state_rows(conn) -> list:
    return (await conn.execute(text("SELECT * FROM checkpoint_state ORDER BY chain_id"))).mappings().all()


async def add_alert(conn, chain_id: Optional[str], tenant_id: Optional[str], kind: str, severity: str, message: str, detail: Optional[dict] = None) -> None:
    await conn.execute(text("""INSERT INTO checkpoint_alerts (chain_id, tenant_id, kind, severity, message, detail)
                               VALUES (:c, CAST(:t AS uuid), :k, :s, :m, CAST(:d AS jsonb))"""),
                       {"c": chain_id, "t": tenant_id, "k": kind, "s": severity, "m": message[:1000], "d": json.dumps(detail or {}, default=str)})


async def list_alerts(conn, tenant_id: Optional[str], unrestricted: bool, limit: int = 20) -> list[dict]:
    """Recent alerts, newest first, each flagged `open` while its condition still exists.

    * checkpoint-creation failures (signer/key/storage/integrity) are open only while that chain's checkpointing is still failing
      (checkpoint_state.alert_open) and only the newest such alert of the chain counts; a CHECKPOINT_RECOVERED entry closes them;
    * VERIFICATION_<state> alerts are open only while the chain's latest anchored verification still has that state;
    * informational entries (key rotated, recovered) are never open."""
    where, params = ("", {"l": limit}) if unrestricted else ("WHERE tenant_id = CAST(:t AS uuid)", {"t": tenant_id, "l": limit})
    rows = (await conn.execute(text(f"SELECT * FROM checkpoint_alerts {where} ORDER BY raised_at DESC, id DESC LIMIT :l"), params)).mappings().all()
    failing = {r["chain_id"] for r in (await conn.execute(text("SELECT chain_id FROM checkpoint_state WHERE alert_open"))).mappings().all()}
    latest_state = {r["chain_id"]: r["state"] for r in (await conn.execute(text(
        "SELECT DISTINCT ON (chain_id) chain_id, state FROM anchor_verification_runs ORDER BY chain_id, finished_at DESC"))).mappings().all()}
    failing_archive_chains = {r[0] for r in (await conn.execute(text("SELECT DISTINCT chain_id FROM archive_jobs WHERE state = 'FAILED'"))).all()}
    counted: set = set()
    counted_archive: set = set()
    out = []
    for r in rows:
        kind, chain = r["kind"], r["chain_id"]
        if r["severity"] == "INFO":
            is_open = False
        elif kind.startswith("ARCHIVE_"):
            is_open = chain in failing_archive_chains and chain not in counted_archive
            if is_open:
                counted_archive.add(chain)
        elif kind.startswith("VERIFICATION_"):
            is_open = latest_state.get(chain) == kind[len("VERIFICATION_"):]
        elif chain is not None and chain in failing and chain not in counted:
            is_open = True
            counted.add(chain)
        else:
            is_open = False
        out.append({"id": r["id"], "chain_id": chain, "kind": kind, "severity": r["severity"], "message": r["message"],
                    "detail": r["detail"], "raised_at": format_timestamp(r["raised_at"]), "open": is_open})
    return out


async def progress_for_scope(conn, unrestricted: bool, tenant_id: Optional[str]) -> list:
    """Every chain the caller may see, with its progress toward the next checkpoint (including chains with nothing pending)."""
    if unrestricted:
        return (await conn.execute(text(DUE_QUERY.format(where="")))).mappings().all()
    return (await conn.execute(text(DUE_QUERY.format(where="WHERE c.tenant_id = CAST(:t AS uuid)")), {"t": tenant_id})).mappings().all()


async def anchored_runs(conn, chain_id: Optional[str], tenant_id: Optional[str], unrestricted: bool, limit: int = 20) -> list[dict]:
    clauses, params = [], {"l": limit}
    if chain_id:
        clauses.append("chain_id = :c"); params["c"] = chain_id
    if not unrestricted:
        clauses.append("tenant_id = CAST(:t AS uuid)"); params["t"] = tenant_id
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = (await conn.execute(text(f"SELECT * FROM anchor_verification_runs {where} ORDER BY finished_at DESC LIMIT :l"), params)).mappings().all()
    return [{"run_id": str(r["run_id"]), "chain_id": r["chain_id"], "trigger": r["trigger"], "requested_by": r["requested_by"],
             "verified_at": format_timestamp(r["finished_at"]), "duration_ms": r["duration_ms"], "state": r["state"],
             "hash_chain_valid": r["hash_chain_valid"], "signatures_valid": r["signatures_valid"], "signer_trusted": r["signer_trusted"],
             "anchored": r["anchored"], "pending_events": r["pending_events"], "checkpoints_checked": r["checkpoints_checked"],
             "last_checkpoint_number": r["last_checkpoint_number"], "findings": r["findings"]} for r in rows]
