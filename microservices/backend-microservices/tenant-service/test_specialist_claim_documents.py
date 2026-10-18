"""Claim specialists may work their assigned evidence, never another track or a final claim decision."""
import asyncio
from datetime import date
from io import BytesIO
from starlette.datastructures import UploadFile
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlmodel import select, delete

from database import _session_factory, engine
from routers import underwriting_tracks as tracks
from routers import claims
from shared.models.core import (Case, CaseAuditTrail, CaseHistory, CaseWorkflow, CaseRequirement, CaseUnderwritingTrack, Artifact, Claim, ClaimProcess,
    ClaimStatusEnum, ClaimStatusHistory, User, Role)
from services.underwriting_gate import claim_documents_for
from test_group_census import _setup, _cleanup


async def cleanup_claim_test(session, fx):
    await session.rollback()
    cases = select(Case.caseld).where(Case.tenant_id == fx['tenant_id'])
    await session.exec(delete(CaseAuditTrail).where(CaseAuditTrail.caseld.in_(cases)))
    await session.exec(delete(CaseHistory).where(CaseHistory.caseld.in_(cases)))
    await session.exec(delete(CaseWorkflow).where(CaseWorkflow.caseld.in_(cases)))
    for model in (CaseRequirement, CaseUnderwritingTrack, ClaimProcess, ClaimStatusHistory):
        await session.exec(delete(model).where(model.tenant_id == fx['tenant_id']))
    for case in (await session.exec(select(Case).where(Case.tenant_id == fx['tenant_id']))).all():
        case.claim_id = None
        session.add(case)
    await session.flush()
    await session.exec(delete(Artifact).where(Artifact.tenant_id == fx['tenant_id']))
    await session.exec(delete(Claim).where(Claim.tenant_id == fx['tenant_id']))
    await session.exec(delete(User).where(User.tenant_id == fx['tenant_id']))
    await session.commit()
    await _cleanup(session, fx['tenant_id'])


