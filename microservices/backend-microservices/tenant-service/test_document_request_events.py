"""Public document writes notify staff after commit, including proposals without a case."""
from datetime import datetime
from io import BytesIO
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, main
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

from fastapi import HTTPException, UploadFile
from routers import document_requests as routes
from services.case_events import publish_case_event
from shared.events.kafka_events import CaseEvent, CASE_EVENTS_TOPIC


class DocumentRequestEventTests(IsolatedAsyncioTestCase):
    def setUp(self):
        self.req = SimpleNamespace(id=uuid4(), tenant_id=uuid4(), customer_id=uuid4(), policy_id=uuid4(),
                                   required_documents=['CNIC'], submitted_at=None)
        self.session = SimpleNamespace(add=Mock(), commit=AsyncMock(), refresh=AsyncMock())
        self.request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(kafka_producer=None)))

    async def upload(self, case=None, storage_error=None):
        async def published(*args, **kwargs):
            self.session.commit.assert_awaited_once()
        with patch.object(routes, '_resolve', AsyncMock(return_value=self.req)), \
             patch.object(routes.docreq, 'latest_case', AsyncMock(return_value=case)), \
             patch.object(routes, '_upload_to_s3', Mock(return_value='https://storage/report', side_effect=storage_error)), \
             patch.object(routes, '_view', AsyncMock(return_value={'received': 1})), \
             patch.object(routes, 'publish_case_event', AsyncMock(side_effect=published)) as publish:
            result = await routes.public_upload_document(self.request, 'secret-link-token', 'CNIC',
                       UploadFile(filename='cnic.png', file=BytesIO(b'fixture')), self.session)
            return result, publish

    async def test_upload_before_case_exists_publishes_policy_scoped_event(self):
        result, publish = await self.upload()
        self.assertEqual(result['received'], 1)
        event = publish.await_args.kwargs
        self.assertEqual(event['event_type'], 'CustomerDocumentUploaded')
        self.assertIsNone(event['case_id'])
        self.assertEqual(event['tenant_id'], self.req.tenant_id)
        self.assertEqual(event['customer_id'], self.req.customer_id)
        self.assertEqual(event['detail']['policy_id'], str(self.req.policy_id))
        self.assertEqual(event['detail']['document_request_id'], str(self.req.id))
        self.assertNotIn('secret-link-token', str(event))

    async def test_upload_after_case_exists_keeps_case_context(self):
        case = SimpleNamespace(caseld=uuid4())
        _, publish = await self.upload(case)
        self.assertEqual(publish.await_args.kwargs['case_id'], case.caseld)

    async def test_failed_storage_does_not_commit_or_publish(self):
        with self.assertRaises(HTTPException) as exc:
            await self.upload(storage_error=RuntimeError('storage down'))
        self.assertEqual(exc.exception.status_code, 502)
        self.session.commit.assert_not_awaited()

    async def test_final_submission_publishes_once_after_commit(self):
        async def published(*args, **kwargs):
            self.session.commit.assert_awaited_once()
            self.assertIsNotNone(self.req.submitted_at)
        with patch.object(routes, '_resolve', AsyncMock(return_value=self.req)), \
             patch.object(routes.docreq, 'summary', AsyncMock(return_value={'total': 1, 'all_received': True})), \
             patch.object(routes.docreq, 'latest_case', AsyncMock(return_value=None)), \
             patch.object(routes, '_view', AsyncMock(return_value={'submitted': True})), \
             patch.object(routes, 'publish_case_event', AsyncMock(side_effect=published)) as publish:
            await routes.public_submit_documents('token', self.request, self.session)
            await routes.public_submit_documents('token', self.request, self.session)
        publish.assert_awaited_once()
        self.assertEqual(publish.await_args.kwargs['event_type'], 'CustomerDocumentsSubmitted')
        self.assertEqual(publish.await_args.kwargs['detail']['policy_id'], str(self.req.policy_id))

    async def test_incomplete_submission_does_not_publish(self):
        with patch.object(routes, '_resolve', AsyncMock(return_value=self.req)), \
             patch.object(routes.docreq, 'summary', AsyncMock(return_value={'total': 1, 'all_received': False})), \
             patch.object(routes, 'publish_case_event', AsyncMock()) as publish:
            with self.assertRaises(HTTPException) as exc:
                await routes.public_submit_documents('token', self.request, self.session)
        self.assertEqual(exc.exception.status_code, 400)
        self.session.commit.assert_not_awaited()
        publish.assert_not_awaited()

    async def test_publisher_accepts_missing_case_and_preserves_tenant_routing(self):
        producer = SimpleNamespace(send_and_wait=AsyncMock())
        self.request.app.state.kafka_producer = producer
        session = SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(name='Customer')))
        await publish_case_event(self.request, session, event_type='CustomerDocumentsSubmitted',
                                 tenant_id=self.req.tenant_id, case_id=None, customer_id=self.req.customer_id,
                                 detail={'policy_id': str(self.req.policy_id)})
        args = producer.send_and_wait.await_args
        self.assertEqual(args.args[0], CASE_EVENTS_TOPIC)
        self.assertEqual(args.kwargs['key'], str(self.req.tenant_id))
        event = CaseEvent.model_validate_json(args.kwargs['value'])
        self.assertIsNone(event.payload.case_id)
        self.assertEqual(event.payload.detail['policy_id'], str(self.req.policy_id))
        session.get.assert_awaited_once()

    async def test_kafka_failure_does_not_fail_committed_submission(self):
        self.request.app.state.kafka_producer = SimpleNamespace(send_and_wait=AsyncMock(side_effect=RuntimeError('offline')))
        await publish_case_event(self.request, SimpleNamespace(get=AsyncMock()),
                                 event_type='CustomerDocumentsSubmitted', tenant_id=self.req.tenant_id,
                                 case_id=None, detail={'policy_id': str(self.req.policy_id)})


if __name__ == '__main__': main()
