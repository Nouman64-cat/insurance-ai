"""Provision the service-owned schema and restricted database roles."""
import asyncio, os
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

def literal(s): return "'" + s.replace("'", "''") + "'"
async def main():
    url = os.environ['CS_PROVISION_DATABASE_URL']
    engine = create_async_engine(url, isolation_level='AUTOCOMMIT')
    async with engine.connect() as c:
        for role,key in [('customer_service_owner','CS_DB_OWNER_PASSWORD'),('customer_service_app','CS_DB_APP_PASSWORD')]:
            pw=os.environ[key]
            if not pw: raise RuntimeError('Database role passwords are required')
            exists=(await c.execute(text('SELECT 1 FROM pg_roles WHERE rolname=:r'),{'r':role})).first()
            await c.execute(text(f"{'ALTER' if exists else 'CREATE'} ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD {literal(pw)}"))
            await c.execute(text(f'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {role}'))
            await c.execute(text(f'REVOKE CREATE ON SCHEMA public FROM {role}'))
        await c.execute(text('CREATE SCHEMA IF NOT EXISTS customer_service AUTHORIZATION customer_service_owner'))
    await engine.dispose()
if __name__ == '__main__': asyncio.run(main())
