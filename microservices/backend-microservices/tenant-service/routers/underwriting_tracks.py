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

from datetime import datetime, timezone
from typing import Literal, Optional
from uuid import UUID, uuid4

from pydantic import BaseModel, Field

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
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
    request: Request,
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
    if body.claim_checks is not None:
        from shared.models.core import ClaimUnderwritingCheck
        if not case.claim_id:
            raise HTTPException(422, "These checks apply only to claim underwriting reviews.")
        if case.on_hold or str(getattr(case.caseStatus, 'value', case.caseStatus)) in {'Approved', 'Closed', 'Rejected'}:
            raise HTTPException(409, "This application is held or closed for specialist work.")
        if row.assigned_user_id != user.id:
            raise HTTPException(403, "Only the assigned underwriter can record these findings.")
        workspace = await _build_workspace(session, tenant_id, case_id, user, track_key)
        applicable = {r['key'] for r in workspace['requirements'] if r['key'].startswith('claim_')}
        if len({check.key for check in body.claim_checks}) != len(body.claim_checks):
            raise HTTPException(422, "Record each check only once.")
        for check in body.claim_checks:
            if check.key not in applicable or len(check.note.strip()) < 5:
                raise HTTPException(422, "Choose an applicable requirement and supply supporting evidence and rationale.")
            saved = (await session.exec(select(ClaimUnderwritingCheck).where(
                ClaimUnderwritingCheck.case_id == case_id, ClaimUnderwritingCheck.track == track_key,
                ClaimUnderwritingCheck.requirement_key == check.key))).first()
            previous = f"{saved.finding}: {saved.note}" if saved else "Not reviewed"
            if saved is None:
                saved = ClaimUnderwritingCheck(tenant_id=tenant_id, case_id=case_id, track=track_key,
                    requirement_key=check.key, finding=check.finding, note=check.note.strip(), updated_by=user.id)
            saved.finding, saved.note, saved.updated_by, saved.updated_at = check.finding, check.note.strip(), user.id, datetime.utcnow()
            session.add(saved)
            session.add(CaseAuditTrail(caseld=case_id, actionPerformed=f"{track.title()} claim requirement reviewed",
                entityChanged=check.key, previousValue=previous, newValue=f"{saved.finding}: {saved.note}",
                performedBy=user.id, timestamp=datetime.utcnow()))
        if body.claim_checks and row.status in {"CLEARED", "REFERRED", "DECLINED"}:
            row.status = "IN_REVIEW"
            session.add(row)
        await session.flush()
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

    if body.status == "CLEARED":
        # An application is only cleared once everything this review needs is in (referring or declining can happen earlier).
        workspace = await _build_workspace(session, tenant_id, case_id, user, track_key, checking_clearance=True)
        done = {"Submitted", "Verified", "Clear", "Completed", "NotRequired", "Waived", "Received"}
        outstanding = [r for r in workspace["requirements"] if r.get("status") not in done]
        if outstanding:
            raise HTTPException(422, "Complete every requirement before clearing: " + "; ".join(f"{r['label']} ({r['status']})" for r in outstanding) + ".")
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
    if row.status != before[0] and row.status in ("CLEARED", "REFERRED", "DECLINED"):
        # Final underwriting compiles the submitted reviews: tell the case page one just came in.
        from services.case_events import publish_case_event
        await publish_case_event(request, session, event_type="UnderwritingReviewSubmitted", tenant_id=tenant_id,
                                 case_id=case_id, detail={"track": track_key.lower(), "status": row.status})
    return (await reviews_by_case(session, [case_id]))[case_id][track_key]


async def _specialist_identity(tenant_id, token, session):
    user = await _get_current_user(token, session)
    role = await _role_name(user, session)
    tracks = _tracks_for_role(role)
    if user.tenant_id != tenant_id or len(tracks) != 1:
        raise HTTPException(403, "This workspace is for medical and financial underwriters in their own organization.")
    return user, next(iter(tracks))


async def resolve_review_policy(session, case):
    """Legacy applications may predate policy_id; never guess between plans."""
    from shared.models.core import Policy
    if case.policy_id:
        policy = await session.get(Policy, case.policy_id)
        return policy if policy and policy.tenant_id == case.tenant_id and policy.customer_id == case.customer_id else None
    policies = (await session.exec(select(Policy).where(Policy.tenant_id == case.tenant_id, Policy.customer_id == case.customer_id))).all()
    return policies[0] if len(policies) == 1 else None


@router.get("/cases/{case_id}/underwriting-tracks")
async def case_specialist_reviews(tenant_id: UUID, case_id: UUID, session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme)):
    """Both specialist reviews of one application, with their AI results — what final underwriting compiles."""
    from services.specialist_reviews import compile_specialist_reviews
    user = await _get_current_user(token, session)
    case = await session.get(Case, case_id)
    if user.tenant_id != tenant_id or not case or case.tenant_id != tenant_id:
        raise HTTPException(404, "Application not found.")
    return await compile_specialist_reviews(session, case_id)


@router.get("/underwriting/reviews")
async def specialist_queue(tenant_id: UUID, session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme)):
    """A specialist's queue is the applications an admin assigned to them on their track.
    Approved, closed and rejected applications stay in it (read-only) as the specialist's record."""
    from shared.models.core import Customer, Policy, CaseTypeEnum, CaseStatusEnum
    user, track = await _specialist_identity(tenant_id, token, session)
    rows = (await session.exec(select(Case, Customer, Policy).join(Customer, Customer.id == Case.customer_id)
        .outerjoin(Policy, Policy.id == Case.policy_id).where(Case.tenant_id == tenant_id,
        Case.caseType == CaseTypeEnum.UNDERWRITING).order_by(Case.createdAt.desc()))).all()
    reviews = await reviews_by_case(session, [c.caseld for c, _, _ in rows])
    resolved = {c.caseld: policy or await resolve_review_policy(session, c) for c, _, policy in rows}
    from shared.models.core import Claim
    claim_ids = [c.claim_id for c, _, _ in rows if c.claim_id]
    claim_numbers = {claim.id: claim.claim_number for claim in (await session.exec(
        select(Claim).where(Claim.tenant_id == tenant_id, Claim.id.in_(claim_ids)))).all()} if claim_ids else {}
    return [{"id": str(c.caseld), "claim_id": str(c.claim_id) if c.claim_id else None,
             "claim_number": claim_numbers.get(c.claim_id), "reference": c.caseNumber, "customer_name": customer.name, "customer_cnic": customer.cnic,
             "product_name": policy.product_name if policy else None,
             "coverage_amount": policy.coverage_amount if policy else None,
             "case_status": c.caseStatus, "on_hold": c.on_hold, "hold_reason": c.hold_reason,
             "created_at": c.createdAt, "review": reviews[c.caseld][track],
             "closed": str(getattr(c.caseStatus, "value", c.caseStatus)) in {"Approved", "Closed", "Rejected"}}
            for c, customer, _ in rows for policy in [resolved[c.caseld]] if reviews[c.caseld][track]["assigned_user_id"] == str(user.id)]


