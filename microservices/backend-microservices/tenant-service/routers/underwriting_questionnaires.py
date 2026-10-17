"""Independent, expiring customer disclosures for the assigned specialist."""
import hashlib
import secrets
from datetime import datetime, timedelta
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession
from database import get_session
from routers.auth import oauth2_scheme
from routers.underwriting_tracks import _specialist_identity
from shared.models.core import Case, CaseUnderwritingTrack, UnderwritingQuestionnaire
from services.case_events import publish_case_event
from services.customer_links import email_customer_link

router = APIRouter(tags=["Specialist questionnaires"])
QUESTIONS = {
    "MEDICAL": {
        "conditions": "Describe diagnosed illnesses, operations, hospital admissions and current symptoms (or write None).",
        "medications": "List current medicines, doses, treatments and allergies (or None).",
        "family_history": "Describe major illnesses in your immediate family (or None).",
        "lifestyle": "Describe smoking, tobacco, alcohol, exercise and any hazardous activities.",
        "tests": "Describe recent medical tests, results and treating doctors (or None).",
    },
    "FINANCIAL": {
        "occupation": "What is your occupation, employer or business and length of employment?",
        "income": "State annual income, currency, sources and whether gross or net.",
        "commitments": "State monthly household expenses, debts and financial dependants.",
        "assets": "Describe assets, savings and outstanding liabilities.",
        "insurance": "List existing or pending life insurance, insurers, cover and annual premiums (or None).",
        "funding": "Who will pay the premium, from which source, and what is the purpose of this cover?",
    },
}
def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()

async def staff_case(tenant_id, case_id, token, session):
    user, track = await _specialist_identity(tenant_id, token, session)
    case = await session.get(Case, case_id)
    review = (await session.exec(select(CaseUnderwritingTrack).where(CaseUnderwritingTrack.case_id == case_id, CaseUnderwritingTrack.track == track))).first()
    if not case or case.tenant_id != tenant_id or not review or review.assigned_user_id != user.id:
        raise HTTPException(403, "This review is not assigned to you.")
    return user, track, case

def view(row, track):
    return {"track": track.lower(), "questions": QUESTIONS[track], "status": "NotSent" if not row else "Submitted" if row.submitted_at else "Expired" if row.expires_at < datetime.utcnow() else "Sent", "sent_at": row.sent_at if row else None, "submitted_at": row.submitted_at if row else None, "answers": row.answers if row else None}

@router.get("/tenants/{tenant_id}/cases/{case_id}/underwriting-questionnaire")
async def read_questionnaire(tenant_id: UUID, case_id: UUID, token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)):
    _, track, _ = await staff_case(tenant_id, case_id, token, session)
    row = (await session.exec(select(UnderwritingQuestionnaire).where(UnderwritingQuestionnaire.case_id == case_id, UnderwritingQuestionnaire.track == track))).first()
    return view(row, track)

@router.post("/tenants/{tenant_id}/cases/{case_id}/underwriting-questionnaire/invite")
async def invite(tenant_id: UUID, case_id: UUID, token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)):
    user, track, case = await staff_case(tenant_id, case_id, token, session)
    # Serialize competing invitations; a replacement invalidates the earlier link.
    await session.exec(select(Case).where(Case.caseld == case_id).with_for_update())
    row = (await session.exec(select(UnderwritingQuestionnaire).where(UnderwritingQuestionnaire.case_id == case_id, UnderwritingQuestionnaire.track == track))).first()
    if row and row.submitted_at:
        raise HTTPException(409, "This questionnaire has already been submitted.")
    raw = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    if not row:
        row = UnderwritingQuestionnaire(tenant_id=tenant_id, case_id=case_id, track=track, token_hash=digest(raw), expires_at=now + timedelta(days=14), sent_by=user.id)
    row.token_hash, row.sent_at, row.expires_at, row.sent_by = digest(raw), now, now + timedelta(days=14), user.id
    session.add(row)
    await session.commit()
    link = f"/underwriting-questionnaire/{raw}"
    delivery = await email_customer_link(session, kind=track.lower()+"_questionnaire", tenant_id=tenant_id, case=case, link_path=link, expires_at=row.expires_at)
    return {**view(row, track), "link_path": link, **delivery}

async def public_row(raw_token, session):
    row = (await session.exec(select(UnderwritingQuestionnaire).where(UnderwritingQuestionnaire.token_hash == digest(raw_token)).with_for_update())).first()
    if not row:
        raise HTTPException(404, "Questionnaire not found.")
    if row.expires_at < datetime.utcnow():
        raise HTTPException(410, "This link has expired. Please contact your reviewer.")
    return row

@router.get("/public/underwriting-questionnaire/{raw_token}")
async def public_read(raw_token: str, session: AsyncSession = Depends(get_session)):
    row = await public_row(raw_token, session)
    # A submitted token never discloses the customer's sensitive answers.
    return {"track": row.track.lower(), "questions": QUESTIONS[row.track], "submitted": row.submitted_at is not None}

class Submission(BaseModel):
    answers: dict[str, str]
    signature: str = Field(min_length=2, max_length=200)
    consent: bool

@router.post("/public/underwriting-questionnaire/{raw_token}/submit")
async def submit(raw_token: str, body: Submission, request: Request, session: AsyncSession = Depends(get_session)):
    row = await public_row(raw_token, session)
    if row.submitted_at:
        raise HTTPException(409, "This questionnaire has already been submitted.")
    if not body.consent or not body.signature.strip() or set(body.answers) != set(QUESTIONS[row.track]) or any(not value.strip() or len(value) > 5000 for value in body.answers.values()):
        raise HTTPException(422, "Answer every question and sign the declaration.")
    case = await session.get(Case, row.case_id)
    if not case or case.on_hold or str(getattr(case.caseStatus, "value", case.caseStatus)) in {"Approved", "Closed", "Rejected"}:
        raise HTTPException(409, "This application is no longer accepting responses.")
    row.answers = {**body.answers, "signature": body.signature.strip(), "consent": True}
    row.submitted_at = datetime.utcnow()
    session.add(row)
    await session.commit()
    review = (await session.exec(select(CaseUnderwritingTrack).where(CaseUnderwritingTrack.case_id == row.case_id, CaseUnderwritingTrack.track == row.track))).first()
    await publish_case_event(request, session, event_type="UnderwritingQuestionnaireSubmitted", tenant_id=row.tenant_id, case_id=row.case_id, customer_id=case.customer_id, detail={"track": row.track.lower(), "reviewer_user_id": str(review.assigned_user_id) if review and review.assigned_user_id else None})
    return {"submitted": True}
