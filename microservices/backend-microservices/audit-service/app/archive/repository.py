"""SQL for archive jobs, the catalog, retention policies, legal holds, verification history and retrieval. Plain functions over the
caller's connection; the database triggers (migration 0004) enforce the invariants even if these are bypassed."""
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import text

from shared.audit.hashing import format_timestamp

NON_TERMINAL = ("ELIGIBLE", "VERIFYING", "EXPORTING", "UPLOADING", "VALIDATING")
ARCHIVED_STATES = ("ARCHIVED", "HOT_CLEANUP_ELIGIBLE", "HOT_CLEANUP_COMPLETED")
STATE_ORDER = ("ELIGIBLE", "VERIFYING", "EXPORTING", "UPLOADING", "VALIDATING", "ARCHIVED", "HOT_CLEANUP_ELIGIBLE", "HOT_CLEANUP_COMPLETED")


def _ts(value: Optional[datetime]) -> Optional[str]:
    return format_timestamp(value) if value else None


def _json(value: Any) -> str:
    return json.dumps(value, default=str)


# ── retention policies ───────────────────────────────────────────────────────────────────────────────────
async def policy_rows(conn, tenant_id: Optional[str]) -> list[dict]:
    """The current (non-superseded) policies that apply to a tenant: platform defaults plus its own overrides."""
    rows = (await conn.execute(text("""SELECT * FROM retention_policies WHERE superseded_at IS NULL AND (tenant_id IS NULL OR tenant_id = CAST(:t AS uuid))
                                       ORDER BY category, tenant_id NULLS FIRST"""), {"t": tenant_id})).mappings().all()
    return [dict(r) for r in rows]


def policy_to_api(row: dict) -> dict:
    return {"policy_id": str(row["policy_id"]), "tenant_id": str(row["tenant_id"]) if row["tenant_id"] else None, "category": row["category"],
            "hot_retention_months": row["hot_retention_months"], "cold_retention_years": row["cold_retention_years"],
            "allow_hot_cleanup": row["allow_hot_cleanup"], "approved": row["approved"], "approved_by": row["approved_by"],
            "approved_at": _ts(row["approved_at"]), "notes": row["notes"], "created_by": row["created_by"], "created_at": _ts(row["created_at"]),
            "superseded_at": _ts(row["superseded_at"])}


async def policy_history(conn, tenant_id: Optional[str], unrestricted: bool) -> list[dict]:
    where, params = ("", {}) if unrestricted else ("WHERE tenant_id IS NULL OR tenant_id = CAST(:t AS uuid)", {"t": tenant_id})
    rows = (await conn.execute(text(f"SELECT * FROM retention_policies {where} ORDER BY category, created_at DESC"), params)).mappings().all()
    return [policy_to_api(dict(r)) for r in rows]


async def set_policy(conn, *, tenant_id: Optional[str], category: str, hot_months: int, cold_years: Optional[int], allow_hot_cleanup: bool,
                     approved: bool, actor: str, notes: Optional[str]) -> dict:
    """Supersede the current policy for (tenant, category) and insert the new version. Never edits history."""
    await conn.execute(text("""UPDATE retention_policies SET superseded_at = now()
                               WHERE superseded_at IS NULL AND category = :c AND tenant_id IS NOT DISTINCT FROM CAST(:t AS uuid)"""), {"c": category, "t": tenant_id})
    row = (await conn.execute(text("""
        INSERT INTO retention_policies (tenant_id, category, hot_retention_months, cold_retention_years, allow_hot_cleanup, approved, approved_by, approved_at, notes, created_by)
        VALUES (CAST(:t AS uuid), :c, :h, :y, :a, :ap, CASE WHEN :ap THEN :by END, CASE WHEN :ap THEN now() END, :n, :by) RETURNING *"""),
        {"t": tenant_id, "c": category, "h": hot_months, "y": cold_years, "a": allow_hot_cleanup, "ap": approved, "by": actor, "n": notes})).mappings().one()
    return policy_to_api(dict(row))