@router.get("/underwriting/claim-referrals")
async def claim_underwriting_queue(tenant_id: UUID, session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme)):
    """Claims the Claims department has referred to underwriting ("Claim Underwriting"), oldest first. Resolving one
    (POST /claims/{id}/resolve-underwriting) sends it back to Claims."""
    from shared.models.core import Claim, ClaimStatusEnum, Customer, Policy
    user = await _get_current_user(token, session)
    role = await _role_name(user, session)
    if user.tenant_id != tenant_id or role not in (set(TRACK_ROLE.values()) | GENERAL_ROLES | ADMIN_ROLES):
        raise HTTPException(403, "The claim underwriting queue is for underwriters and admins in their own organization.")
    rows = (await session.exec(select(Claim, Policy, Customer).join(Policy, Policy.id == Claim.policy_id)
        .join(Customer, Customer.id == Policy.customer_id)
        .where(Claim.tenant_id == tenant_id, Claim.status == ClaimStatusEnum.REUNDERWRITING_REQUIRED)
        .order_by(Claim.created_at))).all()
    return [{"id": str(c.id), "claim_number": c.claim_number or f"CLM-{c.created_at.year}-{str(c.id)[:6].upper()}",
             "claim_type": c.claim_type, "submitted_amount": c.submitted_amount,
             "customer_name": customer.name, "policy_number": policy.policy_number, "product_name": policy.product_name,
             "coverage_amount": policy.coverage_amount, "policy_start_date": (lambda d: (d.date() if hasattr(d, "date") else d).isoformat() if d else None)(policy.issued_at or policy.effective_date),
             "incident_date": c.incident_date.isoformat() if c.incident_date else None,
             "is_contestable": c.is_contestable, "referral_reason": c.underwriting_referral_reason,
             "referral_notes": c.underwriting_decision_notes, "created_at": c.created_at.isoformat()}
            for c, policy, customer in rows]


@router.get("/underwriting/reviews/{case_id}")
async def specialist_workspace(tenant_id: UUID, case_id: UUID, session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme)):
    user, track = await _specialist_identity(tenant_id, token, session)
    return await _build_workspace(session, tenant_id, case_id, user, track)


