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
        with patch.object(medical_exam,'_resolve_by_lab_token',AsyncMock(return_value=(order,None))), \
             patch.object(medical_exam,'_uploaded_reports',AsyncMock(return_value=[])), \
             patch('services.medical_report_uploads.store_report',AsyncMock(return_value='https://s3/report.pdf')):
            result=await medical_exam.lab_upload_medical_report('token',request,'FBS',UploadFile(filename='report.pdf',file=BytesIO(b'%PDF-1.4')),session)
        artifact=session.add.call_args_list[0].args[0]
        self.assertEqual(artifact.customer_id,order.customer_id)
        self.assertEqual(artifact.case_id,order.case_id)
        self.assertEqual(artifact.source_request_id,order.id)
        self.assertEqual(artifact.document_type,'Medical Report: FBS')
        self.assertEqual(result['report']['test_code'],'FBS')
        producer.send_and_wait.assert_awaited_once()
    async def test_lab_submission_never_fabricates_normal_results(self):
        order=self.order(); report=SimpleNamespace(id=uuid4(),document_type='Medical Report: FBS',status='Accepted')
        session=SimpleNamespace(add=Mock(),commit=AsyncMock())
        with patch.object(medical_exam,'_resolve_by_lab_token',AsyncMock(return_value=(order,None))), \
             patch.object(medical_exam,'_uploaded_reports',AsyncMock(return_value=[report])), \
             patch.object(medical_exam,'publish_case_event',AsyncMock()):
            result=await medical_exam.lab_complete_medical_exam('token',medical_exam.LabSubmitRequest(signature_name='Dr. Ayesha Khan'),SimpleNamespace(),session)
        self.assertTrue(result['reports_submitted'])
        self.assertEqual(order.lab_signed_by,'Dr. Ayesha Khan')
        self.assertEqual(order.status,MedicalExamStatusEnum.SCHEDULED)
        self.assertNotIn('standard_panel',order.results_json)
    async def test_missing_test_blocks_submission(self):
        with patch.object(medical_exam,'_resolve_by_lab_token',AsyncMock(return_value=(self.order(),None))), \
             patch.object(medical_exam,'_uploaded_reports',AsyncMock(return_value=[])):
            with self.assertRaises(HTTPException) as raised:
                await medical_exam.lab_complete_medical_exam('token',medical_exam.LabSubmitRequest(signature_name='Dr. Ayesha Khan'),SimpleNamespace(),SimpleNamespace())
        self.assertEqual(raised.exception.status_code,409)
    async def test_invalid_token_never_reaches_storage(self):
        with patch.object(medical_exam,'_resolve_by_lab_token',AsyncMock(side_effect=HTTPException(410,'Expired'))), \
             patch('services.medical_report_uploads.store_report',AsyncMock()) as store:
            with self.assertRaises(HTTPException):
                await medical_exam.lab_upload_medical_report('expired',SimpleNamespace(),'FBS',UploadFile(filename='a.pdf',file=BytesIO(b'%PDF-1.4')),SimpleNamespace())
            store.assert_not_awaited()

class BookingTests(IsolatedAsyncioTestCase):
    async def test_booking_is_rejected_once_scheduled(self):
        from datetime import datetime
        order = SimpleNamespace(status=MedicalExamStatusEnum.SCHEDULED)
        body = medical_exam.PublicBookRequest(clinic_id=uuid4(), appointment_at=datetime.utcnow())
        session = SimpleNamespace(commit=AsyncMock())
        with patch.object(medical_exam, '_resolve_by_token', AsyncMock(return_value=order)):
            with self.assertRaises(HTTPException) as raised:
                await medical_exam.public_book_medical_exam('valid-token', body, session)
        self.assertEqual(raised.exception.status_code, 409)
        session.commit.assert_not_awaited()

    async def test_clinic_of_another_tenant_cannot_be_booked(self):
        from datetime import datetime
        order = SimpleNamespace(status=MedicalExamStatusEnum.INVITED, tenant_id=uuid4(), required_tests=[])
        clinic = SimpleNamespace(tenant_id=uuid4(), is_active=True)
        session = SimpleNamespace(commit=AsyncMock(), get=AsyncMock(return_value=clinic))
        body = medical_exam.PublicBookRequest(clinic_id=uuid4(), appointment_at=datetime.utcnow())
        with patch.object(medical_exam, '_resolve_by_token', AsyncMock(return_value=order)):
            with self.assertRaises(HTTPException) as raised:
                await medical_exam.public_book_medical_exam('valid-token', body, session)
        self.assertEqual(raised.exception.status_code, 404)
        session.commit.assert_not_awaited()

