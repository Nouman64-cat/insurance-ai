"""Versioned migrations for the request_management schema.

Migrations are the numbered SQL files in ../migrations (0001_initial.sql, 0002_...). Each runs once, in its own
transaction, and is recorded with its checksum in request_management.schema_migrations; an applied file that has
since been edited stops the run (fix forward with a new file instead). A Postgres advisory lock keeps two starting
replicas from migrating at once. No create_all: the SQL files are the schema.

Run as the schema owner (REQUEST_MGMT_MIGRATION_DATABASE_URL):

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

log = logging.getLogger("request-management.migrate")
MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
LOCK_ID = 74_210_331  # arbitrary, constant: this service's migration lock


def migration_files() -> list[tuple[str, str, str]]:
    """(version, name, sql) in order."""
    out = []
    for path in sorted(MIGRATIONS_DIR.glob("[0-9][0-9][0-9][0-9]_*.sql")):
        version, name = path.stem.split("_", 1)
        out.append((version, name, path.read_text()))
    return out


def checksum(sql: str) -> str:
    return hashlib.sha256(sql.encode()).hexdigest()


async def apply_grants(conn, schema: str) -> None:
    """Row-level access for the application role on everything the migrations created; re-applied every run so a
    new table is never left without (or with too many) privileges. Audit rows can be added, never changed."""
    app_role = os.environ.get("REQUEST_MGMT_DB_APP_ROLE", "request_mgmt_app")
    if not (await conn.execute(text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": app_role})).first():
        log.warning("application role %s does not exist; run app.provision", app_role)
        return
    await conn.execute(text(f'GRANT USAGE ON SCHEMA "{schema}" TO {app_role}'))
    await conn.execute(text(f'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "{schema}" TO {app_role}'))
    await conn.execute(text(f'REVOKE UPDATE, DELETE, TRUNCATE ON "{schema}".audit_events FROM {app_role}'))
    await conn.execute(text(f'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "{schema}".schema_migrations FROM {app_role}'))
    await conn.execute(text(f'GRANT USAGE ON ALL SEQUENCES IN SCHEMA "{schema}" TO {app_role}'))


async def run(url: str | None = None, schema: str | None = None) -> list[str]:
    url = url or settings.migration_database_url
    schema = schema or settings.schema
    if not url:
        raise RuntimeError("REQUEST_MGMT_MIGRATION_DATABASE_URL is not set")
    engine = create_async_engine(url)
    applied_now: list[str] = []
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT pg_advisory_lock(:id)"), {"id": LOCK_ID})
            try:
                # Normally created by app.provision (the owner has no CREATE on the database); create it only when missing.
                if not (await conn.execute(text("SELECT 1 FROM information_schema.schemata WHERE schema_name = :s"), {"s": schema})).first():
                    await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
                await conn.execute(text(f'''CREATE TABLE IF NOT EXISTS "{schema}".schema_migrations (
                    version TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'''))
                await conn.commit()
                done = {row.version: row.checksum for row in (await conn.execute(
                    text(f'SELECT version, checksum FROM "{schema}".schema_migrations'))).all()}
                for version, name, sql in migration_files():
                    if version in done:
                        if done[version] != checksum(sql):
                            raise RuntimeError(f"Migration {version}_{name} was changed after it was applied; add a new migration instead")
                        continue
                    # The file sets its own search_path; this keeps a non-default schema name working too.
                    body = sql.replace("SET search_path TO request_management;", f'SET search_path TO "{schema}";')
                    await conn.execute(text(f'SET search_path TO "{schema}"'))
                    # A migration file holds many statements: run it through the driver's simple-query protocol, on this
                    # connection and inside its open transaction (the version row below commits with it).
                    raw = await conn.get_raw_connection()
                    await raw.driver_connection.execute(body)
                    await conn.execute(text(f'INSERT INTO "{schema}".schema_migrations (version, name, checksum) VALUES (:v, :n, :c)'),
                                       {"v": version, "n": name, "c": checksum(sql)})
                    await conn.commit()
                    applied_now.append(f"{version}_{name}")
                    log.info("applied migration %s_%s", version, name)
                await apply_grants(conn, schema)
                await conn.commit()
            except Exception:
                await conn.rollback()
                raise
            finally:
                await conn.execute(text("SELECT pg_advisory_unlock(:id)"), {"id": LOCK_ID})
                await conn.commit()
    finally:
        await engine.dispose()
    return applied_now


async def status(url: str | None = None, schema: str | None = None) -> None:
    engine = create_async_engine(url or settings.migration_database_url)
    schema = schema or settings.schema
    try:
        async with engine.connect() as conn:
            try:
                done = {r.version for r in (await conn.execute(text(f'SELECT version FROM "{schema}".schema_migrations'))).all()}
            except Exception:
                done = set()
        for version, name, _ in migration_files():
            print(f"{'applied' if version in done else 'PENDING'}  {version}_{name}")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if "--status" in sys.argv:
        asyncio.run(status())
    else:
        print("applied:", asyncio.run(run()) or "nothing (up to date)")
