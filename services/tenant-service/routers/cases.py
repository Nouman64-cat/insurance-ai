from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import selectinload
from sqlmodel.ext.asyncio.session import AsyncSession
from sqlmodel import select, delete
from typing import List, Literal, Optional
from uuid import UUID
from datetime import datetime

from database import get_session
from document_requirements import get_required_documents
from routers.auth import oauth2_scheme, _get_current_user, _role_name
from shared.models.core import (
    Customer,
    Artifact,
    Case,
    CaseHistory,
    CaseAssignment,
    CaseComment,
    CaseStatusEnum,
    CaseTypeEnum,
    ActionTypeEnum,
    CaseAuditTrail,
    AssignmentTypeEnum,
    AssignmentStatusEnum,
    Policy,
    PolicyStatusEnum,
    RiskAssessment,
    User,
    InsurancePlan,
)
from schemas import (
    CustomerRead,
    CaseCreate,
    CaseRead,
    CaseUpdate,
    CaseStatusUpdate,
    CaseAssignmentCreate,
    CaseCommentCreate,
    PolicyRead,
)
from shared.services.policy_state_machine import IllegalStateTransition, apply_transition

router = APIRouter(prefix="/tenants/{tenant_id}/cases", tags=["Cases"])

# Case decisions (Approved/Rejected) drive the linked Policy's status and are
# reserved for whoever is allowed to make an underwriting call; everything
# else about managing a case (opening it, moving it through review) is also
# something the submitting Agent can do. Mirrors the same split applied to
# the Proposal page's PATCH /quotes/{id} in api-gateway/routers/quote.py.
_CASE_DECISION_ROLES = {"Underwriter", "Admin", "SuperAdmin"}
_CASE_SUBMISSION_ROLES = {"Agent", "Underwriter", "Admin", "SuperAdmin"}

def generate_case_number() -> str:
    # Auto-generate CaseNumber: e.g., CASE-YYYY-XXXXXX
    import uuid
    random_hex = uuid.uuid4().hex[:6].upper()
    return f"CASE-{datetime.utcnow().year}-{random_hex}"

@router.post("", response_model=CaseRead, status_code=201)
async def create_case(
    tenant_id: UUID,
    body: CaseCreate,
    session: AsyncSession = Depends(get_session),
    token: str = Depends(oauth2_scheme),
):
    user = await _get_current_user(token, session)
    role_name = await _role_name(user, session)
    if role_name not in _CASE_SUBMISSION_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Opening a case requires one of: {', '.join(sorted(_CASE_SUBMISSION_ROLES))} (you are {role_name}).",
        )

    # If a policy is named, it must belong to this tenant + customer — a case
    # opens formal underwriting on one specific quote, not just any policy.
    policy: Optional[Policy] = None
    if body.policy_id is not None:
        policy = await session.get(Policy, body.policy_id)
        if not policy or policy.tenant_id != tenant_id or policy.customer_id != body.customer_id:
            raise HTTPException(status_code=404, detail="Policy not found for this customer.")
        
        # Prevent creating multiple cases for the same policy (of the same type)
        existing_case = (await session.execute(
            select(Case).where(
                Case.policy_id == body.policy_id, 
                Case.tenant_id == tenant_id,
                Case.caseType == body.caseType
            )
        )).scalars().first()
        if existing_case:
            return existing_case

    case = Case(
        tenant_id=tenant_id,
        customer_id=body.customer_id,
        policy_id=body.policy_id,
        caseNumber=generate_case_number(),
        caseType=body.caseType,
        caseStatus=CaseStatusEnum.NEW,
        priorityLevel=body.priorityLevel,
        sourceChannel=body.sourceChannel,
        assignedTeamld=body.assignedTeamld,
        assignedAgentId=body.assignedAgentId,
        createdAt=datetime.utcnow(),
        updatedAt=datetime.utcnow()
    )
    session.add(case)

    # Opening an Underwriting case on a quote moves it from indicative
    # ("Quoted") to formally in-flight ("Proposed") — the customer has
    # committed to this specific offer.
    if policy is not None and policy.status == PolicyStatusEnum.QUOTED:
        try:
            apply_transition(
                session, policy, PolicyStatusEnum.PROPOSED,
                event_type="case_opened", actor=str(user.id),
            )
        except IllegalStateTransition as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))

    await session.commit()
    await session.refresh(case)

    # Generate Audit Trail
    audit = CaseAuditTrail(
        caseld=case.caseld,
        actionPerformed="Created new case",
        entityChanged="Case",
        newValue=case.caseStatus,
        performedBy=user.id,
        timestamp=datetime.utcnow()
    )
    session.add(audit)
    await session.commit()

    return case