async def _build_workspace(session: AsyncSession, tenant_id: UUID, case_id: UUID, user, track: str, checking_clearance: bool = False):
    from shared.models.core import Customer, Policy, CustomerEApplication, MedicalExamOrder, RiskAssessment, CaseTypeEnum, Artifact, AgentConfidentialReport, PremiumQuote, DocumentRequest, InsuranceHistoryCheck
    case = await session.get(Case, case_id)
    if not case or case.tenant_id != tenant_id or case.caseType != CaseTypeEnum.UNDERWRITING:
        raise HTTPException(404, "Underwriting application not found.")
    review = (await reviews_by_case(session, [case_id]))[case_id][track]
    if review['assigned_user_id'] not in (None, str(user.id)):
        raise HTTPException(403, "This review is assigned to another underwriter.")
    customer = await session.get(Customer, case.customer_id)
    policy = await resolve_review_policy(session, case)
    app = (await session.exec(select(CustomerEApplication).where(CustomerEApplication.case_id == case_id))).first()
    assessment = (await session.exec(select(RiskAssessment).where(RiskAssessment.tenant_id == tenant_id,
        RiskAssessment.customer_id == case.customer_id, RiskAssessment.case_id == case_id,
        RiskAssessment.superseded_at == None).order_by(RiskAssessment.created_at.desc()))).first()
    evidence = {}
    if track == 'MEDICAL':
        # A claim review orders no examination; one left on a claim case from before isn't evidence for it.
        exam = None if case.claim_id else (await session.exec(select(MedicalExamOrder).where(MedicalExamOrder.case_id == case_id))).first()
        evidence = {"Date of birth": customer.dob, "Smoker": customer.is_smoker,
            "Height (cm)": customer.height_cm, "Weight (kg)": customer.weight_kg,
            "Medical questionnaire": app.medical_questionnaire if app else None,
            "Family medical history": app.family_history if app else None,
            "Medical examination": exam.status if exam else None,
            "Required tests": exam.required_tests if exam else None,
            "Medical findings": exam.results_json if exam else None}
    else:
        history = (await session.exec(select(InsuranceHistoryCheck).where(InsuranceHistoryCheck.case_id == case_id))).first()
        acr = (await session.exec(select(AgentConfidentialReport).where(AgentConfidentialReport.case_id == case_id))).first()
        quote = (await session.exec(select(PremiumQuote).where(PremiumQuote.policy_id == policy.id).order_by(PremiumQuote.created_at.desc()))).first() if policy else None
        evidence = {"Quoted premium (PKR)": quote.total_premium if quote else None,
            "Agent income verification": {"Occupation verified": acr.occupation_verified, "Income source verified": acr.income_source_verified, "Estimated income opinion": acr.estimated_income_opinion, "Income consistency": acr.income_consistency_note} if acr else None,
            "Declared income (PKR)": customer.declared_income, "Occupation": customer.occupation,
            "Sum assured (PKR)": policy.coverage_amount if policy else None,
            "Term (years)": policy.term_years if policy else None,
            "Existing insurance": app.existing_insurance if app else None,
            "Financial e-application": app.financial_profile if app else None}
    from sqlalchemy import or_, and_
    request_ids = (await session.exec(select(DocumentRequest.id).where(DocumentRequest.policy_id == policy.id))).all() if policy else []
    documents = (await session.exec(select(Artifact).where(Artifact.tenant_id == tenant_id, or_(
        Artifact.case_id == case_id,
        *([Artifact.claim_id == case.claim_id] if case.claim_id else []),
        and_(Artifact.case_id == None, Artifact.customer_id == case.customer_id,
             or_(Artifact.source_request_id == None, Artifact.source_request_id.in_(request_ids)))
    )))).all()
    allowed_documents = ({'medicalreport', 'medicalexamination', 'labreport', 'ecg', 'bloodtest', 'xray', 'mriscan', 'physicianreport'} if track == 'MEDICAL' else {'salaryslip', 'bankstatement', 'incomecertificate', 'incometaxreturn', 'taxreturn', 'financialstatement', 'proofofincome'}) | {'cnic'}
    if case.claim_id:
        from services import claim_engine
        from services.underwriting_gate import claim_documents_for
        allowed_documents |= {''.join(ch for ch in d["label"].lower() if ch.isalpha())
                              for d in await claim_documents_for(session, tenant_id, case.claim_id)
                              if claim_engine.is_medical_document(d["label"]) == (track == "MEDICAL")}
    from ocr_worker import processing_stalled
    documents = [{"processing_stalled": processing_stalled(d), "id": str(d.id), "name": d.file_name or d.document_type, "type": d.document_type, "status": d.status, "scope": "application" if d.case_id else "customer", "ocr_text": d.ocr_result, "extracted": d.extracted_metadata, "quality_score": d.quality_score, "tampered": d.tampered_flag}
                 for d in documents if ''.join(ch for ch in d.document_type.lower() if ch.isalpha()) in allowed_documents or (track == 'MEDICAL' and d.document_type.startswith('Medical Report: '))]
    # Only the evidence this application actually asks for: the plan's financial
    # documents, or the tests the medical examination ordered. Nothing asked
    # for means no documents requirement at all.
    if track == "MEDICAL":
        reported = {d["type"].removeprefix("Medical Report: ") for d in documents}
        required_documents = [{"type": t.get("name") or t.get("code"), "received": t.get("code") in reported}
                              for t in (exam.required_tests or [] if exam else [])]
    else:
        from services.document_requests import required_documents_for
        from specialist_access import DOCUMENT_TYPES
        received_types = {d["type"] for d in documents if d["status"] != "Re-submission Requested"}
        required_documents = [{"type": t, "received": t in received_types}
                              for t in (await required_documents_for(session, policy) if policy else []) if t in DOCUMENT_TYPES["financial"]]
    from shared.models.core import CustomerEApplicationPart
    part = (await session.exec(select(CustomerEApplicationPart).where(
        CustomerEApplicationPart.case_id == case_id, CustomerEApplicationPart.part == track.lower()))).first()
    # Before the split the e-application was one combined form: its status stands for both parts.
    raw_status = part.status if part else (app.status if app else "NotSent")
    waived = bool(part and isinstance(part.declaration, dict) and part.declaration.get("waived"))
    e_application_status = "Waived" if waived else "Submitted" if app and str(getattr(app.status, "value", app.status)) == "Verified" else str(getattr(raw_status, "value", raw_status))
    requirements = [
        # Each track reviews from its own e-application questionnaire.
        {"key": "e_application", "label": "Medical E-Application Questionnaire" if track == "MEDICAL" else "Financial E-Application Questionnaire",
         "status": e_application_status, "section": "overview"},
    ]
    if track == "FINANCIAL":
        requirements.append({"key": "insurance_history", "label": "Insurance History Clearance", "status": str(getattr(history.status, "value", history.status)) if history else "NotStarted", "section": "overview"})
    if required_documents:
        missing = sum(not d["received"] for d in required_documents)
        requirements.append({"key": "documents", "label": "Medical documents & reports" if track == "MEDICAL" else "Financial documents & income evidence",
                             "status": "Received" if not missing else "Outstanding", "section": "documents",
                             "detail": f"{len(required_documents) - missing} of {len(required_documents)} received"})
    if track == "MEDICAL":
        no_exam = exam and str(getattr(exam.status, "value", exam.status)) in {"NotRequired", "Waived"}
        from routers.medical_exam import _uploaded_reports
        exam_reports = await _uploaded_reports(session, exam) if exam else []
        required_codes = {t.get("code") for t in (exam.required_tests or [])} if exam else set()
        accepted_codes = {a.document_type.split(": ", 1)[-1] for a in exam_reports if a.status == "Accepted"}
        reports_ready = bool(required_codes) and required_codes <= accepted_codes
        ai_tests = (((exam.results_json or {}).get("ai_review") or {}).get("tests") or {}) if exam else {}
        ai_complete = reports_ready and bool(exam.outcome) and required_codes <= set(ai_tests) and all(
            sorted((ai_tests.get(code) or {}).get("report_ids") or []) == sorted(str(a.id) for a in exam_reports if a.status == "Accepted" and a.document_type == f"Medical Report: {code}")
            for code in required_codes)
        requirements.append({"key": "medical_ai", "label": "AI Medical Underwriting", "status": "NotRequired" if no_exam else "Completed" if ai_complete else "Required" if reports_ready else "Outstanding", "section": "overview",
                             "detail": "No medical examination is required." if no_exam else "AI results reviewed and saved." if ai_complete else "Required: run AI medical underwriting, review the extracted results, then Save & rate." if reports_ready else "Upload all required reports and wait for processing before running AI medical underwriting."})
    # What the application as a whole still waits on (owned by pre-underwriting),
    # so "Pending Documents" is explained rather than left unexplained.
    from services.underwriting_gate import outstanding_requirements
    from specialist_access import APPLICATION_DOCUMENTS
    from shared.underwriting.requirements_rules import _EXAM_TESTS_FOR_REQUIREMENT
    # Once a medical examination has ordered its tests, the medical-exam, ECG and
    # lab requirements are met by that exam's reports (recorded through AI medical
    # underwriting), not by separate uploads — so they are not asked for twice.
    ordered = (await session.exec(select(MedicalExamOrder).where(MedicalExamOrder.case_id == case_id))).first()
    exam_tests = {t.get("code") for t in (ordered.required_tests or [])} if ordered else set()
    covered = {code.value for code, tests in _EXAM_TESTS_FOR_REQUIREMENT.items() if tests & exam_tests}
    application_outstanding = []
    for spec in (await outstanding_requirements(session, tenant_id, case) if policy and not case.claim_id else []):
        document_type, owner = APPLICATION_DOCUMENTS.get(spec.code, (None, None))
        by_exam = spec.code in covered
        application_outstanding.append({"code": spec.code, "reason": spec.reason, "document_type": document_type,
                                        "owner": owner, "covered_by_exam": by_exam,
                                        "can_upload": document_type is not None and not by_exam and owner in (None, track.lower())})
    # Outstanding application documents this track collects are its to chase
    # too; the other track's (e.g. a physician report) stay off this review.
    outstanding_documents = [o for o in application_outstanding if o["can_upload"]]
    if outstanding_documents:
        requirements.append({"key": "application_documents", "label": "Application documents", "status": "Outstanding", "section": "documents",
                             "detail": f"{len(outstanding_documents)} still needed for the application"})
    # A Claim UW case reviews a claim, not an application: the application's own outstanding items don't apply, and the
    # claim travels with it. The track's requirements do — its e-application questionnaire, insurance history and
    # evidence are what the underwriter reviews the claim on, so only the application-level ones are dropped.
    claim_info = None
    claim_checks = {}
    if case.claim_id:
        from shared.models.core import Claim, ClaimProcess, InsurancePlan
        from services import claim_engine
        application_outstanding = []
        claim = await session.get(Claim, case.claim_id)
        # A claim review is checked against the claim's own plan terms (insurance_plans.claims_terms) and the claim's
        # document checklist — not the policy's underwriting requirements (questionnaire, history, income documents).
        proc = (await session.exec(select(ClaimProcess).where(ClaimProcess.claim_id == case.claim_id))).first()
        plan = (await session.exec(select(InsurancePlan).where(InsurancePlan.tenant_id == tenant_id,
                                                               InsurancePlan.label == policy.product_name))).first() if policy else None
        from services.underwriting_gate import claim_documents_for
        claim_docs = await claim_documents_for(session, tenant_id, case.claim_id)
        from shared.models.core import ClaimUnderwritingCheck
        saved_checks = (await session.exec(select(ClaimUnderwritingCheck).where(
            ClaimUnderwritingCheck.case_id == case_id, ClaimUnderwritingCheck.track == track,
            ClaimUnderwritingCheck.tenant_id == tenant_id))).all()
        claim_checks = {c.requirement_key: {"finding": c.finding, "note": c.note,
                        "updated_at": c.updated_at.isoformat(), "updated_by": str(c.updated_by)} for c in saved_checks}
        requirements, required_documents = claim_engine.claim_review_requirements(
            track=track, claims_terms=plan.claims_terms if plan else None, documents=claim_docs,
            contestable=bool(((proc.eligibility_json if proc else None) or {}).get("contestable")) or bool(claim and claim.is_contestable),
            review_submitted=not checking_clearance and review["status"] in ("CLEARED", "REFERRED", "DECLINED"), checks=claim_checks)
        both = (await reviews_by_case(session, [case_id]))[case_id]
        if claim:
            from routers.claims import claim_underwriting_review_state
            final_state = await claim_underwriting_review_state(session, claim)
            claim_info = {"id": str(claim.id), "claim_number": claim.claim_number, "claim_type": claim.claim_type,
                          "submitted_amount": claim.submitted_amount, "incident_date": claim.incident_date.isoformat() if claim.incident_date else None,
                          "referral_reason": claim.underwriting_referral_reason, "referral_notes": claim.underwriting_decision_notes,
                          "reviews": {t.lower(): {"status": r["status"], "note": r["note"]} for t, r in both.items()},
                          "ready": bool(final_state['ready'] and final_state['case_id'] == str(case_id)),
                          "underwriting_outcome": final_state.get('outcome'),
                          "ai_recommendation": final_state.get('ai_recommendation')}
    return {"id": str(case_id), "claim": claim_info, "claim_checks": claim_checks, "reference": case.caseNumber, "customer_name": customer.name,
        "product_name": policy.product_name if policy else None, "track": track.lower(), "review": review,
        "case_status": case.caseStatus, "created_at": case.createdAt, "customer_cnic": customer.cnic,
        "coverage_amount": policy.coverage_amount if policy else None, "term_years": policy.term_years if policy else None,
        "requirements": requirements, "required_documents": required_documents,
        "application_outstanding": application_outstanding,
        "ai_underwriting": await _financial_ai_state(session, case, policy) if track == "FINANCIAL" else None,
        "on_hold": case.on_hold, "hold_reason": case.hold_reason,
        "read_only": case.on_hold or str(getattr(case.caseStatus, "value", case.caseStatus)) in {"Approved", "Closed", "Rejected"}, "evidence": evidence, "documents": documents,
        "policy_linked": policy is not None,
        "assessment": {"results": (assessment.underwriting_results or {}).get(track.lower()), "score": getattr(assessment, track.lower() + '_score'),
                       "reasons": getattr(assessment, track.lower() + '_reasons') or [],
                       "created_at": assessment.created_at,
                       "recommendation": str(getattr(assessment.ai_decision, 'value', assessment.ai_decision)),
                       "advisory_only": True} if assessment else None}


