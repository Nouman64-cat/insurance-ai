"""Medical / financial underwriting tracks, against a disposable PostgreSQL database.

Run: docker compose exec -T tenant-service python test_underwriting_tracks.py
"""
import os
os.environ["DISABLE_PGVECTOR"] = "true"
import asyncio
import sys
import unittest
from uuid import uuid4

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from case_hold import refuse_writes_on_held_case
from specialist_access import restrict_specialist_writes
from database import get_session
from routers.auth import create_access_token
from routers.cases import router as cases_router
from routers.underwriting_tracks import router as tracks_router
from routers.medical_exam import router as medical_router
from routers.insurance_history import router as history_router
from routers.underwriting_questionnaires import router as questionnaires_router
from routers.e_application import router as e_application_router
from shared.models.core import (Case, CaseAuditTrail, CaseStatusEnum, CaseTypeEnum, Customer, Policy, Role, SourceChannelEnum, Tenant, User)

DB = "tenant_tracks_test_" + uuid4().hex[:10]
ADMIN = f"postgresql+asyncpg://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}@host.docker.internal:5432"
factory = None


class Tracks(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async with factory() as s:
            self.t = Tenant(name=f"T {uuid4()}", code="T" + uuid4().hex[:8]); s.add(self.t); await s.flush()
            roles = {}
            for n in ("Admin", "Medical Underwriter", "Financial Underwriter", "Agent"):
                r = (await s.exec(select(Role).where(Role.name == n))).first() or Role(name=n, description=""); s.add(r); await s.flush(); roles[n] = r.id
            def user(role, name): return User(tenant_id=self.t.id, role_id=roles[role], email=f"{uuid4()}@x.test", username=uuid4().hex, hashed_password="x", full_name=name)
            self.admin, self.med, self.fin, self.agent = (user("Admin", "Ayla Admin"), user("Medical Underwriter", "Dr Mehreen"),
                                                          user("Financial Underwriter", "Faisal Fin"), user("Agent", "Ali Agent"))
            s.add_all([self.admin, self.med, self.fin, self.agent]); await s.flush()
            cust = Customer(tenant_id=self.t.id, name="Track Person", cnic="35202-1111111-1"); s.add(cust); await s.flush()
            pol = Policy(tenant_id=self.t.id, customer_id=cust.id, product_name="Term Life", insurance_type="TERM_LIFE", coverage_amount=1_000_000.0, term_years=10, status="UnderReview")
            s.add(pol); await s.flush()
            self.case = Case(tenant_id=self.t.id, customer_id=cust.id, policy_id=pol.id, caseNumber="UW-" + uuid4().hex[:10], caseType=CaseTypeEnum.UNDERWRITING,
                             caseStatus=CaseStatusEnum.UNDER_REVIEW, sourceChannel=SourceChannelEnum.BRANCH)
            s.add(self.case); await s.commit()
        self.app = FastAPI(); self.app.include_router(cases_router); self.app.include_router(tracks_router); self.app.include_router(medical_router); self.app.include_router(history_router); self.app.include_router(questionnaires_router); self.app.include_router(e_application_router)
        self.app.middleware("http")(refuse_writes_on_held_case)
        self.app.middleware("http")(restrict_specialist_writes)

        async def dep():
            async with factory() as s:
                yield s
        self.app.dependency_overrides[get_session] = dep
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        h = lambda u: {"authorization": "Bearer " + create_access_token({"sub": str(u.id)})}
        self.admin_h, self.med_h, self.fin_h, self.agent_h = h(self.admin), h(self.med), h(self.fin), h(self.agent)

    async def asyncTearDown(self):
        await self.http.aclose()

    def url(self, track):
        return f"/tenants/{self.t.id}/cases/{self.case.caseld}/underwriting-tracks/{track}"

    async def listed(self):
        r = await self.http.get(f"/tenants/{self.t.id}/cases", headers=self.admin_h)
        self.assertEqual(r.status_code, 200, r.text)
        return next(c for c in r.json() if c["caseld"] == str(self.case.caseld))

    async def test_document_processing_retry_ownership_scope_and_queue(self):
        from datetime import datetime, timedelta
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        from shared.models.core import Artifact
        from shared.events.kafka_events import ArtifactOCRRequestedEvent
        producer = SimpleNamespace(send_and_wait=AsyncMock())
        self.app.state.kafka_producer = producer
        async with factory() as session:
            artifact = Artifact(tenant_id=self.t.id, case_id=self.case.caseld,
                document_type='Physician Report', file_name='synthetic.pdf', file_type='application/pdf',
                storage_url='local://synthetic/report.pdf', status='Processing Failed')
            session.add(artifact); await session.commit()
            artifact_id = artifact.id
        root = f"/tenants/{self.t.id}/cases/{self.case.caseld}"
        retry = root + f"/underwriting-documents/{artifact_id}/retry"
        self.assertEqual((await self.http.post(retry, headers=self.med_h)).status_code, 403)
        await self.http.put(self.url('medical'), json={'status':'IN_REVIEW'}, headers=self.med_h)
        await self.http.put(self.url('financial'), json={'status':'IN_REVIEW'}, headers=self.fin_h)
        self.assertEqual((await self.http.post(retry, headers=self.fin_h)).status_code, 404)
        self.assertEqual((await self.http.post(retry.replace(str(self.t.id),str(uuid4())), headers=self.med_h)).status_code, 403)
        async with factory() as session:
            case = await session.get(Case,self.case.caseld)
            case.on_hold=True; session.add(case); await session.commit()
        self.assertEqual((await self.http.post(retry, headers=self.med_h)).status_code, 409)
        async with factory() as session:
            case = await session.get(Case,self.case.caseld)
            case.on_hold=False; session.add(case); await session.commit()
        response = await self.http.post(retry, headers=self.med_h)
        self.assertEqual(response.status_code,202,response.text)
        producer.send_and_wait.assert_awaited_once()
        event=ArtifactOCRRequestedEvent.model_validate_json(producer.send_and_wait.call_args.kwargs['value'])
        self.assertEqual(event.payload.artifact_id,artifact_id)
        self.assertEqual(event.payload.s3_key,'synthetic/report.pdf')
        self.assertEqual((await self.http.post(retry, headers=self.med_h)).status_code,409)
        async with factory() as session:
            artifact=await session.get(Artifact,artifact_id)
            artifact.status='Uploaded'; artifact.created_at=datetime.utcnow()-timedelta(hours=1)
            artifact.extracted_metadata={};session.add(artifact);await session.commit()
        workspace=await self.http.get(f'/tenants/{self.t.id}/underwriting/reviews/{self.case.caseld}',headers=self.med_h)
        self.assertEqual(workspace.status_code,200,workspace.text)
        self.assertTrue(next(d for d in workspace.json()['documents'] if d['id']==str(artifact_id))['processing_stalled'])
        producer.send_and_wait.side_effect=RuntimeError('queue down')
        self.assertEqual((await self.http.post(retry,headers=self.med_h)).status_code,503)
        async with factory() as session:
            artifact=await session.get(Artifact,artifact_id)
            self.assertEqual(artifact.status,'Processing Failed')

    async def test_questionnaire_expiry_resend_and_tenant_scope(self):
        from datetime import datetime, timedelta
        from unittest.mock import AsyncMock, patch
        from shared.models.core import UnderwritingQuestionnaire
        root = f"/tenants/{self.t.id}/cases/{self.case.caseld}/underwriting-questionnaire"
        await self.http.put(self.url('financial'),json={'assigned_user_id':str(self.fin.id)},headers=self.fin_h)
        with patch('routers.underwriting_questionnaires.email_customer_link',new_callable=AsyncMock,return_value={'email_status':'failed','emailed_to':'test@example.test'}):
            first = (await self.http.post(root+'/invite',headers=self.fin_h)).json()
            second = (await self.http.post(root+'/invite',headers=self.fin_h)).json()
        self.assertEqual(first['email_status'],'failed')
        self.assertNotEqual(first['link_path'],second['link_path'])
        self.assertEqual((await self.http.get('/public'+first['link_path'])).status_code,404)
        other = f"/tenants/{uuid4()}/cases/{self.case.caseld}/underwriting-questionnaire"
        self.assertEqual((await self.http.get(other,headers=self.fin_h)).status_code,403)
        async with factory() as session:
            row = (await session.exec(select(UnderwritingQuestionnaire).where(UnderwritingQuestionnaire.case_id == self.case.caseld))).first()
            row.expires_at = datetime.utcnow()-timedelta(seconds=1);session.add(row);await session.commit()
        self.assertEqual((await self.http.get('/public'+second['link_path'])).status_code,410)
        self.assertEqual((await self.http.post('/public'+second['link_path']+'/submit',json={'answers':{},'signature':'Test','consent':True})).status_code,410)

    async def test_specialist_questionnaires_independent_secure_and_live(self):
        from unittest.mock import AsyncMock, patch
        from routers.underwriting_questionnaires import QUESTIONS
        root = f"/tenants/{self.t.id}/cases/{self.case.caseld}/underwriting-questionnaire"
        self.assertEqual((await self.http.post(root+'/invite', headers=self.med_h)).status_code, 403)
        tokens = {}
        with patch('routers.underwriting_questionnaires.email_customer_link', new_callable=AsyncMock, return_value={'email_status':'sent','emailed_to':'test@example.test'}) as mail:
            for track, user, headers in [('medical',self.med,self.med_h),('financial',self.fin,self.fin_h)]:
                await self.http.put(self.url(track),json={'assigned_user_id':str(user.id)},headers=headers)
                response = await self.http.post(root+'/invite',headers=headers)
                self.assertEqual(response.status_code,200,response.text)
                tokens[track] = response.json()['link_path'].split('/')[-1]
            self.assertEqual(mail.await_count,2)
        public = '/public/underwriting-questionnaire/'+tokens['medical']
        form = (await self.http.get(public)).json()
        self.assertEqual(set(form['questions']),set(QUESTIONS['MEDICAL']))
        self.assertNotIn('income',form['questions'])
        payload = {'answers':{k:'None' for k in form['questions']},'signature':'Test Customer','consent':True}
        invalid = await self.http.post(public+'/submit',json={**payload,'consent':False})
        self.assertEqual(invalid.status_code,422)
        with patch('routers.underwriting_questionnaires.publish_case_event',new_callable=AsyncMock) as publish:
            response = await self.http.post(public+'/submit',json=payload)
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(publish.call_args.kwargs['detail'],{'track':'medical','reviewer_user_id':str(self.med.id)})
            self.assertEqual(publish.call_args.kwargs['event_type'],'UnderwritingQuestionnaireSubmitted')
        self.assertEqual((await self.http.post(public+'/submit',json=payload)).status_code,409)
        self.assertNotIn('answers',(await self.http.get(public)).json())
        self.assertEqual((await self.http.get(root,headers=self.med_h)).json()['status'],'Submitted')
        financial = (await self.http.get(root,headers=self.fin_h)).json()
        self.assertEqual(financial['status'],'Sent'); self.assertIsNone(financial['answers'])
        self.assertEqual((await self.http.get('/public/underwriting-questionnaire/invalid')).status_code,404)
        self.assertEqual((await self.http.get(root,headers=self.agent_h)).status_code,403)

    async def test_untouched_case_reads_pending_on_both_tracks(self):
        row = await self.listed()
        self.assertEqual((row["medical_review"]["status"], row["financial_review"]["status"]), ("PENDING", "PENDING"))
        self.assertIsNone(row["medical_review"]["assigned_user_name"])

    async def test_admin_assigns_and_the_list_shows_it(self):
        r = await self.http.put(self.url("medical"), json={"assigned_user_id": str(self.med.id)}, headers=self.admin_h)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["status"], r.json()["assigned_user_name"]), ("IN_REVIEW", "Dr Mehreen"))  # picking it up puts it in review
        row = await self.listed()
        self.assertEqual((row["medical_review"]["assigned_user_name"], row["financial_review"]["status"]), ("Dr Mehreen", "PENDING"))
        async with factory() as s:
            trail = (await s.exec(select(CaseAuditTrail).where(CaseAuditTrail.caseld == self.case.caseld))).all()
        self.assertTrue(any(a.entityChanged == "CaseUnderwritingTrack" for a in trail))

    async def test_each_specialist_works_only_their_own_track(self):
        self.assertEqual((await self.http.put(self.url("medical"), json={"status": "CLEARED"}, headers=self.fin_h)).status_code, 403)
        mine = await self.http.put(self.url("financial"), json={"assigned_user_id": str(self.fin.id), "status": "CLEARED", "note": "Income verified"}, headers=self.fin_h)
        self.assertEqual(mine.status_code, 200, mine.text)
        self.assertEqual((mine.json()["status"], mine.json()["note"]), ("CLEARED", "Income verified"))
        # a specialist may pick a review up for themselves, not hand it to someone else
        self.assertEqual((await self.http.put(self.url("medical"), json={"assigned_user_id": str(self.fin.id)}, headers=self.med_h)).status_code, 403)
        self.assertEqual((await self.http.put(self.url("financial"), json={"status": "CLEARED"}, headers=self.agent_h)).status_code, 403)

    async def test_assignee_must_be_able_to_take_that_track(self):
        r = await self.http.put(self.url("medical"), json={"assigned_user_id": str(self.fin.id)}, headers=self.admin_h)
        self.assertEqual(r.status_code, 422, r.text)
        other = await self.http.put(f"/tenants/{uuid4()}/cases/{self.case.caseld}/underwriting-tracks/medical", json={"status": "CLEARED"}, headers=self.admin_h)
        self.assertEqual(other.status_code, 403)

    async def test_underwriters_list_says_which_track_each_can_take(self):
        r = await self.http.get(f"/tenants/{self.t.id}/underwriting/underwriters", headers=self.admin_h)
        self.assertEqual(r.status_code, 200, r.text)
        tracks = {u["full_name"]: u["tracks"] for u in r.json()}
        self.assertEqual(tracks, {"Dr Mehreen": ["medical"], "Faisal Fin": ["financial"]})

    async def test_a_held_case_refuses_track_changes(self):
        hold = await self.http.post(f"/tenants/{self.t.id}/cases/{self.case.caseld}/hold", json={"reason": "awaiting CNIC copy"}, headers=self.admin_h)
        self.assertEqual(hold.status_code, 200, hold.text)
        self.assertEqual((await self.http.put(self.url("medical"), json={"status": "CLEARED"}, headers=self.admin_h)).status_code, 409)

    async def test_specialist_workspace_is_track_scoped(self):
        root = f"/tenants/{self.t.id}/underwriting/reviews"
        for headers, track, present, absent in [(self.med_h, 'medical', 'Medical questionnaire', 'Declared income (PKR)'),
                                                (self.fin_h, 'financial', 'Declared income (PKR)', 'Medical questionnaire')]:
            queue = await self.http.get(root, headers=headers)
            self.assertEqual(queue.status_code, 200, queue.text)
            self.assertEqual(queue.json(), [])  # unassigned work is not in a specialist's queue
            assignee = self.med if track == 'medical' else self.fin
            r = await self.http.put(self.url(track), json={"assigned_user_id": str(assignee.id)}, headers=self.admin_h)
            self.assertEqual(r.status_code, 200, r.text)
            queue = await self.http.get(root, headers=headers)
            self.assertEqual([q['id'] for q in queue.json()], [str(self.case.caseld)])
            detail = await self.http.get(root + f"/{self.case.caseld}", headers=headers)
            self.assertEqual(detail.status_code, 200, detail.text)
            self.assertEqual(detail.json()['track'], track)
            self.assertIn(present, detail.json()['evidence'])
            self.assertNotIn(absent, detail.json()['evidence'])
            self.assertIsNone(detail.json()['assessment'])
        self.assertEqual((await self.http.get(root, headers=self.agent_h)).status_code, 403)
        self.assertEqual((await self.http.get(f"/tenants/{uuid4()}/underwriting/reviews", headers=self.med_h)).status_code, 403)

    async def test_proposal_upload_receipt_is_separate_from_ocr_status(self):
        from datetime import datetime, timedelta
        from shared.models.core import Artifact, DocumentRequest
        from services.document_requests import summary
        async with factory() as session:
            request=DocumentRequest(tenant_id=self.t.id,policy_id=self.case.policy_id,
                customer_id=self.case.customer_id,required_documents=['Salary Slip'],
                expires_at=datetime.utcnow()+timedelta(days=30))
            session.add(request);await session.flush()
            artifact=Artifact(tenant_id=self.t.id,customer_id=self.case.customer_id,
                source_request_id=request.id,document_type='Salary Slip',file_name='proposal-income.pdf',
                storage_url='local://synthetic/proposal-income.pdf',status='Uploaded')
            session.add(artifact);await session.commit()
            request_id,artifact_id=request.id,artifact.id
        root=f"/tenants/{self.t.id}/underwriting/reviews/{self.case.caseld}"
        for status in ['Uploaded','Processing','OCR Pending','Processing Failed','Accepted','Waived','Re-submission Requested']:
            with self.subTest(status=status):
                async with factory() as session:
                    artifact=await session.get(Artifact,artifact_id)
                    artifact.status=status;session.add(artifact);await session.commit()
                    request=await session.get(DocumentRequest,request_id)
                    proposal_receipt=await summary(session,request)
                response=await self.http.get(root,headers=self.fin_h)
                self.assertEqual(response.status_code,200,response.text)
                workspace=response.json()
                expected=status!='Re-submission Requested'
                self.assertEqual(workspace['required_documents'],[{'type':'Salary Slip','received':expected}])
                self.assertEqual(proposal_receipt['all_received'],expected)
                requirement=next(r for r in workspace['requirements'] if r['key']=='documents')
                self.assertEqual(requirement['status'],'Received' if expected else 'Outstanding')
                saved=next(d for d in workspace['documents'] if d['id']==str(artifact_id))
                self.assertEqual(saved['scope'],'customer')
                self.assertEqual(saved['status'],status)  # receipt never overwrites OCR evidence

    async def test_documents_requirement_only_when_the_plan_asks_for_track_evidence(self):
        root = f"/tenants/{self.t.id}/underwriting/reviews/{self.case.caseld}"
        financial = (await self.http.get(root, headers=self.fin_h)).json()
        self.assertEqual(financial['required_documents'], [{"type": "Salary Slip", "received": False}])
        self.assertEqual([r['key'] for r in financial['requirements']][:2], ['e_application', 'insurance_history'])  # one questionnaire: the e-application
        self.assertNotIn('Financial customer disclosures', financial['evidence'])
        docs = next(r for r in financial['requirements'] if r['key'] == 'documents')
        self.assertEqual(docs['detail'], '0 of 1 received')
        cnic = next(o for o in financial['application_outstanding'] if o['code'] == 'CNIC')  # explains Pending Documents
        self.assertEqual((cnic['document_type'], cnic['can_upload']), ('CNIC', True))
        self.assertIn('application_documents', [r['key'] for r in financial['requirements']])
        self.assertTrue(all(o['owner'] in (None, 'financial') for o in financial['application_outstanding'] if o['can_upload']))
        medical = (await self.http.get(root, headers=self.med_h)).json()
        self.assertEqual(medical['required_documents'], [])  # no examination ordered yet
        self.assertNotIn('documents', [r['key'] for r in medical['requirements']])
        async with factory() as s:
            pol = await s.get(Policy, self.case.policy_id); pol.insurance_type = "HEALTH_CASH"; await s.commit()
        financial = (await self.http.get(root, headers=self.fin_h)).json()
        self.assertEqual(financial['required_documents'], [])
        self.assertNotIn('documents', [r['key'] for r in financial['requirements']])

    async def test_specialist_emails_only_their_own_e_application_until_it_is_submitted(self):
        base = f"/tenants/{self.t.id}/cases/{self.case.caseld}/e-application"
        self.assertEqual((await self.http.post(base + "/financial/invite", headers=self.fin_h)).status_code, 403)  # not their review yet
        await self.http.put(self.url('financial'), json={'assigned_user_id': str(self.fin.id)}, headers=self.fin_h)
        self.assertEqual((await self.http.post(base + "/medical/invite", headers=self.fin_h)).status_code, 403)  # the other track's
        self.assertEqual((await self.http.post(base + "/invite", headers=self.fin_h)).status_code, 403)  # both at once is pre-underwriting's
        sent = await self.http.post(base + "/financial/invite", headers=self.fin_h)
        self.assertEqual(sent.status_code, 200, sent.text)
        self.assertEqual((sent.json()['status'], sent.json()['part']), ('Sent', 'financial'))
        token = sent.json()['token']
        await self.http.put(f"/public/e-application/{token}", json={"declaration": {k: True for k in ("confirms_accurate", "authorizes_records_access", "not_signed_blank", "understood_terms")} | {"signature_name": "Track Person"}})
        self.assertEqual((await self.http.post(f"/public/e-application/{token}/submit")).status_code, 200)
        self.assertEqual((await self.http.post(base + "/financial/invite", headers=self.fin_h)).status_code, 409)

    async def test_e_application_is_two_questionnaires_and_complete_when_both_are(self):
        base = f"/tenants/{self.t.id}/cases/{self.case.caseld}/e-application"
        both = await self.http.post(base + "/invite", headers=self.admin_h)
        self.assertEqual(both.status_code, 200, both.text)
        links = {p['part']: p['token'] for p in both.json()['parts']}
        self.assertEqual(set(links), {'medical', 'financial'})
        sign = {"declaration": {k: True for k in ("confirms_accurate", "authorizes_records_access", "not_signed_blank", "understood_terms")} | {"signature_name": "Track Person"}}
        # The financial link reads and writes only the financial sections.
        fin = (await self.http.get(f"/public/e-application/{links['financial']}")).json()
        self.assertEqual((fin['part'], fin['medical_questionnaire']), ('financial', None))
        await self.http.put(f"/public/e-application/{links['financial']}", json={**sign, "financial_profile": {"income": {"annual_income": "3600000"}}, "medical_questionnaire": {"tobacco_use": True}})
        self.assertEqual((await self.http.post(f"/public/e-application/{links['financial']}/submit")).status_code, 200)
        overall = (await self.http.get(base, headers=self.admin_h)).json()
        self.assertEqual((overall['status'], overall['parts']['financial']['status'], overall['parts']['medical']['status']), ('InProgress', 'Submitted', 'Sent'))
        self.assertEqual((overall['financial_profile'], overall['medical_questionnaire']), ({"income": {"annual_income": "3600000"}}, None))
        self.assertEqual((await self.http.get(f"/public/e-application/{links['financial']}")).json()['status'], 'Submitted')
        await self.http.put(f"/public/e-application/{links['medical']}", json={**sign, "medical_questionnaire": {"tobacco_use": False}})
        self.assertEqual((await self.http.post(f"/public/e-application/{links['medical']}/submit")).status_code, 200)
        overall = (await self.http.get(base, headers=self.admin_h)).json()
        self.assertEqual((overall['status'], overall['declaration']['signature_name']), ('Submitted', 'Track Person'))
        await self.http.put(self.url('medical'), json={'assigned_user_id': str(self.med.id)}, headers=self.med_h)
        review = (await self.http.get(f"/tenants/{self.t.id}/underwriting/reviews/{self.case.caseld}", headers=self.med_h)).json()
        self.assertEqual(next(r for r in review['requirements'] if r['key'] == 'e_application')['status'], 'Submitted')
        self.assertEqual((await self.http.post(base + "/invite", headers=self.admin_h)).status_code, 409)  # nothing left to send

    async def test_exam_covered_requirements_are_not_asked_for_as_uploads(self):
        from shared.models.core import MedicalExamOrder
        async with factory() as s:
            pol = await s.get(Policy, self.case.policy_id); pol.coverage_amount = 20_000_000.0
            s.add(MedicalExamOrder(tenant_id=self.t.id, case_id=self.case.caseld, customer_id=self.case.customer_id, status="Required",
                                   sum_assured_at_risk=20_000_000.0, required_tests=[{"code": "CBC", "name": "Complete Blood Count"}, {"code": "ECG", "name": "Resting ECG"}]))
            await s.commit()
        await self.http.put(self.url('medical'), json={'assigned_user_id': str(self.med.id)}, headers=self.med_h)
        review = (await self.http.get(f"/tenants/{self.t.id}/underwriting/reviews/{self.case.caseld}", headers=self.med_h)).json()
        by_code = {o['code']: o for o in review['application_outstanding']}
        for code in ('LAB_REPORTS', 'ECG'):
            self.assertTrue(by_code[code]['covered_by_exam'], code)
            self.assertFalse(by_code[code]['can_upload'], code)
        self.assertTrue(by_code['CNIC']['can_upload'])

    async def test_ai_financial_underwriting_runs_once_the_financial_requirements_are_in(self):
        from unittest.mock import AsyncMock, patch
        from shared.models.core import Artifact, CustomerEApplication, CustomerEApplicationPart, InsuranceHistoryCheck
        run = f"/tenants/{self.t.id}/cases/{self.case.caseld}/financial-underwriting/run"
        review_url = f"/tenants/{self.t.id}/underwriting/reviews/{self.case.caseld}"
        await self.http.put(self.url('financial'), json={'assigned_user_id': str(self.fin.id)}, headers=self.fin_h)
        await self.http.put(self.url('medical'), json={'assigned_user_id': str(self.med.id)}, headers=self.med_h)
        self.assertEqual((await self.http.post(run, headers=self.med_h)).status_code, 403)  # the financial track's tool
        state = (await self.http.get(review_url, headers=self.fin_h)).json()['ai_underwriting']
        self.assertFalse(state['ready'])
        self.assertEqual(len(state['blockers']), 3)  # e-application, insurance history, salary slip
        self.assertEqual((await self.http.post(run, headers=self.fin_h)).status_code, 409)
        async with factory() as s:
            s.add(CustomerEApplication(tenant_id=self.t.id, case_id=self.case.caseld, customer_id=self.case.customer_id, status="InProgress"))
            s.add(CustomerEApplicationPart(tenant_id=self.t.id, case_id=self.case.caseld, part="financial", status="Submitted"))
            s.add(InsuranceHistoryCheck(tenant_id=self.t.id, case_id=self.case.caseld, customer_id=self.case.customer_id, status="Clear"))
            s.add(Artifact(tenant_id=self.t.id, customer_id=self.case.customer_id, case_id=self.case.caseld, document_type="Salary Slip", status="Accepted", ocr_confidence_score=0.9))
            await s.commit()
        self.assertTrue((await self.http.get(review_url, headers=self.fin_h)).json()['ai_underwriting']['ready'])
        engine = {"financial_score": 22, "financial_reasons": [{"parameter": "Income", "observation": "Stable salary", "risk_rating": "Low"}],
                  "financial_result": {"financially_justified": True, "maximum_supported_cover": 9_000_000, "referral_required": False}}
        with patch("routers.underwriting_tracks._evaluate_financial", AsyncMock(return_value=engine)) as evaluate:
            done = await self.http.post(run, headers=self.fin_h)
            self.assertEqual(done.status_code, 200, done.text)
            body = evaluate.call_args.args[0]
            self.assertEqual((body['customer']['cnic'], body['policy']['product_name']), ("35202-1111111-1", "Term Life"))
            import json
            json.dumps(body)  # what httpx sends: the salary slip's evidence carries an artifact UUID
            self.assertTrue(any(d.get('document_type') == 'Salary Slip' for d in body['document_evidence']))
        state = (await self.http.get(review_url, headers=self.fin_h)).json()['ai_underwriting']
        self.assertEqual((state['result']['score'], state['result']['financially_justified']), (22, True))
        self.assertIsNotNone(state['run_at'])

    async def test_final_underwriting_compiles_both_specialist_reviews(self):
        compiled_url = f"/tenants/{self.t.id}/cases/{self.case.caseld}/underwriting-tracks"
        empty = (await self.http.get(compiled_url, headers=self.admin_h)).json()
        self.assertEqual((empty['medical']['submitted'], empty['financial']['submitted']), (False, False))
        await self.http.put(self.url('medical'), json={'assigned_user_id': str(self.med.id), 'status': 'CLEARED', 'note': 'Normal panel'}, headers=self.med_h)
        await self.http.put(self.url('financial'), json={'assigned_user_id': str(self.fin.id), 'status': 'REFERRED', 'note': 'Income unverified'}, headers=self.fin_h)
        compiled = (await self.http.get(compiled_url, headers=self.admin_h)).json()
        self.assertEqual((compiled['medical']['status'], compiled['medical']['reviewer'], compiled['medical']['note']), ('CLEARED', 'Dr Mehreen', 'Normal panel'))
        self.assertEqual((compiled['financial']['status'], compiled['financial']['submitted']), ('REFERRED', True))
        from services.underwriting_gate import build_evidence_bundle
        async with factory() as s:
            bundle = await build_evidence_bundle(s, self.t.id, await s.get(Case, self.case.caseld))
        self.assertEqual(bundle['specialist_reviews']['financial']['note'], 'Income unverified')

    async def test_specialist_cannot_take_or_edit_another_assignee(self):
        # General underwriters can own either track, but a specialist cannot overwrite that owner.
        async with factory() as s:
            role = Role(name='Underwriter'); s.add(role); await s.flush()
            other = User(tenant_id=self.t.id, role_id=role.id, email=uuid4().hex+'@test.local', full_name='Other reviewer', username=uuid4().hex, hashed_password='unused')
            s.add(other); await s.commit()
        assigned = await self.http.put(self.url('medical'), json={'assigned_user_id': str(other.id)}, headers=self.admin_h)
        self.assertEqual(assigned.status_code, 200, assigned.text)
        denied = await self.http.put(self.url('medical'), json={'status':'CLEARED','note':'Attempt overwrite'}, headers=self.med_h)
        self.assertEqual(denied.status_code, 403)
        root=f"/tenants/{self.t.id}/underwriting/reviews"
        self.assertEqual((await self.http.get(root, headers=self.med_h)).json(), [])
        self.assertEqual((await self.http.get(root+f"/{self.case.caseld}",headers=self.med_h)).status_code,403)

    async def test_specialist_decision_requires_reason_and_self_assignment(self):
        self.assertEqual((await self.http.put(self.url('medical'),json={'status':'CLEARED'},headers=self.med_h)).status_code,422)
        saved=await self.http.put(self.url('medical'),json={'status':'REFERRED','note':'Need cardiology evidence'},headers=self.med_h)
        self.assertEqual(saved.status_code,200,saved.text)
        self.assertEqual(saved.json()['assigned_user_id'],str(self.med.id))
        self.assertEqual((await self.http.put(self.url('medical'),json={'clear_assignee':True},headers=self.med_h)).status_code,403)
        row=await self.listed()
        self.assertEqual(row['medical_review']['status'],'REFERRED')
        self.assertEqual(row['financial_review']['status'],'PENDING')

    async def test_specialists_cannot_mutate_general_workflows(self):
        for headers in (self.med_h,self.fin_h):
            for path in [f"/tenants/{self.t.id}/cases/{self.case.caseld}/compliance/run",
                         f"/tenants/{self.t.id}/cases/{self.case.caseld}/hold",
                         f"/tenants/{self.t.id}/policies/any/issue"]:
                response=await self.http.post(path,json={},headers=headers)
                self.assertEqual(response.status_code,403,response.text)


    async def test_closed_application_stays_with_its_specialist_read_only(self):
        await self.http.put(self.url('medical'),json={'assigned_user_id':str(self.med.id)},headers=self.med_h)
        async with factory() as s:
            c=await s.get(Case,self.case.caseld); c.caseStatus=CaseStatusEnum.CLOSED; s.add(c); await s.commit()
        root=f"/tenants/{self.t.id}/underwriting/reviews"
        queue=(await self.http.get(root,headers=self.med_h)).json()
        self.assertEqual([(q['id'],q['closed']) for q in queue],[(str(self.case.caseld),True)])
        self.assertEqual((await self.http.get(root,headers=self.fin_h)).json(),[])  # never assigned on financial
        detail=await self.http.get(root+f"/{self.case.caseld}",headers=self.med_h)
        self.assertTrue(detail.json()['read_only'])
        response=await self.http.put(self.url('medical'),json={'status':'CLEARED','note':'Attempt late change'},headers=self.med_h)
        self.assertEqual(response.status_code,409,response.text)

    async def test_specialists_have_working_track_tools_not_just_review_notes(self):
        root=f"/tenants/{self.t.id}/cases/{self.case.caseld}"
        # Unassigned work cannot be mutated before the reviewer picks it up.
        self.assertEqual((await self.http.post(root+'/medical-exam/assess',headers=self.med_h)).status_code,403)
        for track, headers in [('medical',self.med_h),('financial',self.fin_h)]:
            self.assertEqual((await self.http.put(self.url(track),json={'status':'IN_REVIEW'},headers=headers)).status_code,200)
        medical=await self.http.post(root+'/medical-exam/assess',headers=self.med_h)
        self.assertEqual(medical.status_code,200,medical.text)
        self.assertIn('non_medical_limit',medical.json())
        history=await self.http.post(root+'/insurance-history/run',headers=self.fin_h)
        self.assertEqual(history.status_code,200,history.text)
        self.assertIn('aggregate_sum_assured',history.json())
        self.assertEqual((await self.http.post(root+'/medical-exam/assess',headers=self.fin_h)).status_code,403)
        self.assertEqual((await self.http.post(root+'/insurance-history/run',headers=self.med_h)).status_code,403)
        self.assertEqual((await self.http.post(root+'/insurance-history/clear',json={'note':''},headers=self.fin_h)).status_code,422)
        clear=await self.http.post(root+'/insurance-history/clear',json={'note':'Income documents checked'},headers=self.fin_h)
        self.assertEqual(clear.status_code,200,clear.text)
        self.assertEqual(clear.json()['clearance_note'],'Income documents checked')

    async def test_tools_respect_hold_and_missing_policy(self):
        root=f"/tenants/{self.t.id}/cases/{self.case.caseld}"
        await self.http.put(self.url('medical'),json={'status':'IN_REVIEW'},headers=self.med_h)
        async with factory() as s:
            case=await s.get(Case,self.case.caseld); case.policy_id=None; s.add(case)
            s.add(Policy(tenant_id=self.t.id,customer_id=case.customer_id,product_name='Another plan',insurance_type='TERM_LIFE',coverage_amount=2000000,term_years=10,status='UnderReview'))
            await s.commit()
        response=await self.http.post(root+'/medical-exam/assess',headers=self.med_h)
        self.assertEqual(response.status_code,409,response.text)
        self.assertIn('No proposal',response.json()['detail'])
        async with factory() as s:
            case=await s.get(Case,self.case.caseld); case.on_hold=True; s.add(case); await s.commit()
        self.assertEqual((await self.http.post(root+'/medical-exam/assess',headers=self.med_h)).status_code,409)

    async def test_evidence_resolves_application_assessment_and_shared_customer_documents(self):
        from shared.models.core import Artifact, RiskAssessment, AIDecision
        async with factory() as s:
            s.add(RiskAssessment(tenant_id=self.t.id,customer_id=self.case.customer_id,case_id=self.case.caseld,policy_id=None,
                medical_score=21,financial_score=41,fraud_probability=0.1,composite_risk_score=30,ai_decision=AIDecision.HUMAN_REVIEW))
            s.add(Artifact(tenant_id=self.t.id,customer_id=self.case.customer_id,case_id=None,document_type='Medical Report',file_name='medical.pdf',ocr_result='Clinical evidence'))
            s.add(Artifact(tenant_id=self.t.id,customer_id=self.case.customer_id,case_id=None,document_type='Salary Slip',file_name='salary.pdf'))
            await s.commit()
        root=f"/tenants/{self.t.id}/underwriting/reviews/{self.case.caseld}"
        med=(await self.http.get(root,headers=self.med_h)).json()
        fin=(await self.http.get(root,headers=self.fin_h)).json()
        self.assertEqual(med['assessment']['score'],21)
        self.assertEqual(fin['assessment']['score'],41)
        self.assertEqual([d['name'] for d in med['documents']],['medical.pdf'])
        self.assertEqual([d['name'] for d in fin['documents']],['salary.pdf'])
        self.assertEqual(med['documents'][0]['scope'],'customer')

    async def test_uploads_stay_in_the_owning_track(self):
        from unittest.mock import AsyncMock, patch
        root=f"/tenants/{self.t.id}/cases/{self.case.caseld}/underwriting-documents"
        await self.http.put(self.url('medical'),json={'status':'IN_REVIEW'},headers=self.med_h)
        await self.http.put(self.url('financial'),json={'status':'IN_REVIEW'},headers=self.fin_h)
        for headers, invalid in [(self.med_h,'Salary Slip'),(self.fin_h,'Medical Report')]:
            response=await self.http.post(root,data={'document_type':invalid},files={'file':('test.pdf',b'%PDF-1.4','application/pdf')},headers=headers)
            self.assertEqual(response.status_code,403,response.text)
        with patch('routers.artifacts.upload_artifact',AsyncMock(return_value={'id':'synthetic-document','status':'Uploaded'})) as upload:
            response=await self.http.post(root,data={'document_type':'Salary Slip'},files={'file':('salary.pdf',b'%PDF-1.4','application/pdf')},headers=self.fin_h)
            self.assertEqual(response.status_code,202,response.text)
            self.assertEqual(upload.call_args.kwargs['case_id'],self.case.caseld)
        response=await self.http.post(root,data={'document_type':'Medical Report','test_code':'NOT-ORDERED'},files={'file':('lab.pdf',b'%PDF-1.4','application/pdf')},headers=self.med_h)
        self.assertEqual(response.status_code,422,response.text)

    async def test_outstanding_application_documents_can_be_uploaded_by_their_owner(self):
        from unittest.mock import AsyncMock, patch
        root=f"/tenants/{self.t.id}/cases/{self.case.caseld}/underwriting-documents"
        await self.http.put(self.url('financial'),json={'status':'IN_REVIEW'},headers=self.fin_h)
        with patch('routers.artifacts.upload_artifact',AsyncMock(return_value={'id':'synthetic-document','status':'Uploaded'})):
            cnic=await self.http.post(root,data={'document_type':'CNIC'},files={'file':('cnic.pdf',b'%PDF-1.4','application/pdf')},headers=self.fin_h)
            self.assertEqual(cnic.status_code,202,cnic.text)  # outstanding, and either track may collect it
            physician=await self.http.post(root,data={'document_type':'Physician Report'},files={'file':('p.pdf',b'%PDF-1.4','application/pdf')},headers=self.fin_h)
            self.assertEqual(physician.status_code,403,physician.text)  # a medical document, whatever its status

    async def test_single_legacy_plan_is_resolved_without_changing_the_application(self):
        async with factory() as s:
            c=await s.get(Case,self.case.caseld); original=c.policy_id; c.policy_id=None; s.add(c); await s.commit()
        detail=await self.http.get(f"/tenants/{self.t.id}/underwriting/reviews/{self.case.caseld}",headers=self.med_h)
        self.assertEqual(detail.status_code,200,detail.text)
        self.assertTrue(detail.json()['policy_linked'])
        self.assertEqual(detail.json()['product_name'],'Term Life')
        self.assertEqual(detail.json()['coverage_amount'],1000000)
        async with factory() as s:
            self.assertIsNone((await s.get(Case,self.case.caseld)).policy_id)
        await self.http.put(self.url('medical'),json={'status':'IN_REVIEW'},headers=self.med_h)
        response=await self.http.post(f"/tenants/{self.t.id}/cases/{self.case.caseld}/medical-exam/assess",headers=self.med_h)
        self.assertEqual(response.status_code,200,response.text)


if __name__ == "__main__":
    async def create():
        engine = create_async_engine(f"{ADMIN}/postgres", isolation_level="AUTOCOMMIT")
        async with engine.connect() as c:
            await c.execute(text(f'CREATE DATABASE "{DB}"'))
        await engine.dispose()
        target = create_async_engine(f"{ADMIN}/{DB}", poolclass=NullPool)
        async with target.begin() as c:
            await c.run_sync(SQLModel.metadata.create_all)
        return target

    async def drop(target):
        await target.dispose()
        engine = create_async_engine(f"{ADMIN}/postgres", isolation_level="AUTOCOMMIT")
        async with engine.connect() as c:
            await c.execute(text(f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'))
        await engine.dispose()

    target = asyncio.run(create())
    factory = async_sessionmaker(target, class_=AsyncSession, expire_on_commit=False)
    database._session_factory = factory
    try:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Tracks))
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
