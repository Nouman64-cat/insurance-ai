"""One-time database provisioning for the Audit Service (run with Postgres admin credentials).

Creates, idempotently:
  * the schema audit, owned by the migration role;
  * AUDIT_DB_OWNER_ROLE (default audit_owner): owns the schema, runs migrations;
  * AUDIT_DB_APP_ROLE (default audit_app): what the service connects as. It can read the ledger, append events and
    call ensure_chain/lock_chain. It has no UPDATE or DELETE on any audit table, no DDL, and no privileges on any other
    service's tables (see app/migrate.py: apply_grants).

    AUDIT_PROVISION_DATABASE_URL=postgresql+asyncpg://postgres:...@host/insurance-ai \
    AUDIT_DB_OWNER_PASSWORD=... AUDIT_DB_APP_PASSWORD=... python -m app.provision
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


async def provision(admin_url: str, schema: str, owner: str, owner_password: str, app: str, app_password: str,
                    signer: str | None = None, signer_password: str | None = None) -> None:
    schema, owner, app = _ident(schema), _ident(owner), _ident(app)
    signer = _ident(signer) if signer and signer_password else None
    database = make_url(admin_url).database
    engine = create_async_engine(admin_url)
    try:
        async with engine.begin() as conn:
            # All service provisioners share this transaction lock: public-schema ACL changes touch the same
            # PostgreSQL catalog row, even for different roles.
            await conn.execute(text("SELECT pg_advisory_xact_lock(731144001)"))
            roles = [(owner, owner_password), (app, app_password)] + ([(signer, signer_password)] if signer else [])
            for role, password in roles:
                exists = (await conn.execute(text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": role})).first()
                verb = "ALTER" if exists else "CREATE"
                await conn.execute(text(f"{verb} ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD {_literal(password)}"))
            await conn.execute(text(f'GRANT CONNECT ON DATABASE "{database}" TO {", ".join([owner, app] + ([signer] if signer else []))}'))
            await conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {schema} AUTHORIZATION {owner}"))
            await conn.execute(text(f"ALTER SCHEMA {schema} OWNER TO {owner}"))
            await conn.execute(text(f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {', '.join([owner, app] + ([signer] if signer else []))}"))
            await conn.execute(text(f"REVOKE CREATE ON SCHEMA public FROM {', '.join([owner, app] + ([signer] if signer else []))}"))
            for role, _ in roles:
                await conn.execute(text(f"ALTER ROLE {role} SET search_path = {schema}"))
    finally:
        await engine.dispose()


def main() -> None:
    admin_url = os.environ.get("AUDIT_PROVISION_DATABASE_URL", "")
    owner_password = os.environ.get("AUDIT_DB_OWNER_PASSWORD", "")
    app_password = os.environ.get("AUDIT_DB_APP_PASSWORD", "")
    if not admin_url or not owner_password or not app_password:
        raise SystemExit("Set AUDIT_PROVISION_DATABASE_URL, AUDIT_DB_OWNER_PASSWORD and AUDIT_DB_APP_PASSWORD")
    asyncio.run(provision(
        admin_url,
        os.environ.get("AUDIT_DB_SCHEMA", "audit"),
        os.environ.get("AUDIT_DB_OWNER_ROLE", "audit_owner"), owner_password,
        os.environ.get("AUDIT_DB_APP_ROLE", "audit_app"), app_password,
        os.environ.get("AUDIT_DB_SIGNER_ROLE", "audit_signer"), os.environ.get("AUDIT_DB_SIGNER_PASSWORD") or None,
    ))
    print("provisioned")


if __name__ == "__main__":
    main()
