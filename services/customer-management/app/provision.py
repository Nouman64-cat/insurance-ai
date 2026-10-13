"""One-time database provisioning for Customer Management (run with Postgres admin credentials).

Creates, idempotently:
  * the schema customer_management, owned by the migration role;
  * CM_DB_OWNER_ROLE (default customer_management_owner): owns the schema, runs migrations;
  * CM_DB_APP_ROLE (default customer_management_app): what the service connects as. Row access in customer_management
    only (no DDL; append-only audit tables), and no privileges on any other service's tables.

    CM_PROVISION_DATABASE_URL=postgresql+asyncpg://postgres:...@host/insurance-ai \
    CM_DB_OWNER_PASSWORD=... CM_DB_APP_PASSWORD=... python -m app.provision
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
    if not owner_password or not app_password:
        raise RuntimeError("CM_DB_OWNER_PASSWORD and CM_DB_APP_PASSWORD are required")
    database = make_url(admin_url).database
    engine = create_async_engine(admin_url, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as conn:
            for role, password in ((owner, owner_password), (app, app_password)):
                exists = (await conn.execute(text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": role})).first()
                verb = "ALTER" if exists else "CREATE"
                await conn.execute(text(f"{verb} ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD {_literal(password)}"))
            await conn.execute(text(f'GRANT CONNECT ON DATABASE "{database}" TO {owner}, {app}'))
            await conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {schema} AUTHORIZATION {owner}"))
            await conn.execute(text(f"ALTER SCHEMA {schema} OWNER TO {owner}"))
            # Neither role gets anything in the shared public schema.
            for role in (owner, app):
                await conn.execute(text(f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {role}"))
                await conn.execute(text(f"REVOKE CREATE ON SCHEMA public FROM {role}"))
    finally:
        await engine.dispose()


async def main() -> None:
    await provision(
        os.environ["CM_PROVISION_DATABASE_URL"], os.environ.get("CM_DB_SCHEMA", "customer_management"),
        os.environ.get("CM_DB_OWNER_ROLE", "customer_management_owner"), os.environ.get("CM_DB_OWNER_PASSWORD", ""),
        os.environ.get("CM_DB_APP_ROLE", "customer_management_app"), os.environ.get("CM_DB_APP_PASSWORD", ""))
    print("customer_management schema and roles are ready")


if __name__ == "__main__":
    asyncio.run(main())
