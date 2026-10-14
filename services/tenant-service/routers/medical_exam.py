"""
Pre-Underwriting — Medical Examination scheduling (panel clinics).

The sixth pre-underwriting clearance gate. Every insurer publishes a
Non-Medical Limit: below it a life is underwritten on the E-Application alone;
above it physical diagnostics are mandatory — fasting blood sugar, lipid
profile, resting ECG, chest X-ray and, at larger sums assured, stress
cardiology and serology. The tests are performed at a contracted panel lab
(Chughtai, Aga Khan, IDC, Shaukat Khanum) at the insurer's cost, and the risk
engine must not produce a final decision until the results are in.

Flow:

    assess   → read the NML grid for this life; either NotRequired, or Required
               with a resolved test panel and a costed budget
    invite   → issue a tokenized, expiring booking link for the customer
    (public) → customer picks a panel clinic and an appointment slot
    schedule → or staff books it directly on the customer's behalf
    result   → results keyed in, rated against the underwriting manual
    waive    → underwriter waives (e.g. a valid recent examination on file)

Placement note: this is *pre*-underwriting, not Stage A pre-issuance. The
results change the underwriting decision itself — the loading, the exclusions,
and how much cover has to be reinsured — so the exam is ordered before the risk
engine's verdict, not after it. The Stage A PolicyRequirement(MedicalReport) is
the downstream *document* checklist item; this is the clinical order that
produces it.

Staff endpoints are tenant-authenticated. The customer-facing booking endpoints
under /public/medical-exam are unauthenticated and scoped only by a single-use,
hashed, expiring token — the same scheme routers/e_application.py uses, because
the customer never has a login.
"""

import hashlib
import secrets
from datetime import date, datetime, time, timedelta
from typing import Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status, UploadFile, File, Form
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, _role_name, oauth2_scheme
from services import medical_findings
from services.underwriting_limits import (
    MEDICAL_INVITE_VALID_DAYS,
    MEDICAL_VALIDITY_DAYS,
    age_from_dob,
    assess_medical_requirement,
)
from shared.models.core import (
    Artifact,
    Case,
    Customer,
    CustomerEApplication,
    InsuranceHistoryCheck,
    MedicalExamOrder,
    MedicalExamOutcomeEnum,
    MedicalExamStatusEnum,
    PanelClinic,
    Policy,
    PolicyRequirement,
    RequirementStatusEnum,
    RequirementTypeEnum,
    Tenant,
)

from services.case_events import publish_case_event

router = APIRouter(tags=["Pre-Underwriting — Medical Examination"])

_WAIVER_ROLES = {"Underwriter", "Admin", "SuperAdmin"}

# The panel every tenant starts with — the diagnostic networks Pakistani
# insurers actually contract with for pre-policy medicals. Seeded lazily on
# first read so a new tenant has a working panel without a migration step.
_DEFAULT_PANEL: list[dict] = [
    {"code": "CHUGHTAI-LHR", "name": "Chughtai Lab — Jail Road", "network": "Chughtai Lab",
     "city": "Lahore", "address": "Main Jail Road, Gulberg, Lahore", "phone": "042-111-456-789",
     "home_sampling": True, "turnaround_hours": 24},
    {"code": "CHUGHTAI-KHI", "name": "Chughtai Lab — Clifton", "network": "Chughtai Lab",
     "city": "Karachi", "address": "Block 5, Clifton, Karachi", "phone": "021-111-456-789",
     "home_sampling": True, "turnaround_hours": 24},
    {"code": "AKUH-KHI", "name": "Aga Khan University Hospital — Stadium Road", "network": "Aga Khan Lab",
     "city": "Karachi", "address": "Stadium Road, Karachi", "phone": "021-111-911-911",
     "home_sampling": True, "turnaround_hours": 48},
    {"code": "AKUH-LHR", "name": "Aga Khan Lab Collection Point — Model Town", "network": "Aga Khan Lab",
     "city": "Lahore", "address": "Model Town Link Road, Lahore", "phone": "042-111-911-911",
     "home_sampling": True, "turnaround_hours": 48},
    {"code": "IDC-ISB", "name": "Islamabad Diagnostic Centre — Blue Area", "network": "IDC",
     "city": "Islamabad", "address": "Jinnah Avenue, Blue Area, Islamabad", "phone": "051-111-987-654",
     "home_sampling": True, "turnaround_hours": 24},
    {"code": "IDC-RWP", "name": "Islamabad Diagnostic Centre — Saddar", "network": "IDC",
     "city": "Rawalpindi", "address": "Bank Road, Saddar, Rawalpindi", "phone": "051-111-987-654",
     "home_sampling": False, "turnaround_hours": 24},
    {"code": "SKMCH-LHR", "name": "Shaukat Khanum Diagnostic Centre — Johar Town", "network": "Shaukat Khanum",
     "city": "Lahore", "address": "7A Block R-3, Johar Town, Lahore", "phone": "042-3590-5000",
     "home_sampling": False, "turnaround_hours": 72},
    {"code": "EXCEL-ISB", "name": "Excel Labs — F-8 Markaz", "network": "Excel Labs",
     "city": "Islamabad", "address": "F-8 Markaz, Islamabad", "phone": "051-111-000-190",
     "home_sampling": True, "turnaround_hours": 36},
    {"code": "ESSA-KHI", "name": "Dr. Essa's Laboratory — Gulshan", "network": "Dr. Essa's",
     "city": "Karachi", "address": "Gulshan-e-Iqbal, Karachi", "phone": "021-111-113-772",
     "home_sampling": True, "turnaround_hours": 24},
]

# Appointment slots offered to the customer: the next N days, working hours,
# hourly. Fasting panels are morning-only, which is why the earliest slots
# matter and are surfaced first.
_SLOT_DAYS = 14
_SLOT_HOURS = (8, 9, 10, 11, 12, 15, 16)
_FASTING_SLOT_HOURS = (8, 9, 10, 11)


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _v(x):
    return x.value if hasattr(x, "value") else (str(x) if x is not None else None)


async def _get_case(session: AsyncSession, tenant_id: UUID, case_id: UUID) -> Case:
    case = await session.get(Case, case_id)
    if case is None or case.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


