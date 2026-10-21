"""Retrieving archived events. Asynchronous, and never into the live chain.

A request names what is wanted (a chain or sequence range, a time range, an entity / actor / case, a module / action). The service
picks the archives that may contain it (catalog ranges, then the per-archive Bloom filter for entity / actor / case lookups), then a
background job reads each archive back from object storage, VERIFIES it (signed manifest, checksum, every event hash and link), and
copies only the matching events into a staging table, flagged as archived and verified. The live `events` table and the hash chain
are never touched, so retrieval cannot alter, duplicate or re-order history. Staged rows expire (AUDIT_RETRIEVAL_TTL_HOURS).
"""
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

from sqlalchemy import text

from app import db
from app.archive import crypto, format as fmt, repository as repo
from app.archive.store import ObjectStore, StoreError
from app.archive.verify import ArchiveVerifier, ContentError, Finding, verify_content
from app.config import Settings, settings as default_settings
from shared.audit.hashing import format_timestamp

log = logging.getLogger("audit.archive.retrieval")
STAGING_COLUMNS = ["event_id", "chain_id", "sequence_number", "tenant_id", "environment_id", "occurred_at", "recorded_at", "actor_id", "actor_type", "actor_role",
                   "service_name", "module", "action", "entity_type", "entity_id", "case_id", "correlation_id", "source_event_id", "previous_value", "new_value",
                   "outcome", "metadata", "previous_hash", "current_hash", "hash_version"]
CRITERIA_KEYS = {"chain_id", "from_sequence", "to_sequence", "since", "until", "entity_id", "actor_id", "case_id", "module", "action", "archive_ids"}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class RetrievalError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def clean_criteria(criteria: dict) -> dict:
    unknown = set(criteria) - CRITERIA_KEYS
    if unknown:
        raise RetrievalError("BAD_CRITERIA", f"unknown retrieval criteria: {sorted(unknown)}")
    out = {k: v for k, v in criteria.items() if v not in (None, "", [])}
    if not out:
        raise RetrievalError("BAD_CRITERIA", "name at least one criterion (chain, range, time, entity, actor, case, module, action)")
    return out


def matches(record: dict, c: dict) -> bool:
    if "from_sequence" in c and record["sequence_number"] < c["from_sequence"]:
        return False
    if "to_sequence" in c and record["sequence_number"] > c["to_sequence"]:
        return False
    if "since" in c and record["occurred_at"] < c["since"]:
        return False
    if "until" in c and record["occurred_at"] > c["until"]:
        return False
    for key in ("entity_id", "actor_id", "case_id", "module", "action"):
        if key in c and record.get(key) != c[key]:
            return False
    return True