@router.get("", response_model=List[CaseRead])
async def list_cases(
    tenant_id: UUID,
    customer_id: UUID = Query(None, description="Filter by customer"),
    status: CaseStatusEnum = Query(None, description="Filter by status"),
    assigned_user: UUID = Query(None, description="Filter by assignee"),
    case_type: CaseTypeEnum = Query(None, description="Filter by case type"),
    segment: Optional[Literal["individual", "family", "organization"]] = Query(
        None, description="Filter by customer segment: individual | family | organization"
    ),
    session: AsyncSession = Depends(get_session)
):
    """Enriched case list — the data source for the Underwriting queue page.

    Distinct from GET /assessments (api-gateway): that endpoint lists AI
    RiskAssessment runs (an append-only evaluation log — a case can have
    several as it gets re-evaluated); this lists Cases (the work items an
    underwriter actually tracks — status, assignment, documents) enriched
    with just the *latest* assessment's headline numbers for at-a-glance
    triage.
    """
    stmt = select(Case).where(Case.tenant_id == tenant_id)
    if customer_id:
        stmt = stmt.where(Case.customer_id == customer_id)
    if status:
        stmt = stmt.where(Case.caseStatus == status)
    if assigned_user:
        stmt = stmt.where(Case.assignedAgentId == assigned_user)
    if case_type:
        stmt = stmt.where(Case.caseType == case_type)
    stmt = stmt.order_by(Case.createdAt.desc())

    cases = (await session.execute(stmt)).scalars().all()
    if not cases:
        return []

    customer_ids = list({c.customer_id for c in cases})
    customers = {
        a.id: a for a in (await session.execute(
            select(Customer).where(Customer.id.in_(customer_ids))
        )).scalars().all()
    }

    if segment:
        def _segment_of(customer: Optional[Customer]) -> str:
            if customer and customer.organization_id:
                return "organization"
            if customer and customer.family_group_id:
                return "family"
            return "individual"

        cases = [c for c in cases if _segment_of(customers.get(c.customer_id)) == segment]
        if not cases:
            return []

    policy_ids = list({c.policy_id for c in cases if c.policy_id})
    policies = {}
    if policy_ids:
        policies = {
            p.id: p for p in (await session.execute(
                select(Policy).where(Policy.id.in_(policy_ids))
            )).scalars().all()
        }

    # Latest assessment per case — assessments ordered newest-first, so the
    # first one seen per case_id in this loop is the latest.
    case_ids = [c.caseld for c in cases]
    assessments_stmt = (
        select(RiskAssessment)
        .where(RiskAssessment.case_id.in_(case_ids))
        .order_by(RiskAssessment.created_at.desc())
    )
    latest_by_case: dict = {}
    for a in (await session.execute(assessments_stmt)).scalars().all():
        latest_by_case.setdefault(a.case_id, a)

    # Pre-Underwriting status — E-Application / Agent's Confidential Report,
    # bulk-fetched by case_id like everything else above (avoids N+1 on the queue).
    from shared.models.core import AgentConfidentialReport, CustomerEApplication, InitialPremiumPayment
    e_app_status_by_case = {
        row[0]: row[1] for row in (await session.execute(
            select(CustomerEApplication.case_id, CustomerEApplication.status)
            .where(CustomerEApplication.case_id.in_(case_ids))
        )).all()
    }
    acr_status_by_case = {
        row[0]: row[1] for row in (await session.execute(
            select(AgentConfidentialReport.case_id, AgentConfidentialReport.status)
            .where(AgentConfidentialReport.case_id.in_(case_ids))
        )).all()
    }
    ipp_status_by_case = {
        row[0]: row[1] for row in (await session.execute(
            select(InitialPremiumPayment.case_id, InitialPremiumPayment.status)
            .where(InitialPremiumPayment.case_id.in_(case_ids))
        )).all()
    }

    # Fetch Family groups to include the true group name
    family_group_ids = list({c.family_group_id for c in customers.values() if c.family_group_id})
    family_groups = {}
    if family_group_ids:
        from shared.models.core import FamilyGroup
        family_groups = {
            f.id: f for f in (await session.execute(
                select(FamilyGroup).where(FamilyGroup.id.in_(family_group_ids))
            )).scalars().all()
        }

    out = []
    for c in cases:
        customer = customers.get(c.customer_id)
        policy = policies.get(c.policy_id) if c.policy_id else None
        latest = latest_by_case.get(c.caseld)
        row = CaseRead.model_validate(c).model_dump()
        row["customer_name"] = customer.name if customer else None
        row["customer_cnic"] = customer.cnic if customer else None
        if customer and customer.organization_id:
            row["customer_segment"] = "organization"
            row["organization_id"] = str(customer.organization_id)
        elif customer and customer.family_group_id:
            row["customer_segment"] = "family"
            row["family_group_id"] = str(customer.family_group_id)
            if customer.family_group_id in family_groups:
                row["family_group_name"] = family_groups[customer.family_group_id].name
        else:
            row["customer_segment"] = "individual"
        row["product_name"] = policy.product_name if policy else None
        row["coverage_amount"] = policy.coverage_amount if policy else None
        row["latest_ai_decision"] = latest.ai_decision.value if latest else None
        row["latest_composite_score"] = latest.composite_risk_score if latest else None
        e_app_status = e_app_status_by_case.get(c.caseld)
        row["e_application_status"] = e_app_status.value if e_app_status else "NotSent"
        acr_status = acr_status_by_case.get(c.caseld)
        row["acr_status"] = acr_status.value if acr_status else "NotStarted"
        ipp_status = ipp_status_by_case.get(c.caseld)
        row["ipp_status"] = ipp_status.value if ipp_status else "NotStarted"
        out.append(row)
    return out