# ── legal holds ──────────────────────────────────────────────────────────────────────────────────────────
def hold_to_api(r: Any) -> dict:
    return {"hold_id": str(r["hold_id"]), "tenant_id": str(r["tenant_id"]) if r["tenant_id"] else None, "chain_id": r["chain_id"], "reason": r["reason"],
            "case_reference": r["case_reference"], "placed_by": r["placed_by"], "placed_at": _ts(r["placed_at"]), "released_at": _ts(r["released_at"]),
            "released_by": r["released_by"], "release_reason": r["release_reason"], "active": r["released_at"] is None}


async def place_hold(conn, tenant_id: Optional[str], chain_id: Optional[str], reason: str, case_reference: Optional[str], actor: str) -> dict:
    row = (await conn.execute(text("""INSERT INTO legal_holds (tenant_id, chain_id, reason, case_reference, placed_by)
                                      VALUES (CAST(:t AS uuid), :c, :r, :cr, :by) RETURNING *"""),
                              {"t": tenant_id, "c": chain_id, "r": reason, "cr": case_reference, "by": actor})).mappings().one()
    return hold_to_api(row)


async def release_hold(conn, hold_id: str, reason: str, actor: str) -> Optional[dict]:
    row = (await conn.execute(text("""UPDATE legal_holds SET released_at = now(), released_by = :by, release_reason = :r
                                      WHERE hold_id = CAST(:h AS uuid) AND released_at IS NULL RETURNING *"""), {"h": hold_id, "r": reason, "by": actor})).mappings().first()
    return hold_to_api(row) if row else None


async def list_holds(conn, tenant_id: Optional[str], unrestricted: bool, active_only: bool = False) -> list[dict]:
    clauses, params = [], {}
    if not unrestricted:
        clauses.append("tenant_id = CAST(:t AS uuid)"); params["t"] = tenant_id
    if active_only:
        clauses.append("released_at IS NULL")
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = (await conn.execute(text(f"SELECT * FROM legal_holds {where} ORDER BY placed_at DESC"), params)).mappings().all()
    return [hold_to_api(r) for r in rows]


async def get_hold(conn, hold_id: str):
    return (await conn.execute(text("SELECT * FROM legal_holds WHERE hold_id = CAST(:h AS uuid)"), {"h": hold_id})).mappings().first()


async def active_hold_for(conn, tenant_id: Optional[str], chain_id: str) -> Optional[dict]:
    row = (await conn.execute(text("""SELECT * FROM legal_holds WHERE released_at IS NULL AND tenant_id IS NOT DISTINCT FROM CAST(:t AS uuid)
                                      AND (chain_id IS NULL OR chain_id = :c) LIMIT 1"""), {"t": tenant_id, "c": chain_id})).mappings().first()
    return hold_to_api(row) if row else None


# ── planning inputs ──────────────────────────────────────────────────────────────────────────────────────
CHAIN_PLAN_QUERY = """
SELECT c.chain_id, c.tenant_id, c.head_sequence,
       COALESCE((SELECT max(end_sequence) FROM archive_jobs j WHERE j.chain_id = c.chain_id), 0)  AS planned_end,
       COALESCE((SELECT max(archive_number) FROM archive_jobs j WHERE j.chain_id = c.chain_id), 0) AS last_number,
       EXISTS (SELECT 1 FROM archive_jobs j WHERE j.chain_id = c.chain_id AND j.state = ANY(:open_states)) AS has_open_job
FROM chains c {where} ORDER BY c.chain_id"""


async def chains_for_planning(conn, chain_id: Optional[str] = None) -> list[dict]:
    where, params = ("WHERE c.chain_id = :c", {"c": chain_id}) if chain_id else ("", {})
    params["open_states"] = list(NON_TERMINAL) + ["FAILED"]
    return [dict(r) for r in (await conn.execute(text(CHAIN_PLAN_QUERY.format(where=where)), params)).mappings().all()]


