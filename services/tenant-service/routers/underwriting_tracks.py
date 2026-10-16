"""
Medical and financial underwriting tracks.

Every underwriting application is reviewed twice, by two kinds of underwriter:
a Medical Underwriter (health, medical evidence, panel exam) and a Financial
Underwriter (income, sum assured vs. means, premium affordability). Each review
is a CaseUnderwritingTrack row with its own status and assignee. A case with no
row for a track has not been picked up on it yet and reads as PENDING.

  GET /tenants/{tenant_id}/underwriting/underwriters
      the tenant's users who can take each track (for the admin's assign menu)
  PUT /tenants/{tenant_id}/cases/{case_id}/underwriting-tracks/{track}
      set a track's status / assignee / note

Who may change a track: Admin, SuperAdmin and the general Underwriter role, on
either track; a Medical Underwriter only the medical track and a Financial
Underwriter only the financial one — and those two may only assign it to
themselves. The admin's Underwriting page reads the tracks through GET /cases.
"""

from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, _role_name, oauth2_scheme
from schemas import UnderwritingTrackUpdate
from shared.models.core import (
    UNDERWRITING_TRACKS,
    Case,
    CaseAuditTrail,
    CaseUnderwritingTrack,
    Role,
    User,
)

router = APIRouter(prefix="/tenants/{tenant_id}", tags=["Underwriting tracks"])

TRACK_ROLE = {"MEDICAL": "Medical Underwriter", "FINANCIAL": "Financial Underwriter"}
# Roles that may work (and be assigned) either track.
GENERAL_ROLES = {"Underwriter"}
ADMIN_ROLES = {"Admin", "SuperAdmin"}

TrackParam = Literal["medical", "financial"]


def _pending() -> dict:
    return {"status": "PENDING", "assigned_user_id": None, "assigned_user_name": None, "note": None, "updated_at": None}


