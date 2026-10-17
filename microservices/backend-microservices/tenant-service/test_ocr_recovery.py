"""Failure and retry regressions; no provider calls or production data."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4
import httpx
from fastapi import HTTPException
import ocr_worker as worker
from routers import underwriting_tracks as tracks
from shared.events.kafka_events import ArtifactOCRPayload, ArtifactOCRRequestedEvent


class ProcessingTests(IsolatedAsyncioTestCase):
    def event(self):
        return ArtifactOCRRequestedEvent(tenant_id=uuid4(), payload=ArtifactOCRPayload(
            artifact_id=uuid4(), tenant_id=uuid4(), case_id=uuid4(), s3_key='synthetic/key',
            file_name='report.pdf', mime_type='application/pdf'))

    async def run_processing(self, failure):
        event = self.event()
        with patch.object(worker, '_download_from_s3', return_value=b'pdf'), \
             patch.object(worker, '_run_ocr', AsyncMock(side_effect=failure)) as ocr, \
             patch.object(worker, '_set_processing_status', AsyncMock()) as status, \
             patch.object(worker, '_update_artifact', AsyncMock()) as result, \
             patch.object(worker.asyncio, 'sleep', AsyncMock()):
            await worker._process(event)
            return event, ocr, status, result

    async def test_terminal_service_failure_is_retryable_not_unreadable(self):
        error = httpx.HTTPStatusError('provider config', request=httpx.Request('POST', 'http://ocr/extract'), response=httpx.Response(422))
        event, ocr, status, result = await self.run_processing(error)
        self.assertEqual(ocr.await_count, 1)
        status.assert_awaited_with(event.payload.artifact_id, 'Processing Failed')
        result.assert_not_awaited()

    async def test_transient_failure_retries_then_accepts_real_text(self):
        text = 'Synthetic physician evidence. ' * 12
        event, ocr, status, result = await self.run_processing([httpx.ConnectError('down'), text])
        self.assertEqual(ocr.await_count, 2)
        result.assert_awaited_once_with(event.payload.artifact_id, text, 0.9, 'Accepted')
        status.assert_awaited_once_with(event.payload.artifact_id, 'Processing')

    async def test_exhausted_retries_persist_failure(self):
        event, ocr, status, result = await self.run_processing(httpx.ReadTimeout('slow'))
        self.assertEqual(ocr.await_count, 3)
        status.assert_awaited_with(event.payload.artifact_id, 'Processing Failed')
        result.assert_not_awaited()

    async def test_storage_outage_is_not_an_unreadable_file(self):
        event = self.event()
        with patch.object(worker, '_download_from_s3', side_effect=RuntimeError('unavailable')), \
             patch.object(worker, '_set_processing_status', AsyncMock()) as status:
            await worker._process(event)
        status.assert_awaited_with(event.payload.artifact_id, 'Processing Failed')


class StalledTests(TestCase):
    def test_old_pending_upload_and_fresh_retry(self):
        artifact = SimpleNamespace(status='Uploaded', extracted_metadata={}, created_at=datetime.utcnow()-timedelta(hours=1))
        self.assertTrue(worker.processing_stalled(artifact))
        artifact.extracted_metadata={'processing_started_at':datetime.now(timezone.utc).isoformat()}
        self.assertFalse(worker.processing_stalled(artifact))
        artifact.status='Accepted'
        self.assertFalse(worker.processing_stalled(artifact))


class RetryTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.user=SimpleNamespace(id=uuid4())
        self.tenant, self.case, self.id = uuid4(), uuid4(), uuid4()
        self.artifact=SimpleNamespace(id=self.id, status='Processing Failed', file_name='report.pdf', file_type='application/pdf',
            storage_url='local://synthetic/report.pdf', extracted_metadata={}, created_at=datetime.utcnow())
        self.workspace={'read_only':False, 'review':{'assigned_user_id':str(self.user.id)}, 'documents':[{'id':str(self.id)}]}
        self.producer=SimpleNamespace(send_and_wait=AsyncMock())
        self.request=SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(kafka_producer=self.producer)))
        self.session=SimpleNamespace(exec=AsyncMock(return_value=SimpleNamespace(one=lambda:self.artifact)), add=Mock(), commit=AsyncMock())

    async def retry(self):
        with patch.object(tracks, '_specialist_identity', AsyncMock(return_value=(self.user,'MEDICAL'))), \
             patch.object(tracks, '_build_workspace', AsyncMock(return_value=self.workspace)):
            return await tracks.retry_specialist_document(self.request,self.tenant,self.case,self.id,self.session,'token')

    async def test_requeues_stored_file_and_resets_timeout(self):
        result=await self.retry()
        self.assertEqual(result['status'],'Uploaded')
        event=ArtifactOCRRequestedEvent.model_validate_json(self.producer.send_and_wait.call_args.kwargs['value'])
        self.assertEqual(event.payload.s3_key,'synthetic/report.pdf')
        self.assertEqual(event.payload.artifact_id,self.id)
        self.assertIn('processing_started_at',self.artifact.extracted_metadata)

    async def test_active_job_and_accepted_document_cannot_be_requeued(self):
        for status in ['Uploaded','Processing','Accepted','Waived']:
            self.artifact.status=status
            with self.assertRaises(HTTPException) as raised: await self.retry()
            self.assertEqual(raised.exception.status_code,409)
        self.producer.send_and_wait.assert_not_awaited()

    async def test_held_unassigned_and_out_of_track_documents_are_denied(self):
        for changes, code in [({'read_only':True},409), ({'review':{'assigned_user_id':str(uuid4())}},409), ({'documents':[]},404)]:
            saved=self.workspace.copy(); self.workspace.update(changes)
            with self.assertRaises(HTTPException) as raised: await self.retry()
            self.assertEqual(raised.exception.status_code,code)
            self.workspace=saved
        self.producer.send_and_wait.assert_not_awaited()

    async def test_queue_outage_leaves_visible_failure(self):
        self.producer.send_and_wait.side_effect=RuntimeError('queue down')
        with self.assertRaises(HTTPException) as raised: await self.retry()
        self.assertEqual(raised.exception.status_code,503)
        self.assertEqual(self.artifact.status,'Processing Failed')
