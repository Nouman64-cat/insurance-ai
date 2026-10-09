"""
Pre-Underwriting — Agent's Confidential Report (ACR).

Non-medical risk control filled by the selling agent: moral hazard,
financial standing, and general lifestyle observations that structured
data fields alone miss. Reviewed read-only by underwriters alongside the
AI risk score and the customer's E-Application.

Request flow: when the pipeline (individual, family or corporate) reaches Gate 2
it calls POST /acr/request, which addresses the report to whoever brought the
customer in — the acquisition source's own login (agent, broker, bank desk…),
else the customer's assigned agent. That person sees it under GET /acr-requests
in the agent app, files it there, and submitting publishes an `ACRSubmitted`
case event that api-gateway pushes to the copilot over SSE so the workflow moves
on by itself — the same loop the e-application and the panel medical use.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from jose import JWTError
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import decode_access_token, oauth2_scheme, source_scope
from services.case_events import publish_case_event
from shared.models.core import (
    ACRRecommendationEnum,
    ACRStatusEnum,
    AcquisitionSource,
    AgentConfidentialReport,
    Case,
    Customer,
    FamilyGroup,
    Organization,
    Tenant,
    User,
)

router = APIRouter(tags=["Pre-Underwriting — Agent's Confidential Report"])


async def _get_current_user_id(token: str) -> UUID:
    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
        return UUID(user_id)
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


from family_approval import owner_case_id


async def _get_case(session: AsyncSession, tenant_id: UUID, case_id: UUID) -> Case:
    case = await session.get(Case, case_id)
    if case is None or case.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


class ACRUpsert(BaseModel):
    known_proposer_since: Optional[str] = None
    relationship_to_proposer: Optional[str] = None
    purpose_of_insurance: Optional[str] = None
    financial_interest_explained: Optional[bool] = None
    adverse_info_known: Optional[bool] = None
    adverse_info_details: Optional[str] = None

    occupation_verified: Optional[bool] = None
    income_source_verified: Optional[bool] = None
    estimated_income_opinion: Optional[float] = None
    income_consistency_note: Optional[str] = None

    health_appearance_note: Optional[str] = None
    habits_observed: Optional[dict] = None
    hazardous_activity_known: Optional[bool] = None

    terms_explained_to_proposer: Optional[bool] = None
    identity_verified_kyc: Optional[bool] = None
    signature_obtained_in_presence: Optional[bool] = None

    recommendation: Optional[ACRRecommendationEnum] = None
    remarks: Optional[str] = None


class ACRRead(ACRUpsert):
    status: ACRStatusEnum
    agent_id: Optional[UUID]
    submitted_at: Optional[datetime]
    requested_at: Optional[datetime] = None


def _to_read(acr: AgentConfidentialReport) -> ACRRead:
    return ACRRead(
        status=acr.status,
        agent_id=acr.agent_id,
        submitted_at=acr.submitted_at,
        requested_at=acr.requested_at,
        known_proposer_since=acr.known_proposer_since,
        relationship_to_proposer=acr.relationship_to_proposer,
        purpose_of_insurance=acr.purpose_of_insurance,
        financial_interest_explained=acr.financial_interest_explained,
        adverse_info_known=acr.adverse_info_known,
        adverse_info_details=acr.adverse_info_details,
        occupation_verified=acr.occupation_verified,
        income_source_verified=acr.income_source_verified,
        estimated_income_opinion=acr.estimated_income_opinion,
        income_consistency_note=acr.income_consistency_note,
        health_appearance_note=acr.health_appearance_note,
        habits_observed=acr.habits_observed,
        hazardous_activity_known=acr.hazardous_activity_known,
        terms_explained_to_proposer=acr.terms_explained_to_proposer,
        identity_verified_kyc=acr.identity_verified_kyc,
        signature_obtained_in_presence=acr.signature_obtained_in_presence,
        recommendation=acr.recommendation,
        remarks=acr.remarks,
    )


@router.get("/tenants/{tenant_id}/cases/{case_id}/acr", response_model=ACRRead)
async def get_acr(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user_id(token)
    case_id = await owner_case_id(session, await _get_case(session, tenant_id, case_id), "acr")   # the head's, for an insured spouse

    stmt = select(AgentConfidentialReport).where(AgentConfidentialReport.case_id == case_id)
    acr = (await session.execute(stmt)).scalars().first()
    if acr is None:
        return ACRRead(status=ACRStatusEnum.NOT_STARTED, agent_id=None, submitted_at=None)
    return _to_read(acr)


@router.put("/tenants/{tenant_id}/cases/{case_id}/acr", response_model=ACRRead)
async def upsert_acr(
    tenant_id: UUID,
    case_id: UUID,
    body: ACRUpsert,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    user_id = await _get_current_user_id(token)
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None or not tenant.is_active:
        raise HTTPException(status_code=404, detail="Tenant not found or inactive")
    case_id = await owner_case_id(session, await _get_case(session, tenant_id, case_id), "acr")

    stmt = select(AgentConfidentialReport).where(AgentConfidentialReport.case_id == case_id)
    acr = (await session.execute(stmt)).scalars().first()

    if acr is not None and acr.status == ACRStatusEnum.SUBMITTED:
        raise HTTPException(status_code=409, detail="This ACR has already been submitted and is locked.")

    if acr is None:
        acr = AgentConfidentialReport(tenant_id=tenant_id, case_id=case_id, agent_id=user_id)
    elif acr.agent_id is None:
        acr.agent_id = user_id   # a row opened by /acr/request has no author until someone drafts it

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(acr, field, value)

    acr.status = ACRStatusEnum.DRAFT
    acr.updated_at = datetime.utcnow()

    session.add(acr)
    await session.commit()
    await session.refresh(acr)
    return _to_read(acr)


@router.post("/tenants/{tenant_id}/cases/{case_id}/acr/submit", response_model=ACRRead)
async def submit_acr(
    tenant_id: UUID,
    case_id: UUID,
    request: Request,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    user_id = await _get_current_user_id(token)
    case_id = await owner_case_id(session, await _get_case(session, tenant_id, case_id), "acr")

    stmt = select(AgentConfidentialReport).where(AgentConfidentialReport.case_id == case_id)
    acr = (await session.execute(stmt)).scalars().first()
    if acr is None:
        raise HTTPException(status_code=404, detail="No ACR draft found for this case yet.")
    if acr.status == ACRStatusEnum.SUBMITTED:
        raise HTTPException(status_code=409, detail="This ACR has already been submitted.")
    if not acr.recommendation:
        raise HTTPException(status_code=422, detail="A recommendation is required before submitting.")
    missing = [
        label for flag, label in (
            (acr.terms_explained_to_proposer, "confirm you explained the policy terms to the proposer"),
            (acr.identity_verified_kyc, "confirm you verified the proposer's identity (KYC)"),
            (acr.signature_obtained_in_presence, "confirm the proposer's signature was obtained in your presence"),
        ) if not flag
    ]
    if missing:
        raise HTTPException(status_code=422, detail=f"Please {'; '.join(missing)} before submitting.")

    now = datetime.utcnow()
    acr.status = ACRStatusEnum.SUBMITTED
    acr.submitted_at = now
    acr.updated_at = now

    session.add(acr)
    await session.commit()
    await session.refresh(acr)

    # Lets the copilot that requested it move on to the next gate on its own.
    case = await session.get(Case, acr.case_id)
    submitter = await session.get(User, user_id)
    await publish_case_event(
        request, session,
        event_type="ACRSubmitted",
        tenant_id=tenant_id, case_id=acr.case_id, customer_id=case.customer_id if case else None,
        detail={
            "recommendation": acr.recommendation.value if acr.recommendation else None,
            "submitted_by": submitter.full_name if submitter else None,
            "was_requested": acr.requested_at is not None,
        },
    )
    return _to_read(acr)


# ── Requests to the acquisition source ───────────────────────────────────────

class ACRRecipient(BaseModel):
    user_id: UUID
    name: str
    source_id: Optional[UUID] = None
    source_type: Optional[str] = None
    source_name: Optional[str] = None
    source_code: Optional[str] = None


class ACRRequestResult(BaseModel):
    case_id: UUID
    status: ACRStatusEnum
    requested_at: Optional[datetime]
    recipient: Optional[ACRRecipient]
    already_requested: bool
    # The caller IS the recipient (e.g. a broker running the copilot) — they
    # should just file it rather than wait on a request to themselves.
    self_request: bool


async def _resolve_recipient(session: AsyncSession, case: Case) -> Optional[ACRRecipient]:
    """Who files the ACR for this case: the acquisition source's own login if it
    has an active one, else the agent assigned to the customer. Family members
    and corporate employees fall back to their group's source / agent, which is
    who brought the group in."""
    customer = await session.get(Customer, case.customer_id) if case.customer_id else None
    if customer is None:
        return None
    group = None
    if customer.family_group_id:
        group = await session.get(FamilyGroup, customer.family_group_id)
    elif customer.organization_id:
        group = await session.get(Organization, customer.organization_id)

    source_id = customer.acquisition_source_id or (group.acquisition_source_id if group else None)
    source = await session.get(AcquisitionSource, source_id) if source_id else None
    source_fields = dict(
        source_id=source.id, source_type=getattr(source.source_type, "value", source.source_type),
        source_name=source.name, source_code=source.code,
    ) if source else {}

    if source is not None and source.is_active and source.user_id:
        login = await session.get(User, source.user_id)
        if login is not None and not getattr(login, "is_deleted", False):
            return ACRRecipient(user_id=login.id, name=login.full_name or source.name, **source_fields)

    agent_id = customer.assigned_agent_id or (group.assigned_agent_id if group else None)
    agent = await session.get(User, agent_id) if agent_id else None
    if agent is not None and not getattr(agent, "is_deleted", False):
        return ACRRecipient(user_id=agent.id, name=agent.full_name, **source_fields)
    return None


@router.post("/tenants/{tenant_id}/cases/{case_id}/acr/request", response_model=ACRRequestResult)
async def request_acr(
    tenant_id: UUID,
    case_id: UUID,
    request: Request,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Ask the case's acquisition source to file the ACR from the agent app.
    Idempotent: asking again returns the standing request instead of re-sending."""
    user_id = await _get_current_user_id(token)
    case_id = await owner_case_id(session, await _get_case(session, tenant_id, case_id), "acr")
    owner = await session.get(Case, case_id)

    acr = (await session.execute(
        select(AgentConfidentialReport).where(AgentConfidentialReport.case_id == case_id)
    )).scalars().first()

    recipient = await _resolve_recipient(session, owner)
    if acr is not None and acr.status == ACRStatusEnum.SUBMITTED:
        return ACRRequestResult(
            case_id=case_id, status=acr.status, requested_at=acr.requested_at, recipient=recipient,
            already_requested=acr.requested_at is not None, self_request=False,
        )
    if recipient is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "Nobody can be asked for this ACR: the customer has no acquisition source with an app login "
                "and no assigned agent. Link an acquisition source (or assign an agent) to the customer first."
            ),
        )
    if recipient.user_id == user_id:
        return ACRRequestResult(
            case_id=case_id, status=acr.status if acr else ACRStatusEnum.NOT_STARTED,
            requested_at=acr.requested_at if acr else None, recipient=recipient,
            already_requested=False, self_request=True,
        )

    already = acr is not None and acr.requested_at is not None and acr.requested_user_id == recipient.user_id
    if not already:
        if acr is None:
            acr = AgentConfidentialReport(tenant_id=tenant_id, case_id=case_id, status=ACRStatusEnum.NOT_STARTED)
        now = datetime.utcnow()
        acr.requested_at = now
        acr.requested_by = user_id
        acr.requested_source_id = recipient.source_id
        acr.requested_user_id = recipient.user_id
        acr.updated_at = now
        session.add(acr)
        await session.commit()
        await session.refresh(acr)
        await publish_case_event(
            request, session,
            event_type="ACRRequested",
            tenant_id=tenant_id, case_id=case_id, customer_id=owner.customer_id,
            detail={"recipient": recipient.name, "source_type": recipient.source_type},
        )

    return ACRRequestResult(
        case_id=case_id, status=acr.status, requested_at=acr.requested_at, recipient=recipient,
        already_requested=already, self_request=False,
    )


