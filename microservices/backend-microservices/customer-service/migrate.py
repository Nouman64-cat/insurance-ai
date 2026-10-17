import asyncio, os, hashlib
from pathlib import Path
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
async def run():
    engine=create_async_engine(os.environ['CS_MIGRATION_DATABASE_URL'])
    async with engine.begin() as c:
        await c.execute(text('SELECT pg_advisory_xact_lock(740210332)'))
        await c.execute(text('CREATE TABLE IF NOT EXISTS customer_service.schema_migrations(version TEXT PRIMARY KEY, checksum TEXT NOT NULL)'))
        for p in sorted(Path('migrations').glob('*.sql')):
            sql=p.read_text(); checksum=hashlib.sha256(sql.encode()).hexdigest()
            old=(await c.execute(text('SELECT checksum FROM customer_service.schema_migrations WHERE version=:v'),{'v':p.name})).scalar()
            if old and old!=checksum: raise RuntimeError('Applied migration modified: '+p.name)
            if not old:
                for statement in sql.split(';'):
                    if statement.strip(): await c.execute(text(statement))
                await c.execute(text('INSERT INTO customer_service.schema_migrations VALUES (:v,:c)'),{'v':p.name,'c':checksum})
        await c.execute(text('GRANT USAGE ON SCHEMA customer_service TO customer_service_app'))
        await c.execute(text('GRANT SELECT, INSERT, UPDATE ON customer_service.tickets TO customer_service_app'))
        await c.execute(text('GRANT SELECT, INSERT ON customer_service.events TO customer_service_app'))
        await c.execute(text('GRANT USAGE ON ALL SEQUENCES IN SCHEMA customer_service TO customer_service_app'))
    await engine.dispose()
if __name__=='__main__': asyncio.run(run())