async def last_old_sequence(conn, chain_id: str, cutoff: datetime) -> int:
    """The highest sequence recorded before `cutoff` (0 if none)."""
    return (await conn.execute(text("SELECT COALESCE(max(sequence_number), 0) FROM events WHERE chain_id = :c AND recorded_at < :t"),
                               {"c": chain_id, "t": cutoff})).scalar_one()


async def checkpoint_boundary(conn, chain_id: str, after: int, at_most: int) -> Optional[dict]:
    """The latest checkpoint ending in (after, at_most]: the position an archive may end on."""
    row = (await conn.execute(text("""SELECT checkpoint_number, end_sequence, last_event_hash FROM checkpoints
                                      WHERE chain_id = :c AND end_sequence > :a AND end_sequence <= :m ORDER BY end_sequence DESC LIMIT 1"""),
                              {"c": chain_id, "a": after, "m": at_most})).mappings().first()
    return dict(row) if row else None


async def checkpoint_numbers_for(conn, chain_id: str, start: int, end: int) -> Optional[dict]:
    """first/last checkpoint number covering exactly start..end, if the database has them contiguous (the signer re-derives this itself)."""
    row = (await conn.execute(text("""SELECT min(checkpoint_number) AS first, max(checkpoint_number) AS last, count(*) AS n, min(start_sequence) AS lo, max(end_sequence) AS hi
                                      FROM checkpoints WHERE chain_id = :c AND start_sequence >= :s AND end_sequence <= :e"""),
                              {"c": chain_id, "s": start, "e": end})).mappings().first()
    if not row or not row["n"] or row["lo"] != start or row["hi"] != end or row["last"] - row["first"] + 1 != row["n"]:
        return None
    return {"first_number": row["first"], "last_number": row["last"], "count": row["n"]}


async def create_job(conn, *, chain_id: str, tenant_id: Optional[str], number: int, start: int, end: int, trigger: str, requested_by: Optional[str],
                     plan: dict) -> Optional[dict]:
    row = (await conn.execute(text("""
        INSERT INTO archive_jobs (chain_id, tenant_id, archive_number, start_sequence, end_sequence, event_count, state, trigger, requested_by, plan, history)
        VALUES (:c, CAST(:t AS uuid), :n, :s, :e, :cnt, 'ELIGIBLE', :trig, :by, CAST(:p AS jsonb),
                CAST(:h AS jsonb))
        ON CONFLICT DO NOTHING RETURNING *"""),
        {"c": chain_id, "t": tenant_id, "n": number, "s": start, "e": end, "cnt": end - start + 1, "trig": trigger, "by": requested_by, "p": _json(plan),
         "h": _json([{"state": "ELIGIBLE", "at": format_timestamp(datetime.now(timezone.utc)), "note": "planned"}])})).mappings().first()
    return dict(row) if row else None


# ── job leasing and state transitions ────────────────────────────────────────────────────────────────────
async def due_jobs(conn, now: datetime, limit: int = 20) -> list[dict]:
    rows = (await conn.execute(text("""
        SELECT * FROM archive_jobs
         WHERE ((state = ANY(:open) AND (next_attempt_at IS NULL OR next_attempt_at <= :now)) OR (state = 'FAILED' AND next_attempt_at IS NOT NULL AND next_attempt_at <= :now))
           AND (lease_until IS NULL OR lease_until < :now)
         ORDER BY created_at LIMIT :l"""), {"open": list(NON_TERMINAL), "now": now, "l": limit})).mappings().all()
    return [dict(r) for r in rows]