async def _policy_for_case(session: AsyncSession, case: Case) -> Optional[Policy]:
    if case.policy_id is not None:
        policy = await session.get(Policy, case.policy_id)
        if policy is not None:
            return policy
    stmt = (
        select(Policy)
        .where(Policy.tenant_id == case.tenant_id, Policy.customer_id == case.customer_id)
        .order_by(Policy.created_at.desc())  # type: ignore[arg-type]
    )
    return (await session.exec(stmt)).first()


async def _load_order(session: AsyncSession, case_id: UUID) -> Optional[MedicalExamOrder]:
    stmt = select(MedicalExamOrder).where(MedicalExamOrder.case_id == case_id)
    return (await session.exec(stmt)).first()


# ── Panel clinics ────────────────────────────────────────────────────────────

async def ensure_panel_clinics(session: AsyncSession, tenant_id: UUID) -> list[PanelClinic]:
    """Return the tenant's panel, seeding the standard network on first use."""
    stmt = select(PanelClinic).where(PanelClinic.tenant_id == tenant_id)
    clinics = list((await session.exec(stmt)).all())
    if clinics:
        return clinics

    for spec in _DEFAULT_PANEL:
        session.add(PanelClinic(tenant_id=tenant_id, **spec))
    await session.commit()

    return list((await session.exec(stmt)).all())


def _clinic_dict(c: PanelClinic) -> dict:
    return {
        "id": str(c.id),
        "code": c.code,
        "name": c.name,
        "network": c.network,
        "city": c.city,
        "address": c.address,
        "phone": c.phone,
        "home_sampling": c.home_sampling,
        "turnaround_hours": c.turnaround_hours,
        "supported_tests": c.supported_tests,
        "is_active": c.is_active,
    }


