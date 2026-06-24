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
    (
        "v2a — add username to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255)",
    ),
    (
        "v2b — backfill username",
        "UPDATE users SET username = email WHERE username IS NULL",
    ),
    (
        "v2c — set username not null",
        "ALTER TABLE users ALTER COLUMN username SET NOT NULL",
    ),
    (
        "v2d — drop constraint if exists",
        "ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_username",
    ),
    (
        "v2e — add unique constraint",
        "ALTER TABLE users ADD CONSTRAINT uq_users_username UNIQUE (username)",
    ),
    (
        "v2f — add user_type_id to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS user_type_id UUID REFERENCES user_types(id)",
    ),
    (
        "v2g — add status to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE'",
    ),
    (
        "v2h — add is_verified to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE",
    ),
    (
        "v2i — add failed_login_count to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0",
    ),
    (
        "v2j — add last_login to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP WITH TIME ZONE",
    ),
    (
        "v2k — add is_deleted to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE",
    ),
    (
        "v2l — add updated_at to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()",
    ),
    (
        "v3 — add details to applicants",
        "ALTER TABLE applicants ADD COLUMN IF NOT EXISTS details JSON",
    ),
    (
        "v4a — add case_id to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS case_id UUID REFERENCES cases(caseld)",
    ),
    (
        "v4b — add uploaded_by to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES users(id)",
    ),
    (
        "v4c — add file_name to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS file_name VARCHAR(255)",
    ),
    (
        "v4d — add file_size to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS file_size INTEGER",
    ),
    (
        "v4e — add file_type to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS file_type VARCHAR(100)",
    ),
    (
        "v4f — add storage_url to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS storage_url VARCHAR(1000)",
    ),
    (
        "v4g — add ocr_result to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS ocr_result TEXT",
    ),
    (
        "v4h — set default for ocr_confidence_score",
        "ALTER TABLE artifacts ALTER COLUMN ocr_confidence_score SET DEFAULT 0.0",
    ),
    (
        "v4i — set default for authenticity_score",
        "ALTER TABLE artifacts ALTER COLUMN authenticity_score SET DEFAULT 1.0",
    ),
    (
        "v4j — set default for quality_score",
        "ALTER TABLE artifacts ALTER COLUMN quality_score SET DEFAULT 1.0",
    ),
    (
        "v4k — set default for status",
        "ALTER TABLE artifacts ALTER COLUMN status SET DEFAULT 'Processing'",
    ),
]

# ── Runner ────────────────────────────────────────────────────────────────────

async def _create_enums_idempotent(conn) -> None:
    """Create all PostgreSQL enum types in the metadata using DO blocks.

    Using DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$
    makes this safe on both a fresh DB and a restart with an existing volume —
    the second case previously caused UniqueViolationError on casetypeenum etc.
    """
    from sqlalchemy import Enum as SAEnum

    seen: set[str] = set()
    for table in SQLModel.metadata.sorted_tables:
        for column in table.columns:
            if (
                isinstance(column.type, SAEnum)
                and column.type.name
                and column.type.name not in seen
            ):
                seen.add(column.type.name)
                values_str = ", ".join(f"'{v}'" for v in column.type.enums)
                await conn.execute(text(f"""
                    DO $$ BEGIN
                        CREATE TYPE {column.type.name} AS ENUM ({values_str});
                    EXCEPTION WHEN duplicate_object THEN NULL;
                    END $$;
                """))
    log.info("enums created/verified: %s", sorted(seen))


async def _seed_user_types(conn) -> None:
    from uuid import uuid4
    from datetime import datetime

    user_types = [
        ("Admin", "System administrator with full permissions"),
        ("Underwriter", "Insurance underwriter evaluating risk"),
        ("Agent", "Insurance agent managing clients and policies"),
        ("BancassuranceOfficer", "Bancassurance officer selling products through bank channel")
    ]
    for name, desc in user_types:
        res = await conn.execute(text("SELECT id FROM user_types WHERE type_name = :name"), {"name": name})
        row = res.first()
        if not row:
            await conn.execute(
                text("INSERT INTO user_types (id, type_name, description, is_active, created_at) "
                     "VALUES (:id, :name, :desc, true, :created_at)"),
                {"id": str(uuid4()), "name": name, "desc": desc, "created_at": datetime.utcnow()}
            )


async def run_migrations() -> None:
    import shared.models.core  # noqa: F401 — registers all SQLModel metadata

    async with _engine.begin() as conn:
        # 1. Create enum types idempotently before create_all so that restarts
        #    with an existing volume do not raise UniqueViolationError.
        await _create_enums_idempotent(conn)

        # 2. Tell SQLAlchemy the enum types already exist so create_all only
        #    issues CREATE TABLE statements (never CREATE TYPE).
        from sqlalchemy import Enum as SAEnum
        for table in SQLModel.metadata.sorted_tables:
            for column in table.columns:
                if isinstance(column.type, SAEnum):
                    column.type.create_type = False

        # 3. Create any tables that do not yet exist (fully idempotent).
        await conn.run_sync(SQLModel.metadata.create_all)
        log.info("create_all complete")

        # 2. Apply column / index changes to existing tables.
        for label, sql in MIGRATIONS:
            await conn.execute(text(sql))
            log.info("applied: %s", label)

        # 3. Seed user types.
        await _seed_user_types(conn)
        log.info("seed_user_types complete")

    log.info("all migrations complete")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
    asyncio.run(run_migrations())