class ClaimUnderwritingOutcomeBody(BaseModel):
    decision: Literal['PROCEED', 'DECLINE']
    reason: str = Field(min_length=5, max_length=2000)
    assessment_id: UUID


async def _claim_outcome_access(tenant_id, case_id, token, session, *, write=False):
    from shared.models.core import Claim, ClaimStatusEnum
    user = await _get_current_user(token, session)
    role = await _role_name(user, session)
    allowed = {'Admin', 'SuperAdmin'} if write else {'Admin', 'SuperAdmin', 'Underwriter', 'ClaimsManager'}
    tenant_access = user.tenant_id == tenant_id or (role == "SuperAdmin" and user.tenant_id is None)
    if not tenant_access or role not in allowed:
        raise HTTPException(403, 'Only Admin records the human underwriting outcome; the Claims Manager decides the claim.')
    case = (await session.exec(select(Case).where(Case.caseld == case_id, Case.tenant_id == tenant_id)
        .with_for_update().execution_options(populate_existing=True))).first()
    if not case or not case.claim_id:
        raise HTTPException(404, 'Claim underwriting referral not found.')
    claim = await session.get(Claim, case.claim_id)
    if not claim or claim.tenant_id != tenant_id:
        raise HTTPException(404, 'Claim not found.')
    if write and (case.on_hold or claim.status != ClaimStatusEnum.REUNDERWRITING_REQUIRED or
                  str(getattr(case.caseStatus, 'value', case.caseStatus)) in {'Approved', 'Rejected', 'Closed'}):
        raise HTTPException(409, 'This referral is held or already resolved by a human. It cannot receive a new outcome.')
    return user, case, claim


@router.get('/cases/{case_id}/claim-underwriting-outcome')
async def get_claim_underwriting_outcome(tenant_id: UUID, case_id: UUID,
    session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme)):
    from services.claim_underwriting_opinion import opinion_state
    _, case, claim = await _claim_outcome_access(tenant_id, case_id, token, session)
    from shared.models.core import ClaimStatusEnum
    return {**await opinion_state(session, case), 'on_hold': case.on_hold,
            'resolved': claim.status != ClaimStatusEnum.REUNDERWRITING_REQUIRED}


@router.post('/cases/{case_id}/claim-underwriting-outcome')
async def record_claim_underwriting_outcome(tenant_id: UUID, case_id: UUID, body: ClaimUnderwritingOutcomeBody,
    session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme)):
    import json
    from services.claim_underwriting_opinion import opinion_state, ACTION
    user, case, _ = await _claim_outcome_access(tenant_id, case_id, token, session, write=True)
    state = await opinion_state(session, case)
    if not state['reviews_complete'] or not state['assessment_id']:
        raise HTTPException(409, 'Submit both specialist reviews and run the final AI assessment before recording your human underwriting outcome.')
    if state['assessment_id'] != str(body.assessment_id):
        raise HTTPException(409, 'A newer assessment exists. Review its recommendation before recording your outcome.')
    if len(body.reason.strip()) < 5:
        raise HTTPException(422, 'Record your own underwriting rationale.')
    outcome = {'decision': body.decision, 'reason': body.reason.strip(), 'assessment_id': state['assessment_id'],
               'ai_recommendation': state['ai_recommendation'], 'reviews': state['review_snapshot']}
    if state['outcome'] and state['outcome']['current'] and all(state['outcome'].get(k) == v for k, v in outcome.items()):
        return {'success': True, 'outcome': state['outcome']}
    session.add(CaseAuditTrail(caseld=case_id, actionPerformed=ACTION, entityChanged='ClaimUnderwritingOutcome',
        previousValue=json.dumps(state['outcome']) if state['outcome'] else None,
        newValue=json.dumps(outcome), performedBy=user.id, timestamp=datetime.utcnow()))
    await session.commit()
    return {'success': True, 'outcome': {**outcome, 'current': True, 'recorded_by': str(user.id)},
            'message': 'Human underwriting outcome recorded for the Claims Manager. No claim or policy decision was changed.'}


