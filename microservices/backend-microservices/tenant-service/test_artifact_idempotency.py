"""Document uploads are stored, indexed and queued for OCR once per operation on real PostgreSQL."""
import io
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from idem_testkit import RouteCase
from routers import artifacts
from shared.models.core import Case, CaseStatusEnum, CaseTypeEnum, Customer, Role, SourceChannelEnum, User


class Uploads(RouteCase):
    routers = (artifacts,)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        async with self.factory() as s:
            role = Role(name=f'Agent-{uuid4().hex[:6]}', tenant_id=self.tenant_id) if hasattr(Role, 'tenant_id') else Role(name=f'Agent-{uuid4().hex[:6]}')
            s.add(role)
            await s.flush()
            user = User(tenant_id=self.tenant_id, role_id=role.id, email=f'{uuid4().hex}@test.invalid', username=uuid4().hex, hashed_password='x', full_name='Test Agent')
            s.add(user)
            customer = Customer(tenant_id=self.tenant_id, cnic=f'35202-{uuid4().int % 10**7:07d}-1', name='Test only', gender='Male')
            s.add(customer)
            await s.flush()
            case = Case(tenant_id=self.tenant_id, customer_id=customer.id, caseNumber=f'CASE-UP-{uuid4().hex[:6]}', caseType=CaseTypeEnum.UNDERWRITING,
                        caseStatus=CaseStatusEnum.NEW, sourceChannel=SourceChannelEnum.AGENT)
            s.add(case)
            await s.commit()
            self.case_id, self.user_id = case.caseld, user.id
        self.producer = SimpleNamespace(send_and_wait=AsyncMock())
        self.app.state.kafka_producer = self.producer
        self.upload = patch.object(artifacts, '_upload_to_s3', return_value='s3://bucket/key.pdf')
        self.upload_mock = self.upload.start()
        self.addCleanup(self.upload.stop)
        p = patch.object(artifacts, '_get_current_user_id', new=AsyncMock(return_value=self.user_id))
        p.start()
        self.addCleanup(p.stop)
        self.url = f'/tenants/{self.tenant_id}/cases/{self.case_id}/artifacts'

    def files(self, content=b'%PDF-1.4 same document'):
        return {'file': ('report.pdf', io.BytesIO(content), 'application/pdf')}

    async def test_a_retried_upload_stores_and_queues_once(self):
        async with self.client() as c:
            h = self.headers('upload-operation-1')
            a = await c.post(self.url, files=self.files(), data={'document_type': 'Medical Report'}, headers=h)
            self.assertEqual(a.status_code, 202, a.text)
            b = await c.post(self.url, files=self.files(), data={'document_type': 'Medical Report'}, headers=h)
            other = await c.post(self.url, files=self.files(b'%PDF-1.4 a different document'), data={'document_type': 'Medical Report'}, headers=h)
            fresh = await c.post(self.url, files=self.files(), data={'document_type': 'Medical Report'}, headers=self.headers('upload-operation-2'))
        self.assertEqual((b.status_code, b.headers['idempotency-replayed'], b.json()['id']), (202, 'true', a.json()['id']))
        self.assertEqual(other.status_code, 409)
        self.assertEqual(fresh.status_code, 202)
        self.assertNotEqual(fresh.json()['id'], a.json()['id'], 'a new key is a new upload')
        self.assertEqual(self.upload_mock.call_count, 2)
        self.assertEqual(self.producer.send_and_wait.await_count, 2)
        self.assertEqual(await self.scalar('SELECT count(*) FROM artifacts'), 2)


if __name__ == '__main__':
    unittest.main()
