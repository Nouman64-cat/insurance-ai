"""
Claims Management Router — FNOL creation, adjuster workbench, status transitions,
rule-engine adjudication, disbursement payouts, and reinsurance recovery.
"""

from datetime import date, datetime
from typing import List, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field as PydanticField
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, _role_name, oauth2_scheme
from shared.models.core import (
    Artifact,
    Case,
    CasePriorityEnum,
    CaseStatusEnum,
    CaseTypeEnum,
    Claim,
    ClaimPayout,
    ClaimStatusEnum,
    ClaimStatusHistory,
    Customer,
    Policy,
    ReinsuranceReferral,
    ReinsuranceReferralStatusEnum,
    ReinsuranceReferralTypeEnum,
    Role,
    SourceChannelEnum,
    Tenant,
    User,
)

router = APIRouter(prefix="/tenants/{tenant_id}/claims", tags=["Claims"])

_CLAIMS_ROLES = {"ClaimsAdjuster", "ClaimsManager", "Admin", "SuperAdmin", "Underwriter"}


async def _assert_claims_role(token: str, session: AsyncSession) -> User:
    user = await _get_current_user(token, session)
    role = await _role_name(user, session)
    if role not in _CLAIMS_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Claims actions require one of: {', '.join(sorted(_CLAIMS_ROLES))} (you are {role}).",
        )
    return user


async def _generate_claim_number(session: AsyncSession, tenant_id: UUID) -> str:
    year = datetime.utcnow().year
    stmt = (
        select(Claim)
        .where(Claim.tenant_id == tenant_id, Claim.claim_number.like(f"CLM-{year}-%"))
        .order_by(Claim.created_at.desc())
    )
    last = (await session.exec(stmt)).first()
    seq = 1
    if last and last.claim_number:
        try:
            seq = int(last.claim_number.rsplit("-", 1)[-1]) + 1
        except ValueError:
            seq = 1
    return f"CLM-{year}-{seq:04d}"


def _claim_dict(claim: Claim, policy: Optional[Policy] = None, customer: Optional[Customer] = None, adjuster: Optional[User] = None, artifacts_count: int = 0) -> dict:
    return {
        "id": str(claim.id),
        "tenant_id": str(claim.tenant_id),
        "policy_id": str(claim.policy_id),
        "case_id": str(claim.case_id) if claim.case_id else None,
        "claim_number": claim.claim_number or f"CLM-{claim.created_at.year}-{str(claim.id)[:6].upper()}",
        "claim_type": claim.claim_type,
        "submitted_amount": claim.submitted_amount,
        "approved_amount": claim.approved_amount,
        "status": claim.status.value if hasattr(claim.status, "value") else str(claim.status),
        "fraud_probability": claim.fraud_probability,
        "duplicate_flag": claim.duplicate_flag,
        "ai_recommendation": claim.ai_recommendation,
        "incident_date": claim.incident_date.isoformat() if claim.incident_date else None,
        "reported_date": claim.reported_date.isoformat() if claim.reported_date else None,
        "assigned_adjuster_id": str(claim.assigned_adjuster_id) if claim.assigned_adjuster_id else None,
        "assigned_adjuster_name": adjuster.full_name if adjuster else None,
        "reinsurance_referral_id": str(claim.reinsurance_referral_id) if claim.reinsurance_referral_id else None,
        "settlement_amount": claim.settlement_amount,
        "settled_at": claim.settled_at.isoformat() if claim.settled_at else None,
        "closed_at": claim.closed_at.isoformat() if claim.closed_at else None,
        "created_at": claim.created_at.isoformat(),
        # Policy & Customer details
        "policy_number": policy.policy_number if policy else None,
        "policy_type": policy.product_name if policy else None,
        "coverage_amount": policy.coverage_amount if policy else 0.0,
        "claimant_name": customer.name if customer else "Unknown",
        "customer_id": str(customer.id) if customer else None,
        "artifacts_count": artifacts_count,
    }