# Keep upload validation/storage/OCR in the existing artifact implementation.

@router.post('/cases/{case_id}/underwriting-documents', status_code=202)
async def upload_specialist_document(
    request: Request, tenant_id: UUID, case_id: UUID,
    document_type: str = Form(...), file: UploadFile = File(...), test_code: Optional[str] = Form(None),
    session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme),
):
    from routers.artifacts import upload_artifact
    user, track = await _specialist_identity(tenant_id, token, session)
    from specialist_access import DOCUMENT_TYPES
    claim_doc = await _claim_document_for_track(session, tenant_id, case_id, track, document_type)
    if claim_doc is None and document_type not in DOCUMENT_TYPES[track.lower()] and not await _fills_outstanding_requirement(session, tenant_id, case_id, track, document_type):
        raise HTTPException(403, 'This document type belongs to another underwriting track.')
    if track == 'MEDICAL' and test_code:
        from routers.medical_exam import _load_order, _ensure_reports_open, _save_reports, _report_view
        from services.medical_report_uploads import MAX_REPORT_BYTES, validate_report
        order = await _load_order(session, case_id)
        if not order or test_code not in {t.get('code') for t in (order.required_tests or [])}:
            raise HTTPException(422, 'Choose a required test from this application medical examination.')
        _ensure_reports_open(order)
        data = await file.read(MAX_REPORT_BYTES + 1)
        filename, mime = validate_report(file.filename, data)
        artifacts = await _save_reports(request, session, order, [test_code], data, filename, mime)
        await _refresh_case_requirements(session, tenant_id, case_id)
        return {'report': _report_view(artifacts[0])}
    # The shared middleware enforces ownership, tenant, hold and application state.
    result = await upload_artifact(request=request, tenant_id=tenant_id, case_id=case_id,
        document_type=document_type, file=file, token=token, session=session)
    if claim_doc is not None:
        await _file_on_claim(session, case_id, claim_doc, result, user)
    await _refresh_case_requirements(session, tenant_id, case_id)
    return result


class SpecialistDocumentWaiver(BaseModel):
    document_type: str
    reason: str = Field(min_length=5, max_length=2000)


async def _assigned_claim_document(session, tenant_id, case_id, user, track, document_type):
    from shared.models.core import Claim, ClaimStatusEnum, CaseTypeEnum
    case = (await session.exec(select(Case).where(Case.caseld == case_id, Case.tenant_id == tenant_id).with_for_update())).first()
    if not case or case.caseType != CaseTypeEnum.UNDERWRITING or not case.claim_id:
        raise HTTPException(404, "Claim underwriting review not found.")
    review = (await session.exec(select(CaseUnderwritingTrack).where(
        CaseUnderwritingTrack.case_id == case_id, CaseUnderwritingTrack.track == track))).first()
    if not review or review.assigned_user_id != user.id:
        raise HTTPException(403, "Only the assigned underwriter can waive documents on this track.")
    if case.on_hold or str(getattr(case.caseStatus, 'value', case.caseStatus)) in {'Approved', 'Closed', 'Rejected'}:
        raise HTTPException(409, "This claim review is held or closed.")
    claim = await session.get(Claim, case.claim_id)
    if not claim or claim.tenant_id != tenant_id or claim.status in {
        ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL, ClaimStatusEnum.DECLINED,
        ClaimStatusEnum.SETTLED, ClaimStatusEnum.CLOSED,
    }:
        raise HTTPException(409, "Documents cannot be waived after the claim decision.")
    doc = await _claim_document_for_track(session, tenant_id, case_id, track, document_type)
    if doc is None:
        raise HTTPException(403, "Choose a claim document belonging to your underwriting track.")
    return case, claim, review, doc


@router.post('/cases/{case_id}/underwriting-documents/waive')
async def waive_specialist_claim_document(
    tenant_id: UUID, case_id: UUID, body: SpecialistDocumentWaiver,
    session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme),
):
    from shared.models.core import ClaimProcess
    from services import underwriting_gate
    user, track = await _specialist_identity(tenant_id, token, session)
    if len(body.reason.strip()) < 5:
        raise HTTPException(422, "Supply the reason for waiving this document.")
    case, claim, review, doc = await _assigned_claim_document(
        session, tenant_id, case_id, user, track, body.document_type)
    if doc.get('status') == 'Waived':
        return {'status': 'Waived', 'document_type': body.document_type, 'already_waived': True}
    if doc.get('status') == 'Received':
        raise HTTPException(409, "This document is already received; it does not need a waiver.")
    proc = (await session.exec(select(ClaimProcess).where(ClaimProcess.claim_id == claim.id).with_for_update())).first()
    if proc:
        from routers.claim_workflow import _update_doc, _sync_documents, _touch, _audit
        _update_doc(proc, doc['key'], status='Waived', note=body.reason.strip(),
                    waived_by=str(user.id), waived_at=datetime.utcnow().isoformat())
        await _sync_documents(session, claim, proc, user)
        _touch(proc)
        session.add(proc)
        from shared.models.core import Policy
        policy = await session.get(Policy, claim.policy_id)
        _audit(session, policy, claim, proc, 'ClaimDocumentWaived', user.email,
               {'document': body.document_type, 'reason': body.reason.strip(), 'track': track.lower()})
    else:
        rows, _ = await underwriting_gate.compute_requirements(session, tenant_id, case)
        code = '_'.join(''.join(ch if ch.isalnum() else ' ' for ch in body.document_type).split())[:100]
        requirement = next((row for row in rows if row.code == code), None)
        if requirement is None:
            raise HTTPException(409, "This document is not a claim requirement.")
        await underwriting_gate.waive_requirement(session, requirement, note=body.reason.strip())
    session.add(CaseAuditTrail(caseld=case_id, actionPerformed=f'{track.title()} claim document waived',
        entityChanged=body.document_type, previousValue=doc.get('status') or 'Requested',
        newValue=f'Waived: {body.reason.strip()}', performedBy=user.id, timestamp=datetime.utcnow()))
    if review.status in {'CLEARED', 'REFERRED', 'DECLINED'}:
        review.status = 'IN_REVIEW'
        session.add(review)
    await session.commit()
    await _refresh_case_requirements(session, tenant_id, case_id)
    return {'status': 'Waived', 'document_type': body.document_type, 'reason': body.reason.strip()}