class ReportClassificationTests(IsolatedAsyncioTestCase):
    required = [{'code': 'FBS', 'name': 'Fasting Blood Sugar'}, {'code': 'LIPID', 'name': 'Lipid Profile'},
                {'code': 'ECG', 'name': 'Resting ECG'}, {'code': 'TMT', 'name': 'Treadmill / Exercise Stress ECG'}]
    def test_filename_keywords_only_return_required_tests(self):
        from services.medical_report_classifier import classify_by_filename
        self.assertEqual(classify_by_filename('Chughtai_FBS-and-Lipid.pdf', self.required), ['FBS', 'LIPID'])
        self.assertEqual(classify_by_filename('stress_ecg_report.pdf', self.required), ['TMT'])
        self.assertEqual(classify_by_filename('hba1c.pdf', self.required), [])
        self.assertEqual(classify_by_filename('IMG_2031.jpg', self.required), [])
    async def test_model_answer_is_filtered_to_the_ordered_panel(self):
        from services import medical_report_classifier as clf
        with patch.object(clf, 'classify_with_model', AsyncMock(return_value=['LIPID'])):
            self.assertEqual(await clf.classify_report(None, b'%PDF', 'application/pdf', 'scan.pdf', self.required), (['LIPID'], 'content'))
        with patch.object(clf, 'classify_with_model', AsyncMock(return_value=None)):
            self.assertEqual(await clf.classify_report(None, b'%PDF', 'application/pdf', 'fbs.pdf', self.required), (['FBS'], 'filename'))
            self.assertEqual(await clf.classify_report(None, b'%PDF', 'application/pdf', 'scan.pdf', self.required), ([], 'none'))
    async def test_combined_report_attaches_to_every_covered_test(self):
        order = SimpleNamespace(id=uuid4(), tenant_id=uuid4(), case_id=uuid4(), customer_id=uuid4(),
                                required_tests=self.required, status=MedicalExamStatusEnum.SCHEDULED,
                                results_json=None, updated_at=None)
        session = SimpleNamespace(add=Mock(), commit=AsyncMock())
        producer = SimpleNamespace(send_and_wait=AsyncMock())
        request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(kafka_producer=producer)))
        with patch.object(medical_exam, '_resolve_by_lab_token', AsyncMock(return_value=(order, None))), \
             patch.object(medical_exam, '_uploaded_reports', AsyncMock(return_value=[])), \
             patch('services.medical_report_classifier.classify_report', AsyncMock(return_value=(['FBS', 'LIPID'], 'content'))), \
             patch('services.medical_report_uploads.store_report', AsyncMock(return_value='https://s3/r.pdf')):
            result = await medical_exam.lab_auto_upload_medical_report(
                'token', request, UploadFile(filename='lab.pdf', file=BytesIO(b'%PDF-1.4')), session)
        self.assertEqual([r['test_code'] for r in result['reports']], ['FBS', 'LIPID'])
        self.assertEqual(producer.send_and_wait.await_count, 2)
    async def test_unidentified_report_is_not_stored(self):
        order = SimpleNamespace(required_tests=self.required, status=MedicalExamStatusEnum.SCHEDULED)
        with patch.object(medical_exam, '_resolve_by_lab_token', AsyncMock(return_value=(order, None))), \
             patch('services.medical_report_classifier.classify_report', AsyncMock(return_value=([], 'none'))), \
             patch('services.medical_report_uploads.store_report', AsyncMock()) as store:
            result = await medical_exam.lab_auto_upload_medical_report(
                'token', SimpleNamespace(), UploadFile(filename='scan.pdf', file=BytesIO(b'%PDF-1.4')), SimpleNamespace())
        self.assertEqual(result['test_codes'], [])
        store.assert_not_awaited()