def test_claim_document_waivers_sync_checklist_and_reject_wrong_track_or_owner(monkeypatch):
    async def number(*_):
        return f'CLM-TEST-{uuid4().hex}'
    monkeypatch.setattr(claims, '_generate_claim_number', number)
    identity = {}
    async def specialist(*_):
        return identity['user'], identity['track']
    monkeypatch.setattr(tracks, '_specialist_identity', specialist)
    from routers import artifacts
    async def store_upload(**kw):
        artifact = Artifact(tenant_id=kw['tenant_id'], case_id=kw['case_id'], document_type=kw['document_type'],
                            file_name=kw['file'].filename, uploaded_by=identity['user'].id, status='Accepted')
        kw['session'].add(artifact)
        await kw['session'].commit()
        return {'id': str(artifact.id)}
    monkeypatch.setattr(artifacts, 'upload_artifact', store_upload)

    async def run():
        async with _session_factory() as session:
            fx = await _setup(session)
            try:
                role = (await session.exec(select(Role).where(Role.name == 'Financial Underwriter'))).first()
                assert role is not None
                user = User(tenant_id=fx['tenant_id'], role_id=role.id, email=f'{uuid4().hex}@test.invalid',
                    username=uuid4().hex, hashed_password='not-a-login-password', full_name='Test underwriter')
                session.add(user)
                await session.flush()
                claim, _, _ = await claims.open_claim(session, fx['tenant_id'], user, claims.ClaimCreate(
                    policy_id=fx['individual_policy'], claim_type='Death Claim', submitted_amount=200000,
                    incident_date=date(2026, 10, 18)))
                case = await session.get(Case, fx['individual_case'])
                case.claim_id = claim.id
                session.add(case)
                proc = ClaimProcess(tenant_id=fx['tenant_id'], policy_id=claim.policy_id, claim_id=claim.id,
                    category='Death', segment='Individual', event_date=date(2026, 10, 18), documents_json=[
                        {'key': 'bank', 'label': 'Payee bank account details / cancelled cheque', 'required': True, 'status': 'Requested'},
                        {'key': 'medical', 'label': 'Hospital records', 'required': True, 'status': 'Requested'},
                        {'key': 'physician', 'label': 'Physician Report', 'required': True, 'status': 'Requested'},
                        {'key': 'cnic', 'label': 'Claimant CNIC', 'required': True, 'status': 'Requested'}])
                session.add(proc)
                session.add(CaseUnderwritingTrack(tenant_id=fx['tenant_id'], case_id=case.caseld, track='FINANCIAL',
                    assigned_user_id=user.id, status='IN_REVIEW'))
                await session.commit()
                identity.update(user=user, track='FINANCIAL')
                args = dict(tenant_id=fx['tenant_id'], case_id=case.caseld, session=session, token='synthetic')
                with pytest.raises(HTTPException) as wrong_track:
                    await tracks.waive_specialist_claim_document(**args,
                        body=tracks.SpecialistDocumentWaiver(document_type='Hospital records', reason='Evidence held on file elsewhere'))
                assert wrong_track.value.status_code == 403
                result = await tracks.waive_specialist_claim_document(**args,
                    body=tracks.SpecialistDocumentWaiver(document_type='Payee bank account details / cancelled cheque',
                        reason='Verified bank details are already held on file'))
                assert result['status'] == 'Waived'
                documents = await claim_documents_for(session, fx['tenant_id'], claim.id)
                bank = next(doc for doc in documents if doc['key'] == 'bank')
                assert bank['status'] == 'Waived' and bank['waived_by'] == str(user.id)
                assert next(doc for doc in documents if doc['key'] == 'medical')['status'] == 'Requested'
                audits = (await session.exec(select(CaseAuditTrail).where(CaseAuditTrail.caseld == case.caseld))).all()
                assert any(a.performedBy == user.id and 'Verified bank details' in a.newValue for a in audits)
                # A repeat is harmless and does not add another audit event.
                repeat = await tracks.waive_specialist_claim_document(**args,
                    body=tracks.SpecialistDocumentWaiver(document_type='Payee bank account details / cancelled cheque',
                        reason='Verified bank details are already held on file'))
                assert repeat['already_waived']
                identity['user'] = SimpleNamespace(id=uuid4())
                with pytest.raises(HTTPException) as wrong_owner:
                    await tracks.waive_specialist_claim_document(**args,
                        body=tracks.SpecialistDocumentWaiver(document_type='Payee bank account details / cancelled cheque', reason='Another rationale'))
                assert wrong_owner.value.status_code == 403
                identity['user'] = user
                session.add(CaseUnderwritingTrack(tenant_id=fx['tenant_id'], case_id=case.caseld, track='MEDICAL',
                    assigned_user_id=user.id, status='IN_REVIEW'))
                await session.commit()
                identity['track'] = 'MEDICAL'
                medical = await tracks.waive_specialist_claim_document(**args,
                    body=tracks.SpecialistDocumentWaiver(document_type='Hospital records', reason='Existing hospital evidence verified'))
                assert medical['status'] == 'Waived'
                for track, label in [('MEDICAL', 'Physician Report'), ('FINANCIAL', 'Claimant CNIC')]:
                    identity['track'] = track
                    await tracks.upload_specialist_document(**args, request=None, document_type=label,
                        file=UploadFile(filename='test-evidence.pdf', file=BytesIO(b'%PDF-test')), test_code=None)
                    documents = await claim_documents_for(session, fx['tenant_id'], claim.id)
                    document = next(doc for doc in documents if doc['label'] == label)
                    assert document['status'] == 'Received'
                    from uuid import UUID
                    artifact = await session.get(Artifact, UUID(document['artifact_id']))
                    assert artifact.claim_id == claim.id and artifact.case_id == case.caseld
                identity['track'] = 'FINANCIAL'
                # Legacy register-only claims retain the same waiver through their case requirements.
                await session.delete(proc)
                await session.commit()
                from services.claim_engine import is_medical_document
                legacy_docs = await claim_documents_for(session, fx['tenant_id'], claim.id)
                legacy = next(doc for doc in legacy_docs if not is_medical_document(doc['label']) and doc['status'] == 'Requested')
                await tracks.waive_specialist_claim_document(**args, body=tracks.SpecialistDocumentWaiver(
                    document_type=legacy['label'], reason='Alternative evidence reviewed and recorded'))
                refreshed = await claim_documents_for(session, fx['tenant_id'], claim.id)
                assert next(doc for doc in refreshed if doc['label'] == legacy['label'])['status'] == 'Waived'
                claim.status = ClaimStatusEnum.CLOSED
                session.add(claim)
                await session.commit()
                with pytest.raises(HTTPException) as closed:
                    await tracks.waive_specialist_claim_document(**args,
                        body=tracks.SpecialistDocumentWaiver(document_type='Payee bank account details / cancelled cheque', reason='Another rationale'))
                assert closed.value.status_code == 409
            finally:
                await cleanup_claim_test(session, fx)
        await engine.dispose()
    asyncio.run(run())