@router.post('/cases/{case_id}/underwriting-documents/{artifact_id}/retry', status_code=202)
async def retry_specialist_document(
    request: Request, tenant_id: UUID, case_id: UUID, artifact_id: UUID,
    session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme),
):
    from ocr_worker import processing_stalled
    from shared.models.core import Artifact
    from shared.events.kafka_events import ArtifactOCRPayload, ArtifactOCRRequestedEvent
    user, track = await _specialist_identity(tenant_id, token, session)
    workspace = await _build_workspace(session, tenant_id, case_id, user, track)
    if workspace["read_only"] or workspace["review"]["assigned_user_id"] != str(user.id):
        raise HTTPException(409, "Start your review on an open application before retrying a document.")
    if str(artifact_id) not in {d["id"] for d in workspace["documents"]}:
        raise HTTPException(404, "Document not found in this underwriting track.")
    # Lock the row so simultaneous retry requests cannot publish duplicate jobs.
    artifact = (await session.exec(select(Artifact).where(Artifact.id == artifact_id).with_for_update().execution_options(populate_existing=True))).one()
    if artifact.status != "Processing Failed" and not processing_stalled(artifact):
        raise HTTPException(409, "This document is already processing or has been read.")
    storage = artifact.storage_url or ""
    if storage.startswith("local://"):
        key = storage.removeprefix("local://")
    elif ".amazonaws.com/" in storage:
        key = storage.split(".amazonaws.com/", 1)[1]
    else:
        raise HTTPException(409, "Stored document is unavailable. Please upload it again.")
    event = ArtifactOCRRequestedEvent(tenant_id=tenant_id, payload=ArtifactOCRPayload(
        artifact_id=artifact.id, tenant_id=tenant_id, case_id=case_id, s3_key=key,
        file_name=artifact.file_name or "document.pdf", mime_type=artifact.file_type or "application/pdf"))
    artifact.status = "Uploaded"
    artifact.extracted_metadata = {**(artifact.extracted_metadata or {}), "processing_started_at": datetime.now(timezone.utc).isoformat()}
    session.add(artifact)
    # Commit before publish: the consumer can immediately write Processing/Accepted.
    await session.commit()
    try:
        await request.app.state.kafka_producer.send_and_wait(
            "insurance.artifact.ocr.requested.v1", value=event.model_dump_json(), key=str(artifact.id))
    except Exception:
        artifact.status = "Processing Failed"
        session.add(artifact)
        await session.commit()
        raise HTTPException(503, "The document reader is unavailable. Please retry shortly.")
    return {"id": str(artifact_id), "status": "Uploaded"}


# ── Demo shortcut: mark documents as uploaded ────────────────────────────────
# DEMO ONLY. Files a small accepted placeholder for each document the underwriter
# names, so a walkthrough does not need every file uploaded by hand. Each item is
# checked exactly as a real upload is; the placeholders are named "(demo)".

_DEMO_PDF = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
             b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")


@router.post('/cases/{case_id}/underwriting-documents/demo-complete')
async def demo_mark_documents_uploaded(
    tenant_id: UUID, case_id: UUID, body: dict,
    session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme),
):
    from shared.models.core import Artifact, MedicalExamOrder
    from services.medical_report_uploads import store_report
    from specialist_access import DOCUMENT_TYPES
    user, track = await _specialist_identity(tenant_id, token, session)
    case = await session.get(Case, case_id)
    if not case or case.tenant_id != tenant_id:
        raise HTTPException(404, "Underwriting application not found.")
    if case.on_hold:
        raise HTTPException(409, "This application is on hold.")
    waived = body.get("status") == "Waived"   # a bulk waive files "Waived" placeholders instead of accepted ones
    items = body.get("items") or []
    if not isinstance(items, list) or not items or len(items) > 60:
        raise HTTPException(422, "Nothing to mark as uploaded.")
    order = (await session.exec(select(MedicalExamOrder).where(MedicalExamOrder.case_id == case_id))).first() if track == "MEDICAL" else None
    ordered = {t.get("code") for t in (order.required_tests or [])} if order else set()
    if order and ordered:
        # Medical results can only be recorded from real reports: at least 3 (or all, if fewer are ordered) must be actual uploads.
        real = {a.document_type for a in (await session.exec(select(Artifact).where(
            Artifact.case_id == case_id, Artifact.document_type.startswith("Medical Report: ")))).all()
            if not any(tag in (a.file_name or "").lower() for tag in ("(demo)", "(waived)"))}
        if len(real) < min(3, len(ordered)):
            raise HTTPException(422, f"Upload at least {min(3, len(ordered))} real reports first ({len(real)} uploaded). The rest can then be marked as uploaded.")
    made = 0
    for item in items:
        document_type, test_code = str(item.get("document_type") or ""), item.get("test_code")
        if track == "MEDICAL" and test_code:
            if test_code not in ordered:
                continue
            document_type = f"Medical Report: {test_code}"
        elif document_type not in DOCUMENT_TYPES[track.lower()] and not await _fills_outstanding_requirement(session, tenant_id, case_id, track, document_type):
            continue
        artifact_id = uuid4()
        filename = f"{document_type.replace(':', '').replace('/', '-')} ({'waived' if waived else 'demo'}).pdf"
        storage_url = await store_report(_DEMO_PDF, f"{tenant_id}/cases/{case_id}/{artifact_id}/demo.pdf", "application/pdf")
        session.add(Artifact(id=artifact_id, tenant_id=tenant_id, customer_id=case.customer_id, case_id=case_id,
                             source_request_id=order.id if order and test_code else None, uploaded_by=user.id,
                             document_type=document_type, file_name=filename, file_size=len(_DEMO_PDF), file_type="application/pdf",
                             storage_url=storage_url, status="Waived" if waived else "Accepted",
                             ocr_result="Waived by the underwriter." if waived else "Demo placeholder: marked as uploaded."))
        made += 1
    await session.commit()
    await _refresh_case_requirements(session, tenant_id, case_id)
    return {"marked": made}


