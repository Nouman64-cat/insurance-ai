"""
Idempotent schema migration runner for the tenant-service.

SQLModel's create_all handles brand-new tables. This file handles the harder
case: adding columns to tables that already exist in production. Every entry in
MIGRATIONS must be safe to run multiple times (IF NOT EXISTS / IF EXISTS guards).

Called automatically from the FastAPI lifespan on every uvicorn reload.
Can also be run standalone:

    docker compose exec tenant-service python migrate.py
"""

import asyncio
import logging
import os

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel import SQLModel

log = logging.getLogger(__name__)

DATABASE_URL: str = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://insurance:insurance_secret@postgres:5432/insurance_db",
)

_engine = create_async_engine(DATABASE_URL, echo=False, future=True)

# ── Migration list ────────────────────────────────────────────────────────────
# Append new entries at the bottom. Never edit or remove existing ones.
# create_all handles NEW tables; only column/index changes on EXISTING tables
# belong here.

MIGRATIONS: list[tuple[str, str]] = [
    (
        "v1 — add is_active to tenants",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE",
    ),
    # Next migration goes here, e.g.:
    # (
    #     "v2 — add phone to users",
    #     "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30)",
    # ),
]

# ── Runner ────────────────────────────────────────────────────────────────────

async def run_migrations() -> None:
    import shared.models.core  # noqa: F401 — registers all SQLModel metadata

    async with _engine.begin() as conn:
        # 1. Create any tables that do not yet exist (fully idempotent).
        await conn.run_sync(SQLModel.metadata.create_all)
        log.info("create_all complete")

        # 2. Apply column / index changes to existing tables.
        for label, sql in MIGRATIONS:
            await conn.execute(text(sql))
            log.info("applied: %s", label)

    log.info("all migrations complete")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
    asyncio.run(run_migrations())
