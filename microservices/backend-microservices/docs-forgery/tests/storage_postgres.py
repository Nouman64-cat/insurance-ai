"""Isolated real-PostgreSQL migration, tenant isolation and privilege tests. No model calls."""
import asyncio
import json
import secrets
import unittest
from unittest.mock import patch
from uuid import uuid4
from urllib.parse import urlsplit,urlunsplit
import asyncpg
from fastapi import HTTPException
import result_store as store
from scripts.provision_results import urls,provision,DDL

class StorageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        owner,_=urls(); base=urlsplit(owner)
        self.admin=await asyncpg.connect(urlunsplit(base._replace(path='/postgres')))
        suffix=uuid4().hex[:10];self.db='forgery-test-'+suffix
        self.owner='forgery_owner_'+suffix;self.app='forgery_app_'+suffix
        self.password=secrets.token_urlsafe(32)
        await self.admin.execute('CREATE DATABASE "'+self.db+'"')
        self.conn=await asyncpg.connect(urlunsplit(base._replace(path='/'+self.db)))
        self.tenant,self.other,self.actor,self.legacy_id=uuid4(),uuid4(),uuid4(),uuid4()
        await self.conn.execute('CREATE SCHEMA dev')
        await self.conn.execute(DDL.replace('docs_forgery.','dev.'))
        await self.conn.execute('ALTER TABLE dev.document_intelligence_results ALTER COLUMN status DROP DEFAULT, ALTER COLUMN created_at DROP DEFAULT')
        self.report={'verdict':'review','findings':[{'detail':'Synthetic evidence'}],'pixel_forensics':{'map':'synthetic'},'incomplete':[]}
        await self.conn.execute("INSERT INTO dev.document_intelligence_results (id,tenant_id,created_by,filename,sha256,size_bytes,options,report,status,verdict,created_at) VALUES($1,$2,$3,'legacy.pdf','hash',12,'{}',$4,'completed','review',timezone('utc',now()))",self.legacy_id,self.tenant,self.actor,json.dumps(self.report))
        self.assertEqual(await provision(self.conn,self.password,owner_role=self.owner,app_role=self.app),1)
        app_url=urlunsplit(base._replace(netloc=self.app+':'+self.password+'@'+base.netloc.split('@',1)[1],path='/'+self.db))
        self.env=patch.dict('os.environ',{'DOCS_FORGERY_DATABASE_URL':app_url});self.env.start()
        await store.initialize()

    async def asyncTearDown(self):
        await store.close();self.env.stop();await self.conn.close()
        await self.admin.execute('DROP DATABASE "'+self.db+'" WITH (FORCE)')
        await self.admin.execute('DROP ROLE "'+self.app+'"');await self.admin.execute('DROP ROLE "'+self.owner+'"')
        await self.admin.close()

    async def test_migration_is_idempotent_and_preserves_reports(self):
        self.assertIsNone(await self.conn.fetchval("SELECT to_regclass('dev.document_intelligence_results')"))
        row=await store.get(self.tenant,self.legacy_id)
        self.assertEqual(row['report'],self.report)
        self.assertEqual(row['created_by'],self.actor)
        self.assertEqual(await provision(self.conn,self.password,owner_role=self.owner,app_role=self.app),0)
        self.assertEqual((await store.get(self.tenant,self.legacy_id))['report'],self.report)

    async def test_private_crud_and_pool_context(self):
        created=await store.create(self.tenant,self.actor,'new.pdf','hash',1,{'layer3':True})
        saved=await store.finish(self.tenant,created['id'],report=self.report)
        self.assertEqual(saved['report'],self.report)
        self.assertEqual(saved['status'],'completed')
        self.assertEqual((await store.listing(self.tenant))['total'],2)
        self.assertEqual((await store.listing(self.other))['total'],0)
        with self.assertRaises(HTTPException) as error:await store.get(self.other,created['id'])
        self.assertEqual(error.exception.status_code,404)
        async with store._pool.acquire() as conn:
            self.assertEqual(await conn.fetchval('SELECT count(*) FROM '+store.TABLE),0)
        await store.finish(self.tenant,created['id'],error='Synthetic failure')
        self.assertEqual((await store.get(self.tenant,created['id']))['status'],'failed')

    async def test_runtime_cannot_access_other_schemas_ddl_or_delete(self):
        async with store._pool.acquire() as conn:
            for sql in ('CREATE SCHEMA not_allowed','CREATE TABLE docs_forgery.not_allowed(id int)','SELECT * FROM dev.document_intelligence_results','DELETE FROM '+store.TABLE):
                with self.assertRaises(asyncpg.InsufficientPrivilegeError):await conn.execute(sql)
        async with store.connection(self.tenant) as conn:
            with self.assertRaises(asyncpg.InsufficientPrivilegeError):
                await conn.execute('INSERT INTO '+store.TABLE+" (id,tenant_id,created_by,filename,sha256,size_bytes,options) VALUES($1,$2,$3,'x','h',1,'{}')",uuid4(),self.other,self.actor)

if __name__ == '__main__':unittest.main(verbosity=2)