@router.post('/cases/{case_id}/e-application/{part_name}/waive')
async def waive_e_application_part(
    tenant_id: UUID, case_id: UUID, part_name: str, body: dict,
    session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme),
):
    """Records that this track's e-application questionnaire is waived (with a reason), without touching the customer's answers."""
    from shared.models.core import CustomerEApplicationPart, EApplicationStatusEnum
    user, track = await _specialist_identity(tenant_id, token, session)
    reason = str(body.get("reason") or "").strip() or "Waived"
    if part_name != track.lower():
        raise HTTPException(403, "You can only waive your own track's questionnaire.")
    case = await session.get(Case, case_id)
    if not case or case.tenant_id != tenant_id:
        raise HTTPException(404, "Underwriting application not found.")
    part = (await session.exec(select(CustomerEApplicationPart).where(
        CustomerEApplicationPart.case_id == case_id, CustomerEApplicationPart.part == part_name))).first()
    if part is None:
        part = CustomerEApplicationPart(tenant_id=tenant_id, case_id=case_id, part=part_name, status=EApplicationStatusEnum.NOT_SENT)
    declaration = dict(part.declaration or {})
    declaration["waived"] = {"by": str(user.id), "reason": reason, "at": datetime.utcnow().isoformat()}
    part.declaration = declaration
    session.add(part)
    await session.commit()
    return {"status": "Waived"}


# ── AI financial underwriting ────────────────────────────────────────────────
# The financial counterpart of AI medical underwriting: once the financial
# requirements are in, risk-engine scores the financial risk, works out the
# cover the income supports and whether a referral is needed. The result is
# evidence on the financial review — the underwriter still records the decision.

async def _financial_ai_blockers(session: AsyncSession, case: Case, policy) -> list[str]:
    from shared.models.core import Artifact, CustomerEApplication, CustomerEApplicationPart, InsuranceHistoryCheck
    from services.document_requests import required_documents_for
    from specialist_access import DOCUMENT_TYPES
    blockers: list[str] = []
    if policy is None:
        return ["Link a proposal to this application."]
    part = (await session.exec(select(CustomerEApplicationPart).where(
        CustomerEApplicationPart.case_id == case.caseld, CustomerEApplicationPart.part == "financial"))).first()
    app = (await session.exec(select(CustomerEApplication).where(CustomerEApplication.case_id == case.caseld))).first()
    submitted = {"Submitted", "Verified"}
    waived = bool(part and isinstance(part.declaration, dict) and part.declaration.get("waived"))   # waived by the underwriter
    if not (waived or (part and str(getattr(part.status, "value", part.status)) in submitted)
            or (not part and app and str(getattr(app.status, "value", app.status)) in submitted)):
        blockers.append("The customer has not submitted the financial e-application.")
    history = (await session.exec(select(InsuranceHistoryCheck).where(InsuranceHistoryCheck.case_id == case.caseld))).first()
    if not history or str(getattr(history.status, "value", history.status)) != "Clear":
        blockers.append("Run and clear the insurance history check.")
    required = [t for t in await required_documents_for(session, policy) if t in DOCUMENT_TYPES["financial"]]
    accepted = set((await session.exec(select(Artifact.document_type).where(
        Artifact.tenant_id == case.tenant_id, Artifact.status == "Accepted",
        (Artifact.case_id == case.caseld) | ((Artifact.case_id == None) & (Artifact.customer_id == case.customer_id))))).all())  # noqa: E711
    for document_type in required:
        if document_type not in accepted:
            blockers.append(f"{document_type} has not been received and accepted yet.")
    return blockers


async def _financial_ai_state(session: AsyncSession, case: Case, policy) -> dict:
    row = (await session.exec(select(CaseUnderwritingTrack).where(
        CaseUnderwritingTrack.case_id == case.caseld, CaseUnderwritingTrack.track == "FINANCIAL"))).first()
    blockers = await _financial_ai_blockers(session, case, policy)
    return {"ready": not blockers, "blockers": blockers,
            "result": row.ai_result if row else None, "run_at": row.ai_run_at if row else None}


async def _evaluate_financial(body: dict, tenant_id: UUID) -> dict:
    """risk-engine's financial-only evaluation (several LLM-backed seconds)."""
    import httpx
    import os
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(f"{os.getenv('RISK_ENGINE_URL', 'http://risk-engine:8002')}/evaluate/financial",
                                         json=body, headers={"X-Tenant-Id": str(tenant_id)})
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"The risk engine could not be reached: {type(exc).__name__}.")
    if response.status_code != 200:
        raise HTTPException(502, f"The risk engine could not assess this application ({response.status_code}).")
    return response.json()


@router.post("/cases/{case_id}/financial-underwriting/run")
async def run_financial_underwriting(
    request: Request, tenant_id: UUID, case_id: UUID,
    session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme),
):
    from shared.models.core import Customer
    from services.underwriting_gate import _customer_dict, _policy_dict, build_evidence_bundle
    user, track = await _specialist_identity(tenant_id, token, session)
    if track != "FINANCIAL":
        raise HTTPException(403, "AI financial underwriting is the financial underwriter's tool.")
    case = await session.get(Case, case_id)
    if not case or case.tenant_id != tenant_id:
        raise HTTPException(404, "Underwriting application not found.")
    policy = await resolve_review_policy(session, case)
    blockers = await _financial_ai_blockers(session, case, policy)
    if blockers:
        raise HTTPException(409, "Not ready for AI financial underwriting: " + " ".join(blockers))

    customer = await session.get(Customer, case.customer_id)
    evidence = await build_evidence_bundle(session, tenant_id, case, request=request)
    await session.commit()  # the bundle re-runs verification; keep its findings
    person = _customer_dict(customer)
    person.update({"dob": person.get("dob") or "1990-01-01", "gender": person.get("gender") or "Unknown",
                   "occupation": person.get("occupation") or "", "declared_income": float(person.get("declared_income") or 0)})
    from fastapi.encoders import jsonable_encoder
    # The evidence carries UUIDs and datetimes (artifact ids, verification times): make it JSON first.
    body = jsonable_encoder({"customer": person, "policy": _policy_dict(policy),
            "e_application": evidence.get("e_application"), "acr": evidence.get("acr"),
            "document_evidence": evidence.get("document_evidence"), "verified_facts": evidence.get("verified_facts")})
    data = await _evaluate_financial(body, tenant_id)

    row = (await session.exec(select(CaseUnderwritingTrack).where(
        CaseUnderwritingTrack.case_id == case_id, CaseUnderwritingTrack.track == "FINANCIAL"))).first()
    if row is None:
        row = CaseUnderwritingTrack(tenant_id=tenant_id, case_id=case_id, track="FINANCIAL")
    row.ai_result = {"score": data.get("financial_score"), "reasons": data.get("financial_reasons") or [],
                     **(data.get("financial_result") or {})}
    row.ai_run_at = datetime.utcnow()
    session.add(row)
    await session.commit()
    return {"result": row.ai_result, "run_at": row.ai_run_at}


async def _claim_document_for_track(session: AsyncSession, tenant_id: UUID, case_id: UUID, track: str, document_type: str) -> Optional[dict]:
    """On a Claim UW case, the claim document (from the plan's claim terms) this upload is — when it belongs to this
    underwriter's track (medical evidence to the Medical Underwriter, the rest to the Financial Underwriter)."""
    from services import claim_engine
    from services.underwriting_gate import claim_documents_for
    case = await session.get(Case, case_id)
    if case is None or case.tenant_id != tenant_id or not case.claim_id:
        return None
    return next((d for d in await claim_documents_for(session, tenant_id, case.claim_id)
                 if d.get("label") == document_type and claim_engine.is_medical_document(d["label"]) == (track.upper() == "MEDICAL")), None)