class ACRRequestItem(BaseModel):
    case_id: UUID
    case_number: Optional[str]
    applicant_name: Optional[str]
    segment: str                    # individual | family | organization
    group_name: Optional[str]
    status: str                     # Requested | Draft | Submitted
    requested_at: Optional[datetime]
    requested_by_name: Optional[str]
    submitted_at: Optional[datetime]


@router.get("/tenants/{tenant_id}/acr-requests", response_model=list[ACRRequestItem])
async def list_my_acr_requests(
    tenant_id: UUID,
    include_submitted: bool = False,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """The ACRs the signed-in user has been asked to file — addressed to them,
    or to an acquisition source whose login they hold. Newest first."""
    user_id = await _get_current_user_id(token)
    scope = await source_scope(token, session)

    addressed = AgentConfidentialReport.requested_user_id == user_id
    if scope:
        addressed = addressed | AgentConfidentialReport.requested_source_id.in_(scope)
    stmt = (
        select(AgentConfidentialReport)
        .where(
            AgentConfidentialReport.tenant_id == tenant_id,
            AgentConfidentialReport.requested_at.is_not(None),
            addressed,
        )
        .order_by(AgentConfidentialReport.requested_at.desc())
    )
    if not include_submitted:
        stmt = stmt.where(AgentConfidentialReport.status != ACRStatusEnum.SUBMITTED)
    rows = (await session.execute(stmt.limit(100))).scalars().all()

    out: list[ACRRequestItem] = []
    for acr in rows:
        case = await session.get(Case, acr.case_id)
        customer = await session.get(Customer, case.customer_id) if case and case.customer_id else None
        segment, group_name = "individual", None
        if customer and customer.family_group_id:
            segment = "family"
            fg = await session.get(FamilyGroup, customer.family_group_id)
            group_name = fg.name if fg else None
        elif customer and customer.organization_id:
            segment = "organization"
            org = await session.get(Organization, customer.organization_id)
            group_name = org.name if org else None
        requester = await session.get(User, acr.requested_by) if acr.requested_by else None
        out.append(ACRRequestItem(
            case_id=acr.case_id,
            case_number=case.caseNumber if case else None,
            applicant_name=customer.name if customer else None,
            segment=segment,
            group_name=group_name,
            status="Requested" if acr.status == ACRStatusEnum.NOT_STARTED else acr.status.value,
            requested_at=acr.requested_at,
            requested_by_name=requester.full_name if requester else None,
            submitted_at=acr.submitted_at,
        ))
    return out
