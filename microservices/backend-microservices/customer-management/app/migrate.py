"""Versioned migrations for the customer_management schema.

Migrations are the numbered SQL files in ../migrations. Each runs once, in its own transaction, and is recorded with
its checksum in customer_management.schema_migrations; an applied file that has since been edited stops the run (fix
forward with a new file). A Postgres advisory lock keeps two starting replicas from migrating at once.

    python -m app.migrate            # apply pending migrations
    python -m app.migrate --status   # list applied / pending
"""
import asyncio
import hashlib
import logging
import os
import sys
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import settings

log = logging.getLogger("customer-management.migrate")
MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
LOCK_ID = 74_210_332


def migration_files() -> list[tuple[str, str, str]]:
    out = []
    for path in sorted(MIGRATIONS_DIR.glob("[0-9][0-9][0-9][0-9]_*.sql")):
        version, name = path.stem.split("_", 1)
        out.append((version, name, path.read_text()))
    return out


def checksum(sql: str) -> str:
    return hashlib.sha256(sql.encode()).hexdigest()


def statements(sql: str) -> list[str]:
    lines = [line for line in sql.splitlines() if not line.strip().startswith("--")]
    return [s.strip() for s in "\n".join(lines).split(";") if s.strip()]


async def apply_grants(conn, schema: str) -> None:
    """Row-level access for the application role, re-applied every run so a new table is never left without (or with
    too many) privileges. Audit rows can be added, never changed."""
    app_role = os.environ.get("CM_DB_APP_ROLE", "customer_management_app")
    if not (await conn.execute(text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": app_role})).first():
        log.warning("application role %s does not exist; run app.provision", app_role)
        return
    await conn.execute(text(f'GRANT USAGE ON SCHEMA "{schema}" TO {app_role}'))
    await conn.execute(text(f'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "{schema}" TO {app_role}'))
    await conn.execute(text(f'REVOKE UPDATE, DELETE, TRUNCATE ON "{schema}".security_events FROM {app_role}'))
    await conn.execute(text(f'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "{schema}".schema_migrations FROM {app_role}'))
    await conn.execute(text(f'GRANT USAGE ON ALL SEQUENCES IN SCHEMA "{schema}" TO {app_role}'))


async def run(url: str | None = None, schema: str | None = None) -> list[str]:
    url = url or settings.migration_database_url
    schema = schema or settings.schema
    if not url:
        raise RuntimeError("CM_MIGRATION_DATABASE_URL is not set")
    engine = create_async_engine(url, connect_args={"server_settings": {"search_path": schema}})
    applied: list[str] = []
    try:
        async with engine.begin() as conn:
            await conn.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": LOCK_ID})
            await conn.execute(text(f'CREATE TABLE IF NOT EXISTS "{schema}".schema_migrations '
                                    "(version TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"))
            done = {r[0]: r[1] for r in (await conn.execute(text(f'SELECT version, checksum FROM "{schema}".schema_migrations'))).all()}
            for version, name, sql in migration_files():
                digest = checksum(sql)
                if version in done:
                    if done[version] != digest:
                        raise RuntimeError(f"applied migration {version}_{name} was modified; add a new migration instead")
                    continue
                for stmt in statements(sql):
                    await conn.execute(text(stmt))
                await conn.execute(text(f'INSERT INTO "{schema}".schema_migrations (version, name, checksum) VALUES (:v, :n, :c)'),
                                   {"v": version, "n": name, "c": digest})
                applied.append(f"{version}_{name}")
            await apply_grants(conn, schema)
    finally:
        await engine.dispose()
    return applied


async def status(url: str | None = None, schema: str | None = None) -> list[tuple[str, bool]]:
    url = url or settings.migration_database_url
    schema = schema or settings.schema
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            try:
                done = {r[0] for r in (await conn.execute(text(f'SELECT version FROM "{schema}".schema_migrations'))).all()}
            except Exception:
                done = set()
    finally:
        await engine.dispose()
    return [(f"{v}_{n}", v in done) for v, n, _ in migration_files()]


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if "--status" in sys.argv:
        for name, ok in asyncio.run(status()):
            print(("applied  " if ok else "pending  ") + name)
    else:
        print("applied:", asyncio.run(run()) or "nothing (up to date)")