async def reviews_by_case(session: AsyncSession, case_ids: list[UUID]) -> dict[UUID, dict[str, dict]]:
    """{case_id: {"MEDICAL": review, "FINANCIAL": review}} for every case asked about, PENDING where no row exists."""
    out = {case_id: {track: _pending() for track in UNDERWRITING_TRACKS} for case_id in case_ids}
    if not case_ids:
        return out
    rows = (await session.exec(
        select(CaseUnderwritingTrack).where(CaseUnderwritingTrack.case_id.in_(case_ids))
    )).all()
    user_ids = {r.assigned_user_id for r in rows if r.assigned_user_id}
    names = {}
    if user_ids:
        names = {u.id: u.full_name for u in (await session.exec(select(User).where(User.id.in_(user_ids)))).all()}
    for r in rows:
        if r.track in out.get(r.case_id, {}):
            out[r.case_id][r.track] = {
                "status": r.status,
                "assigned_user_id": str(r.assigned_user_id) if r.assigned_user_id else None,
                "assigned_user_name": names.get(r.assigned_user_id),
                "note": r.note,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
    return out


def _tracks_for_role(role: str) -> set[str]:
    if role in ADMIN_ROLES or role in GENERAL_ROLES:
        return set(UNDERWRITING_TRACKS)
    return {track for track, track_role in TRACK_ROLE.items() if track_role == role}


@router.get("/underwriting/underwriters")
async def list_underwriters(
    tenant_id: UUID,
    session: AsyncSession = Depends(get_session),
    token: str = Depends(oauth2_scheme),
):
    """Active users of this tenant who can take a track, with the tracks each can take."""
    user = await _get_current_user(token, session)
    if user.tenant_id not in (tenant_id, None):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your organization.")
    role_names = set(TRACK_ROLE.values()) | GENERAL_ROLES
    rows = (await session.exec(
        select(User, Role.name)
        .join(Role, Role.id == User.role_id)
        .where(User.tenant_id == tenant_id, User.is_active == True, Role.name.in_(role_names))  # noqa: E712
        .order_by(User.full_name)
    )).all()
    return [
        {"id": str(u.id), "full_name": u.full_name, "email": u.email, "role": role,
         "tracks": sorted(t.lower() for t in _tracks_for_role(role))}
        for u, role in rows
    ]


@router.put("/cases/{case_id}/underwriting-tracks/{track}")
async def update_track(
    tenant_id: UUID,
    case_id: UUID,
    track: TrackParam,
    body: UnderwritingTrackUpdate,
    session: AsyncSession = Depends(get_session),
    token: str = Depends(oauth2_scheme),
):
    user = await _get_current_user(token, session)
    role = await _role_name(user, session)
    track_key = track.upper()
    if user.tenant_id not in (tenant_id, None) or track_key not in _tracks_for_role(role):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"The {track} underwriting review can be changed by an Admin, an Underwriter or a {TRACK_ROLE[track_key]} (you are {role}).",
        )

    case = (await session.exec(select(Case).where(Case.caseld == case_id).with_for_update())).first()
    if case is None or case.tenant_id != tenant_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Application not found.")

    if role in TRACK_ROLE.values() and str(getattr(case.caseStatus, 'value', case.caseStatus)) in {'Approved', 'Closed', 'Rejected'}:
        raise HTTPException(409, "This application is closed for specialist review.")
    if body.assigned_user_id is not None:
        if role not in ADMIN_ROLES and role not in GENERAL_ROLES and body.assigned_user_id != user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only assign this review to yourself.")
        assignee = (await session.exec(
            select(User, Role.name).join(Role, Role.id == User.role_id).where(User.id == body.assigned_user_id)
        )).first()
        if assignee is None or assignee[0].tenant_id != tenant_id or not assignee[0].is_active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Underwriter not found in this organization.")
        if track_key not in _tracks_for_role(assignee[1]) or assignee[1] in ADMIN_ROLES:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"{assignee[0].full_name} is a {assignee[1]}; the {track} review needs a {TRACK_ROLE[track_key]} or an Underwriter.",
            )

    row = (await session.exec(select(CaseUnderwritingTrack).where(
        CaseUnderwritingTrack.case_id == case_id, CaseUnderwritingTrack.track == track_key,
    ))).first()
    if row is None:
        row = CaseUnderwritingTrack(tenant_id=tenant_id, case_id=case_id, track=track_key)
    before = (row.status, row.assigned_user_id, row.note)
    if role in TRACK_ROLE.values():
        if row.assigned_user_id not in (None, user.id):
            raise HTTPException(403, "This review is assigned to another underwriter. Ask an admin to reassign it.")
        if body.clear_assignee:
            raise HTTPException(403, "Only an admin or general underwriter can unassign a review.")
        # A specialist's first saved review is owned by that verified user.
        if row.assigned_user_id is None:
            row.assigned_user_id = user.id
        if body.status in {"CLEARED", "REFERRED", "DECLINED"} and not (body.note or '').strip():
            raise HTTPException(422, "Record a reason for the review decision.")

    if body.status is not None:
        row.status = body.status
    if body.clear_assignee:
        row.assigned_user_id = None
    elif body.assigned_user_id is not None:
        row.assigned_user_id = body.assigned_user_id
        # Picking up a review that nobody has started puts it in review.
        if body.status is None and row.status == "PENDING":
            row.status = "IN_REVIEW"
    if body.note is not None:
        row.note = body.note.strip() or None
    row.updated_by = user.id
    row.updated_at = datetime.utcnow()
    session.add(row)

    if (row.status, row.assigned_user_id, row.note) != before:
        session.add(CaseAuditTrail(
            caseld=case_id,
            actionPerformed=f"{track.title()} underwriting review updated",
            entityChanged="CaseUnderwritingTrack",
            previousValue=f"{before[0]} / {before[1] or 'unassigned'}",
            newValue=f"{row.status} / {row.assigned_user_id or 'unassigned'}",
            performedBy=user.id,
            timestamp=datetime.utcnow(),
        ))
    await session.commit()
    return (await reviews_by_case(session, [case_id]))[case_id][track_key]


async def _specialist_identity(tenant_id, token, session):
    user = await _get_current_user(token, session)
    role = await _role_name(user, session)
    tracks = _tracks_for_role(role)
    if user.tenant_id != tenant_id or len(tracks) != 1:
        raise HTTPException(403, "This workspace is for medical and financial underwriters in their own organization.")
    return user, next(iter(tracks))