async def acquire_job(conn, job_id, owner: str, now: datetime, lease_seconds: float) -> Optional[dict]:
    """Exclusive right to work on one job. A job whose lease expired (a crashed worker) can be taken over; a FAILED job whose backoff has
    passed resumes in the state it failed in."""
    row = (await conn.execute(text("""
        UPDATE archive_jobs SET lease_owner = :o, lease_until = :until, attempts = attempts + 1, updated_at = :now,
               state = CASE WHEN state = 'FAILED' THEN resume_state ELSE state END
         WHERE job_id = CAST(:j AS uuid) AND (lease_until IS NULL OR lease_until < :now)
           AND (state = ANY(:open) OR (state = 'FAILED' AND next_attempt_at IS NOT NULL AND next_attempt_at <= :now))
           AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
        RETURNING *"""), {"j": str(job_id), "o": owner, "now": now, "until": now + timedelta(seconds=lease_seconds), "open": list(NON_TERMINAL)})).mappings().first()
    return dict(row) if row else None


async def renew_lease(conn, job_id, owner: str, now: datetime, lease_seconds: float) -> bool:
    row = (await conn.execute(text("UPDATE archive_jobs SET lease_until = :u, updated_at = :n WHERE job_id = CAST(:j AS uuid) AND lease_owner = :o RETURNING job_id"),
                              {"j": str(job_id), "o": owner, "n": now, "u": now + timedelta(seconds=lease_seconds)})).first()
    return row is not None


async def advance(conn, job_id, owner: str, new_state: str, note: str, now: datetime, result_patch: Optional[dict] = None, **columns) -> bool:
    """Move a leased job to its next state, appending to its history. The database trigger rejects any illegal transition."""
    extra = "".join(f", {name} = :{name}" for name in columns)
    row = (await conn.execute(text(f"""
        UPDATE archive_jobs SET state = :s, updated_at = :now, last_error_code = NULL, last_error = NULL, next_attempt_at = NULL,
               history = history || CAST(:h AS jsonb), result = result || CAST(:r AS jsonb),
               completed_at = CASE WHEN :s = 'HOT_CLEANUP_COMPLETED' THEN :now ELSE completed_at END,
               lease_owner = CASE WHEN :s IN ('ARCHIVED', 'HOT_CLEANUP_ELIGIBLE', 'HOT_CLEANUP_COMPLETED') THEN NULL ELSE lease_owner END,
               lease_until = CASE WHEN :s IN ('ARCHIVED', 'HOT_CLEANUP_ELIGIBLE', 'HOT_CLEANUP_COMPLETED') THEN NULL ELSE lease_until END{extra}
         WHERE job_id = CAST(:j AS uuid) AND lease_owner = :o RETURNING job_id"""),
        {"j": str(job_id), "o": owner, "s": new_state, "now": now, "h": _json([{"state": new_state, "at": format_timestamp(now), "note": note}]),
         "r": _json(result_patch or {}), **columns})).first()
    return row is not None


async def advance_system(conn, job_id, from_state: str, to_state: str, note: str, now: datetime, result_patch: Optional[dict] = None) -> bool:
    """Cleanup-phase transitions need no lease: they are guarded by the expected current state instead (and by the database trigger)."""
    row = (await conn.execute(text("""
        UPDATE archive_jobs SET state = :s, updated_at = :now, history = history || CAST(:h AS jsonb), result = result || CAST(:r AS jsonb),
               completed_at = CASE WHEN :s = 'HOT_CLEANUP_COMPLETED' THEN :now ELSE completed_at END
         WHERE job_id = CAST(:j AS uuid) AND state = :f RETURNING job_id"""),
        {"j": str(job_id), "f": from_state, "s": to_state, "now": now, "h": _json([{"state": to_state, "at": format_timestamp(now), "note": note}]),
         "r": _json(result_patch or {})})).first()
    return row is not None