class RetrievalService:
    def __init__(self, reader: ObjectStore, keyring: crypto.KeyRing, verifier: ArchiveVerifier, instance_id: str, *,
                 clock: Callable[[], datetime] = utcnow, config: Settings = default_settings):
        self.reader, self.keyring, self.verifier, self.instance_id, self.clock, self.config = reader, keyring, verifier, instance_id, clock, config

    # ── request ──
    async def request(self, *, tenant_id: Optional[str], unrestricted: bool, requested_by: str, criteria: dict) -> dict:
        criteria = clean_criteria(criteria)
        try:
            since = _parse(criteria["since"]) if "since" in criteria else None
            until = _parse(criteria["until"]) if "until" in criteria else None
        except ValueError:
            raise RetrievalError("BAD_CRITERIA", "since/until must be ISO-8601 timestamps") from None
        if since:
            criteria["since"] = format_timestamp(since)
        if until:
            criteria["until"] = format_timestamp(until)
        async with db.engine().connect() as conn:
            rows, _ = await repo.search_catalog(conn, tenant_id=tenant_id, unrestricted=unrestricted, chain_id=criteria.get("chain_id"), since=since, until=until,
                                                module=criteria.get("module"), action=criteria.get("action"), limit=500, with_bloom=True)
        chosen = []
        wanted = [a for a in criteria.get("archive_ids", [])]
        for row in rows:
            if wanted and str(row["archive_id"]) not in wanted:
                continue
            if "from_sequence" in criteria and row["end_sequence"] < criteria["from_sequence"]:
                continue
            if "to_sequence" in criteria and row["start_sequence"] > criteria["to_sequence"]:
                continue
            bloom = fmt.Bloom(row["chain_id"], row["bloom_bits"], row["bloom_hashes"], bytes(row["bloom"]))
            if any(k in criteria and not bloom.might_contain(kind, criteria[k]) for k, kind in (("entity_id", "entity"), ("actor_id", "actor"), ("case_id", "case"))):
                continue
            chosen.append(row)
        if not chosen:
            raise RetrievalError("NO_ARCHIVES", "no archive can contain events matching these criteria")
        if sum(r["event_count"] for r in chosen) > self.config.retrieval_max_events * 20 and not any(k in criteria for k in ("entity_id", "actor_id", "case_id")):
            raise RetrievalError("TOO_BROAD", "the request would read too many archives; narrow the time range or sequence range")
        scope_tenant = tenant_id if not unrestricted else (str(chosen[0]["tenant_id"]) if chosen[0]["tenant_id"] else None)
        chain = chosen[0]["chain_id"] if len({r["chain_id"] for r in chosen}) == 1 else None
        async with db.transaction() as conn:
            r = (await conn.execute(text("""INSERT INTO archive_retrievals (tenant_id, chain_id, requested_by, criteria, state, archives, expires_at)
                                            VALUES (CAST(:t AS uuid), :c, :by, CAST(:cr AS jsonb), 'PENDING', CAST(:a AS jsonb), :exp) RETURNING *"""),
                                    {"t": scope_tenant, "c": chain, "by": requested_by, "cr": json.dumps(criteria),
                                     "a": json.dumps([{"archive_id": str(x["archive_id"]), "archive_number": x["archive_number"], "chain_id": x["chain_id"]} for x in chosen]),
                                     "exp": self.clock() + timedelta(hours=self.config.retrieval_ttl_hours)})).mappings().one()
        return retrieval_to_api(r)

    # ── processing ──
    async def process_pending(self, limit: int = 5) -> int:
        done = 0
        for _ in range(limit):
            async with db.transaction() as conn:
                row = (await conn.execute(text("""
                    UPDATE archive_retrievals SET state = 'RUNNING', lease_owner = :o, lease_until = :u
                     WHERE retrieval_id = (SELECT retrieval_id FROM archive_retrievals
                                            WHERE (state = 'PENDING' OR (state = 'RUNNING' AND lease_until < :n)) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
                    RETURNING *"""), {"o": self.instance_id, "n": self.clock(), "u": self.clock() + timedelta(seconds=self.config.archive_lease_seconds)})).mappings().first()
            if row is None:
                break
            await self._run(dict(row))
            done += 1
        return done

    async def _run(self, row: dict) -> None:
        rid, criteria = str(row["retrieval_id"]), row["criteria"]
        total, problems, verified = 0, [], True
        try:
            async with db.engine().connect() as conn:
                env = str((await conn.execute(text("SELECT environment_id FROM environment"))).scalar_one())
                await conn.execute(text("SELECT 1"))
            async with db.transaction() as conn:
                await conn.execute(text("DELETE FROM archive_staging WHERE retrieval_id = CAST(:r AS uuid)"), {"r": rid})   # a retry starts clean
            for ref in row["archives"]:
                async with db.engine().connect() as conn:
                    entry = await repo.get_catalog(conn, ref["archive_id"])
                if entry is None:
                    raise RetrievalError("ARCHIVE_NOT_FOUND", f"archive {ref['archive_id']} is not in the catalog")
                entry = dict(entry)
                total += await self._stage(rid, entry, criteria, env, problems, self.config.retrieval_max_events - total)
        except Exception as exc:
            code = getattr(exc, "code", type(exc).__name__)
            message = getattr(exc, "message", str(exc))
            async with db.transaction() as conn:
                await conn.execute(text("DELETE FROM archive_staging WHERE retrieval_id = CAST(:r AS uuid)"), {"r": rid})
                await conn.execute(text("""UPDATE archive_retrievals SET state = 'FAILED', error = :e, finished_at = now(), lease_owner = NULL, lease_until = NULL,
                                           verified = FALSE, event_count = 0 WHERE retrieval_id = CAST(:r AS uuid)"""), {"r": rid, "e": f"{code}: {message}"[:1000]})
            log.error("retrieval %s failed: %s %s", rid, code, message)
            return
        async with db.transaction() as conn:
            await conn.execute(text("""UPDATE archive_retrievals SET state = 'READY', event_count = :n, verified = TRUE, finished_at = now(), lease_owner = NULL, lease_until = NULL,
                                       verification = CAST(:v AS jsonb) WHERE retrieval_id = CAST(:r AS uuid)"""),
                               {"r": rid, "n": total, "v": json.dumps({"archives_verified": len(row["archives"]), "checks": "signed manifest, checksum, decryption, every event hash and link"})})

    async def _stage(self, rid: str, entry: dict, criteria: dict, env: str, problems: list, budget: int) -> int:
        verdict = await self.verifier.verify(entry, deep=False, env=env)
        if verdict.findings:
            raise RetrievalError(verdict.findings[0].code, f"archive {entry['archive_number']} failed verification: {verdict.findings[0].message}")
        manifest = _manifest_of(self.verifier, entry, env)
        work = self.verifier.work_dir
        work.mkdir(parents=True, exist_ok=True)
        local = work / f"retrieve-{rid}-{entry['archive_id']}.iaar"
        staged: list[dict] = []
        try:
            try:
                await asyncio.to_thread(self.reader.get_file, entry["data_key"], local, entry.get("data_version_id"))
            except StoreError as exc:
                raise RetrievalError(exc.code, exc.message) from exc
            collected: list[dict] = []

            def sink(record: dict) -> None:
                if matches(record, criteria):
                    if len(collected) >= budget:
                        raise RetrievalError("TOO_MANY_EVENTS", f"more than {self.config.retrieval_max_events} events match; narrow the request")
                    collected.append(record)

            try:
                await asyncio.to_thread(self._verify_and_collect, local, manifest, sink, entry)
            except crypto.ArchiveCryptoError as exc:
                raise RetrievalError(exc.code, exc.message) from exc
            except ContentError as exc:
                raise RetrievalError(exc.code, exc.message) from exc
            staged = collected
        finally:
            local.unlink(missing_ok=True)
        for i in range(0, len(staged), 500):
            batch = staged[i:i + 500]
            async with db.transaction() as conn:
                await conn.execute(text(f"""INSERT INTO archive_staging (retrieval_id, archive_id, {', '.join(STAGING_COLUMNS)})
                    VALUES (CAST(:retrieval_id AS uuid), CAST(:archive_id AS uuid), CAST(:event_id AS uuid), :chain_id, :sequence_number, CAST(:tenant_id AS uuid),
                            CAST(:environment_id AS uuid), :occurred_at, :recorded_at, :actor_id, :actor_type, :actor_role,
                            :service_name, :module, :action, :entity_type, :entity_id, :case_id, :correlation_id, :source_event_id, CAST(:previous_value AS jsonb),
                            CAST(:new_value AS jsonb), :outcome, CAST(:metadata AS jsonb), :previous_hash, :current_hash, :hash_version)"""),
                                   [{**{k: _staging_value(k, rec[k]) for k in STAGING_COLUMNS}, "retrieval_id": rid, "archive_id": str(entry["archive_id"])} for rec in batch])
        return len(staged)

    def _verify_and_collect(self, local: Path, manifest: dict, sink, entry: dict) -> None:
        import hashlib
        h = hashlib.sha256()
        with open(local, "rb") as f:
            for block in iter(lambda: f.read(1024 * 1024), b""):
                h.update(block)
        if h.hexdigest() != manifest["stored_sha256"]:
            raise RetrievalError("ARCHIVE_CHECKSUM_MISMATCH", f"archive {entry['archive_number']} differs from its signed manifest (replaced or corrupted)")
        verify_content(local, manifest, self.keyring, sink=sink)

    async def expire(self) -> int:
        """Delete staged copies of expired retrievals (the archive itself is untouched)."""
        async with db.transaction() as conn:
            ids = [r[0] for r in (await conn.execute(text("UPDATE archive_retrievals SET state = 'EXPIRED' WHERE state = 'READY' AND expires_at < :n RETURNING retrieval_id"),
                                                      {"n": self.clock()})).all()]
            for rid in ids:
                await conn.execute(text("DELETE FROM archive_staging WHERE retrieval_id = :r"), {"r": rid})
        return len(ids)