@router.get("/{case_id}", response_model=CaseRead)
async def get_case(tenant_id: UUID, case_id: UUID, session: AsyncSession = Depends(get_session)):
    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    result = await session.execute(stmt)
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


@router.get("/{case_id}/detail")
async def get_case_detail(
    tenant_id: UUID,
    case_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    """Bundled Case 360 view: case + customer + policy + document checklist +
    latest risk assessment, in one round trip — the data source for the
    frontend's single-page underwriting workbench (case/[id])."""
    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    case = (await session.execute(stmt)).scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")

    customer_res = await session.execute(
        select(Customer)
        .where(Customer.id == case.customer_id)
        .options(selectinload(Customer.acquisition_source))
    )
    customer = customer_res.scalar_one_or_none()

    # Prefer the case's explicitly linked policy; fall back to the
    # customer's most recent policy for cases created before policy_id
    # existed (same fallback document-checklist already uses).
    policy: Optional[Policy] = None
    if case.policy_id is not None:
        policy = await session.get(Policy, case.policy_id)
    if policy is None:
        policy_stmt = (
            select(Policy)
            .where(Policy.tenant_id == tenant_id, Policy.customer_id == case.customer_id)
            .order_by(Policy.created_at.desc())
        )
        policy = (await session.execute(policy_stmt)).scalars().first()

    insurance_type = policy.insurance_type.value if policy else None

    required = None
    if case.caseType.value == "Underwriting" and policy:
        plan_stmt = select(InsurancePlan).where(
            InsurancePlan.tenant_id == tenant_id,
            InsurancePlan.insurance_type == policy.insurance_type,
            InsurancePlan.label == policy.product_name
        )
        plan = (await session.execute(plan_stmt)).scalars().first()
        if plan:
            required = plan.required_documents

    if required is None:
        required = get_required_documents(insurance_type, case.caseType.value)

    artifacts_stmt = select(Artifact.document_type).where(Artifact.customer_id == case.customer_id, Artifact.tenant_id == tenant_id)
    received = sorted({row[0] for row in (await session.execute(artifacts_stmt)).all()})
    missing = [doc for doc in required if doc not in received]

    assessments_stmt = (
        select(RiskAssessment)
        .where(RiskAssessment.tenant_id == tenant_id, RiskAssessment.case_id == case_id)
        .order_by(RiskAssessment.created_at.desc())
    )
    assessments = (await session.execute(assessments_stmt)).scalars().all()
    latest = assessments[0] if assessments else None

    principal_participant_name = None
    is_principal_participant = False
    family_relationship = None

    if customer and customer.family_group_id:
        family_relationship = customer.family_relationship.value if customer.family_relationship else None
        from shared.models.core import FamilyGroup
        family_group = await session.get(FamilyGroup, customer.family_group_id)
        if family_group and family_group.primary_member_customer_id:
            if family_group.primary_member_customer_id == customer.id:
                is_principal_participant = True
            else:
                pp = await session.get(Customer, family_group.primary_member_customer_id)
                if pp:
                    principal_participant_name = pp.name
                    
    family_members: List[dict] = []
    if customer and customer.family_group_id:
        family_peers = (await session.execute(
            select(Customer).where(
                Customer.tenant_id == tenant_id,
                Customer.family_group_id == customer.family_group_id,
            )
        )).scalars().all()
        family_peer_ids = [p.id for p in family_peers]
        
        latest_case_by_family_customer: dict = {}
        if family_peer_ids:
            family_peer_cases = (await session.execute(
                select(Case)
                .where(Case.tenant_id == tenant_id, Case.customer_id.in_(family_peer_ids))
                .order_by(Case.createdAt.desc())
            )).scalars().all()
            for c in family_peer_cases:
                latest_case_by_family_customer.setdefault(c.customer_id, c)
                
        for p in family_peers:
            peer_case = latest_case_by_family_customer.get(p.id)
            if not peer_case:
                continue
            family_members.append({
                "customer_id": str(p.id),
                "name": p.name,
                "cnic": p.cnic,
                "case_id": str(peer_case.caseld),
                "case_number": peer_case.caseNumber,
                "case_status": peer_case.caseStatus.value,
                "is_current": peer_case.caseld == case.caseld,
            })

    organization_name = None
    organization_members: List[dict] = []

    if customer and customer.organization_id:
        from shared.models.core import Organization
        org = await session.get(Organization, customer.organization_id)
        organization_name = org.name if org else None

        peers = (await session.execute(
            select(Customer).where(
                Customer.tenant_id == tenant_id,
                Customer.organization_id == customer.organization_id,
            )
        )).scalars().all()
        peer_ids = [p.id for p in peers]

        # Guaranteed-issue employees (at/under the Free Cover Limit) never get
        # a Case, so only peers routed through underwriting show up here —
        # this list powers the "switch to another member of this company"
        # dropdown on the case page, and there's nothing to switch *to* for
        # a peer without a case.
        latest_case_by_customer: dict = {}
        if peer_ids:
            peer_cases = (await session.execute(
                select(Case)
                .where(Case.tenant_id == tenant_id, Case.customer_id.in_(peer_ids))
                .order_by(Case.createdAt.desc())
            )).scalars().all()
            for c in peer_cases:
                latest_case_by_customer.setdefault(c.customer_id, c)

        for p in peers:
            peer_case = latest_case_by_customer.get(p.id)
            if not peer_case:
                continue
            organization_members.append({
                "customer_id": str(p.id),
                "name": p.name,
                "cnic": p.cnic,
                "case_id": str(peer_case.caseld),
                "case_number": peer_case.caseNumber,
                "case_status": peer_case.caseStatus.value,
                "is_current": peer_case.caseld == case.caseld,
            })

    return {
        "case": CaseRead.model_validate(case),
        "customer": CustomerRead.model_validate(customer) if customer else None,
        "principal_participant_name": principal_participant_name,
        "is_principal_participant": is_principal_participant,
        "family_relationship": family_relationship,
        "family_members": family_members,
        "organization_name": organization_name,
        "organization_members": organization_members,
        "policy": PolicyRead.model_validate(policy) if policy else None,
        "document_checklist": {
            "insurance_type": insurance_type,
            "required": required,
            "received": received,
            "missing": missing,
        },
        "latest_assessment": (
            {
                "id": str(latest.id),
                "medical_score": latest.medical_score,
                "financial_score": latest.financial_score,
                "fraud_probability": latest.fraud_probability,
                "composite_risk_score": latest.composite_risk_score,
                "ai_decision": latest.ai_decision.value,
                "suggested_loading": latest.suggested_loading,
                "reasons": latest.reasons or [],
                "medical_reasons": latest.medical_reasons or [],
                "financial_reasons": latest.financial_reasons or [],
                "fraud_reasons": latest.fraud_reasons or [],
                "ai_summary": latest.ai_summary,
                "created_at": latest.created_at.isoformat(),
            }
            if latest else None
        ),
        "assessments_count": len(assessments),
    }


@router.put("/{case_id}", response_model=CaseRead)
async def update_case(
    tenant_id: UUID,
    case_id: UUID,
    body: CaseUpdate,
    session: AsyncSession = Depends(get_session)
):
    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    result = await session.execute(stmt)
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    
    update_data = body.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(case, key, value)
        
    case.updatedAt = datetime.utcnow()
    session.add(case)
    await session.commit()
    await session.refresh(case)
    return case


@router.delete("/{case_id}", status_code=204)
async def delete_case(
    tenant_id: UUID,
    case_id: UUID,
    session: AsyncSession = Depends(get_session)
):
    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    result = await session.execute(stmt)
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    
    # Delete all child dependencies manually to avoid NotNullViolationError
    await session.execute(delete(CaseHistory).where(CaseHistory.caseld == case_id))
    await session.execute(delete(CaseAuditTrail).where(CaseAuditTrail.caseld == case_id))
    await session.execute(delete(CaseComment).where(CaseComment.caseld == case_id))
    await session.execute(delete(CaseAssignment).where(CaseAssignment.caseld == case_id))
    await session.execute(delete(RiskAssessment).where(RiskAssessment.case_id == case_id))
    await session.execute(delete(Artifact).where(Artifact.case_id == case_id))
    
    await session.delete(case)
    await session.commit()
    return None


@router.patch("/{case_id}/status", response_model=CaseRead)
async def update_case_status(
    tenant_id: UUID,
    case_id: UUID,
    body: CaseStatusUpdate,
    session: AsyncSession = Depends(get_session),
    token: str = Depends(oauth2_scheme),
):
    user = await _get_current_user(token, session)
    role_name = await _role_name(user, session)

    is_decision = body.status in (CaseStatusEnum.APPROVED, CaseStatusEnum.REJECTED)
    required_roles = _CASE_DECISION_ROLES if is_decision else _CASE_SUBMISSION_ROLES
    if role_name not in required_roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Setting case status to '{body.status.value}' requires one of: {', '.join(sorted(required_roles))} (you are {role_name}).",
        )

    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    result = await session.execute(stmt)
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")

    old_status = case.caseStatus
    case.caseStatus = body.status
    case.updatedAt = datetime.utcnow()

    history = CaseHistory(
        caseld=case.caseld,
        actionType=ActionTypeEnum.STATUS_CHANGE,
        fromStatus=old_status,
        toStatus=case.caseStatus,
        changedBy=user.id,
        changeTimestamp=datetime.utcnow()
    )
    session.add(history)
    session.add(case)

    # A case decision (Approved/Rejected) drives the linked Policy's own
    # lifecycle status — this is the *only* legitimate place a proposal
    # reaches Approved/Declined; the Proposal page's PATCH /quotes/{id}
    # (api-gateway/routers/quote.py) no longer allows jumping there directly.
    if case.caseStatus in (CaseStatusEnum.APPROVED, CaseStatusEnum.REJECTED):
        policy_to_update = None
        if case.policy_id:
            policy_to_update = await session.get(Policy, case.policy_id)
        if not policy_to_update:
            # Fallback: find the most-recent non-issued policy for THIS specific
            # customer only. Explicitly exclude already-Active/Issued policies so
            # we never accidentally link this case to an already-bound contract.
            from sqlalchemy import cast, String as SAString
            _excluded = [
                "ACTIVE", "Active", "ISSUED", "Issued",
                "LAPSED", "Lapsed", "CANCELLED", "Cancelled",
                "DECLINED", "Declined",
            ]
            policy_stmt = (
                select(Policy)
                .where(
                    Policy.tenant_id == tenant_id,
                    Policy.customer_id == case.customer_id,
                    cast(Policy.status, SAString).notin_(_excluded),
                )
                .order_by(Policy.created_at.desc())
            )
            policy_to_update = (await session.execute(policy_stmt)).scalars().first()
            # Stitch the case → policy FK so the issuance endpoint can find this
            # case when it closes all APPROVED cases after issuing the policy.
            if policy_to_update and case.policy_id is None:
                case.policy_id = policy_to_update.id
                session.add(case)
                
                # If it was still Quoted (because the case wasn't explicitly created against it),
                # move it to Proposed now so it can legally transition to Approved/Declined.
                st_early = policy_to_update.status.value if hasattr(policy_to_update.status, "value") else str(policy_to_update.status)
                if st_early == PolicyStatusEnum.QUOTED.value:
                    apply_transition(
                        session, policy_to_update, PolicyStatusEnum.PROPOSED,
                        event_type="case_linked_retroactively", actor=str(user.id)
                    )

        if policy_to_update:
            target_status = (
                PolicyStatusEnum.APPROVED if case.caseStatus == CaseStatusEnum.APPROVED
                else PolicyStatusEnum.DECLINED
            )
            st_val = policy_to_update.status.value if hasattr(policy_to_update.status, "value") else str(policy_to_update.status)
            if st_val.upper() in ("ACTIVE", "ISSUED"):
                raise HTTPException(400, "Cannot decide this case: the associated policy is already Active/Issued.")
            # Idempotent no-op if the policy is already in the target status — the
            # AI's auto-decision (routers/evaluate.py) may have already applied it
            # before an underwriter's manual "Override: Approve/Decline" click
            # lands, and re-asserting the same status is not a real transition.
            if st_val != target_status.value:
                try:
                    apply_transition(
                        session, policy_to_update, target_status,
                        event_type="case_decision", actor=str(user.id),
                    )
                except IllegalStateTransition as exc:
                    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))

        # NOTE: Do NOT promote customer to POLICYHOLDER here.
        # A customer only becomes a policyholder when the policy is actually
        # issued and goes Active. Promoting at Approved is premature and causes
        # them to appear on the Policyholders page before coverage exists.
        # This transition is handled in routers/policies.py → issue_policy().

    await session.commit()
    await session.refresh(case)

    return case


