"""tenant-service's handle on the evaluation data lake (shared/evaluation): one DataLake per process, built from the
environment (EVAL_LAKE_*, see .env.example) and this service's database sessions.
"""
from __future__ import annotations

import logging
from functools import lru_cache

from shared.evaluation.config import load_settings
from shared.evaluation.lake import DataLake
from shared.evaluation.object_store import get_store

log = logging.getLogger("tenant-service.eval-lake")


@lru_cache(maxsize=1)
def get_lake() -> DataLake:
    import database

    settings = load_settings()
    # Looked up on every call, so a session factory swapped in by a test is honoured.
    return DataLake(get_store(settings), settings, lambda: database._session_factory())


async def warm_up_lake() -> None:
    """Startup work that must never stop the service: prepare the bucket, then finish or clean up interrupted publications."""
    try:
        lake = get_lake()
        await lake.ensure_ready()
        report = await lake.reconcile()
        if report.finalized or report.failed or report.skipped:
            log.info("evaluation lake reconcile: finalized=%s failed=%s skipped=%s", report.finalized, report.failed, report.skipped)
    except Exception as exc:    # noqa: BLE001
        log.warning("The evaluation data lake is not ready (%s). It is prepared again on first use.", exc)