async def _file_on_claim(session: AsyncSession, case_id: UUID, doc: dict, uploaded: dict, user) -> None:
    """A claim document uploaded by an underwriter is the claim's document: link the file to the claim and, on a
    workflow claim, mark the checklist item received — so the claims team sees it too."""
    from datetime import datetime as _dt
    from shared.models.core import Artifact, Claim, ClaimProcess
    case = await session.get(Case, case_id)
    art = await session.get(Artifact, UUID(str(uploaded.get("id")))) if isinstance(uploaded, dict) and uploaded.get("id") else None
    if case is None or art is None:
        return
    art.claim_id = case.claim_id
    session.add(art)
    proc = (await session.exec(select(ClaimProcess).where(ClaimProcess.claim_id == case.claim_id))).first()
    if proc and doc.get("key") and any(d.get("key") == doc["key"] for d in proc.documents_json or []):
        from routers.claim_workflow import _sync_documents, _touch, _update_doc
        _update_doc(proc, doc["key"], status="Received", received_at=_dt.utcnow().isoformat(), artifact_id=str(art.id),
                    file_name=art.file_name, note="Uploaded by underwriting")
        claim = await session.get(Claim, case.claim_id)
        if claim is not None:
            await _sync_documents(session, claim, proc, user)
        _touch(proc)
        session.add(proc)
    await session.commit()


async def _fills_outstanding_requirement(session: AsyncSession, tenant_id: UUID, case_id: UUID, track: str, document_type: str) -> bool:
    """An application document (e.g. CNIC) may be uploaded by a specialist only while it is outstanding and theirs to collect."""
    from services.underwriting_gate import outstanding_requirements
    from specialist_access import APPLICATION_DOCUMENTS
    case = await session.get(Case, case_id)
    if case is None or case.tenant_id != tenant_id:
        return False
    return any(APPLICATION_DOCUMENTS.get(spec.code, (None, None))[0] == document_type
               and APPLICATION_DOCUMENTS[spec.code][1] in (None, track.lower())
               for spec in await outstanding_requirements(session, tenant_id, case))


async def _refresh_case_requirements(session: AsyncSession, tenant_id: UUID, case_id: UUID) -> None:
    """New evidence can meet an application requirement; never fail the upload over it."""
    import logging
    from services import underwriting_gate
    try:
        case = await session.get(Case, case_id)
        if case is not None:
            await underwriting_gate.compute_requirements(session, tenant_id, case)
            await session.commit()
    except Exception:
        await session.rollback()
        logging.getLogger(__name__).exception("could not refresh requirements for case %s", case_id)


# ── Bulk upload: which document is each file? ────────────────────────────────
# Read-only. The specialist drops several files at once; before anything is
# stored, the configured vision LLM reads each one and names the matching
# required test (medical) or document type (financial) from this application's
# own options. Anything it is not sure of comes back unmatched, for the
# underwriter to choose — a wrong guess would file a report under the wrong test.

CLASSIFY_MAX_FILES = 20
CLASSIFY_MIN_CONFIDENCE = 0.6


def _sniff_mime(name: str, data: bytes) -> str:
    if data[:4] == b"%PDF":
        return "application/pdf"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "application/octet-stream"


def _classify_prompt(track: str, options: list[dict]) -> str:
    listing = "\n".join(f'- "{o["id"]}": {o["label"]}' for o in options)
    what = "medical examination report" if track == "MEDICAL" else "financial / income document"
    return (
        f"You are sorting files an insurance underwriter uploaded in bulk. Each should be a {what}. "
        "Decide which ONE of these options the attached file is:\n"
        f"{listing}\n"
        'Respond ONLY with JSON: {"match": "<option id or null>", "confidence": <0..1>, "reason": "<max 12 words>"}. '
        'Use null if the file matches none of the options or you cannot tell — never guess.'
    )


@router.post("/cases/{case_id}/underwriting-documents/classify")
async def classify_specialist_documents(
    tenant_id: UUID, case_id: UUID,
    files: list[UploadFile] = File(...),
    session: AsyncSession = Depends(get_session), token: str = Depends(oauth2_scheme),
):
    import asyncio
    from routers.llm_config import ocr_providers
    from services.medical_report_uploads import MAX_REPORT_BYTES
    from services.report_llm import MODEL_READABLE, ask_json
    from shared.models.core import MedicalExamOrder
    from specialist_access import DOCUMENT_TYPES

    user, track = await _specialist_identity(tenant_id, token, session)
    case = await session.get(Case, case_id)
    if not case or case.tenant_id != tenant_id:
        raise HTTPException(404, "Underwriting application not found.")
    if len(files) > CLASSIFY_MAX_FILES:
        raise HTTPException(422, f"Choose at most {CLASSIFY_MAX_FILES} files at a time.")

    if track == "MEDICAL":
        order = (await session.exec(select(MedicalExamOrder).where(MedicalExamOrder.case_id == case_id))).first()
        options = [{"id": t.get("code"), "label": t.get("name") or t.get("code")} for t in (order.required_tests or [])] if order else []
    else:
        options = [{"id": t, "label": t} for t in sorted(DOCUMENT_TYPES["financial"])]
    valid = {o["id"] for o in options}

    payloads = []
    for f in files:
        data = await f.read(MAX_REPORT_BYTES + 1)
        payloads.append((f.filename or "file", data))
    if not options:
        return {"results": [{"index": i, "match": None, "confidence": 0, "reason": "No required tests to match against yet."} for i in range(len(payloads))]}

    providers = await ocr_providers(session)
    prompt = _classify_prompt(track, options)
    gate = asyncio.Semaphore(4)

    async def one(index: int, name: str, data: bytes) -> dict:
        mime = _sniff_mime(name, data)
        if len(data) > MAX_REPORT_BYTES or mime not in MODEL_READABLE:
            return {"index": index, "match": None, "confidence": 0, "reason": "This file type can't be read automatically."}
        async with gate:
            answer = await ask_json(None, [(data, mime)], prompt, f"classify {name}", providers)
        match = (answer or {}).get("match")
        try:
            confidence = float((answer or {}).get("confidence") or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        if match not in valid or confidence < CLASSIFY_MIN_CONFIDENCE:
            match = None
        return {"index": index, "match": match, "confidence": round(confidence, 2), "reason": (answer or {}).get("reason")}

    results = await asyncio.gather(*(one(i, name, data) for i, (name, data) in enumerate(payloads)))
    return {"results": list(results)}