# ── Requests / Responses ──────────────────────────────────────────────────────

class ClaimCreate(BaseModel):
    policy_id: UUID
    claim_type: str  # Hospitalization, Surgery, Death Claim, Reimbursement
    submitted_amount: float = PydanticField(gt=0)
    incident_date: Optional[date] = None
    notes: Optional[str] = None


class ClaimStatusUpdate(BaseModel):
    status: ClaimStatusEnum
    notes: Optional[str] = None
    assigned_adjuster_id: Optional[UUID] = None


class ClaimAdjudicate(BaseModel):
    decision: str  # APPROVED, PARTIAL_APPROVAL, DECLINED, REFERRED_TO_MANAGER
    approved_amount: Optional[float] = 0.0
    notes: Optional[str] = None
    fraud_probability: Optional[float] = None
    duplicate_flag: Optional[bool] = None


class ClaimPayoutCreate(BaseModel):
    amount: float = PydanticField(gt=0)
    method: str = "Bank Transfer"
    reference_number: Optional[str] = None
    notes: Optional[str] = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("", status_code=201, summary="Create FNOL Claim")
async def create_claim(
    tenant_id: UUID,
    body: ClaimCreate,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    current_user = await _assert_claims_role(token, session)

    tenant = await session.get(Tenant, tenant_id)
    if tenant is None or not tenant.is_active:
        raise HTTPException(status_code=404, detail="Tenant not found or inactive")

    policy = await session.get(Policy, body.policy_id)
    if policy is None or policy.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Policy not found for this tenant")

    customer = await session.get(Customer, policy.customer_id)
    claim_num = await _generate_claim_number(session, tenant_id)

    # Simple AI risk scoring recommendation
    fraud_prob = 0.02
    duplicate_flag = False
    ai_rec = "AUTO_APPROVE" if body.submitted_amount <= 200000 else "REFER_TO_ADJUSTER"

    # Check for recent claims on same policy to flag duplicates
    existing_claims = (await session.exec(
        select(Claim).where(Claim.policy_id == policy.id, Claim.tenant_id == tenant_id)
    )).all()
    if len(existing_claims) > 0:
        for ec in existing_claims:
            if ec.claim_type == body.claim_type and abs(ec.submitted_amount - body.submitted_amount) < 1.0:
                duplicate_flag = True
                fraud_prob = 0.85
                ai_rec = "DUPLICATE_FLAGGED"

    # Open linkage case for SLA tracking
    case = Case(
        tenant_id=tenant_id,
        customer_id=policy.customer_id,
        policy_id=policy.id,
        caseNumber=f"CASE-{claim_num}",
        caseType=CaseTypeEnum.CLAIM,
        caseStatus=CaseStatusEnum.NEW,
        priorityLevel=CasePriorityEnum.HIGH if body.submitted_amount > 500000 else CasePriorityEnum.NORMAL,
        sourceChannel=SourceChannelEnum.PORTAL,
    )
    session.add(case)
    await session.flush()

    claim = Claim(
        tenant_id=tenant_id,
        policy_id=policy.id,
        case_id=case.caseld,
        claim_number=claim_num,
        claim_type=body.claim_type,
        submitted_amount=body.submitted_amount,
        approved_amount=0.0,
        status=ClaimStatusEnum.NEW,
        fraud_probability=fraud_prob,
        duplicate_flag=duplicate_flag,
        ai_recommendation=ai_rec,
        incident_date=body.incident_date or date.today(),
        reported_date=date.today(),
        assigned_adjuster_id=current_user.id,
    )
    session.add(claim)
    await session.flush()

    # Log initial status history
    history = ClaimStatusHistory(
        tenant_id=tenant_id,
        claim_id=claim.id,
        from_status=None,
        to_status=ClaimStatusEnum.NEW.value,
        actor_id=current_user.id,
        notes=body.notes or "FNOL intake completed and claim created.",
    )
    session.add(history)
    await session.commit()
    await session.refresh(claim)

    return _claim_dict(claim, policy, customer, current_user, 0)


@router.get("", summary="List Claims")
async def list_claims(
    tenant_id: UUID,
    status: Optional[str] = Query(None, description="Filter by status"),
    claim_type: Optional[str] = Query(None, description="Filter by claim type"),
    search: Optional[str] = Query(None, description="Search claim_number or claimant name"),
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _assert_claims_role(token, session)

    stmt = select(Claim).where(Claim.tenant_id == tenant_id).order_by(Claim.created_at.desc())
    if status and status != "ALL":
        stmt = stmt.where(Claim.status == status)
    if claim_type and claim_type != "ALL":
        stmt = stmt.where(Claim.claim_type == claim_type)

    claims = list((await session.exec(stmt)).all())

    results = []
    for c in claims:
        policy = await session.get(Policy, c.policy_id)
        customer = await session.get(Customer, policy.customer_id) if policy else None
        adjuster = await session.get(User, c.assigned_adjuster_id) if c.assigned_adjuster_id else None

        if search:
            q = search.lower()
            ref_match = c.claim_number and q in c.claim_number.lower()
            name_match = customer and q in customer.name.lower()
            pol_match = policy and policy.policy_number and q in policy.policy_number.lower()
            if not (ref_match or name_match or pol_match):
                continue

        art_count = len((await session.exec(select(Artifact).where(Artifact.claim_id == c.id))).all())
        results.append(_claim_dict(c, policy, customer, adjuster, art_count))

    return results


@router.get("/{claim_id}", summary="Get Claim Detail")
async def get_claim_detail(
    tenant_id: UUID,
    claim_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _assert_claims_role(token, session)

    claim = await session.get(Claim, claim_id)
    if claim is None or claim.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Claim not found")

    policy = await session.get(Policy, claim.policy_id)
    customer = await session.get(Customer, policy.customer_id) if policy else None
    adjuster = await session.get(User, claim.assigned_adjuster_id) if claim.assigned_adjuster_id else None

    # Load artifacts, status history, payouts
    artifacts = (await session.exec(select(Artifact).where(Artifact.claim_id == claim.id))).all()
    if claim.case_id:
        case_artifacts = (await session.exec(select(Artifact).where(Artifact.case_id == claim.case_id))).all()
        # Merge unique
        art_ids = {a.id for a in artifacts}
        for ca in case_artifacts:
            if ca.id not in art_ids:
                artifacts.append(ca)

    history_rows = (await session.exec(
        select(ClaimStatusHistory)
        .where(ClaimStatusHistory.claim_id == claim.id)
        .order_by(ClaimStatusHistory.created_at.desc())
    )).all()

    payout_rows = (await session.exec(
        select(ClaimPayout)
        .where(ClaimPayout.claim_id == claim.id)
        .order_by(ClaimPayout.created_at.desc())
    )).all()

    history_list = []
    for h in history_rows:
        actor = await session.get(User, h.actor_id) if h.actor_id else None
        history_list.append({
            "id": str(h.id),
            "from_status": h.from_status,
            "to_status": h.to_status,
            "actor_name": actor.full_name if actor else "System",
            "notes": h.notes,
            "created_at": h.created_at.isoformat(),
        })

    payout_list = [{
        "id": str(p.id),
        "amount": p.amount,
        "method": p.method,
        "status": p.status,
        "reference_number": p.reference_number,
        "initiated_at": p.initiated_at.isoformat(),
        "completed_at": p.completed_at.isoformat() if p.completed_at else None,
        "notes": p.notes,
    } for p in payout_rows]

    art_list = [{
        "id": str(a.id),
        "document_type": a.document_type,
        "file_name": a.file_name,
        "file_size": a.file_size,
        "file_type": a.file_type,
        "storage_url": a.storage_url,
        "status": a.status,
        "ocr_result": a.ocr_result,
        "created_at": a.created_at.isoformat(),
    } for a in artifacts]

    base = _claim_dict(claim, policy, customer, adjuster, len(artifacts))
    base["status_history"] = history_list
    base["payouts"] = payout_list
    base["artifacts"] = art_list

    return base


VALID_TRANSITIONS = {
    ClaimStatusEnum.NEW: {
        ClaimStatusEnum.TRIAGED,
        ClaimStatusEnum.UNDER_INVESTIGATION,
        ClaimStatusEnum.PENDING_DOCUMENTS,
    },
    ClaimStatusEnum.TRIAGED: {
        ClaimStatusEnum.UNDER_INVESTIGATION,
        ClaimStatusEnum.PENDING_DOCUMENTS,
        ClaimStatusEnum.REFERRED_TO_MANAGER,
        ClaimStatusEnum.DECLINED,
    },
    ClaimStatusEnum.PENDING_DOCUMENTS: {
        ClaimStatusEnum.UNDER_INVESTIGATION,
        ClaimStatusEnum.TRIAGED,
        ClaimStatusEnum.DECLINED,
    },
    ClaimStatusEnum.UNDER_INVESTIGATION: {
        ClaimStatusEnum.APPROVED,
        ClaimStatusEnum.PARTIAL_APPROVAL,
        ClaimStatusEnum.DECLINED,
        ClaimStatusEnum.PENDING_DOCUMENTS,
        ClaimStatusEnum.REFERRED_TO_MANAGER,
    },
    ClaimStatusEnum.REFERRED_TO_MANAGER: {
        ClaimStatusEnum.APPROVED,
        ClaimStatusEnum.PARTIAL_APPROVAL,
        ClaimStatusEnum.DECLINED,
        ClaimStatusEnum.UNDER_INVESTIGATION,
    },
    ClaimStatusEnum.APPROVED: {
        ClaimStatusEnum.SETTLED,
        ClaimStatusEnum.CLOSED,
    },
    ClaimStatusEnum.PARTIAL_APPROVAL: {
        ClaimStatusEnum.SETTLED,
        ClaimStatusEnum.CLOSED,
    },
    ClaimStatusEnum.DECLINED: {
        ClaimStatusEnum.CLOSED,
    },
    ClaimStatusEnum.SETTLED: {
        ClaimStatusEnum.CLOSED,
    },
    ClaimStatusEnum.CLOSED: set(),
}


@router.patch("/{claim_id}/status", summary="Update Claim Status")
async def update_claim_status(
    tenant_id: UUID,
    claim_id: UUID,
    body: ClaimStatusUpdate,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    current_user = await _assert_claims_role(token, session)

    claim = await session.get(Claim, claim_id)
    if claim is None or claim.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Claim not found")

    old_status = claim.status.value if hasattr(claim.status, "value") else str(claim.status)
    old_status_enum = claim.status if isinstance(claim.status, ClaimStatusEnum) else ClaimStatusEnum(claim.status)

    # 1. State Machine Sequence Enforcement
    allowed_next = VALID_TRANSITIONS.get(old_status_enum, set())
    if body.status not in allowed_next:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status transition from '{old_status_enum.value}' to '{body.status.value}'. Claims must follow formal insurance workflow sequence.",
        )

    # 2. Document Prerequisite Gate (Required for Approved, Partial Approval, or Settled)
    if body.status in (ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL, ClaimStatusEnum.SETTLED):
        if claim.case_id:
            art_stmt = select(Artifact).where((Artifact.claim_id == claim.id) | (Artifact.case_id == claim.case_id))
        else:
            art_stmt = select(Artifact).where(Artifact.claim_id == claim.id)
        art_count = len((await session.exec(art_stmt)).all())
        if art_count == 0:
            raise HTTPException(
                status_code=400,
                detail="Document Gate Error: Cannot transition claim to Approved or Settled without at least 1 verified claim document attached (e.g. Hospital Bill, Medical Report, CNIC).",
            )

    # 3. Payout Record Gate (Required for Settled)
    if body.status == ClaimStatusEnum.SETTLED:
        payouts = (await session.exec(select(ClaimPayout).where(ClaimPayout.claim_id == claim.id))).all()
        if len(payouts) == 0:
            raise HTTPException(
                status_code=400,
                detail="Payout Gate Error: Cannot mark claim as Settled without an issued disbursement payout record. Please use 'Issue Payout' first.",
            )

    # 4. Manager Escalation Gate (> 500k or REFERRED_TO_MANAGER)
    if body.status in (ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL) or old_status_enum == ClaimStatusEnum.REFERRED_TO_MANAGER:
        if old_status_enum == ClaimStatusEnum.REFERRED_TO_MANAGER or claim.submitted_amount > 500000:
            r_name = await _role_name(current_user, session)
            if r_name not in ("ClaimsManager", "Admin", "SuperAdmin"):
                raise HTTPException(
                    status_code=403,
                    detail=f"Manager Gate Error: Approving or settling high-value (> PKR 500,000) or manager-referred claims requires a ClaimsManager role (your role is {r_name}).",
                )

    claim.status = body.status

    if body.assigned_adjuster_id:
        claim.assigned_adjuster_id = body.assigned_adjuster_id

    if body.status in (ClaimStatusEnum.SETTLED, ClaimStatusEnum.CLOSED):
        claim.closed_at = datetime.utcnow()

    session.add(claim)

    history = ClaimStatusHistory(
        tenant_id=tenant_id,
        claim_id=claim.id,
        from_status=old_status,
        to_status=body.status.value,
        actor_id=current_user.id,
        notes=body.notes or f"Status updated to {body.status.value}",
    )
    session.add(history)
    await session.commit()
    await session.refresh(claim)

    policy = await session.get(Policy, claim.policy_id)
    customer = await session.get(Customer, policy.customer_id) if policy else None
    adjuster = await session.get(User, claim.assigned_adjuster_id) if claim.assigned_adjuster_id else None

    return _claim_dict(claim, policy, customer, adjuster, 0)


@router.post("/{claim_id}/adjudicate", summary="Adjudicate Claim Decision")
async def adjudicate_claim(
    tenant_id: UUID,
    claim_id: UUID,
    body: ClaimAdjudicate,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    current_user = await _assert_claims_role(token, session)

    claim = await session.get(Claim, claim_id)
    if claim is None or claim.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Claim not found")

    old_status = claim.status.value if hasattr(claim.status, "value") else str(claim.status)
    decision = body.decision.upper()

    if claim.case_id:
        adj_art_stmt = select(Artifact).where((Artifact.claim_id == claim.id) | (Artifact.case_id == claim.case_id))
    else:
        adj_art_stmt = select(Artifact).where(Artifact.claim_id == claim.id)
    art_count = len((await session.exec(adj_art_stmt)).all())
    if decision in ("APPROVED", "PARTIAL_APPROVAL") and art_count == 0:
        raise HTTPException(
            status_code=400,
            detail="Document Gate Error: Cannot approve claim decision without at least 1 verified claim document attached.",
        )

    # Duplicate Flag Override Note Requirement
    if claim.duplicate_flag and decision in ("APPROVED", "PARTIAL_APPROVAL"):
        if not body.notes or len(body.notes.strip()) < 15:
            raise HTTPException(
                status_code=400,
                detail="Duplicate Flag Override Error: Approving a duplicate-flagged claim requires detailed adjudicator rationale notes (minimum 15 characters).",
            )

    # Manager Escalation Gate for High Value / Referred
    if decision in ("APPROVED", "PARTIAL_APPROVAL") and (claim.submitted_amount > 500000 or claim.status == ClaimStatusEnum.REFERRED_TO_MANAGER):
        r_name = await _role_name(current_user, session)
        if r_name not in ("ClaimsManager", "Admin", "SuperAdmin"):
            raise HTTPException(
                status_code=403,
                detail=f"Manager Gate Error: Approving claims exceeding PKR 500,000 or referred to manager requires a ClaimsManager role (your role is {r_name}).",
            )

    if decision in ("APPROVED", "PARTIAL_APPROVAL"):
        app_amt = body.approved_amount if body.approved_amount else claim.submitted_amount
        if app_amt > claim.submitted_amount:
            raise HTTPException(
                status_code=400,
                detail=f"Validation Error: Approved amount (PKR {app_amt:,.2f}) cannot exceed the claimed amount (PKR {claim.submitted_amount:,.2f}).",
            )
        if app_amt <= 0:
            raise HTTPException(
                status_code=400,
                detail="Validation Error: Approved amount must be greater than 0.",
            )

    if decision == "APPROVED":
        claim.status = ClaimStatusEnum.APPROVED
        claim.approved_amount = body.approved_amount if body.approved_amount else claim.submitted_amount
    elif decision == "PARTIAL_APPROVAL":
        claim.status = ClaimStatusEnum.PARTIAL_APPROVAL
        claim.approved_amount = body.approved_amount if body.approved_amount else (claim.submitted_amount * 0.7)
    elif decision == "DECLINED":
        claim.status = ClaimStatusEnum.DECLINED
        claim.approved_amount = 0.0
    elif decision == "REFERRED_TO_MANAGER":
        claim.status = ClaimStatusEnum.REFERRED_TO_MANAGER
    else:
        raise HTTPException(status_code=400, detail=f"Invalid decision '{body.decision}'")

    if body.fraud_probability is not None:
        claim.fraud_probability = body.fraud_probability
    if body.duplicate_flag is not None:
        claim.duplicate_flag = body.duplicate_flag

    session.add(claim)

    history = ClaimStatusHistory(
        tenant_id=tenant_id,
        claim_id=claim.id,
        from_status=old_status,
        to_status=claim.status.value,
        actor_id=current_user.id,
        notes=body.notes or f"Adjudication decision: {decision}. Approved amount: PKR {claim.approved_amount:,.2f}",
    )
    session.add(history)
    await session.commit()
    await session.refresh(claim)

    policy = await session.get(Policy, claim.policy_id)
    customer = await session.get(Customer, policy.customer_id) if policy else None
    adjuster = await session.get(User, claim.assigned_adjuster_id) if claim.assigned_adjuster_id else None

    return _claim_dict(claim, policy, customer, adjuster, 0)


@router.post("/{claim_id}/payout", status_code=201, summary="Initiate Claim Disbursement Payout")
async def create_claim_payout(
    tenant_id: UUID,
    claim_id: UUID,
    body: ClaimPayoutCreate,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    current_user = await _assert_claims_role(token, session)

    claim = await session.get(Claim, claim_id)
    if claim is None or claim.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Claim not found")

    if claim.status not in (ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL):
        raise HTTPException(
            status_code=400,
            detail=f"Payout Gate Error: Payouts can only be issued for claims in 'Approved' or 'Partial Approval' status (current status is '{claim.status.value}').",
        )

    if claim.case_id:
        p_art_stmt = select(Artifact).where((Artifact.claim_id == claim.id) | (Artifact.case_id == claim.case_id))
    else:
        p_art_stmt = select(Artifact).where(Artifact.claim_id == claim.id)
    art_count = len((await session.exec(p_art_stmt)).all())
    if art_count == 0:
        raise HTTPException(
            status_code=400,
            detail="Document Gate Error: Cannot issue disbursement payout without at least 1 verified claim document attached.",
        )

    max_allowed = claim.approved_amount if claim.approved_amount > 0 else claim.submitted_amount
    if body.amount > max_allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Validation Error: Payout amount (PKR {body.amount:,.2f}) cannot exceed approved claim amount (PKR {max_allowed:,.2f}).",
        )
    if body.amount <= 0:
        raise HTTPException(
            status_code=400,
            detail="Validation Error: Payout amount must be greater than 0.",
        )

    payout = ClaimPayout(
        tenant_id=tenant_id,
        claim_id=claim.id,
        amount=body.amount,
        method=body.method,
        status="Settled",
        initiated_at=datetime.utcnow(),
        completed_at=datetime.utcnow(),
        reference_number=body.reference_number or f"PAY-{datetime.utcnow().strftime('%Y%m%d')}-{uuid4().hex[:6].upper()}",
        notes=body.notes,
    )
    session.add(payout)

    # Update claim settlement state
    old_status = claim.status.value if hasattr(claim.status, "value") else str(claim.status)
    claim.status = ClaimStatusEnum.SETTLED
    claim.settlement_amount = (claim.settlement_amount or 0.0) + body.amount
    claim.settled_at = datetime.utcnow()
    session.add(claim)

    history = ClaimStatusHistory(
        tenant_id=tenant_id,
        claim_id=claim.id,
        from_status=old_status,
        to_status=ClaimStatusEnum.SETTLED.value,
        actor_id=current_user.id,
        notes=f"Disbursement payout of PKR {body.amount:,.2f} initiated via {body.method}. Ref: {payout.reference_number}",
    )
    session.add(history)
    await session.commit()
    await session.refresh(payout)

    return {
        "id": str(payout.id),
        "claim_id": str(claim.id),
        "amount": payout.amount,
        "method": payout.method,
        "status": payout.status,
        "reference_number": payout.reference_number,
        "initiated_at": payout.initiated_at.isoformat(),
        "completed_at": payout.completed_at.isoformat() if payout.completed_at else None,
    }


@router.post("/{claim_id}/reinsurance-refer", summary="Refer Claim to Reinsurance for Recovery")
async def refer_claim_to_reinsurance(
    tenant_id: UUID,
    claim_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    current_user = await _assert_claims_role(token, session)

    claim = await session.get(Claim, claim_id)
    if claim is None or claim.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Claim not found")

    policy = await session.get(Policy, claim.policy_id)
    customer = await session.get(Customer, policy.customer_id) if policy else None

    # Check or create a reinsurance referral record
    referral = ReinsuranceReferral(
        tenant_id=tenant_id,
        policy_id=policy.id,
        customer_id=customer.id if customer else policy.customer_id,
        case_id=claim.case_id,
        referral_type=ReinsuranceReferralTypeEnum.FACULTATIVE,
        status=ReinsuranceReferralStatusEnum.SUBMITTED,
        total_sum_assured=policy.coverage_amount,
        retention_limit=5000000.0,
        retained_amount=5000000.0,
        treaty_ceded_amount=0.0,
        facultative_ceded_amount=max(0.0, policy.coverage_amount - 5000000.0),
        cession_pct=round((max(0.0, policy.coverage_amount - 5000000.0) / policy.coverage_amount) * 100, 2) if policy.coverage_amount else 0.0,
        submitted_at=datetime.utcnow(),
        submitted_by=current_user.email or str(current_user.id),
    )
    session.add(referral)
    await session.flush()

    old_status = claim.status.value if hasattr(claim.status, "value") else str(claim.status)
    claim.reinsurance_referral_id = referral.id
    claim.status = ClaimStatusEnum.REINSURANCE_REFERRED
    session.add(claim)

    history = ClaimStatusHistory(
        tenant_id=tenant_id,
        claim_id=claim.id,
        from_status=old_status,
        to_status=ClaimStatusEnum.REINSURANCE_REFERRED.value,
        actor_id=current_user.id,
        notes="Reinsurance recovery referral created for claim amount exceeding treaty retention.",
    )
    session.add(history)
    await session.commit()
    await session.refresh(claim)

    return {
        "claim_id": str(claim.id),
        "status": claim.status.value,
        "reinsurance_referral_id": str(referral.id),
    }
