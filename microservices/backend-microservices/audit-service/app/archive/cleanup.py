"""Removing archived events from hot storage: a SEPARATE step from archiving, never automatic unless explicitly enabled.

Two stages, both re-checked at the moment they act:

  promote   ARCHIVED -> HOT_CLEANUP_ELIGIBLE. After the safety period, the archive is re-verified IN FULL from object storage
            (signature, checksum, decrypt, every event hash), no legal hold may apply, and the tenant's retention policy must allow
            hot cleanup. Only then does the catalog entry get its one-time cleanup approval.
  remove    Whole monthly partitions only, never single rows. The database function remove_event_partition() independently refuses
            any partition holding an event that is not covered by an approved archive, any chain under legal hold, or the current
            month. By default the partition is DETACHED (kept as a standalone table, re-attachable); 'drop' must be chosen explicitly.

Removing events from PostgreSQL does not remove them from the ledger's history: the archive, the signed manifest and the signed
checkpoints keep proving them, and the hot chain remains verifiable from the archive boundary.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from sqlalchemy import text

from app import db
from app.archive import policy as pol, repository as repo
from app.archive.verify import ArchiveVerifier
from app.config import Settings, settings as default_settings
from shared.audit.hashing import format_timestamp

log = logging.getLogger("audit.archive.cleanup")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def month_start(value: datetime) -> datetime:
    return datetime(value.year, value.month, 1, tzinfo=timezone.utc)


def next_month(value: datetime) -> datetime:
    return datetime(value.year + (value.month == 12), value.month % 12 + 1, 1, tzinfo=timezone.utc)


class CleanupService:
    def __init__(self, verifier: ArchiveVerifier, *, clock: Callable[[], datetime] = utcnow, config: Settings = default_settings):
        self.verifier, self.clock, self.config = verifier, clock, config

    # ── promotion ──────────────────────────────────────────────────────────────────────────────────────
    async def promote(self, *, requested_by: str = "archive-scheduler", ignore_safety_period: bool = False, job_ids: Optional[list[str]] = None) -> list[dict]:
        now = self.clock()
        async with db.engine().connect() as conn:
            env = str((await conn.execute(text("SELECT environment_id FROM environment"))).scalar_one())
            jobs = (await conn.execute(text("SELECT * FROM archive_jobs WHERE state = 'ARCHIVED' ORDER BY created_at"))).mappings().all()
        out = []
        for job in jobs:
            if job_ids and str(job["job_id"]) not in job_ids:
                continue
            if not ignore_safety_period and job["cleanup_after"] and job["cleanup_after"] > now:
                out.append({"job_id": str(job["job_id"]), "chain_id": job["chain_id"], "status": "WAITING", "reason": f"safety period until {format_timestamp(job['cleanup_after'])}"})
                continue
            out.append(await self._gate(job, env, now, requested_by))
        return out

    async def _gate(self, job, env: str, now: datetime, requested_by: str) -> dict:
        tenant = str(job["tenant_id"]) if job["tenant_id"] else None
        base = {"job_id": str(job["job_id"]), "chain_id": job["chain_id"], "archive_number": job["archive_number"]}
        async with db.engine().connect() as conn:
            hold = await repo.active_hold_for(conn, tenant, job["chain_id"])
            policies = pol.resolve(await repo.policy_rows(conn, tenant), self.config.hot_retention_months)
            row = await repo.catalog_for_chain(conn, job["chain_id"], "*")
        if hold:
            return {**base, "status": "BLOCKED", "reason": f"legal hold {hold['hold_id']} applies"}
        if not pol.hot_cleanup_allowed(policies):
            return {**base, "status": "BLOCKED", "reason": "the retention policy does not allow hot cleanup for this tenant"}
        entry = next((dict(r) for r in row if r["archive_number"] == job["archive_number"]), None)
        if entry is None:
            return {**base, "status": "BLOCKED", "reason": "the archive is not in the catalog"}
        verification = await self.verifier.verify(entry, deep=True, env=env)
        async with db.transaction() as conn:
            await repo.add_verification(conn, str(entry["archive_id"]), "CLEANUP_GATE", verification.state, verification.code,
                                        {"findings": [f.to_api() for f in verification.findings], **verification.details}, requested_by, verification.duration_ms)
            if verification.findings:
                return {**base, "status": "BLOCKED", "reason": f"archive verification failed: {verification.findings[0].code}: {verification.findings[0].message}"}
            await repo.approve_cleanup(conn, str(entry["archive_id"]))
            await repo.advance_system(conn, job["job_id"], "ARCHIVED", "HOT_CLEANUP_ELIGIBLE", "re-verified in full; cleanup approved", now)
        return {**base, "status": "ELIGIBLE", "reason": "re-verified; cleanup approved"}

    # ── removal ────────────────────────────────────────────────────────────────────────────────────────
    async def analyse(self) -> list[dict]:
        """Every past monthly partition and whether (and why not) it could be removed right now. Pure reading; mirrors the database's own checks."""
        now = self.clock()
        current = month_start(now)
        async with db.engine().connect() as conn:
            partitions = [dict(r) for r in (await conn.execute(text("SELECT * FROM list_event_partitions() ORDER BY month_start"))).mappings().all()]
            report = []
            for part in partitions:
                lo = datetime(part["month_start"].year, part["month_start"].month, 1, tzinfo=timezone.utc)
                item = {"partition": part["partition_name"], "month": lo.strftime("%Y-%m"), "events": part["row_count"], "bytes": part["total_bytes"], "status": "REMOVABLE", "reasons": []}
                if lo >= current:
                    item["status"], item["reasons"] = "KEEP", ["the current or a future month"]
                elif part["row_count"] == 0:
                    item["status"], item["reasons"] = "EMPTY", ["no events"]
                else:
                    groups = (await conn.execute(text("""SELECT chain_id, tenant_id, max(sequence_number) AS top FROM events
                                                         WHERE recorded_at >= :lo AND recorded_at < :hi GROUP BY chain_id, tenant_id"""),
                                                 {"lo": lo, "hi": next_month(lo)})).mappings().all()
                    for g in groups:
                        covered = (await conn.execute(text("SELECT cleanup_approved_at, archive_number FROM archive_catalog WHERE chain_id = :c AND end_sequence >= :t ORDER BY archive_number LIMIT 1"),
                                                      {"c": g["chain_id"], "t": g["top"]})).first()
                        if covered is None:
                            item["reasons"].append(f"{g['chain_id']}: events up to {g['top']} are not archived")
                        elif covered.cleanup_approved_at is None:
                            item["reasons"].append(f"{g['chain_id']}: archive {covered.archive_number} is not yet approved for cleanup (safety period / re-verification)")
                        hold = await repo.active_hold_for(conn, str(g["tenant_id"]) if g["tenant_id"] else None, g["chain_id"])
                        if hold:
                            item["reasons"].append(f"{g['chain_id']}: legal hold {hold['hold_id']}")
                    if item["reasons"]:
                        item["status"] = "BLOCKED"
                report.append(item)
        return report

    async def remove(self, *, dry_run: bool, mode: Optional[str] = None, requested_by: str = "archive-scheduler") -> dict:
        mode = mode or self.config.cleanup_mode
        if mode not in ("detach", "drop"):
            raise ValueError("cleanup mode must be 'detach' or 'drop'")
        report = await self.analyse()
        removed = []
        for item in report:
            if requested_by == "archive-scheduler" and hasattr(self, "runtime_read"):
                current = await self.runtime_read()
                controls = current["settings"]
                if current["revision"] != self.configuration_revision or not controls["archiving_enabled"] or not controls["auto_hot_cleanup"]:
                    break
            if item["status"] != "REMOVABLE":
                continue
            if dry_run:
                item["action"] = f"would {mode}"
                continue
            month = datetime.strptime(item["month"] + "-01", "%Y-%m-%d").date()
            try:
                async with db.transaction() as conn:
                    count = (await conn.execute(text("SELECT remove_event_partition(:m, :mode)"), {"m": month, "mode": mode})).scalar_one()
                item["action"], item["removed_events"] = mode + "ed" if mode == "detach" else "dropped", count
                removed.append(item["month"])
                log.warning("hot cleanup: %s partition %s (%d events) by %s", mode, item["partition"], count, requested_by)
            except Exception as exc:       # the database's own checks refused: nothing was changed
                item["status"], item["reasons"], item["action"] = "BLOCKED", [f"the database refused: {str(exc).splitlines()[0][:200]}"], "none"
        completed = 0 if dry_run else await self._complete_jobs()
        return {"dry_run": dry_run, "mode": mode, "partitions": report, "removed_months": removed, "jobs_completed": completed}

    async def _complete_jobs(self) -> int:
        now, done = self.clock(), 0
        async with db.engine().connect() as conn:
            jobs = (await conn.execute(text("SELECT job_id, chain_id, start_sequence, end_sequence FROM archive_jobs WHERE state = 'HOT_CLEANUP_ELIGIBLE'"))).mappings().all()
            finished = []
            for j in jobs:
                left = (await conn.execute(text("SELECT 1 FROM events WHERE chain_id = :c AND sequence_number BETWEEN :s AND :e LIMIT 1"),
                                           {"c": j["chain_id"], "s": j["start_sequence"], "e": j["end_sequence"]})).first()
                if left is None:
                    finished.append(j["job_id"])
        for job_id in finished:
            async with db.transaction() as conn:
                if await repo.advance_system(conn, job_id, "HOT_CLEANUP_ELIGIBLE", "HOT_CLEANUP_COMPLETED", "events removed from hot storage", now):
                    done += 1
        return done