async def fail_job(conn, job: dict, owner: str, now: datetime, code: str, message: str, retry_in: Optional[float]) -> bool:
    """Park the job as FAILED remembering where to resume; retry_in=None means a person must intervene (manual retry)."""
    resume = job["state"] if job["state"] != "FAILED" else job["resume_state"]
    row = (await conn.execute(text("""
        UPDATE archive_jobs SET state = 'FAILED', resume_state = :resume, last_error_code = :code, last_error = :msg, updated_at = :now,
               next_attempt_at = :next, lease_owner = NULL, lease_until = NULL, history = history || CAST(:h AS jsonb)
         WHERE job_id = CAST(:j AS uuid) AND lease_owner = :o RETURNING job_id"""),
        {"j": str(job["job_id"]), "o": owner, "resume": resume, "code": code, "msg": message[:1000], "now": now,
         "next": (now + timedelta(seconds=retry_in)) if retry_in is not None else None,
         "h": _json([{"state": "FAILED", "at": format_timestamp(now), "note": f"{code}: {message[:200]}", "resume": resume}])})).first()
    return row is not None


async def request_retry(conn, job_id: str, now: datetime) -> bool:
    row = (await conn.execute(text("UPDATE archive_jobs SET next_attempt_at = :n WHERE job_id = CAST(:j AS uuid) AND state = 'FAILED' RETURNING job_id"),
                              {"j": job_id, "n": now})).first()
    return row is not None


def job_to_api(r: Any) -> dict:
    r = dict(r)
    return {"job_id": str(r["job_id"]), "chain_id": r["chain_id"], "tenant_id": str(r["tenant_id"]) if r["tenant_id"] else None,
            "archive_number": r["archive_number"], "start_sequence": r["start_sequence"], "end_sequence": r["end_sequence"], "event_count": r["event_count"],
            "state": r["state"], "resume_state": r["resume_state"], "attempts": r["attempts"], "last_error_code": r["last_error_code"],
            "last_error": r["last_error"], "next_attempt_at": _ts(r["next_attempt_at"]), "trigger": r["trigger"], "requested_by": r["requested_by"],
            "cleanup_after": _ts(r["cleanup_after"]), "created_at": _ts(r["created_at"]), "updated_at": _ts(r["updated_at"]),
            "completed_at": _ts(r["completed_at"]), "history": r["history"], "result": r["result"], "plan": r["plan"]}


async def list_jobs(conn, tenant_id: Optional[str], unrestricted: bool, states: Optional[list[str]] = None, limit: int = 50) -> list[dict]:
    clauses, params = [], {"l": limit}
    if not unrestricted:
        clauses.append("tenant_id = CAST(:t AS uuid)"); params["t"] = tenant_id
    if states:
        clauses.append("state = ANY(:s)"); params["s"] = states
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = (await conn.execute(text(f"SELECT * FROM archive_jobs {where} ORDER BY updated_at DESC LIMIT :l"), params)).mappings().all()
    return [job_to_api(r) for r in rows]


async def get_job(conn, job_id: str):
    return (await conn.execute(text("SELECT * FROM archive_jobs WHERE job_id = CAST(:j AS uuid)"), {"j": job_id})).mappings().first()


# ── catalog ──────────────────────────────────────────────────────────────────────────────────────────────
CATALOG_API_COLUMNS = """archive_id, job_id, chain_id, tenant_id, environment_id, archive_number, archive_version, start_sequence, end_sequence, event_count,
    first_previous_hash, last_event_hash, previous_archive_hash, manifest_hash, archive_checksum, size_bytes, uncompressed_bytes, compression_algorithm,
    encryption_algorithm, kek_id, object_prefix, data_key, manifest_key, signature_key, checkpoints_key, data_version_id, lock_mode, lock_retain_until,
    covered_checkpoints, first_occurred_at, last_occurred_at, first_recorded_at, last_recorded_at, modules, actions, entity_types, bloom_bits, bloom_hashes,
    retention_policy_id, retention_until, cleanup_approved_at, created_at"""


def catalog_to_api(r: Any) -> dict:
    r = dict(r)
    out = {k: (str(v) if isinstance(v, UUID) else v) for k, v in r.items() if k not in ("bloom", "data_version_id")}
    for name in ("first_occurred_at", "last_occurred_at", "first_recorded_at", "last_recorded_at", "created_at", "cleanup_approved_at", "lock_retain_until"):
        out[name] = _ts(r.get(name))
    out["retention_until"] = r["retention_until"].isoformat() if r.get("retention_until") else None
    out["ratio"] = round(r["uncompressed_bytes"] / r["size_bytes"], 2) if r.get("size_bytes") else None
    return out