class AiReportReadingTests(IsolatedAsyncioTestCase):
    def test_answers_are_normalised_to_the_rating_vocabulary(self):
        from services.medical_report_reader import _normalise
        self.assertEqual(_normalise('FBS', 'numeric', {'readable': True, 'value': '112 mg/dL', 'abnormal': False})['value'], '112')
        self.assertTrue(_normalise('FBS', 'numeric', {'readable': True, 'value': 112, 'abnormal': False})['abnormal'])
        self.assertFalse(_normalise('HIV', 'screen', {'readable': True, 'value': 'non-reactive'})['abnormal'])
        self.assertEqual(_normalise('HIV', 'screen', {'readable': True, 'value': 'Positive'})['value'], 'reactive')
        self.assertTrue(_normalise('ECG', 'qualitative', {'readable': True, 'value': 'ST depression'})['abnormal'])
        for answer in (None, {'readable': False, 'value': '5'}, {'readable': True, 'value': 'see report'}):
            self.assertFalse(_normalise('FBS', 'numeric', answer)['readable'])
    async def test_reading_is_cached_per_test_until_its_reports_change(self):
        fbs, lipid = (SimpleNamespace(id=uuid4(), status='Accepted', document_type=f'Medical Report: {c}') for c in ('FBS', 'LIPID'))
        order = SimpleNamespace(id=uuid4(), status=MedicalExamStatusEnum.INVITED,
                                required_tests=[{'code': 'FBS'}, {'code': 'LIPID'}], results_json={})
        session = SimpleNamespace(add=Mock(), commit=AsyncMock(),
                                  exec=AsyncMock(return_value=SimpleNamespace(one=lambda: order)))
        async def read(_session, tests, reports, _fetch):
            return {t['code']: {'value': '92', 'abnormal': False, 'evidence': 'x', 'readable': True,
                                'report_ids': sorted(str(r.id) for r in reports if r.document_type.endswith(t['code']))} for t in tests}
        reader = AsyncMock(side_effect=read)
        call = lambda **kw: medical_exam.ai_review_medical_reports(uuid4(), uuid4(), token='t', session=session, **kw)
        with patch.object(medical_exam, '_get_current_user', AsyncMock()), patch.object(medical_exam, '_get_case', AsyncMock()), \
             patch.object(medical_exam, '_load_order', AsyncMock(return_value=order)), \
             patch.object(medical_exam, '_uploaded_reports', AsyncMock(return_value=[fbs, lipid])), \
             patch('services.medical_report_reader.read_results', reader):
            one = await call(test_code='FBS')
            both = await call()                      # only LIPID still needs reading
            await call(test_code='FBS')              # cached
            await call(test_code='FBS', refresh=True)
        self.assertEqual(list(one['tests']), ['FBS'])
        self.assertEqual(set(both['tests']), {'FBS', 'LIPID'})
        self.assertEqual([[t['code'] for t in c.args[1]] for c in reader.await_args_list], [['FBS'], ['LIPID'], ['FBS']])
        self.assertEqual(order.status, MedicalExamStatusEnum.INVITED)


class MedicalReviewPrerequisiteTests(IsolatedAsyncioTestCase):
    async def test_ai_and_result_wait_for_every_required_processed_report(self):
        for reports in ([], [SimpleNamespace(id=uuid4(),status="Accepted",document_type="Medical Report: FBS")], [SimpleNamespace(id=uuid4(),status="Processing",document_type="Medical Report: FBS")]):
            order = SimpleNamespace(status=MedicalExamStatusEnum.INVITED, required_tests=[{"code":"FBS"},{"code":"ECG"}])
            with patch.object(medical_exam,"_get_current_user",AsyncMock()), patch.object(medical_exam,"_get_case",AsyncMock()), patch.object(medical_exam,"_load_order",AsyncMock(return_value=order)), patch.object(medical_exam,"_uploaded_reports",AsyncMock(return_value=reports)):
                with self.assertRaises(HTTPException) as ai:
                    await medical_exam.ai_review_medical_reports(uuid4(),uuid4(),token="t",session=Mock())
                self.assertEqual(ai.exception.status_code,409)
                with self.assertRaises(HTTPException) as result:
                    await medical_exam.record_medical_result(uuid4(),uuid4(),medical_exam.ResultRequest(results={"FBS":"90"}),SimpleNamespace(),token="t",session=Mock())
                self.assertEqual(result.exception.status_code,409)
