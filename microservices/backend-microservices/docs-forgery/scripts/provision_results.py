"""Explicit one-off schema/role provisioning; never run in the application process."""
import asyncio
import os
import re
from urllib.parse import urlsplit, urlunsplit, quote
import asyncpg

DDL = '''CREATE TABLE IF NOT EXISTS docs_forgery.document_intelligence_results (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, created_by uuid NOT NULL,
    filename varchar(255) NOT NULL, sha256 varchar(64) NOT NULL, size_bytes bigint NOT NULL,
    status varchar(30) NOT NULL DEFAULT 'processing', verdict varchar(30),
    options jsonb NOT NULL, report jsonb, error varchar(1000),
    created_at timestamp NOT NULL DEFAULT timezone('utc',now()), completed_at timestamp
)'''


def ident(name):
    if not isinstance(name,str) or not name or '\x00' in name: raise ValueError('Invalid SQL identifier')
    return '"'+name.replace('"','""')+'"'


def urls():
    from database_settings import runtime_dsn
    runtime = runtime_dsn()
    parsed = urlsplit(runtime)
    admin = os.getenv('DOCS_FORGERY_MIGRATION_DATABASE_URL')
    if not admin:
        host=parsed.hostname
        if ':' in host: host='['+host+']'
        if parsed.port: host+=':'+str(parsed.port)
        authority=quote(os.environ['POSTGRES_USER'],safe='')+':'+quote(os.environ['POSTGRES_PASSWORD'],safe='')+'@'+host
        admin=urlunsplit((parsed.scheme,authority,parsed.path,parsed.query,parsed.fragment))
    return admin.replace('postgresql+asyncpg://','postgresql://',1),runtime


async def provision(conn, password, source_schema='dev', owner_role='docs_forgery_owner', app_role='docs_forgery_app'):
    source=ident(source_schema)
    owner,app=ident(owner_role),ident(app_role)
    async with conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(672401322)")
        for name,statement in ((owner_role,f'CREATE ROLE {owner} NOLOGIN'),(app_role,f'CREATE ROLE {app} LOGIN')):
            if not await conn.fetchval('SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1)',name):
                await conn.execute(statement)
        literal=await conn.fetchval('SELECT quote_literal($1::text)',password)
        await conn.execute(f'ALTER ROLE {app} PASSWORD {literal} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
        await conn.execute(f'CREATE SCHEMA IF NOT EXISTS docs_forgery AUTHORIZATION {owner}')
        await conn.execute(f'ALTER SCHEMA docs_forgery OWNER TO {owner}')
        await conn.execute('REVOKE ALL ON SCHEMA docs_forgery FROM PUBLIC')
        await conn.execute(f'GRANT USAGE ON SCHEMA docs_forgery TO {app}')
        source_exists=await conn.fetchval('SELECT to_regclass($1) IS NOT NULL',source+'.document_intelligence_results')
        target_exists=await conn.fetchval("SELECT to_regclass('docs_forgery.document_intelligence_results') IS NOT NULL")
        moved=0
        if source_exists:
            if target_exists:
                raise RuntimeError('Both legacy and destination result tables exist; migration stopped without changing either table')
            moved=await conn.fetchval(f'SELECT count(*) FROM {source}.document_intelligence_results')
            await conn.execute(f'LOCK TABLE {source}.document_intelligence_results IN ACCESS EXCLUSIVE MODE')
            await conn.execute(f'ALTER TABLE {source}.document_intelligence_results SET SCHEMA docs_forgery')
        await conn.execute(DDL)
        await conn.execute("ALTER TABLE docs_forgery.document_intelligence_results ALTER COLUMN status SET DEFAULT 'processing', ALTER COLUMN created_at SET DEFAULT timezone('utc',now())")
        # Tenant and actor IDs are verified by the identity API, not by cross-service SQL/FKs.
        keys=await conn.fetch("SELECT conname FROM pg_constraint WHERE conrelid='docs_forgery.document_intelligence_results'::regclass AND contype='f'")
        for key in keys:
            await conn.execute(f'ALTER TABLE docs_forgery.document_intelligence_results DROP CONSTRAINT {ident(key["conname"])}')
        await conn.execute(f'ALTER TABLE docs_forgery.document_intelligence_results OWNER TO {owner}')
        # A moved table may retain old ACLs. Remove grants to every old principal.
        grantees=await conn.fetch("SELECT DISTINCT grantee FROM information_schema.role_table_grants WHERE table_schema='docs_forgery' AND table_name='document_intelligence_results'")
        for row in grantees:
            grantee=row['grantee']
            if grantee != owner_role:
                await conn.execute(f'REVOKE ALL ON docs_forgery.document_intelligence_results FROM {"PUBLIC" if grantee == "PUBLIC" else ident(grantee)}')
        await conn.execute(f'GRANT SELECT,INSERT,UPDATE ON docs_forgery.document_intelligence_results TO {app}')
        for column in ('tenant_id','created_at'):
            await conn.execute(f'CREATE INDEX IF NOT EXISTS document_intelligence_results_{column}_idx ON docs_forgery.document_intelligence_results ({column})')
        await conn.execute('ALTER TABLE docs_forgery.document_intelligence_results ENABLE ROW LEVEL SECURITY')
        await conn.execute('ALTER TABLE docs_forgery.document_intelligence_results FORCE ROW LEVEL SECURITY')
        await conn.execute('DROP POLICY IF EXISTS results_tenant_scope ON docs_forgery.document_intelligence_results')
        await conn.execute(f'''CREATE POLICY results_tenant_scope ON docs_forgery.document_intelligence_results TO {app}
          USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
          WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)''')
        await conn.execute(f'GRANT CONNECT ON DATABASE {ident(await conn.fetchval("SELECT current_database()"))} TO {app}')
    return moved


async def main():
    admin,runtime=urls()
    parsed=urlsplit(runtime)
    if parsed.username != 'docs_forgery_app': raise RuntimeError('Provisioning expects a dedicated docs_forgery_app runtime role')
    from urllib.parse import unquote
    password=unquote(parsed.password or '')
    if len(password)<24: raise RuntimeError('Use a generated runtime password of at least 24 characters')
    conn=await asyncpg.connect(admin)
    try:
        moved=await provision(conn,password,os.getenv('DOCS_FORGERY_LEGACY_SCHEMA','dev'))
        print(f'docs_forgery schema ready; legacy rows moved: {moved}')
    finally:
        await conn.close()

if __name__ == '__main__': asyncio.run(main())