def _staging_value(column: str, value):
    if column in ("previous_value", "new_value", "metadata"):
        return None if value is None else json.dumps(value)
    if column in ("occurred_at", "recorded_at"):
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    return value


def _manifest_of(verifier: ArchiveVerifier, entry: dict, env: str) -> dict:
    tenant = str(entry["tenant_id"]) if entry["tenant_id"] else None
    envelope = verifier.storage.read_archive(env, tenant, entry["archive_number"])
    findings: list[Finding] = []
    manifest = verifier.check_manifest_envelope(envelope, entry, env, tenant, findings, entry["archive_number"]) if envelope and not envelope.get("unreadable") else None
    if manifest is None:
        raise RetrievalError("MANIFEST_UNTRUSTED", findings[0].message if findings else "the signed manifest is not in protected storage")
    return manifest


def _parse(value) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def retrieval_to_api(r) -> dict:
    return {"retrieval_id": str(r["retrieval_id"]), "tenant_id": str(r["tenant_id"]) if r["tenant_id"] else None, "chain_id": r["chain_id"], "requested_by": r["requested_by"],
            "criteria": r["criteria"], "state": r["state"], "archives": r["archives"], "event_count": r["event_count"], "verified": r["verified"],
            "verification": r["verification"], "error": r["error"], "created_at": format_timestamp(r["created_at"]),
            "finished_at": format_timestamp(r["finished_at"]) if r["finished_at"] else None, "expires_at": format_timestamp(r["expires_at"])}