@router.post("/{case_id}/assignments", status_code=201)
async def assign_case(
    tenant_id: UUID,
    case_id: UUID,
    body: CaseAssignmentCreate,
    session: AsyncSession = Depends(get_session)
):
    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    result = await session.execute(stmt)
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    
    case.assignedAgentId = body.assignedToUserld
    case.updatedAt = datetime.utcnow()

    assignment = CaseAssignment(
        caseld=case.caseld,
        assignedToUserld=body.assignedToUserld,
        assignedRole=body.assignedRole,
        assignmentType=AssignmentTypeEnum.PRIMARY,
        assignmentStatus=AssignmentStatusEnum.ACTIVE,
        assignedAt=datetime.utcnow()
    )
    session.add(assignment)
    session.add(case)
    await session.commit()
    
    return {"status": "assigned"}


@router.get("/{case_id}/document-checklist")
async def get_document_checklist(
    tenant_id: UUID,
    case_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    result = await session.execute(stmt)
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")

    policy: Optional[Policy] = None
    if case.policy_id is not None:
        policy = await session.get(Policy, case.policy_id)
    if policy is None:
        policy_stmt = (
            select(Policy)
            .where(Policy.tenant_id == tenant_id, Policy.customer_id == case.customer_id)
            .order_by(Policy.created_at.desc())
        )
        policy = (await session.execute(policy_stmt)).scalars().first()
        
    insurance_type = policy.insurance_type.value if policy else None

    required = None
    if case.caseType.value == "Underwriting" and policy:
        plan_stmt = select(InsurancePlan).where(
            InsurancePlan.tenant_id == tenant_id,
            InsurancePlan.insurance_type == policy.insurance_type,
            InsurancePlan.label == policy.product_name
        )
        plan = (await session.execute(plan_stmt)).scalars().first()
        if plan:
            required = plan.required_documents

    if required is None:
        required = get_required_documents(insurance_type, case.caseType.value)


    artifacts_stmt = select(Artifact.document_type).where(Artifact.customer_id == case.customer_id, Artifact.tenant_id == tenant_id)
    received = sorted({row[0] for row in (await session.execute(artifacts_stmt)).all()})

    missing = [doc for doc in required if doc not in received]

    return {
        "insurance_type": insurance_type,
        "case_type": case.caseType.value,
        "required": required,
        "received": received,
        "missing": missing,
    }


@router.post("/{case_id}/comments", status_code=201)
async def add_case_comment(
    tenant_id: UUID,
    case_id: UUID,
    body: CaseCommentCreate,
    session: AsyncSession = Depends(get_session)
):
    user = (await session.execute(select(User).where(User.tenant_id == tenant_id))).scalars().first()
    if not user:
        raise HTTPException(status_code=400, detail="Tenant has no users.")

    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    result = await session.execute(stmt)
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    
    comment = CaseComment(
        caseld=case.caseld,
        authorld=user.id,
        commentText=body.commentText,
        commentType=body.commentType,
        visibilityLevel=body.visibilityLevel,
        createdAt=datetime.utcnow()
    )
    session.add(comment)
    await session.commit()
    
    return {"status": "comment added"}