@router.get("/tenants/{tenant_id}/panel-clinics")
async def list_panel_clinics(
    tenant_id: UUID,
    city: Optional[str] = None,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user(token, session)
    clinics = await ensure_panel_clinics(session, tenant_id)
    rows = [c for c in clinics if c.is_active]
    if city:
        needle = city.strip().lower()
        rows = [c for c in rows if (c.city or "").lower() == needle]
    rows.sort(key=lambda c: ((c.city or ""), c.name))
    return [_clinic_dict(c) for c in rows]


class PanelClinicCreate(BaseModel):
    code: str
    name: str
    network: Optional[str] = None
    city: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None  # lab/doctor address that receives the report-upload link
    supported_tests: Optional[list] = None
    home_sampling: bool = False
    turnaround_hours: int = 48


@router.post("/tenants/{tenant_id}/panel-clinics", status_code=201)
async def create_panel_clinic(
    tenant_id: UUID,
    body: PanelClinicCreate,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user(token, session)
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None or not tenant.is_active:
        raise HTTPException(status_code=404, detail="Tenant not found or inactive")

    existing = (await session.exec(
        select(PanelClinic).where(PanelClinic.tenant_id == tenant_id, PanelClinic.code == body.code)
    )).first()
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"A panel clinic with code '{body.code}' already exists.")

    clinic = PanelClinic(tenant_id=tenant_id, **body.model_dump())
    session.add(clinic)
    await session.commit()
    await session.refresh(clinic)
    return _clinic_dict(clinic)


# ── Slots ────────────────────────────────────────────────────────────────────

def _available_slots(fasting: bool, from_date: Optional[date] = None) -> list[str]:
    """Bookable appointment times. Fasting panels are morning-only — a customer
    cannot fast until an afternoon draw, so offering those slots would just
    produce rejected samples and a repeat visit."""
    start = (from_date or date.today()) + timedelta(days=1)
    hours = _FASTING_SLOT_HOURS if fasting else _SLOT_HOURS
    slots: list[str] = []
    for offset in range(_SLOT_DAYS):
        day = start + timedelta(days=offset)
        if day.weekday() == 6:  # Sunday — panel collection points closed
            continue
        for hour in hours:
            slots.append(datetime.combine(day, time(hour=hour)).isoformat())
    return slots


# ── Order serialisation ──────────────────────────────────────────────────────

def _order_dict(order: Optional[MedicalExamOrder], clinic: Optional[PanelClinic] = None) -> dict:
    if order is None:
        return {
            "status": MedicalExamStatusEnum.NOT_ASSESSED.value,
            "required_tests": [],
            "trigger_reasons": [],
            "non_medical_limit": None,
            "sum_assured_at_risk": 0.0,
            "estimated_cost": 0.0,
            "clinic": None,
            "appointment_at": None,
            "results": None,
            "outcome": None,
            "abnormal_findings": [],
            "suggested_loading_pct": None,
        }
    return {
        "id": str(order.id),
        "status": _v(order.status),
        "applicant_age": order.applicant_age,
        "sum_assured_at_risk": order.sum_assured_at_risk,
        "non_medical_limit": order.non_medical_limit,
        "trigger_reasons": order.trigger_reasons or [],
        "required_tests": order.required_tests or [],
        "estimated_cost": order.estimated_cost,
        "fasting_required": any(t.get("fasting") for t in (order.required_tests or [])),
        "clinic": _clinic_dict(clinic) if clinic else None,
        "lab_email": clinic.email if clinic else None,  # staff-only: never in the public customer view
        "clinic_id": str(order.clinic_id) if order.clinic_id else None,
        "appointment_at": order.appointment_at.isoformat() if order.appointment_at else None,
        "home_sampling": order.home_sampling,
        "appointment_note": order.appointment_note,
        "invited_at": order.invited_at.isoformat() if order.invited_at else None,
        "invite_expires_at": order.invite_expires_at.isoformat() if order.invite_expires_at else None,
        "lab_link_sent_at": order.lab_sent_at.isoformat() if order.lab_sent_at else None,
        "lab_link_sent_to": order.lab_sent_to,
        "lab_signed_by": order.lab_signed_by,
        "lab_signer_license": order.lab_signer_license,
        "lab_signed_at": order.lab_signed_at.isoformat() if order.lab_signed_at else None,
        "results": order.results_json,
        "outcome": _v(order.outcome),
        "abnormal_findings": order.abnormal_findings or [],
        "suggested_loading_pct": order.suggested_loading_pct,
        "completed_at": order.completed_at.isoformat() if order.completed_at else None,
        "reported_by": order.reported_by,
        "result_artifact_id": str(order.result_artifact_id) if order.result_artifact_id else None,
        "waived_by": order.waived_by,
        "waived_at": order.waived_at.isoformat() if order.waived_at else None,
        "waiver_reason": order.waiver_reason,
        "valid_until": (
            (order.completed_at + timedelta(days=MEDICAL_VALIDITY_DAYS)).isoformat()
            if order.completed_at else None
        ),
    }


async def _order_with_clinic(session: AsyncSession, order: Optional[MedicalExamOrder]) -> dict:
    clinic = await session.get(PanelClinic, order.clinic_id) if (order and order.clinic_id) else None
    result = _order_dict(order, clinic)
    if order:
        result["reports"] = [_report_view(a) for a in await _uploaded_reports(session, order)]
        result["reports_submitted"] = bool((order.results_json or {}).get("customer_reports_submitted_at"))
    return result


# ── Adverse disclosures — the override that pulls a sub-NML case into medicals ─

def _adverse_disclosures(e_app: Optional[CustomerEApplication]) -> list[str]:
    """Yes-answers on the E-Application that mandate an examination regardless of
    sum assured. The NML grid is a floor, not a ceiling: a disclosed cardiac
    history is examined at any sum assured."""
    if e_app is None or not e_app.medical_questionnaire:
        return []

    mq = e_app.medical_questionnaire or {}
    out: list[str] = []

    for cond in mq.get("conditions") or []:
        if isinstance(cond, dict) and cond.get("checked"):
            label = cond.get("label") or cond.get("key") or "declared condition"
            year = cond.get("year_of_diagnosis")
            out.append(f"{label}{f' (since {year})' if year else ''}")

    if mq.get("has_hospitalizations"):
        out.append("hospitalisation in the last 5 years")
    if mq.get("has_surgeries"):
        out.append("surgery in the last 5 years")
    if mq.get("drug_use"):
        out.append("declared recreational drug use")

    for key, answer in (mq.get("disclosures") or {}).items():
        value = answer.get("answer") if isinstance(answer, dict) else answer
        if str(value).strip().lower() in ("yes", "true"):
            out.append(f"disclosure '{key}' answered Yes")

    return out


# ── Assess ───────────────────────────────────────────────────────────────────

@router.get("/tenants/{tenant_id}/cases/{case_id}/medical-exam")
async def get_medical_exam(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user(token, session)
    await _get_case(session, tenant_id, case_id)
    return await _order_with_clinic(session, await _load_order(session, case_id))


@router.post("/tenants/{tenant_id}/cases/{case_id}/medical-exam/assess")
async def assess_medical_exam(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Read the Non-Medical Limit grid for this life and raise (or clear) the
    medical requirement. Safe to re-run: an order that has already been booked,
    completed or waived is never reset by a re-assessment."""
    await _get_current_user(token, session)
    case = await _get_case(session, tenant_id, case_id)

    customer = await session.get(Customer, case.customer_id)
    if customer is None:
        raise HTTPException(status_code=404, detail="Customer not found")

    policy = await _policy_for_case(session, case)
    if policy is None:
        raise HTTPException(
            status_code=409,
            detail="This case has no linked policy — the sum assured is unknown, so the "
                   "non-medical limit cannot be applied.",
        )

    e_app = (await session.exec(
        select(CustomerEApplication).where(CustomerEApplication.case_id == case_id)
    )).first()

    # The grid is read against *aggregate* exposure, not this proposal alone —
    # stacking two sub-limit policies must not buy a non-medical concession.
    # The insurance-history screen is the source of that aggregate when it has
    # been run; otherwise this proposal's own sum assured is the best we have.
    history = (await session.exec(
        select(InsuranceHistoryCheck).where(InsuranceHistoryCheck.case_id == case_id)
    )).first()
    sum_at_risk = float(policy.coverage_amount or 0)
    if history is not None and history.aggregate_sum_assured:
        sum_at_risk = max(sum_at_risk, float(history.aggregate_sum_assured))

    age = age_from_dob(customer.dob)
    assessment = assess_medical_requirement(
        age=age,
        sum_at_risk=sum_at_risk,
        gender=_v(customer.gender),
        is_smoker=customer.is_smoker,
        adverse_disclosures=_adverse_disclosures(e_app),
    )

    now = datetime.utcnow()
    order = await _load_order(session, case_id)
    if order is None:
        order = MedicalExamOrder(tenant_id=tenant_id, case_id=case_id, customer_id=customer.id)

    settled = {
        MedicalExamStatusEnum.SCHEDULED,
        MedicalExamStatusEnum.COMPLETED,
        MedicalExamStatusEnum.WAIVED,
    }
    order.policy_id = policy.id
    order.applicant_age = age
    order.sum_assured_at_risk = sum_at_risk
    order.non_medical_limit = assessment["non_medical_limit"]
    order.trigger_reasons = assessment["reasons"]
    order.updated_at = now

    if order.status in settled:
        # Keep an in-flight or finished exam intact; only refresh the panel so
        # the underwriter can see whether the mandate has since grown.
        if order.status != MedicalExamStatusEnum.COMPLETED:
            order.required_tests = assessment["tests"]
            order.estimated_cost = assessment["estimated_cost"]
    else:
        order.required_tests = assessment["tests"]
        order.estimated_cost = assessment["estimated_cost"]
        order.status = (
            MedicalExamStatusEnum.REQUIRED if assessment["required"]
            else MedicalExamStatusEnum.NOT_REQUIRED
        )

    session.add(order)

    # Keep the Stage A document checklist in step: a mandated exam always has a
    # matching Medical Report requirement waiting for the lab's report.
    if assessment["required"]:
        await _ensure_medical_requirement(session, tenant_id, policy)

    await session.commit()
    await session.refresh(order)
    return await _order_with_clinic(session, order)


async def _ensure_medical_requirement(session: AsyncSession, tenant_id: UUID, policy: Policy) -> None:
    existing = (await session.exec(
        select(PolicyRequirement).where(
            PolicyRequirement.policy_id == policy.id,
            PolicyRequirement.requirement_type == RequirementTypeEnum.MEDICAL_REPORT,
        )
    )).first()
    if existing is not None:
        return
    session.add(PolicyRequirement(
        tenant_id=tenant_id,
        policy_id=policy.id,
        requirement_type=RequirementTypeEnum.MEDICAL_REPORT,
        label="Medical Report",
        description="Panel-clinic examination report for the mandated test set "
                    "(raised automatically by the non-medical limit grid).",
    ))


# ── Invite ───────────────────────────────────────────────────────────────────

class MedicalInviteResponse(BaseModel):
    token: str
    link_path: str
    expires_at: datetime
    status: MedicalExamStatusEnum
    # The link is also emailed to the customer: who it went to, and
    # "sent" | "failed" | "no_email" (no address on record).
    emailed_to: Optional[str] = None
    email_status: str = "no_email"


@router.post(
    "/tenants/{tenant_id}/cases/{case_id}/medical-exam/invite",
    response_model=MedicalInviteResponse,
)
async def invite_medical_exam(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Issue the customer a tokenized link to pick their panel clinic and slot."""
    user = await _get_current_user(token, session)
    case = await _get_case(session, tenant_id, case_id)

    order = await _load_order(session, case_id)
    if order is None or order.status == MedicalExamStatusEnum.NOT_ASSESSED:
        raise HTTPException(
            status_code=409,
            detail="Run the non-medical-limit assessment for this case before inviting the customer.",
        )
    if order.status == MedicalExamStatusEnum.NOT_REQUIRED:
        raise HTTPException(
            status_code=409,
            detail="This proposal is within the non-medical limit — no examination is required.",
        )
    if order.status in (MedicalExamStatusEnum.COMPLETED, MedicalExamStatusEnum.WAIVED):
        raise HTTPException(status_code=409, detail=f"This medical is already {_v(order.status)}.")

    raw_token = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    expires_at = now + timedelta(days=MEDICAL_INVITE_VALID_DAYS)

    order.invite_token_hash = _hash_token(raw_token)
    order.invite_expires_at = expires_at
    order.invited_at = now
    order.invited_by = user.id
    order.status = MedicalExamStatusEnum.INVITED
    order.updated_at = now

    session.add(order)
    await session.commit()

    from services.customer_links import email_customer_link
    link_path = f"/medical-exam/{raw_token}"
    delivery = await email_customer_link(
        session, kind="medical_exam", tenant_id=tenant_id, case=case,
        link_path=link_path, expires_at=expires_at,
        tests=[t.get("name") for t in (order.required_tests or []) if t.get("name")],
    )
    return MedicalInviteResponse(
        token=raw_token,
        link_path=link_path,
        expires_at=expires_at,
        status=order.status,
        **delivery,
    )


# ── Schedule (staff-side) ────────────────────────────────────────────────────

class ScheduleRequest(BaseModel):
    clinic_id: UUID
    appointment_at: datetime
    home_sampling: bool = False
    note: Optional[str] = None


@router.get("/tenants/{tenant_id}/cases/{case_id}/medical-exam/slots")
async def list_slots(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user(token, session)
    await _get_case(session, tenant_id, case_id)
    order = await _load_order(session, case_id)
    fasting = any(t.get("fasting") for t in (order.required_tests or [])) if order else False
    return {"fasting_required": fasting, "slots": _available_slots(fasting)}


@router.post("/tenants/{tenant_id}/cases/{case_id}/medical-exam/schedule")
async def schedule_medical_exam(
    tenant_id: UUID,
    case_id: UUID,
    body: ScheduleRequest,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Book the appointment on the customer's behalf — the branch/agent path,
    used when the customer would rather have it arranged for them."""
    await _get_current_user(token, session)
    await _get_case(session, tenant_id, case_id)

    order = await _load_order(session, case_id)
    if order is None or order.status in (
        MedicalExamStatusEnum.NOT_ASSESSED, MedicalExamStatusEnum.NOT_REQUIRED
    ):
        raise HTTPException(status_code=409, detail="No medical examination is outstanding for this case.")
    if order.status in (MedicalExamStatusEnum.COMPLETED, MedicalExamStatusEnum.WAIVED):
        raise HTTPException(status_code=409, detail=f"This medical is already {_v(order.status)}.")

    clinic = await session.get(PanelClinic, body.clinic_id)
    if clinic is None or clinic.tenant_id != tenant_id or not clinic.is_active:
        raise HTTPException(status_code=404, detail="Panel clinic not found for this tenant.")
    if body.home_sampling and not clinic.home_sampling:
        raise HTTPException(status_code=400, detail=f"{clinic.name} does not offer home sampling.")
    if body.appointment_at < datetime.utcnow():
        raise HTTPException(status_code=400, detail="Appointment time must be in the future.")

    now = datetime.utcnow()
    if order.clinic_id != clinic.id:
        # A lab link only ever works for the clinic currently on the order.
        order.lab_token_hash = None
        order.lab_token_expires_at = None
        order.lab_sent_at = None
        order.lab_sent_to = None
    order.clinic_id = clinic.id
    order.appointment_at = body.appointment_at
    order.home_sampling = body.home_sampling
    order.appointment_note = body.note
    order.status = MedicalExamStatusEnum.SCHEDULED
    order.updated_at = now

    session.add(order)
    await session.commit()
    await session.refresh(order)
    return await _order_with_clinic(session, order)


# ── Results ──────────────────────────────────────────────────────────────────

class ResultRequest(BaseModel):
    # {test_code: value} or {test_code: {"value": ..., "unit": ...}} as reported.
    results: dict
    artifact_id: Optional[UUID] = None
    reported_by: Optional[str] = None


async def _fetch_report(artifact: Artifact) -> tuple[bytes, str]:
    import asyncio
    from routers.artifacts import _s3_client, _S3_BUCKET
    key = (artifact.storage_url or "").split(".amazonaws.com/", 1)[-1]
    body = await asyncio.to_thread(lambda: _s3_client().get_object(Bucket=_S3_BUCKET, Key=key)["Body"].read())
    return body, artifact.file_type


@router.post("/tenants/{tenant_id}/cases/{case_id}/medical-exam/ai-review")
async def ai_review_medical_reports(
    tenant_id: UUID,
    case_id: UUID,
    refresh: bool = False,
    test_code: Optional[str] = None,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """AI reading of the customer's reports — one suggested value per required
    test, with the line it was read from. A pre-fill for the underwriter's
    review: nothing is rated or recorded here. `test_code` reads a single test,
    so the review screen can show each result as soon as it is ready."""
    from services.medical_report_reader import read_results
    await _get_current_user(token, session)
    await _get_case(session, tenant_id, case_id)
    order = await _load_order(session, case_id)
    if order is None or order.status in (MedicalExamStatusEnum.NOT_ASSESSED, MedicalExamStatusEnum.NOT_REQUIRED):
        raise HTTPException(409, "No medical examination was ordered for this case.")
    reports = [a for a in await _uploaded_reports(session, order) if a.status == "Accepted"]
    if not reports:
        raise HTTPException(409, "The customer has not uploaded any processed reports yet.")
    tests = [t for t in (order.required_tests or []) if test_code in (None, t.get("code"))]
    if not tests:
        raise HTTPException(400, "That test is not part of this examination.")
    ids_by_test: dict[str, list[str]] = {}
    for a in reports:
        ids_by_test.setdefault(a.document_type.split(": ", 1)[-1], []).append(str(a.id))
    # Cached per test, valid while that test's set of reports is unchanged.
    cached = ((order.results_json or {}).get("ai_review") or {}).get("tests") or {}
    stale = [t for t in tests if refresh or (cached.get(t.get("code")) or {}).get("report_ids") != sorted(ids_by_test.get(t.get("code"), []))]
    fresh = await read_results(session, stale, reports, _fetch_report) if stale else {}
    if fresh:
        # Several tests are read in parallel requests: lock and re-read the row
        # so one request's results never overwrite another's.
        locked = (await session.exec(select(MedicalExamOrder).where(MedicalExamOrder.id == order.id)
                                     .with_for_update().execution_options(populate_existing=True))).one()
        review = dict((locked.results_json or {}).get("ai_review") or {})
        review["tests"] = {**(review.get("tests") or {}), **fresh}
        review["generated_at"] = datetime.utcnow().isoformat()
        locked.results_json = {**(locked.results_json or {}), "ai_review": review}
        session.add(locked)
        await session.commit()
        cached = review["tests"]
    return {"tests": {t.get("code"): fresh.get(t.get("code")) or cached[t.get("code")] for t in tests}}


@router.post("/tenants/{tenant_id}/cases/{case_id}/medical-exam/result")
async def record_medical_result(
    tenant_id: UUID,
    case_id: UUID,
    body: ResultRequest,
    request: Request,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Record the lab's report and rate it against the underwriting manual."""
    user = await _get_current_user(token, session)
    await _get_case(session, tenant_id, case_id)

    order = await _load_order(session, case_id)
    if order is None or order.status in (
        MedicalExamStatusEnum.NOT_ASSESSED, MedicalExamStatusEnum.NOT_REQUIRED
    ):
        raise HTTPException(status_code=409, detail="No medical examination was ordered for this case.")
    if order.status == MedicalExamStatusEnum.WAIVED:
        raise HTTPException(status_code=409, detail="This medical was waived — reinstate it before recording results.")

    reports = await _uploaded_reports(session, order)
    if reports:
        required = {t.get("code") for t in (order.required_tests or [])}
        processed = {a.document_type.split(": ", 1)[-1] for a in reports if a.status == "Accepted"}
        if required - processed:
            raise HTTPException(409, "Wait for readable reports for every required test before recording the medical review.")
        if body.artifact_id and body.artifact_id not in {a.id for a in reports if a.status == "Accepted"}:
            raise HTTPException(400, "Choose a processed report uploaded for this examination.")

    verdict = medical_findings.evaluate(body.results)

    now = datetime.utcnow()
    order.results_json = body.results
    order.outcome = MedicalExamOutcomeEnum(verdict["outcome"])
    order.abnormal_findings = verdict["abnormal_findings"]
    order.suggested_loading_pct = verdict["suggested_loading_pct"]
    order.result_artifact_id = body.artifact_id or (reports[-1].id if reports else None)
    order.reported_by = body.reported_by or user.email
    order.completed_at = now
    order.status = MedicalExamStatusEnum.COMPLETED
    order.updated_at = now
    session.add(order)

    # The Stage A Medical Report requirement is satisfied by this report.
    if order.policy_id:
        req = (await session.exec(
            select(PolicyRequirement).where(
                PolicyRequirement.policy_id == order.policy_id,
                PolicyRequirement.requirement_type == RequirementTypeEnum.MEDICAL_REPORT,
            )
        )).first()
        if req is not None and req.status != RequirementStatusEnum.WAIVED:
            req.status = RequirementStatusEnum.VERIFIED
            req.artifact_id = body.artifact_id or req.artifact_id
            req.submitted_at = req.submitted_at or now
            req.verified_by = order.reported_by
            req.verified_at = now
            req.note = f"Panel medical completed — outcome {verdict['outcome']}."
            session.add(req)

    await session.commit()
    await session.refresh(order)

    await publish_case_event(
        request, session,
        event_type="MedicalExamCompleted",
        tenant_id=order.tenant_id, case_id=order.case_id, customer_id=order.customer_id,
        detail={"outcome": _v(order.outcome), "source": "underwriter"},
    )

    payload = await _order_with_clinic(session, order)
    payload["unrated_tests"] = verdict["unrated_tests"]
    payload["uninsurable"] = verdict["uninsurable"]
    return payload


@router.post("/tenants/{tenant_id}/cases/{case_id}/medical-exam/confirm-reports")
async def confirm_medical_reports(
    tenant_id: UUID,
    case_id: UUID,
    request: Request,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """The customer's reports are all in: complete the medical step without entering any values. The reports stay on
    the case and are read during the underwriting run. Every required test needs at least one report that has not
    been sent back for re-upload."""
    user = await _get_current_user(token, session)
    await _get_case(session, tenant_id, case_id)
    order = await _load_order(session, case_id)
    if order is None or order.status in (MedicalExamStatusEnum.NOT_ASSESSED, MedicalExamStatusEnum.NOT_REQUIRED):
        raise HTTPException(status_code=409, detail="No medical examination was ordered for this case.")
    if order.status == MedicalExamStatusEnum.WAIVED:
        raise HTTPException(status_code=409, detail="This medical was waived — reinstate it first.")

    reports = await _uploaded_reports(session, order)
    have = {a.document_type.split(": ", 1)[-1] for a in reports if a.status != "Re-submission Requested"}
    missing = [t.get("name") or t.get("code") for t in (order.required_tests or []) if t.get("code") not in have]
    if missing:
        raise HTTPException(status_code=409, detail="Reports are still missing for: " + ", ".join(missing) + ".")

    now = datetime.utcnow()
    order.results_json = {**(order.results_json or {}), "reports_confirmed_at": now.isoformat()}
    order.completed_at = now
    order.reported_by = user.email
    order.status = MedicalExamStatusEnum.COMPLETED
    order.updated_at = now
    session.add(order)
    await session.commit()
    await session.refresh(order)

    await publish_case_event(
        request, session,
        event_type="MedicalExamCompleted",
        tenant_id=order.tenant_id, case_id=order.case_id, customer_id=order.customer_id,
        detail={"outcome": None, "source": "reports_received"},
    )
    return await _order_with_clinic(session, order)


# ── Waive / reinstate ────────────────────────────────────────────────────────

class WaiveRequest(BaseModel):
    reason: str


@router.post("/tenants/{tenant_id}/cases/{case_id}/medical-exam/waive")
async def waive_medical_exam(
    tenant_id: UUID,
    case_id: UUID,
    body: WaiveRequest,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Underwriter waives the requirement — typically a valid examination on
    file from a recent proposal, within the medical validity window."""
    user = await _get_current_user(token, session)
    role = await _role_name(user, session)
    if role not in _WAIVER_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Waiving a medical requirement requires one of: "
                   f"{', '.join(sorted(_WAIVER_ROLES))} (you are {role}).",
        )
    await _get_case(session, tenant_id, case_id)

    order = await _load_order(session, case_id)
    if order is None:
        raise HTTPException(status_code=404, detail="No medical examination order exists for this case.")
    if order.status == MedicalExamStatusEnum.COMPLETED:
        raise HTTPException(status_code=409, detail="This medical is already completed — nothing to waive.")

    now = datetime.utcnow()
    order.status = MedicalExamStatusEnum.WAIVED
    order.waived_by = user.email
    order.waived_at = now
    order.waiver_reason = body.reason
    order.updated_at = now
    session.add(order)
    await session.commit()
    await session.refresh(order)
    return await _order_with_clinic(session, order)


# ── Public, token-scoped (the customer has no login) ─────────────────────────

async def _resolve_by_token(session: AsyncSession, raw_token: str) -> MedicalExamOrder:
    token_hash = _hash_token(raw_token)
    stmt = select(MedicalExamOrder).where(MedicalExamOrder.invite_token_hash == token_hash)
    order = (await session.exec(stmt)).first()
    if order is None:
        raise HTTPException(status_code=404, detail="Invalid or unknown link")
    if order.invite_expires_at and order.invite_expires_at < datetime.utcnow():
        if order.status == MedicalExamStatusEnum.INVITED:
            order.status = MedicalExamStatusEnum.EXPIRED
            session.add(order)
            await session.commit()
        raise HTTPException(
            status_code=410,
            detail="This booking link has expired. Please ask your agent to resend it.",
        )
    return order


async def _uploaded_reports(session: AsyncSession, order: MedicalExamOrder) -> list:
    return list((await session.exec(select(Artifact).where(
        Artifact.source_request_id == order.id,
        Artifact.tenant_id == order.tenant_id,
        Artifact.case_id == order.case_id,
        Artifact.customer_id == order.customer_id,
    ).order_by(Artifact.created_at))).all())


def _report_view(artifact: Artifact) -> dict:
    return {"id": str(artifact.id), "file_name": artifact.file_name,
            "test_code": artifact.document_type.split(": ", 1)[-1],
            "status": artifact.status, "created_at": artifact.created_at.isoformat()}


def _ensure_reports_open(order: MedicalExamOrder) -> None:
    if order.status in (MedicalExamStatusEnum.WAIVED, MedicalExamStatusEnum.NOT_REQUIRED, MedicalExamStatusEnum.COMPLETED):
        raise HTTPException(409, "This examination is closed; contact your agent if another report is needed.")


async def _save_reports(request: Request, session: AsyncSession, order: MedicalExamOrder,
                        test_codes: list[str], data: bytes, filename: str, mime: str) -> list[Artifact]:
    """One artifact per test the file covers, each stored and queued for OCR."""
    from services.medical_report_uploads import store_report
    from shared.events.kafka_events import ArtifactOCRPayload, ArtifactOCRRequestedEvent
    from routers.artifacts import OCR_TOPIC
    if len(await _uploaded_reports(session, order)) + len(test_codes) > 50:
        raise HTTPException(409, "Report limit reached. Please contact your agent.")
    stored = []
    for test_code in test_codes:
        artifact_id = uuid4()
        key = f"{order.tenant_id}/cases/{order.case_id}/{artifact_id}/{filename}"
        storage_url = await store_report(data, key, mime)
        stored.append((Artifact(id=artifact_id, tenant_id=order.tenant_id, customer_id=order.customer_id,
                                case_id=order.case_id, source_request_id=order.id, uploaded_by=None,
                                document_type=f"Medical Report: {test_code}", file_name=filename,
                                file_size=len(data), file_type=mime, storage_url=storage_url, status="Uploaded"), key))
    for artifact, _ in stored:
        session.add(artifact)
    result_data = dict(order.results_json or {})
    result_data.pop("customer_reports_submitted_at", None)
    order.results_json = result_data
    order.updated_at = datetime.utcnow()
    session.add(order)
    await session.commit()
    for artifact, key in stored:
        event = ArtifactOCRRequestedEvent(tenant_id=order.tenant_id, payload=ArtifactOCRPayload(
            artifact_id=artifact.id, tenant_id=order.tenant_id, case_id=order.case_id,
            s3_key=key, file_name=filename, mime_type=mime))
        try:
            await request.app.state.kafka_producer.send_and_wait(OCR_TOPIC, value=event.model_dump_json(), key=str(artifact.id))
        except Exception:
            # Persist the file but don't imply it is being processed. The submit
            # endpoint retries jobs that have not been accepted by the broker.
            artifact.status = "OCR Pending"
            session.add(artifact)
            await session.commit()
    return [artifact for artifact, _ in stored]


@router.get("/public/medical-exam/{raw_token}")
async def public_get_medical_exam(raw_token: str, session: AsyncSession = Depends(get_session)):
    """What the customer sees: which tests, why, how to prepare, and where they
    can go."""
    order = await _resolve_by_token(session, raw_token)
    customer = await session.get(Customer, order.customer_id)
    if customer is None:
        raise HTTPException(status_code=404, detail="Applicant not found")

    policy = await session.get(Policy, order.policy_id) if order.policy_id else None
    clinics = await ensure_panel_clinics(session, order.tenant_id)
    tests = order.required_tests or []
    fasting = any(t.get("fasting") for t in tests)
    booked_clinic = await session.get(PanelClinic, order.clinic_id) if order.clinic_id else None

    return {
        "status": _v(order.status),
        "customer_name": customer.name,
        "customer_city": customer.city,
        "product_name": policy.product_name if policy else None,
        "coverage_amount": policy.coverage_amount if policy else None,
        "tests": tests,
        "fasting_required": fasting,
        "preparation_notes": _preparation_notes(tests),
        "cost_borne_by_insurer": True,
        "clinics": [_clinic_dict(c) for c in clinics if c.is_active],
        "slots": _available_slots(fasting),
        "appointment_at": order.appointment_at.isoformat() if order.appointment_at else None,
        "booked_clinic": _clinic_dict(booked_clinic) if booked_clinic else None,
        "home_sampling": order.home_sampling,
        "expires_at": order.invite_expires_at.isoformat() if order.invite_expires_at else None,
    }


def _preparation_notes(tests: list) -> list[str]:
    notes: list[str] = []
    if any(t.get("fasting") for t in tests):
        notes.append(
            "Fast for 10–12 hours before sample collection. Water is allowed; no tea, "
            "coffee, juice or food."
        )
        notes.append("Morning collection is required — fasting samples cannot be drawn in the afternoon.")
    codes = {t.get("code") for t in tests}
    if "TMT" in codes:
        notes.append("Wear comfortable clothes and walking shoes for the treadmill test.")
    if "CXR" in codes:
        notes.append("Avoid metal jewellery and clothing with metal fastenings for the X-ray.")
    if "URINE_RE" in codes:
        notes.append("A urine sample is collected at the centre — no preparation needed.")
    notes.append("Bring your original CNIC. The examination is arranged and paid for by the insurer.")
    return notes


class PublicBookRequest(BaseModel):
    clinic_id: UUID
    appointment_at: datetime
    home_sampling: bool = False


LAB_LINK_VALID_DAYS = 14  # after the appointment


async def _issue_lab_link(session: AsyncSession, order: MedicalExamOrder, case: Case, clinic: PanelClinic) -> dict:
    """Mint a fresh report-upload link for the clinic on this order and email it to the lab.
    Any earlier lab link stops working (only the newest hash is stored)."""
    from services.customer_links import email_lab_link
    raw_token = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    expires_at = max(now, order.appointment_at or now) + timedelta(days=LAB_LINK_VALID_DAYS)
    order.lab_token_hash = _hash_token(raw_token)
    order.lab_token_expires_at = expires_at
    order.updated_at = now
    link_path = f"/medical-lab/{raw_token}"
    delivery = await email_lab_link(
        session, tenant_id=order.tenant_id, case=case, clinic=clinic, link_path=link_path,
        expires_at=expires_at, appointment_at=order.appointment_at,
        tests=[t.get("name") for t in (order.required_tests or []) if t.get("name")],
    )
    if delivery["email_status"] == "sent":
        order.lab_sent_at = now
        order.lab_sent_to = delivery["emailed_to"]
    session.add(order)
    await session.commit()
    return {"token": raw_token, "link_path": link_path, "expires_at": expires_at, **delivery}


@router.post("/public/medical-exam/{raw_token}/book")
async def public_book_medical_exam(
    raw_token: str,
    body: PublicBookRequest,
    session: AsyncSession = Depends(get_session),
):
    """The customer picks a panel lab and a time. Booking issues the lab's own report-upload
    link and emails it to that lab — the customer never uploads reports."""
    order = await _resolve_by_token(session, raw_token)
    if order.status == MedicalExamStatusEnum.SCHEDULED:
        raise HTTPException(409, "Your appointment is already booked. Contact your agent to change it.")
    if order.status != MedicalExamStatusEnum.INVITED:
        raise HTTPException(409, "This examination can no longer be booked. Please contact your agent.")

    clinic = await session.get(PanelClinic, body.clinic_id)
    if clinic is None or clinic.tenant_id != order.tenant_id or not clinic.is_active:
        raise HTTPException(404, "Lab not found.")
    required = {t.get("code") for t in (order.required_tests or [])}
    if clinic.supported_tests and required - set(clinic.supported_tests):
        raise HTTPException(400, f"{clinic.name} cannot perform every required test. Please choose another lab.")
    if body.home_sampling and not clinic.home_sampling:
        raise HTTPException(400, f"{clinic.name} does not offer home sampling.")
    fasting = any(t.get("fasting") for t in (order.required_tests or []))
    if body.appointment_at.replace(tzinfo=None).isoformat() not in set(_available_slots(fasting)):
        raise HTTPException(400, "Please choose one of the available times.")
    case = await session.get(Case, order.case_id)
    if case is None or case.customer_id != order.customer_id or case.tenant_id != order.tenant_id:
        raise HTTPException(404, "Application not found.")

    now = datetime.utcnow()
    order.clinic_id = clinic.id
    order.appointment_at = body.appointment_at.replace(tzinfo=None)
    order.home_sampling = body.home_sampling
    order.status = MedicalExamStatusEnum.SCHEDULED
    order.updated_at = now
    session.add(order)
    await session.commit()

    lab = await _issue_lab_link(session, order, case, clinic)
    return {
        "status": _v(order.status),
        "appointment_at": order.appointment_at.isoformat(),
        "booked_clinic": _clinic_dict(clinic),
        "lab_notified": lab["email_status"] == "sent",
    }


@router.post("/tenants/{tenant_id}/cases/{case_id}/medical-exam/lab-link")
async def issue_lab_link(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """(Re)send the booked lab its report-upload link — for a lab with no email on file,
    a lost email, or a rebooking made by staff. Replaces any earlier lab link."""
    await _get_current_user(token, session)
    case = await _get_case(session, tenant_id, case_id)
    order = await _load_order(session, case_id)
    if order is None or order.status != MedicalExamStatusEnum.SCHEDULED or not order.clinic_id:
        raise HTTPException(409, "Book a lab and time for this examination first.")
    clinic = await session.get(PanelClinic, order.clinic_id)
    if clinic is None or clinic.tenant_id != tenant_id:
        raise HTTPException(404, "Booked lab not found.")
    lab = await _issue_lab_link(session, order, case, clinic)
    return {"link_path": lab["link_path"], "expires_at": lab["expires_at"], "emailed_to": lab["emailed_to"],
            "email_status": lab["email_status"], "lab_name": clinic.name}


# ── Public, lab-scoped (the doctor has no login) ─────────────────────────────

async def _resolve_by_lab_token(session: AsyncSession, raw_token: str) -> tuple[MedicalExamOrder, PanelClinic]:
    stmt = select(MedicalExamOrder).where(MedicalExamOrder.lab_token_hash == _hash_token(raw_token))
    order = (await session.exec(stmt)).first()
    if order is None or not order.clinic_id:
        raise HTTPException(404, "Invalid or unknown link")
    if order.lab_token_expires_at and order.lab_token_expires_at < datetime.utcnow():
        raise HTTPException(410, "This link has expired. Please ask the insurer to resend it.")
    clinic = await session.get(PanelClinic, order.clinic_id)
    if clinic is None or clinic.tenant_id != order.tenant_id:
        raise HTTPException(404, "Invalid or unknown link")
    return order, clinic


@router.get("/public/medical-lab/{raw_token}")
async def public_get_lab_exam(raw_token: str, session: AsyncSession = Depends(get_session)):
    """What the doctor sees: the applicant, the booked slot, the tests, and what is uploaded."""
    order, clinic = await _resolve_by_lab_token(session, raw_token)
    customer = await session.get(Customer, order.customer_id)
    case = await session.get(Case, order.case_id)
    if customer is None or case is None or case.customer_id != customer.id:
        raise HTTPException(404, "Applicant not found")
    return {
        "status": _v(order.status),
        "lab_name": clinic.name,
        "case_number": case.caseNumber,
        "applicant": {
            "name": customer.name, "cnic": customer.cnic, "age": age_from_dob(customer.dob),
            "gender": _v(customer.gender),
        },
        "appointment_at": order.appointment_at.isoformat() if order.appointment_at else None,
        "home_sampling": order.home_sampling,
        "tests": order.required_tests or [],
        "fasting_required": any(t.get("fasting") for t in (order.required_tests or [])),
        "reports": [_report_view(a) for a in await _uploaded_reports(session, order)],
        "reports_submitted": bool((order.results_json or {}).get("customer_reports_submitted_at")),
        "signed_by": order.lab_signed_by,
        "expires_at": order.lab_token_expires_at.isoformat() if order.lab_token_expires_at else None,
    }


@router.post("/public/medical-lab/{raw_token}/reports", status_code=202)
async def lab_upload_medical_report(
    raw_token: str, request: Request, test_code: str = Form(...),
    file: UploadFile = File(...), session: AsyncSession = Depends(get_session),
):
    from services.medical_report_uploads import MAX_REPORT_BYTES, validate_report
    order, _ = await _resolve_by_lab_token(session, raw_token)
    _ensure_reports_open(order)
    if test_code not in {t.get("code") for t in (order.required_tests or [])}:
        raise HTTPException(400, "Choose one of the tests required for this examination.")
    data = await file.read(MAX_REPORT_BYTES + 1)
    filename, mime = validate_report(file.filename, data)
    artifacts = await _save_reports(request, session, order, [test_code], data, filename, mime)
    return {"report": _report_view(artifacts[0])}


@router.post("/public/medical-lab/{raw_token}/reports/auto", status_code=202)
async def lab_auto_upload_medical_report(
    raw_token: str, request: Request, file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
):
    """Read the report, work out which required tests it covers and attach it to each.
    Nothing is stored when no test can be identified."""
    from services.medical_report_uploads import MAX_REPORT_BYTES, validate_report
    from services.medical_report_classifier import classify_report
    order, _ = await _resolve_by_lab_token(session, raw_token)
    _ensure_reports_open(order)
    data = await file.read(MAX_REPORT_BYTES + 1)
    filename, mime = validate_report(file.filename, data)
    test_codes, method = await classify_report(session, data, mime, filename, order.required_tests or [])
    artifacts = await _save_reports(request, session, order, test_codes, data, filename, mime) if test_codes else []
    return {"file_name": filename, "test_codes": test_codes, "matched_by": method,
            "reports": [_report_view(a) for a in artifacts]}


class LabSubmitRequest(BaseModel):
    signature_name: str
    license_no: Optional[str] = None


@router.post("/public/medical-lab/{raw_token}/complete")
async def lab_complete_medical_exam(
    raw_token: str,
    body: LabSubmitRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    order, _ = await _resolve_by_lab_token(session, raw_token)
    _ensure_reports_open(order)
    signer = body.signature_name.strip()
    if len(signer) < 3:
        raise HTTPException(400, "Type the examining doctor's full name as an e-signature.")

    from routers.artifacts import OCR_TOPIC
    from shared.events.kafka_events import ArtifactOCRPayload, ArtifactOCRRequestedEvent
    reports = await _uploaded_reports(session, order)
    required = {t.get("code") for t in (order.required_tests or [])}
    provided = {a.document_type.split(": ", 1)[-1] for a in reports
                if a.status not in ("Rejected", "Re-submission Requested")}
    if not required or required - provided:
        raise HTTPException(409, "Upload a report for every required test before submitting.")
    for artifact in reports:
        if artifact.status == "OCR Pending":
            key = f"{order.tenant_id}/cases/{order.case_id}/{artifact.id}/{artifact.file_name}"
            event = ArtifactOCRRequestedEvent(tenant_id=order.tenant_id, payload=ArtifactOCRPayload(
                artifact_id=artifact.id, tenant_id=order.tenant_id, case_id=order.case_id,
                s3_key=key, file_name=artifact.file_name, mime_type=artifact.file_type))
            try:
                await request.app.state.kafka_producer.send_and_wait(OCR_TOPIC, value=event.model_dump_json(), key=str(artifact.id))
            except Exception as exc:
                raise HTTPException(503, "Reports are saved, but processing is temporarily unavailable. Please retry submitting.") from exc
            artifact.status = "Uploaded"
            session.add(artifact)
    now = datetime.utcnow()
    order.result_artifact_id = reports[-1].id
    order.lab_signed_by = signer[:255]
    order.lab_signer_license = (body.license_no or "").strip()[:100] or None
    order.lab_signed_at = now
    # Key name kept: the staff view reads it as "reports submitted for review".
    order.results_json = {**(order.results_json or {}), "customer_reports_submitted_at": now.isoformat()}
    order.updated_at = now
    session.add(order)
    await session.commit()
    # The lab's submission is evidence, not a clinical verdict. Only staff's
    # record_medical_result can complete the gate and rate the findings.
    await publish_case_event(request, session, event_type="MedicalReportsSubmitted",
                             tenant_id=order.tenant_id, case_id=order.case_id, customer_id=order.customer_id,
                             detail={"report_count": len(reports), "source": "lab"})
    return {"status": _v(order.status), "reports_submitted": True,
            "message": "Reports submitted for medical review. Thank you."}