@router.get("/underwriting/reviews")
async def specialist_queue(tenant_id: UUID, session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme)):
    from shared.models.core import Customer, Policy, CaseTypeEnum, CaseStatusEnum
    user, track = await _specialist_identity(tenant_id, token, session)
    rows = (await session.exec(select(Case, Customer, Policy).join(Customer, Customer.id == Case.customer_id)
        .outerjoin(Policy, Policy.id == Case.policy_id).where(Case.tenant_id == tenant_id,
        Case.caseType == CaseTypeEnum.UNDERWRITING,
        Case.caseStatus.notin_([CaseStatusEnum.APPROVED, CaseStatusEnum.CLOSED, CaseStatusEnum.REJECTED])).order_by(Case.createdAt.desc()))).all()
    reviews = await reviews_by_case(session, [c.caseld for c, _, _ in rows])
    return [{"id": str(c.caseld), "reference": c.caseNumber, "customer_name": customer.name,
             "product_name": policy.product_name if policy else None,
             "coverage_amount": policy.coverage_amount if policy else None,
             "case_status": c.caseStatus, "on_hold": c.on_hold, "hold_reason": c.hold_reason,
             "created_at": c.createdAt, "review": reviews[c.caseld][track]}
            for c, customer, policy in rows if reviews[c.caseld][track]["assigned_user_id"] in (None, str(user.id))]


@router.get("/underwriting/reviews/{case_id}")
async def specialist_workspace(tenant_id: UUID, case_id: UUID, session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme)):
    from shared.models.core import Customer, Policy, CustomerEApplication, MedicalExamOrder, RiskAssessment, CaseTypeEnum, Artifact
    user, track = await _specialist_identity(tenant_id, token, session)
    case = await session.get(Case, case_id)
    if not case or case.tenant_id != tenant_id or case.caseType != CaseTypeEnum.UNDERWRITING:
        raise HTTPException(404, "Underwriting application not found.")
    review = (await reviews_by_case(session, [case_id]))[case_id][track]
    if review['assigned_user_id'] not in (None, str(user.id)):
        raise HTTPException(403, "This review is assigned to another underwriter.")
    customer = await session.get(Customer, case.customer_id)
    policy = await session.get(Policy, case.policy_id) if case.policy_id else None
    app = (await session.exec(select(CustomerEApplication).where(CustomerEApplication.case_id == case_id))).first()
    assessment = (await session.exec(select(RiskAssessment).where(RiskAssessment.tenant_id == tenant_id,
        RiskAssessment.customer_id == case.customer_id, RiskAssessment.policy_id == case.policy_id,
        RiskAssessment.superseded_at == None).order_by(RiskAssessment.created_at.desc()))).first()
    evidence = {}
    if track == 'MEDICAL':
        exam = (await session.exec(select(MedicalExamOrder).where(MedicalExamOrder.case_id == case_id))).first()
        evidence = {"Date of birth": customer.dob, "Smoker": customer.is_smoker,
            "Height (cm)": customer.height_cm, "Weight (kg)": customer.weight_kg,
            "Medical questionnaire": app.medical_questionnaire if app else None,
            "Family medical history": app.family_history if app else None,
            "Medical examination": exam.status if exam else None,
            "Required tests": exam.required_tests if exam else None,
            "Medical findings": exam.results_json if exam else None}
    else:
        evidence = {"Declared income (PKR)": customer.declared_income, "Occupation": customer.occupation,
            "Sum assured (PKR)": policy.coverage_amount if policy else None,
            "Term (years)": policy.term_years if policy else None,
            "Existing insurance": app.existing_insurance if app else None}
    documents = (await session.exec(select(Artifact).where(Artifact.tenant_id == tenant_id, Artifact.case_id == case_id))).all()
    allowed_documents = {'medicalreport', 'medicalexamination', 'labreport', 'ecg', 'bloodtest', 'xray', 'mriscan'} if track == 'MEDICAL' else {'salaryslip', 'bankstatement', 'incomecertificate', 'incometaxreturn', 'taxreturn', 'financialstatement', 'proofofincome'}
    documents = [{"id": str(d.id), "name": d.file_name or d.document_type, "type": d.document_type, "status": d.status}
                 for d in documents if ''.join(ch for ch in d.document_type.lower() if ch.isalpha()) in allowed_documents]
    return {"id": str(case_id), "reference": case.caseNumber, "customer_name": customer.name,
        "product_name": policy.product_name if policy else None, "track": track.lower(), "review": review,
        "on_hold": case.on_hold, "hold_reason": case.hold_reason,
        "read_only": case.on_hold or str(getattr(case.caseStatus, "value", case.caseStatus)) in {"Approved", "Closed", "Rejected"}, "evidence": evidence, "documents": documents,
        "assessment": {"score": getattr(assessment, track.lower() + '_score'),
                       "reasons": getattr(assessment, track.lower() + '_reasons') or [],
                       "created_at": assessment.created_at} if assessment else None}
