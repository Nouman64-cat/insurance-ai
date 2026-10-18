"""Claim AI is own-track evidence only and cannot record human decisions."""
import asyncio
from datetime import date
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from sqlmodel import select
from database import _session_factory, engine
from routers import underwriting_tracks as tracks, claims
from shared.models.core import (Case, CaseUnderwritingTrack, ClaimProcess, ClaimUnderwritingCheck, User, Role)
from test_group_census import _setup
from test_specialist_claim_documents import cleanup_claim_test


@pytest.mark.parametrize('track', ['medical', 'financial'])
def test_claim_ai_runs_only_assigned_track_and_never_changes_human_outcome(monkeypatch, track):
    identity = {}
    async def specialist(*_):
        return identity['user'], identity['track']
    monkeypatch.setattr(tracks, '_specialist_identity', specialist)
    async def number(*_):
        return f'CLM-AI-{uuid4().hex}'
    monkeypatch.setattr(claims, '_generate_claim_number', number)
    calls = []
    async def evaluate(body, tenant):
        calls.append(body)
        return {'recommendation': 'Decline', 'summary': 'Human review required', 'findings': [], 'missing_evidence': [], 'advisory': True}
    monkeypatch.setattr(tracks, '_evaluate_claim_ai', evaluate)

    async def run():
        async with _session_factory() as session:
            fx = await _setup(session)
            try:
                role = (await session.exec(select(Role).where(Role.name == tracks.TRACK_ROLE[track.upper()]))).first()
                user = User(tenant_id=fx['tenant_id'], role_id=role.id, email=f'{uuid4().hex}@test.invalid',
                    username=uuid4().hex, hashed_password='not-a-login-password', full_name='AI test reviewer')
                session.add(user)
                await session.flush()
                claim, _, _ = await claims.open_claim(session, fx['tenant_id'], user, claims.ClaimCreate(
                    policy_id=fx['individual_policy'], claim_type='Death Claim', submitted_amount=200000,
                    incident_date=date(2026, 10, 18)))
                case = await session.get(Case, fx['individual_case'])
                case.claim_id = claim.id
                session.add(case)
                review = CaseUnderwritingTrack(tenant_id=fx['tenant_id'], case_id=case.caseld, track=track.upper(),
                    assigned_user_id=user.id, status='IN_REVIEW', note='Human note retained')
                session.add(review)
                proc = ClaimProcess(tenant_id=fx['tenant_id'], policy_id=claim.policy_id, claim_id=claim.id,
                    category='Death', segment='Individual', event_date=date(2026, 10, 18), documents_json=[
                        {'key': 'bank', 'label': 'Payee bank account details / cancelled cheque', 'required': True, 'status': 'Received'},
                        {'key': 'medical', 'label': 'Hospital records', 'required': True, 'status': 'Received'}])
                session.add(proc)
                await session.commit()
                identity.update(user=user, track=track.upper())
                args = dict(tenant_id=fx['tenant_id'], case_id=case.caseld, track=track, session=session, token='synthetic')
                original = (case.caseStatus, claim.status)
                ws = await tracks._build_workspace(session, fx['tenant_id'], case.caseld, user, track.upper())
                assert ws['claim_ai_underwriting']['ready']
                result = await tracks.run_claim_track_ai(**args)
                assert result['result']['recommendation'] == 'Decline'
                assert result['result']['advisory']
                await session.refresh(review)
                await session.refresh(case)
                await session.refresh(claim)
                assert (case.caseStatus, claim.status) == original
                assert review.status == 'IN_REVIEW' and review.note == 'Human note retained'
                assert not (await session.exec(select(ClaimUnderwritingCheck).where(ClaimUnderwritingCheck.case_id == case.caseld))).all()
                from services.specialist_reviews import compile_specialist_reviews
                compiled = await compile_specialist_reviews(session, case.caseld)
                assert compiled[track]['ai']['recommendation'] == 'Decline'
                assert compiled[track]['submitted'] is False
                assert calls[0]['track'] == track
                assert calls[0]['context']['claim']['id'] == str(claim.id)
                # Wrong track, tenant, owner, held/closed/decided are denied before an LLM call.
                with pytest.raises(HTTPException) as denied:
                    await tracks.run_claim_track_ai(**{**args, 'track': 'medical' if track == 'financial' else 'financial'})
                assert denied.value.status_code == 403
                with pytest.raises(HTTPException) as denied:
                    await tracks.run_claim_track_ai(**{**args, 'tenant_id': uuid4()})
                assert denied.value.status_code == 404
                review.assigned_user_id = None
                session.add(review)
                await session.commit()
                with pytest.raises(HTTPException) as denied:
                    await tracks.run_claim_track_ai(**args)
                assert denied.value.status_code == 403
                review.assigned_user_id = user.id
                session.add(review)
                case.on_hold = True
                session.add(case)
                await session.commit()
                with pytest.raises(HTTPException) as denied:
                    await tracks.run_claim_track_ai(**args)
                assert denied.value.status_code == 409
                assert len(calls) == 1
                case.on_hold = False
                session.add(case)
                proc.documents_json = [{**d, 'status': 'Requested'} for d in proc.documents_json]
                session.add(proc)
                await session.commit()
                with pytest.raises(HTTPException) as denied:
                    await tracks.run_claim_track_ai(**args)
                assert denied.value.status_code == 409 and 'outstanding' in str(denied.value.detail)
                assert len(calls) == 1
                proc.documents_json = [{**d, 'status': 'Received'} for d in proc.documents_json]
                session.add(proc)
                await session.commit()
                async def unavailable(*_):
                    raise HTTPException(502, 'Provider unavailable')
                monkeypatch.setattr(tracks, '_evaluate_claim_ai', unavailable)
                with pytest.raises(HTTPException) as failed:
                    await tracks.run_claim_track_ai(**args)
                assert failed.value.status_code == 502
                await session.refresh(review)
                assert review.status == 'IN_REVIEW' and review.ai_result['recommendation'] == 'Decline'
                # Ownership can change while the model is running. Refuse to save its result then.
                async def reassigned(body, tenant):
                    review.assigned_user_id = None
                    session.add(review)
                    await session.commit()
                    return {'recommendation': 'Proceed'}
                monkeypatch.setattr(tracks, '_evaluate_claim_ai', reassigned)
                with pytest.raises(HTTPException) as denied:
                    await tracks.run_claim_track_ai(**args)
                assert denied.value.status_code == 403
                await session.refresh(review)
                assert review.ai_result['recommendation'] == 'Decline'
            finally:
                await cleanup_claim_test(session, fx)
        await engine.dispose()
    asyncio.run(run())


def test_claim_ai_requires_bearer_authentication():
    import httpx
    from database import get_session
    app = FastAPI()
    app.include_router(tracks.router)
    app.dependency_overrides[get_session] = lambda: None
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            result = await client.post(f'/tenants/{uuid4()}/cases/{uuid4()}/claim-underwriting/medical/run')
            assert result.status_code in (401, 403)
    asyncio.run(run())
