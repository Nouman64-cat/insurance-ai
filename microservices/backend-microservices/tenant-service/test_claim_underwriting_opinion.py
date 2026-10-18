"""AI advice, Admin's human underwriting opinion, and the Claims Manager's decision are separate."""
import asyncio
from datetime import datetime, timedelta
from uuid import uuid4
import pytest
from fastapi import HTTPException
from sqlmodel import select
from database import _session_factory, engine
from routers import underwriting_tracks as tracks, claims
from services.claim_underwriting_opinion import opinion_state
from shared.models.core import (AIDecision, Case, CaseStatusEnum, CaseUnderwritingTrack, ClaimStatusEnum,
    RiskAssessment, Role, User, Policy, PolicyStatusEnum)
from test_group_census import _setup
from test_specialist_claim_documents import cleanup_claim_test


def test_admin_can_disagree_with_ai_and_only_claims_manager_decides(monkeypatch):
    actor = {}
    async def identity(*_): return actor['user']
    async def role(*_): return actor['role']
    for module in (tracks, claims):
        monkeypatch.setattr(module, '_get_current_user', identity)
        monkeypatch.setattr(module, '_role_name', role)
    async def number(*_): return f'CLM-TEST-{uuid4().hex}'
    monkeypatch.setattr(claims, '_generate_claim_number', number)

    async def run():
        async with _session_factory() as session:
            fx = await _setup(session)
            try:
                admin_role = (await session.exec(select(Role).where(Role.name == 'Admin'))).first()
                user = User(tenant_id=fx['tenant_id'], role_id=admin_role.id, email=f'{uuid4().hex}@test.invalid',
                    username=uuid4().hex, hashed_password='not-a-login-password', full_name='Test Admin')
                session.add(user); await session.flush()
                actor.update(user=user, role='Admin')
                claim, policy, _ = await claims.open_claim(session, fx['tenant_id'], user, claims.ClaimCreate(
                    policy_id=fx['individual_policy'], claim_type='Death Claim', submitted_amount=200000))
                claim.status = ClaimStatusEnum.REUNDERWRITING_REQUIRED
                case = await session.get(Case, fx['individual_case'])
                case.claim_id, case.caseStatus = claim.id, CaseStatusEnum.UNDER_REVIEW
                medical = CaseUnderwritingTrack(tenant_id=fx['tenant_id'], case_id=case.caseld, track='MEDICAL',
                    assigned_user_id=user.id, status='CLEARED', note='Medical evidence reviewed')
                financial = CaseUnderwritingTrack(tenant_id=fx['tenant_id'], case_id=case.caseld, track='FINANCIAL',
                    assigned_user_id=user.id, status='CLEARED', note='Financial evidence reviewed')
                assessment = RiskAssessment(tenant_id=fx['tenant_id'], customer_id=fx['individual_id'], policy_id=policy.id,
                    case_id=case.caseld, medical_score=80, financial_score=70, fraud_probability=.1, ai_decision=AIDecision.DECLINE)
                session.add_all([claim, case, medical, financial, assessment]); await session.commit()
                args = dict(tenant_id=fx['tenant_id'], case_id=case.caseld, session=session, token='test')
                state = await claims.claim_underwriting_review_state(session, claim)
                assert state['reviews_complete'] and not state['ready']
                assert state['ai_recommendation'] == 'Decline'
                body = tracks.ClaimUnderwritingOutcomeBody(decision='PROCEED', reason='Evidence supports continuing despite the AI recommendation', assessment_id=assessment.id)
                for denied_role in ['ClaimsManager', 'Medical Underwriter', 'Financial Underwriter', 'Finance']:
                    actor['role'] = denied_role
                    with pytest.raises(HTTPException) as error:
                        await tracks.record_claim_underwriting_outcome(**args, body=body)
                    assert error.value.status_code == 403
                actor['role'] = 'Admin'
                saved = await tracks.record_claim_underwriting_outcome(**args, body=body)
                assert saved['outcome']['decision'] == 'PROCEED'
                assert claim.status == ClaimStatusEnum.REUNDERWRITING_REQUIRED
                assert policy.status == PolicyStatusEnum.ACTIVE and case.caseStatus == CaseStatusEnum.UNDER_REVIEW
                state = await claims.claim_underwriting_review_state(session, claim)
                assert state['ready'] and state['outcome']['current']
                assert state['reviews']['medical']['status'] == 'CLEARED'
                # A specialist revision invalidates the opinion without deleting its audit record.
                financial.note = 'Revised financial evidence'; financial.updated_at = datetime.utcnow()
                session.add(financial); await session.commit()
                assert not (await claims.claim_underwriting_review_state(session, claim))['ready']
                await tracks.record_claim_underwriting_outcome(**args, body=body)
                # New AI output is still advisory and requires Admin to consider that exact result.
                newer = RiskAssessment(tenant_id=fx['tenant_id'], customer_id=fx['individual_id'], policy_id=policy.id,
                    case_id=case.caseld, medical_score=20, financial_score=20, fraud_probability=.01,
                    ai_decision=AIDecision.AUTO_APPROVE, created_at=datetime.utcnow() + timedelta(seconds=1))
                session.add(newer); await session.commit()
                assert not (await claims.claim_underwriting_review_state(session, claim))['ready']
                with pytest.raises(HTTPException) as stale:
                    await tracks.record_claim_underwriting_outcome(**args, body=body)
                assert stale.value.status_code == 409
                # Admin can also recommend decline despite an AI approval; neither adjudicates the claim.
                await tracks.record_claim_underwriting_outcome(**args, body=tracks.ClaimUnderwritingOutcomeBody(
                    decision='DECLINE', reason='Human review identified a concern not reflected in the model', assessment_id=newer.id))
                assert claim.status == ClaimStatusEnum.REUNDERWRITING_REQUIRED
                with pytest.raises(HTTPException) as denied:
                    await claims.resolve_claim_underwriting(fx['tenant_id'], claim.id, claims.ClaimUnderwritingResolveRequest(
                        decision='APPROVE_CONTINUE', decision_notes='Manager reviewed and resolved the concern'), token='test', session=session)
                assert denied.value.status_code == 403
                actor['role'] = 'ClaimsManager'
                await claims.resolve_claim_underwriting(fx['tenant_id'], claim.id, claims.ClaimUnderwritingResolveRequest(
                    decision='APPROVE_CONTINUE', decision_notes='Manager reviewed the evidence and resolved the concern'), token='test', session=session)
                assert claim.status == ClaimStatusEnum.UNDER_INVESTIGATION and policy.status == PolicyStatusEnum.ACTIVE
                assert 'Human underwriting outcome: DECLINE' in claim.underwriting_decision_notes
                assert 'AI recommendation: Auto Approve (advisory)' in claim.underwriting_decision_notes
            finally:
                await cleanup_claim_test(session, fx)
        await engine.dispose()
    asyncio.run(run())
