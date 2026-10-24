"""Real PostgreSQL control history, atomic audit writes, runtime snapshots and resume safety."""
import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
from fastapi import FastAPI
from sqlalchemy import text

from app import db
from app.api import archive
from app.archive import configuration as config
from app.archive.scheduler import ArchiveScheduler
from app.auth import Identity, current_identity
from app.config import settings
from tests.archive_support import ArchiveCase


class ConfigurationTests(ArchiveCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.base=replace(settings, archive_test_mode=False, archiving_enabled=True, auto_hot_cleanup=False,
                          environment_label="local-dev", cleanup_mode="detach", hot_retention_months=6)
        await config.initialize(self.base)
        self.identity=Identity(user_id=uuid4(),tenant_id=None,name="Test",email="synthetic@example.invalid",role="SuperAdmin",token="test")
        self.app=FastAPI();self.app.include_router(archive.router)
        self.app.dependency_overrides[current_identity]=lambda:self.identity
        self.http=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url="http://test")

    async def asyncTearDown(self):
        await self.http.aclose()
        await super().asyncTearDown()

    async def put(self, **changes):
        row=await config.read()
        return await self.http.put('/v1/archive/config',json={'expected_revision':row['revision'],'settings':row['settings']|changes})

    async def test_persistence_rbac_validation_and_conflicts(self):
        row=await config.read()
        self.identity=replace(self.identity,role='Admin')
        self.assertEqual((await self.http.get('/v1/archive/config')).status_code,403)
        self.assertEqual((await self.put(archiving_enabled=False)).status_code,403)
        self.identity=replace(self.identity,role='SuperAdmin')
        saved=await self.put(archive_interval_seconds=10,archive_compression='none',archiving_enabled=False)
        self.assertEqual(saved.status_code,200,saved.text)
        self.assertEqual(saved.json()['revision'],row['revision']+1)
        await config.initialize(replace(self.base, archive_interval_seconds=999))
        self.assertEqual((await config.read())['settings']['archive_interval_seconds'],10)
        stale=await self.http.put('/v1/archive/config',json={'expected_revision':row['revision'],'settings':row['settings']})
        self.assertEqual(stale.status_code,409)
        for changes in ({'archive_interval_seconds':0},{'hot_retention_months':-1},{'archive_compression':'gzip'},
                        {'archive_test_mode':True,'environment_label':'production'},{'archiving_enabled':'false'}, {'writer_secret':'forbidden'}):
            response=await self.put(**changes)
            self.assertEqual(response.status_code,422,response.text)

    async def test_configuration_and_audit_commit_or_rollback_together(self):
        before=await config.read()
        with patch.object(config.audit_service,'append_to_chain',side_effect=RuntimeError('ledger unavailable')):
            with self.assertRaises(RuntimeError):
                await config.update(config.ArchiveUpdate(expected_revision=before['revision'],settings=before['settings']|{'hot_retention_months':2}),self.identity)
        self.assertEqual((await config.read())['revision'],before['revision'])
        rows=await self.fetch("SELECT hot_retention_months FROM retention_policies WHERE superseded_at IS NULL AND tenant_id IS NULL")
        self.assertTrue(all(r['hot_retention_months']==6 for r in rows))
        response=await self.put(hot_retention_months=2)
        self.assertEqual(response.status_code,200,response.text)
        audit=await self.fetch("SELECT new_value FROM events WHERE action='archive.configuration.updated' ORDER BY sequence_number DESC LIMIT 1")
        self.assertEqual(audit[0]['new_value']['hot_retention_months'],2)
        rows=await self.fetch("SELECT hot_retention_months FROM retention_policies WHERE superseded_at IS NULL AND tenant_id IS NULL")
        self.assertTrue(all(r['hot_retention_months']==2 for r in rows))
        async with db.transaction() as conn:
            await conn.execute(text("INSERT INTO retention_policies (tenant_id, category, hot_retention_months, created_by) VALUES (:t, 'claims', 9, 'explicit-admin')"),{'t':uuid4()})
        await self.put(hot_retention_months=1)
        rows=await self.fetch("SELECT hot_retention_months FROM retention_policies WHERE created_by='explicit-admin'")
        self.assertEqual(rows[0]['hot_retention_months'],9)

    async def test_configuration_history_is_append_only(self):
        for sql in ("UPDATE archive_configuration_versions SET updated_by='attacker'", "DELETE FROM archive_configuration_versions", "TRUNCATE archive_configuration_versions"):
            with self.assertRaises(Exception):
                async with db.transaction() as conn:
                    await conn.execute(text(sql))

    async def test_permanent_automatic_drop_requires_explicit_confirmation(self):
        row=await config.read()
        body={'expected_revision':row['revision'],'settings':row['settings']|{'auto_hot_cleanup':True,'cleanup_mode':'drop'}}
        self.assertEqual((await self.http.put('/v1/archive/config',json=body)).status_code,422)
        response=await self.http.put('/v1/archive/config',json=body|{'confirmation':'ENABLE-AUTOMATIC-DROP'})
        self.assertEqual(response.status_code,200,response.text)

    async def test_workers_refresh_without_restart_and_pause_when_disabled(self):
        def build(effective, signer, instance):
            return SimpleNamespace(worker=SimpleNamespace(config=effective,plan=AsyncMock(return_value=[]),process_due=AsyncMock(return_value=[])),
                cleanup=SimpleNamespace(promote=AsyncMock(return_value=[]),remove=AsyncMock()),
                retrieval=SimpleNamespace(process_pending=AsyncMock(),expire=AsyncMock()))
        with patch('app.archive.service.build',side_effect=build):
            runtime=config.RuntimeArchive(self.base,None,'runtime-test')
            self.app.state.archive_runtime=runtime
            first,old,services=await runtime.snapshot()
            scheduler=ArchiveScheduler(services,config=old,runtime=runtime)
            await scheduler.tick()
            services.worker.plan.assert_awaited_once()
            response=await self.put(archiving_enabled=False,archive_compression='none')
            self.assertEqual(response.status_code,200)
            self.assertTrue(runtime.changed.is_set())
            self.assertEqual((await self.http.post('/v1/archive/run',json={'dry_run':True})).status_code,409)
            await scheduler.tick()
            self.assertFalse(scheduler.config.archiving_enabled)
            scheduler.s.worker.plan.assert_not_awaited()
            scheduler.s.worker.process_due.assert_not_awaited()
            scheduler.s.cleanup.remove.assert_not_awaited()
            scheduler.s.retrieval.process_pending.assert_awaited_once()
            self.assertTrue(old.archiving_enabled)
            self.assertEqual(old.archive_compression,'zstd')
            await self.put(archiving_enabled=True)
            await scheduler.tick()
            scheduler.s.worker.plan.assert_awaited_once()
            scheduler.s.worker.process_due.assert_awaited_once()
            with patch.object(config,'read',side_effect=RuntimeError('database unavailable')):
                with self.assertRaises(RuntimeError):await scheduler.tick()
            self.assertEqual((await config.read())['settings']['archive_compression'],'none')

    async def test_queued_and_retried_jobs_keep_their_compression_snapshot(self):
        chain=await self.aged_events(12,months_ago=8)
        await self.checkpoint(chain)
        worker=self.worker()
        planned=await worker.plan(chain_id=chain)
        self.assertEqual(len(planned),1)
        self.store.down=True
        first=await worker.run_job(planned[0].job_id)
        self.assertEqual(first.status,'FAILED')
        self.store.down=False
        # A different worker revision resumes the exported job after a configuration change.
        worker.config=replace(worker.config, archive_compression='none', lock_days=90)
        outcome=await worker.run_job(planned[0].job_id)
        self.assertEqual(outcome.status,'DONE')
        rows=await self.catalog(chain)
        self.assertEqual(rows[0]['compression_algorithm'],'zstd')
