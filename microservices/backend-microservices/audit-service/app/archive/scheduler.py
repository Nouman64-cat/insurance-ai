"""The archive loop: keeps partitions ready, plans and runs archive jobs, promotes finished archives to cleanup-eligible, serves retrievals,
and (only if AUDIT_AUTO_HOT_CLEANUP=true) removes fully archived monthly partitions. Everything is driven by durable state, so a restart
simply resumes; nothing here runs in a business request."""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from app import db
from app.archive.service import ArchiveServices
from app.config import Settings, settings as default_settings
from app.services import audit_service

log = logging.getLogger("audit.archive.scheduler")


class ArchiveScheduler:
    def __init__(self, services: ArchiveServices, config: Settings = default_settings):
        self.s, self.config = services, config
        self._last_plan = 0.0

    async def ensure_partitions(self) -> None:
        """Monthly partitions for this month and the next two exist before events need them (ingest also creates its own on demand)."""
        now = datetime.now(timezone.utc)
        for months in (0, 1, 2):
            year, month = now.year + (now.month - 1 + months) // 12, (now.month - 1 + months) % 12 + 1
            await audit_service.ensure_partition(datetime(year, month, 15, tzinfo=timezone.utc))

    async def tick(self) -> dict:
        loop = asyncio.get_running_loop()
        report: dict = {}
        await self.ensure_partitions()
        if loop.time() - self._last_plan >= self.config.archive_interval_seconds or self.config.archive_test_mode:
            self._last_plan = loop.time()
            report["planned"] = len(await self.s.worker.plan(trigger="SCHEDULED"))
        report["jobs"] = [o.status for o in await self.s.worker.process_due()]
        report["promoted"] = [r["status"] for r in await self.s.cleanup.promote()]
        if self.config.auto_hot_cleanup:
            report["cleanup"] = (await self.s.cleanup.remove(dry_run=False))["removed_months"]
        await self.s.retrieval.process_pending()
        await self.s.retrieval.expire()
        return report

    async def run(self, stop: asyncio.Event) -> None:
        log.info("archive scheduler: every %ss; hot window %d months (%s); cleanup %s%s", self.config.archive_poll_seconds, self.config.hot_retention_months,
                 self.config.archive_schedule, "AUTOMATIC" if self.config.auto_hot_cleanup else "manual only",
                 "; TEST MODE (hot window %ss)" % self.config.archive_test_hot_seconds if self.config.archive_test_mode else "")
        while not stop.is_set():
            try:
                report = await self.tick()
                if any(report.get(k) for k in ("planned", "jobs", "cleanup")):
                    log.info("archive tick: %s", report)
            except Exception:
                log.exception("archive scheduler tick failed")
            try:
                await asyncio.wait_for(stop.wait(), timeout=self.config.archive_poll_seconds)
            except asyncio.TimeoutError:
                pass
