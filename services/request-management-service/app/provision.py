"""One-time database provisioning for Request Management (run with Postgres admin credentials).

Creates, idempotently:
  * the schema request_management, owned by the migration role;
  * REQUEST_MGMT_DB_OWNER_ROLE (default request_mgmt_owner): owns the schema, runs migrations;
  * REQUEST_MGMT_DB_APP_ROLE (default request_mgmt_app): what the service connects as. It may read and write rows
    in request_management only (no DDL, no UPDATE/DELETE on audit_events) and has no privileges on any other
    service's tables.

    REQUEST_MGMT_PROVISION_DATABASE_URL=postgresql+asyncpg://postgres:...@host/insurance-ai \
    REQUEST_MGMT_DB_OWNER_PASSWORD=... REQUEST_MGMT_DB_APP_PASSWORD=... python -m app.provision

Moving the service to its own database later: provision there, migrate, copy the schema's data, and change
REQUEST_MGMT_DATABASE_URL / REQUEST_MGMT_MIGRATION_DATABASE_URL. Nothing else refers to the database.
"""
import asyncio
import os
import re

from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

IDENT = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def _ident(value: str) -> str:
    if not IDENT.match(value):
        raise ValueError(f"unsafe identifier: {value!r}")
    return value


def _literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


async def provision(admin_url: str, schema: str, owner: str, owner_password: str, app: str, app_password: str) -> None:
    schema, owner, app = _ident(schema), _ident(owner), _ident(app)
    database = make_url(admin_url).database
    engine = create_async_engine(admin_url)
    try:
        async with engine.begin() as conn:
            # All service provisioners share this transaction lock: public-schema ACL
            # changes touch the same PostgreSQL catalog row, even for different roles.
            await conn.execute(text("SELECT pg_advisory_xact_lock(731144001)"))
            for role, password in ((owner, owner_password), (app, app_password)):
                exists = (await conn.execute(text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": role})).first()
                verb = "ALTER" if exists else "CREATE"
                await conn.execute(text(f"{verb} ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD {_literal(password)}"))
            await conn.execute(text(f'GRANT CONNECT ON DATABASE "{database}" TO {owner}, {app}'))
            await conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {schema} AUTHORIZATION {owner}"))
            await conn.execute(text(f"ALTER SCHEMA {schema} OWNER TO {owner}"))
            # Neither role gets anything in other schemas. (They hold no grants there; this makes it explicit.)
            await conn.execute(text(f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {owner}, {app}"))
            await conn.execute(text(f"REVOKE CREATE ON SCHEMA public FROM {owner}, {app}"))
            for role in (owner, app):
                await conn.execute(text(f"ALTER ROLE {role} SET search_path = {schema}"))
    finally:
        await engine.dispose()


def main() -> None:
    admin_url = os.environ.get("REQUEST_MGMT_PROVISION_DATABASE_URL", "")
    owner_password = os.environ.get("REQUEST_MGMT_DB_OWNER_PASSWORD", "")
    app_password = os.environ.get("REQUEST_MGMT_DB_APP_PASSWORD", "")
    if not admin_url or not owner_password or not app_password:
        raise SystemExit("Set REQUEST_MGMT_PROVISION_DATABASE_URL, REQUEST_MGMT_DB_OWNER_PASSWORD and REQUEST_MGMT_DB_APP_PASSWORD")
    asyncio.run(provision(
        admin_url,
        os.environ.get("REQUEST_MGMT_DB_SCHEMA", "request_management"),
        os.environ.get("REQUEST_MGMT_DB_OWNER_ROLE", "request_mgmt_owner"), owner_password,
        os.environ.get("REQUEST_MGMT_DB_APP_ROLE", "request_mgmt_app"), app_password,
    ))
    print("provisioned")


if __name__ == "__main__":
    main()
