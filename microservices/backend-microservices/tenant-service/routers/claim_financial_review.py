"""Claims-manager reads and evidence-backed findings for claim financial underwriting."""
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession
from database import get_session
from routers.auth import oauth2_scheme, _get_current_user, _role_name
from shared.models.core import Case, CaseTypeEnum, Claim, ClaimProcess, ClaimUnderwritingCheck, InsurancePlan, Policy

router = APIRouter(prefix='/tenants/{tenant_id}/claims/{claim_id}/financial-underwriting', tags=['Claim financial underwriting'])


@router.get('')
async def get_claim_financial_review(tenant_id: UUID, claim_id: UUID,
    token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)):
    user = await _get_current_user(token, session)
    if await _role_name(user, session) != 'ClaimsManager' or user.tenant_id != tenant_id:
        raise HTTPException(403, 'This claim financial-review tool requires a Claims Manager in this organization.')
    claim = await session.get(Claim, claim_id)
    if claim is None or claim.tenant_id != tenant_id:
        raise HTTPException(404, 'Claim not found.')
    case = (await session.exec(select(Case).where(Case.tenant_id == tenant_id,
        Case.claim_id == claim_id, Case.caseType == CaseTypeEnum.UNDERWRITING).order_by(Case.createdAt.desc()))).first()
    if case is None:
        raise HTTPException(409, 'This claim has not been referred to underwriting. Refer it before reviewing its financial underwriting requirements.')
    policy = await session.get(Policy, claim.policy_id)
    if policy is None or policy.tenant_id != tenant_id or case.policy_id != policy.id:
        raise HTTPException(409, 'The claim and its underwriting referral must link to the same policy.')
    plan = (await session.exec(select(InsurancePlan).where(InsurancePlan.tenant_id == tenant_id,
        InsurancePlan.label == policy.product_name))).first()
    proc = (await session.exec(select(ClaimProcess).where(ClaimProcess.claim_id == claim_id))).first()
    from services.underwriting_gate import claim_documents_for
    from services.claim_engine import claim_review_requirements
    from routers.underwriting_tracks import reviews_by_case
    reviews = (await reviews_by_case(session, [case.caseld]))[case.caseld]
    saved = (await session.exec(select(ClaimUnderwritingCheck).where(
        ClaimUnderwritingCheck.case_id == case.caseld, ClaimUnderwritingCheck.track == 'FINANCIAL',
        ClaimUnderwritingCheck.tenant_id == tenant_id))).all()
    checks = {c.requirement_key: {'finding': c.finding, 'note': c.note,
        'updated_by': str(c.updated_by), 'updated_at': c.updated_at.isoformat()} for c in saved}
    requirements, documents = claim_review_requirements(track='FINANCIAL', claims_terms=plan.claims_terms if plan else None,
        documents=await claim_documents_for(session, tenant_id, claim_id),
        contestable=claim.is_contestable or bool(((proc.eligibility_json if proc else None) or {}).get('contestable')),
        review_submitted=reviews['FINANCIAL']['status'] in {'CLEARED','REFERRED','DECLINED'}, checks=checks)
    return {'claim_id': str(claim.id), 'claim_number': claim.claim_number, 'case_id': str(case.caseld),
        'case_number': case.caseNumber, 'policy_id': str(policy.id), 'policy_number': policy.policy_number,
        'review': reviews['FINANCIAL'], 'requirements': requirements, 'required_documents': documents,
        'checks': checks, 'read_only': case.on_hold or str(getattr(case.caseStatus,'value',case.caseStatus)) in {'Approved','Closed','Rejected'} or str(getattr(claim.status,'value',claim.status)) in {'Approved','Partial Approval','Declined','Settled','Closed'},
        'ready_to_clear': all(r['status'] in {'Completed','Received','Waived','NotRequired'} for r in requirements)}


from schemas import ClaimUnderwritingCheckInput


@router.post('/checks')
async def record_claim_financial_check(request: Request, tenant_id: UUID, claim_id: UUID, body: ClaimUnderwritingCheckInput,
    token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)):
    from datetime import datetime
    from shared.models.core import CaseAuditTrail, CaseUnderwritingTrack
    context = await get_claim_financial_review(tenant_id, claim_id, token, session)
    case = (await session.exec(select(Case).where(Case.caseld == UUID(context['case_id'])).with_for_update().execution_options(populate_existing=True))).one()
    claim = await session.get(Claim, claim_id)
    if case.on_hold or str(getattr(case.caseStatus,'value',case.caseStatus)) in {'Approved','Closed','Rejected'} or str(getattr(claim.status,'value',claim.status)) in {'Approved','Partial Approval','Declined','Settled','Closed'}:
        raise HTTPException(409, 'This claim or its underwriting review is held, decided or closed.')
    if body.key not in {r['key'] for r in context['requirements']} or len(body.note.strip()) < 5:
        raise HTTPException(422, 'Record an applicable financial requirement with supporting evidence and rationale.')
    review = (await session.exec(select(CaseUnderwritingTrack).where(
        CaseUnderwritingTrack.case_id == case.caseld, CaseUnderwritingTrack.track == 'FINANCIAL'))).first()
    if review is None or review.assigned_user_id is None:
        raise HTTPException(409, 'Assign a Financial Underwriter before recording findings for this review.')
    user = await _get_current_user(token, session)
    saved = (await session.exec(select(ClaimUnderwritingCheck).where(
        ClaimUnderwritingCheck.case_id == case.caseld, ClaimUnderwritingCheck.track == 'FINANCIAL',
        ClaimUnderwritingCheck.requirement_key == body.key))).first()
    if saved and saved.finding == body.finding and saved.note == body.note.strip():
        return await get_claim_financial_review(tenant_id,claim_id,token,session)
    previous = f'{saved.finding}: {saved.note}' if saved else 'Not reviewed'
    if saved is None:
        saved = ClaimUnderwritingCheck(tenant_id=tenant_id,case_id=case.caseld,track='FINANCIAL',
            requirement_key=body.key,finding=body.finding,note=body.note.strip(),updated_by=user.id)
    saved.finding,saved.note,saved.updated_by,saved.updated_at = body.finding,body.note.strip(),user.id,datetime.utcnow()
    session.add(saved)
    # A changed finding invalidates a previous specialist decision; the assignee must review it again.
    review.status = 'IN_REVIEW'
    review.updated_by,review.updated_at = user.id,datetime.utcnow()
    session.add(review)
    session.add(CaseAuditTrail(caseld=case.caseld,actionPerformed='Claims Manager recorded financial claim finding',
        entityChanged=body.key,previousValue=previous,newValue=f'{saved.finding}: {saved.note}',performedBy=user.id,timestamp=datetime.utcnow()))
    await session.commit()
    from services.case_events import publish_case_event
    await publish_case_event(request, session, event_type='ClaimFinancialFindingRecorded',
        tenant_id=tenant_id, case_id=case.caseld, detail={'track':'financial','requirement':body.key})
    return await get_claim_financial_review(tenant_id,claim_id,token,session)