async def insert_catalog(conn, f: dict) -> None:
    columns = ", ".join(f)
    values = ", ".join(("CAST(:%s AS jsonb)" % k) if k == "covered_checkpoints" else ("CAST(:%s AS uuid)" % k) if k in
                       ("archive_id", "job_id", "tenant_id", "environment_id", "retention_policy_id") else ":" + k for k in f)
    params = {k: (_json(v) if k == "covered_checkpoints" else v) for k, v in f.items()}
    await conn.execute(text(f"INSERT INTO archive_catalog ({columns}) VALUES ({values})"), params)


async def catalog_for_chain(conn, chain_id: str, columns: str = CATALOG_API_COLUMNS) -> list:
    return (await conn.execute(text(f"SELECT {columns} FROM archive_catalog WHERE chain_id = :c ORDER BY archive_number"), {"c": chain_id})).mappings().all()


async def get_catalog(conn, archive_id: str, with_bloom: bool = False):
    cols = CATALOG_API_COLUMNS + (", bloom" if with_bloom else "")
    return (await conn.execute(text(f"SELECT {cols} FROM archive_catalog WHERE archive_id = CAST(:a AS uuid)"), {"a": archive_id})).mappings().first()


async def search_catalog(conn, *, tenant_id: Optional[str], unrestricted: bool, chain_id: Optional[str] = None, since: Optional[datetime] = None,
                         until: Optional[datetime] = None, module: Optional[str] = None, action: Optional[str] = None, limit: int = 50, offset: int = 0,
                         with_bloom: bool = False) -> tuple[list, int]:
    clauses, params = [], {"l": limit, "o": offset}
    if not unrestricted:
        clauses.append("tenant_id = CAST(:t AS uuid)"); params["t"] = tenant_id
    if chain_id:
        clauses.append("chain_id = :c"); params["c"] = chain_id
    if since:
        clauses.append("last_occurred_at >= :since"); params["since"] = since
    if until:
        clauses.append("first_occurred_at <= :until"); params["until"] = until
    if module:
        clauses.append(":m = ANY(modules)"); params["m"] = module
    if action:
        clauses.append(":a = ANY(actions)"); params["a"] = action
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    total = (await conn.execute(text(f"SELECT count(*) FROM archive_catalog {where}"), params)).scalar_one()
    cols = CATALOG_API_COLUMNS + (", bloom" if with_bloom else "")
    rows = (await conn.execute(text(f"SELECT {cols} FROM archive_catalog {where} ORDER BY first_occurred_at DESC, archive_number DESC LIMIT :l OFFSET :o"), params)).mappings().all()
    return rows, total


async def approve_cleanup(conn, archive_id: str) -> bool:
    row = (await conn.execute(text("UPDATE archive_catalog SET cleanup_approved_at = now() WHERE archive_id = CAST(:a AS uuid) AND cleanup_approved_at IS NULL RETURNING archive_id"),
                              {"a": archive_id})).first()
    return row is not None


# ── verification history ─────────────────────────────────────────────────────────────────────────────────
async def add_verification(conn, archive_id: str, kind: str, state: str, code: Optional[str], details: dict, requested_by: Optional[str], duration_ms: int) -> str:
    row = (await conn.execute(text("""INSERT INTO archive_verifications (archive_id, kind, state, code, details, requested_by, duration_ms)
                                      VALUES (CAST(:a AS uuid), :k, :s, :c, CAST(:d AS jsonb), :by, :ms) RETURNING verification_id"""),
                              {"a": archive_id, "k": kind, "s": state, "c": code, "d": _json(details), "by": requested_by, "ms": duration_ms})).scalar_one()
    return str(row)


