import asyncio
from io import BytesIO
from types import SimpleNamespace
from unittest import TestCase, IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

from fastapi import HTTPException, UploadFile
from services.medical_report_uploads import validate_report, store_report, MAX_REPORT_BYTES
from routers import medical_exam
from shared.models.core import MedicalExamStatusEnum

class ReportValidationTests(TestCase):
    def test_pdf_jpeg_png_formats_and_safe_filename(self):
        for filename, data, mime in [('lab.PDF', b'%PDF-1.4', 'application/pdf'),
                                     ('photo.jpeg', b'\xff\xd8\xffdata', 'image/jpeg'),
                                     ('../scan.png', b'\x89PNG\r\n\x1a\ndata', 'image/png')]:
            name, actual = validate_report(filename, data)
            self.assertNotIn('/', name)
            self.assertEqual(actual, mime)
    def test_reject_empty_oversize_and_mismatched_files(self):
        for name, data, expected in [('a.pdf', b'', 400), ('a.pdf', b'<script>', 400),
                                      ('a.exe', b'MZ', 400), ('a.png', b'x'*(MAX_REPORT_BYTES+1), 413)]:
            with self.assertRaises(HTTPException) as raised: validate_report(name, data)
            self.assertEqual(raised.exception.status_code, expected)

class ReportSubmissionTests(IsolatedAsyncioTestCase):
    def order(self):
        return SimpleNamespace(id=uuid4(), tenant_id=uuid4(), case_id=uuid4(), customer_id=uuid4(),
                               required_tests=[{'code':'FBS'}], status=MedicalExamStatusEnum.SCHEDULED,
                               results_json=None, updated_at=None, result_artifact_id=None)
    async def test_storage_failure_does_not_fall_back_to_local(self):
        with patch('services.medical_report_uploads._s3_client') as factory:
            factory.return_value.put_object.side_effect=RuntimeError('S3 down')
            with self.assertRaises(HTTPException) as raised:
                await store_report(b'%PDF-1.4', 'test/report.pdf', 'application/pdf')
        self.assertEqual(raised.exception.status_code, 502)
    async def test_upload_binds_to_token_order_and_publishes_ocr(self):
        order=self.order(); session=SimpleNamespace(add=Mock(), commit=AsyncMock())
        producer=SimpleNamespace(send_and_wait=AsyncMock())
        request=SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(kafka_producer=producer)))
        with patch.object(medical_exam,'_resolve_by_token',AsyncMock(return_value=order)), \
             patch.object(medical_exam,'_uploaded_reports',AsyncMock(return_value=[])), \
             patch('services.medical_report_uploads.store_report',AsyncMock(return_value='https://s3/report.pdf')):
            result=await medical_exam.public_upload_medical_report('token',request,'FBS',UploadFile(filename='report.pdf',file=BytesIO(b'%PDF-1.4')),session)
        artifact=session.add.call_args_list[0].args[0]
        self.assertEqual(artifact.customer_id,order.customer_id)
        self.assertEqual(artifact.case_id,order.case_id)
        self.assertEqual(artifact.source_request_id,order.id)
        self.assertEqual(artifact.document_type,'Medical Report: FBS')
        self.assertEqual(result['report']['test_code'],'FBS')
        producer.send_and_wait.assert_awaited_once()
    async def test_customer_submission_never_fabricates_normal_results(self):
        order=self.order(); report=SimpleNamespace(id=uuid4(),document_type='Medical Report: FBS',status='Accepted')
        session=SimpleNamespace(add=Mock(),commit=AsyncMock())
        with patch.object(medical_exam,'_resolve_by_token',AsyncMock(return_value=order)), \
             patch.object(medical_exam,'_uploaded_reports',AsyncMock(return_value=[report])), \
             patch.object(medical_exam,'publish_case_event',AsyncMock()):
            result=await medical_exam.public_complete_medical_exam('token',SimpleNamespace(),session)
        self.assertTrue(result['reports_submitted'])
        self.assertEqual(order.status,MedicalExamStatusEnum.SCHEDULED)
        self.assertNotIn('standard_panel',order.results_json)
    async def test_missing_test_blocks_submission(self):
        with patch.object(medical_exam,'_resolve_by_token',AsyncMock(return_value=self.order())), \
             patch.object(medical_exam,'_uploaded_reports',AsyncMock(return_value=[])):
            with self.assertRaises(HTTPException) as raised:
                await medical_exam.public_complete_medical_exam('token',SimpleNamespace(),SimpleNamespace())
        self.assertEqual(raised.exception.status_code,409)
    async def test_invalid_token_never_reaches_storage(self):
        with patch.object(medical_exam,'_resolve_by_token',AsyncMock(side_effect=HTTPException(410,'Expired'))), \
             patch('services.medical_report_uploads.store_report',AsyncMock()) as store:
            with self.assertRaises(HTTPException):
                await medical_exam.public_upload_medical_report('expired',SimpleNamespace(),'FBS',UploadFile(filename='a.pdf',file=BytesIO(b'%PDF-1.4')),SimpleNamespace())
            store.assert_not_awaited()

class BookingDisabledTests(IsolatedAsyncioTestCase):
    async def test_public_booking_cannot_change_an_order(self):
        from datetime import datetime
        session = SimpleNamespace(commit=AsyncMock())
        body = medical_exam.PublicBookRequest(clinic_id=uuid4(), appointment_at=datetime.utcnow())
        with patch.object(medical_exam, '_resolve_by_token', AsyncMock(return_value=SimpleNamespace())):
            with self.assertRaises(HTTPException) as raised:
                await medical_exam.public_book_medical_exam('valid-token', body, session)
        self.assertEqual(raised.exception.status_code, 410)
        session.commit.assert_not_awaited()