async def verifications_for(conn, archive_id: str, limit: int = 20) -> list[dict]:
    rows = (await conn.execute(text("SELECT * FROM archive_verifications WHERE archive_id = CAST(:a AS uuid) ORDER BY verified_at DESC LIMIT :l"),
                               {"a": archive_id, "l": limit})).mappings().all()
    return [{"verification_id": str(r["verification_id"]), "kind": r["kind"], "state": r["state"], "code": r["code"], "details": r["details"],
             "requested_by": r["requested_by"], "duration_ms": r["duration_ms"], "verified_at": _ts(r["verified_at"])} for r in rows]


async def last_verification(conn, archive_id: str, kinds: tuple = ("INTAKE", "DEEP", "CLEANUP_GATE")):
    return (await conn.execute(text("""SELECT * FROM archive_verifications WHERE archive_id = CAST(:a AS uuid) AND kind = ANY(:k)
                                       ORDER BY verified_at DESC LIMIT 1"""), {"a": archive_id, "k": list(kinds)})).mappings().first()


# ── runs ─────────────────────────────────────────────────────────────────────────────────────────────────
async def start_run(conn, trigger: str, dry_run: bool, requested_by: Optional[str]) -> str:
    return str((await conn.execute(text("INSERT INTO archive_runs (trigger, dry_run, requested_by) VALUES (:t, :d, :b) RETURNING run_id"),
                                   {"t": trigger, "d": dry_run, "b": requested_by})).scalar_one())


async def finish_run(conn, run_id: str, jobs_created: int, summary: dict, error: Optional[str] = None) -> None:
    await conn.execute(text("UPDATE archive_runs SET finished_at = now(), jobs_created = :j, summary = CAST(:s AS jsonb), error = :e WHERE run_id = CAST(:r AS uuid)"),
                       {"r": run_id, "j": jobs_created, "s": _json(summary), "e": error})


async def recent_runs(conn, limit: int = 10) -> list[dict]:
    rows = (await conn.execute(text("SELECT * FROM archive_runs ORDER BY started_at DESC LIMIT :l"), {"l": limit})).mappings().all()
    return [{"run_id": str(r["run_id"]), "trigger": r["trigger"], "dry_run": r["dry_run"], "requested_by": r["requested_by"], "started_at": _ts(r["started_at"]),
             "finished_at": _ts(r["finished_at"]), "jobs_created": r["jobs_created"], "summary": r["summary"], "error": r["error"]} for r in rows]


# ── summary for the dashboard ────────────────────────────────────────────────────────────────────────────
async def summary(conn, tenant_id: Optional[str], unrestricted: bool) -> dict:
    scope, params = ("", {}) if unrestricted else ("WHERE tenant_id = CAST(:t AS uuid)", {"t": tenant_id})
    cat = (await conn.execute(text(f"""SELECT count(*) AS archives, COALESCE(sum(event_count), 0) AS events, COALESCE(sum(size_bytes), 0) AS stored,
                                              COALESCE(sum(uncompressed_bytes), 0) AS plain, min(first_occurred_at) AS first_at, max(last_occurred_at) AS last_at,
                                              max(created_at) AS last_archived, count(*) FILTER (WHERE cleanup_approved_at IS NOT NULL) AS cleanup_approved
                                       FROM archive_catalog {scope}"""), params)).mappings().one()
    jobs = {r["state"]: r["n"] for r in (await conn.execute(text(f"SELECT state, count(*) AS n FROM archive_jobs {scope} GROUP BY state"), params)).mappings().all()}
    return {"archives": cat["archives"], "archived_events": int(cat["events"]), "stored_bytes": int(cat["stored"]), "uncompressed_bytes": int(cat["plain"]),
            "compression_ratio": round(cat["plain"] / cat["stored"], 2) if cat["stored"] else None, "first_event_at": _ts(cat["first_at"]),
            "last_event_at": _ts(cat["last_at"]), "last_archived_at": _ts(cat["last_archived"]), "cleanup_approved": cat["cleanup_approved"], "jobs": jobs}
