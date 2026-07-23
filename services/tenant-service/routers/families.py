import asyncio
import logging
from datetime import date, timedelta
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from decision_status import DECISION_CASE_STATUS, DECISION_POLICY_STATUS, most_conservative_decision
from family_underwriting import (
    age_from_dob,
    eldest_age,
    normalize_cnic,
    validate_family_members,
    validate_life_bundle_members as validate_life_bundle_member_fields,
)
from risk_client import evaluate_group_member
from routers.cases import generate_case_number
from schemas import (
    FamilyConfirmResponse,
    FamilyGroupCreate,
    FamilyGroupUpdate,
    FamilyGroupRead,
    FamilyMembersRequest,
    FamilyMemberOutcome,
    FamilyPolicyRead,
    FamilyStatsRead,
    FamilyValidationResponse,
    FloaterPolicyCreate,
    LifeBundlePolicyCreate,
)
from shared.models.core import (
    ActionTypeEnum,
    AIDecision,
    Artifact,
    Case,
    CaseAssignment,
    CaseAttachment,
    CaseAuditTrail,
    CaseComment,
    CaseEscalation,
    CaseHistory,
    CasePriorityEnum,
    CaseStatusEnum,
    CaseTypeEnum,
    CaseWorkflow,
    Claim,
    Customer,
    FamilyGroup,
    FamilyPlanTypeEnum,
    FamilyPolicy,
    FamilyRelationshipEnum,
    InsurancePlan,
    InsuranceTypeEnum,
    Policy,
    PolicyStatusEnum,
    PremiumQuote,
    RiskAssessment,
    SourceChannelEnum,
    Tenant,
    User,
)
from shared.pricing.calculator import calculate_premium
from routers.users import verify_admin   # reuse existing Admin guard — tenant-scoped for Admin, cross-tenant for SuperAdmin

logger = logging.getLogger("tenant-service.families")

router = APIRouter(prefix="/tenants", tags=["Families"])

# Used only if a tenant has no "FAMILY_FLOATER" InsurancePlan catalog row —
# rather than failing enrollment outright, price at a conservative
# placeholder rate. Same reasoning as organizations.py's _FALLBACK_GROUP_RATE.
_FALLBACK_FLOATER_RATE = 4.0   # PKR per 1,000 sum assured per year
_RISK_ENGINE_CONCURRENCY = 5   # families are <=8 members — generous headroom


def _verify_tenant(tenant: Tenant | None, tenant_id: UUID) -> Tenant:
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Tenant '{tenant_id}' not found.")
    return tenant


async def _get_family_group(tenant_id: UUID, family_id: UUID, session: AsyncSession) -> FamilyGroup:
    fg = await session.get(FamilyGroup, family_id)
    if not fg or fg.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Family group not found.")
    return fg


FamilyCategory = Literal["active", "in_progress", "new"]


async def _member_counts(tenant_id: UUID, session: AsyncSession) -> Dict[UUID, int]:
    rows = (await session.execute(
        select(Customer.family_group_id, func.count())
        .where(Customer.tenant_id == tenant_id, Customer.family_group_id.is_not(None))
        .group_by(Customer.family_group_id)
    )).all()
    return {fid: cnt for fid, cnt in rows}


async def _family_policy_status_map(tenant_id: UUID, session: AsyncSession) -> Dict[UUID, str]:
    """One representative status per family group — "Active" wins if any family
    policy has cleared setup, otherwise the first non-Active status seen (in
    practice just "Pending", the only other value any endpoint writes today)."""
    rows = (await session.execute(
        select(FamilyPolicy.family_group_id, FamilyPolicy.status)
        .where(FamilyPolicy.tenant_id == tenant_id)
    )).all()
    status_map: Dict[UUID, str] = {}
    for fid, fp_status in rows:
        if status_map.get(fid) == "Active":
            continue
        status_map[fid] = fp_status
    return status_map


def _family_category(dto: FamilyGroupRead) -> FamilyCategory:
    if dto.family_policy_status == "Active":
        return "active"
    if dto.family_policy_status or dto.member_count > 0:
        return "in_progress"
    return "new"


async def _enrich_families(tenant_id: UUID, groups: List[FamilyGroup], session: AsyncSession) -> List[FamilyGroupRead]:
    member_counts = await _member_counts(tenant_id, session)
    policy_status = await _family_policy_status_map(tenant_id, session)
    results = []
    for fg in groups:
        dto = FamilyGroupRead.model_validate(fg)
        dto.member_count = member_counts.get(fg.id, 0)
        dto.family_policy_status = policy_status.get(fg.id)
        results.append(dto)
    return results


async def _get_family_policy(
    tenant_id: UUID, family_id: UUID, fp_id: UUID, expected_type: FamilyPlanTypeEnum, session: AsyncSession
) -> FamilyPolicy:
    fp = await session.get(FamilyPolicy, fp_id)
    if not fp or fp.tenant_id != tenant_id or fp.family_group_id != family_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Family policy not found.")
    if fp.plan_type != expected_type:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Family policy '{fp_id}' is a {fp.plan_type.value} policy, not {expected_type.value}.",
        )
    return fp


def _relationship_enum(raw: str) -> FamilyRelationshipEnum:
    return FamilyRelationshipEnum(raw)


async def _get_or_create_member_customer(
    session: AsyncSession,
    tenant_id: UUID,
    family_id: UUID,
    row: Dict[str, Any],
    dob: date,
    declared_income: float,
) -> Customer:
    """Look up a member row's CNIC against Customer.cnic (unique per tenant,
    not per family — see the UniqueConstraint on Customer) and reuse the
    existing row if found, rather than always inserting a new one.

    Necessary, not just an optimization: a family member enrolled in one
    FamilyPolicy (say, the floater) legitimately needs to appear again when
    confirming a second FamilyPolicy for the same family (the life bundle) —
    the per-policy duplicate check in family_underwriting.py already allows
    this, but a naive `Customer(cnic=...)` insert on the second confirm would
    still hit the tenant+cnic unique constraint. Rejects a CNIC that belongs
    to a different family or to a corporate organization's employee roster.
    """
    cnic = normalize_cnic(row["cnic"]) or row["cnic"]
    existing = (await session.exec(
        select(Customer).where(Customer.tenant_id == tenant_id, Customer.cnic == cnic)
    )).first()

    if existing is None:
        customer = Customer(
            tenant_id=tenant_id,
            family_group_id=family_id,
            cnic=cnic,
            name=row["name"],
            dob=dob,
            gender=row["gender"],
            occupation=row["occupation"],
            declared_income=declared_income,
            family_relationship=_relationship_enum(row["relationship"]),
            is_smoker=bool(row.get("is_smoker", False)),
            height_cm=float(row.get("height_cm", 170)),
            weight_kg=float(row.get("weight_kg", 70)),
            # Optional rich profile (address/contact/medical/lifestyle/financial/
            # beneficiary modules) — same `details` shape the individual Customer
            # "Full Customer Entry" form captures. Absent on a quick roster add;
            # filled in later via PUT /customers/{id} from the family member's
            # "Full Details" editor, same endpoint individual customers use.
            details=row.get("details"),
        )
        session.add(customer)
        await session.flush()
        return customer

    if existing.organization_id is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"CNIC '{cnic}' already belongs to a corporate organization's employee roster.",
        )
    if existing.family_group_id is not None and existing.family_group_id != family_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"CNIC '{cnic}' already belongs to a different family group.",
        )

    existing.family_group_id = family_id
    existing.family_relationship = _relationship_enum(row["relationship"])
    if row.get("details"):
        existing.details = row["details"]
    session.add(existing)
    await session.flush()
    return existing


# ── Family groups ────────────────────────────────────────────────────────────────

@router.post(
    "/{tenant_id}/families",
    response_model=FamilyGroupRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_family_group(
    tenant_id: UUID,
    body: FamilyGroupCreate,
    session: AsyncSession = Depends(get_session),
) -> FamilyGroup:
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)

    fg = FamilyGroup(tenant_id=tenant_id, **body.model_dump())
    session.add(fg)
    await session.commit()
    await session.refresh(fg)
    return fg


@router.get(
    "/{tenant_id}/families",
    response_model=List[FamilyGroupRead],
    dependencies=[Depends(verify_admin)],
)
async def list_family_groups(
    tenant_id: UUID,
    search: Optional[str] = Query(None, description="Matches name or contact person"),
    category: Optional[FamilyCategory] = Query(None, description="active | in_progress | new"),
    branch_id: Optional[UUID] = None,
    assigned_agent_id: Optional[UUID] = None,
    city: Optional[str] = None,
    province: Optional[str] = None,
    created_from: Optional[date] = None,
    created_to: Optional[date] = None,
    session: AsyncSession = Depends(get_session),
):
    query = select(FamilyGroup).where(FamilyGroup.tenant_id == tenant_id)
    term = (search or "").strip()
    if term:
        like = f"%{term}%"
        query = query.where(or_(FamilyGroup.name.ilike(like), FamilyGroup.contact_person.ilike(like)))
    if branch_id:
        query = query.where(FamilyGroup.branch_id == branch_id)
    if assigned_agent_id:
        query = query.where(FamilyGroup.assigned_agent_id == assigned_agent_id)
    if city:
        query = query.where(FamilyGroup.city.ilike(f"%{city}%"))
    if province:
        query = query.where(FamilyGroup.province.ilike(f"%{province}%"))
    if created_from:
        query = query.where(FamilyGroup.created_at >= created_from)
    if created_to:
        query = query.where(FamilyGroup.created_at < created_to + timedelta(days=1))
    query = query.order_by(FamilyGroup.created_at.desc())
    groups = list((await session.exec(query)).all())

    results = await _enrich_families(tenant_id, groups, session)
    if category:
        results = [dto for dto in results if _family_category(dto) == category]
    return results


@router.get(
    "/{tenant_id}/families/stats",
    response_model=FamilyStatsRead,
    dependencies=[Depends(verify_admin)],
)
async def get_family_stats(tenant_id: UUID, session: AsyncSession = Depends(get_session)):
    groups = list((await session.exec(select(FamilyGroup).where(FamilyGroup.tenant_id == tenant_id))).all())
    enriched = await _enrich_families(tenant_id, groups, session)
    active = sum(1 for dto in enriched if _family_category(dto) == "active")
    in_progress = sum(1 for dto in enriched if _family_category(dto) == "in_progress")
    return FamilyStatsRead(
        total_families=len(enriched),
        active=active,
        in_progress=in_progress,
        new_no_members=len(enriched) - active - in_progress,
    )


@router.get(
    "/{tenant_id}/families/{family_id}",
    response_model=FamilyGroupRead,
    dependencies=[Depends(verify_admin)],
)
async def get_family_group(tenant_id: UUID, family_id: UUID, session: AsyncSession = Depends(get_session)):
    fg = await _get_family_group(tenant_id, family_id, session)
    return (await _enrich_families(tenant_id, [fg], session))[0]


@router.patch(
    "/{tenant_id}/families/{family_id}",
    response_model=FamilyGroupRead,
    dependencies=[Depends(verify_admin)],
)
async def update_family_group(
    tenant_id: UUID,
    family_id: UUID,
    body: FamilyGroupUpdate,
    session: AsyncSession = Depends(get_session)
):
    fg = await _get_family_group(tenant_id, family_id, session)
    update_data = body.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(fg, key, value)
    
    session.add(fg)
    await session.commit()
    await session.refresh(fg)
    return fg


@router.delete(
    "/{tenant_id}/families/{family_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_family_group(
    tenant_id: UUID,
    family_id: UUID,
    session: AsyncSession = Depends(get_session)
):
    fg = await _get_family_group(tenant_id, family_id, session)
    
    # Nullify the primary member reference to avoid foreign key violation when deleting the customer
    fg.primary_member_customer_id = None
    session.add(fg)
    await session.flush()
    
    # Cascade delete family policies
    family_policies = await session.exec(select(FamilyPolicy).where(FamilyPolicy.family_group_id == family_id))
    for fp in family_policies.all():
        await session.delete(fp)
        
    # Cascade delete members (customers) and their dependencies
    members = await session.exec(select(Customer).where(Customer.family_group_id == family_id))
    for customer in members.all():
        artifacts = await session.exec(select(Artifact).where(Artifact.customer_id == customer.id))
        for a in artifacts.all(): await session.delete(a)
        
        assessments = await session.exec(select(RiskAssessment).where(RiskAssessment.customer_id == customer.id))
        for a in assessments.all(): await session.delete(a)

        policies = await session.exec(select(Policy).where(Policy.customer_id == customer.id))
        for policy in policies.all():
            cases = await session.exec(select(Case).where(Case.policy_id == policy.id))
            for case in cases.all():
                for h in (await session.exec(select(CaseHistory).where(CaseHistory.caseld == case.caseld))).all(): await session.delete(h)
                for w in (await session.exec(select(CaseWorkflow).where(CaseWorkflow.caseld == case.caseld))).all(): await session.delete(w)
                for a in (await session.exec(select(CaseAssignment).where(CaseAssignment.caseld == case.caseld))).all(): await session.delete(a)
                for e in (await session.exec(select(CaseEscalation).where(CaseEscalation.caseld == case.caseld))).all(): await session.delete(e)
                for c in (await session.exec(select(CaseComment).where(CaseComment.caseld == case.caseld))).all(): await session.delete(c)
                for att in (await session.exec(select(CaseAttachment).where(CaseAttachment.caseld == case.caseld))).all(): await session.delete(att)
                for audit in (await session.exec(select(CaseAuditTrail).where(CaseAuditTrail.caseld == case.caseld))).all(): await session.delete(audit)
                for art in (await session.exec(select(Artifact).where(Artifact.case_id == case.caseld))).all(): await session.delete(art)
                for ra in (await session.exec(select(RiskAssessment).where(RiskAssessment.case_id == case.caseld))).all(): await session.delete(ra)
                await session.delete(case)
                
            quotes = await session.exec(select(PremiumQuote).where(PremiumQuote.policy_id == policy.id))
            for q in quotes.all(): await session.delete(q)
            
            claims = await session.exec(select(Claim).where(Claim.policy_id == policy.id))
            for c in claims.all():
                for art in (await session.exec(select(Artifact).where(Artifact.claim_id == c.id))).all(): await session.delete(art)
                await session.delete(c)
                
            await session.delete(policy)
        await session.delete(customer)
        
    await session.delete(fg)
    await session.commit()
    return None


@router.delete(
    "/{tenant_id}/families/{family_id}/members/{member_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_family_member(tenant_id: UUID, family_id: UUID, member_id: UUID, session: AsyncSession = Depends(get_session)):
    fg = await _get_family_group(tenant_id, family_id, session)
    customer = await session.get(Customer, member_id)
    if not customer or customer.tenant_id != tenant_id or customer.family_group_id != family_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found.")

    # Nullify the primary member reference if we are deleting the primary member
    if fg.primary_member_customer_id == member_id:
        fg.primary_member_customer_id = None
        session.add(fg)
        await session.flush()

    # Cascading delete for related records
    # 1. Artifacts & Risk Assessments (linked to customer)
    artifacts = await session.exec(select(Artifact).where(Artifact.customer_id == member_id))
    for a in artifacts.all(): await session.delete(a)

    assessments = await session.exec(select(RiskAssessment).where(RiskAssessment.customer_id == member_id))
    for a in assessments.all(): await session.delete(a)

    # 2. Policies and their downstream dependents
    policies = await session.exec(select(Policy).where(Policy.customer_id == member_id))
    for policy in policies.all():
        cases = await session.exec(select(Case).where(Case.policy_id == policy.id))
        for case in cases.all():
            for h in (await session.exec(select(CaseHistory).where(CaseHistory.caseld == case.caseld))).all(): await session.delete(h)
            for w in (await session.exec(select(CaseWorkflow).where(CaseWorkflow.caseld == case.caseld))).all(): await session.delete(w)
            for a in (await session.exec(select(CaseAssignment).where(CaseAssignment.caseld == case.caseld))).all(): await session.delete(a)
            for e in (await session.exec(select(CaseEscalation).where(CaseEscalation.caseld == case.caseld))).all(): await session.delete(e)
            for c in (await session.exec(select(CaseComment).where(CaseComment.caseld == case.caseld))).all(): await session.delete(c)
            for att in (await session.exec(select(CaseAttachment).where(CaseAttachment.caseld == case.caseld))).all(): await session.delete(att)
            for audit in (await session.exec(select(CaseAuditTrail).where(CaseAuditTrail.caseld == case.caseld))).all(): await session.delete(audit)
            for art in (await session.exec(select(Artifact).where(Artifact.case_id == case.caseld))).all(): await session.delete(art)
            for ra in (await session.exec(select(RiskAssessment).where(RiskAssessment.case_id == case.caseld))).all(): await session.delete(ra)
            await session.delete(case)
            
        quotes = await session.exec(select(PremiumQuote).where(PremiumQuote.policy_id == policy.id))
        for q in quotes.all(): await session.delete(q)
        
        claims = await session.exec(select(Claim).where(Claim.policy_id == policy.id))
        for c in claims.all():
            for art in (await session.exec(select(Artifact).where(Artifact.claim_id == c.id))).all(): await session.delete(art)
            await session.delete(c)
            
        await session.delete(policy)

    await session.delete(customer)
    await session.commit()
    return None


@router.get(
    "/{tenant_id}/families/{family_id}/members",
    response_model=List[Dict[str, Any]],
    dependencies=[Depends(verify_admin)],
)
async def list_family_members(tenant_id: UUID, family_id: UUID, session: AsyncSession = Depends(get_session)):
    await _get_family_group(tenant_id, family_id, session)
    result = await session.exec(
        select(Customer).where(Customer.tenant_id == tenant_id, Customer.family_group_id == family_id)
    )
    return [
        {
            "id": str(c.id), "cnic": c.cnic, "name": c.name, "dob": c.dob.isoformat() if c.dob else None,
            "gender": c.gender.value if c.gender else None, "occupation": c.occupation, "declared_income": c.declared_income,
            "relationship": c.family_relationship.value if c.family_relationship else None,
            "is_smoker": c.is_smoker, "height_cm": c.height_cm, "weight_kg": c.weight_kg,
            # Full profile modules (address/contact/medical/lifestyle/financial/
            # beneficiary) captured via the member's "Full Details" editor —
            # None until an Admin fills it in, same as an individual Customer.
            "details": c.details,
        }
        for c in result.all()
    ]


# ── Family policies ─────────────────────────────────────────────────────────────

@router.post(
    "/{tenant_id}/families/{family_id}/floater-policies",
    response_model=FamilyPolicyRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_floater_policy(
    tenant_id: UUID,
    family_id: UUID,
    body: FloaterPolicyCreate,
    session: AsyncSession = Depends(get_session),
) -> FamilyPolicy:
    await _get_family_group(tenant_id, family_id, session)

    fp = FamilyPolicy(
        tenant_id=tenant_id,
        family_group_id=family_id,
        plan_type=FamilyPlanTypeEnum.FLOATER,
        insurance_type=InsuranceTypeEnum.FAMILY_FLOATER,
        total_sum_insured=body.total_sum_insured,
        term_years=body.term_years,
        effective_date=body.effective_date,
        status="Pending",
    )
    session.add(fp)
    await session.commit()
    await session.refresh(fp)
    return fp


@router.post(
    "/{tenant_id}/families/{family_id}/life-bundle-policies",
    response_model=FamilyPolicyRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_life_bundle_policy(
    tenant_id: UUID,
    family_id: UUID,
    body: LifeBundlePolicyCreate,
    session: AsyncSession = Depends(get_session),
) -> FamilyPolicy:
    await _get_family_group(tenant_id, family_id, session)

    if body.discount_percentage < 0 or body.discount_percentage > 50:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="discount_percentage must be between 0 and 50.",
        )

    fp = FamilyPolicy(
        tenant_id=tenant_id,
        family_group_id=family_id,
        plan_type=FamilyPlanTypeEnum.LIFE_BUNDLE,
        discount_percentage=body.discount_percentage,
        term_years=body.term_years,
        effective_date=body.effective_date,
        status="Pending",
    )
    session.add(fp)
    await session.commit()
    await session.refresh(fp)
    return fp


@router.get(
    "/{tenant_id}/families/{family_id}/family-policies",
    response_model=List[FamilyPolicyRead],
    dependencies=[Depends(verify_admin)],
)
async def list_family_policies(tenant_id: UUID, family_id: UUID, session: AsyncSession = Depends(get_session)):
    await _get_family_group(tenant_id, family_id, session)
    result = await session.exec(
        select(FamilyPolicy).where(FamilyPolicy.tenant_id == tenant_id, FamilyPolicy.family_group_id == family_id)
    )
    return list(result.all())


# ── Floater members ──────────────────────────────────────────────────────────────

@router.post(
    "/{tenant_id}/families/{family_id}/floater-policies/{fp_id}/members/validate",
    response_model=FamilyValidationResponse,
    dependencies=[Depends(verify_admin)],
)
async def validate_floater_members(
    tenant_id: UUID,
    family_id: UUID,
    fp_id: UUID,
    body: FamilyMembersRequest,
    session: AsyncSession = Depends(get_session),
):
    await _get_family_policy(tenant_id, family_id, fp_id, FamilyPlanTypeEnum.FLOATER, session)

    # Scoped to THIS policy, not the whole family — the same member is
    # expected to be reused across a family's multiple policies (see
    # family_underwriting.validate_family_members's docstring).
    existing = await session.exec(
        select(Customer.cnic, Customer.family_relationship).join(Policy, Policy.customer_id == Customer.id).where(Policy.family_policy_id == fp_id)
    )
    existing_list = existing.all()
    existing_cnics = {m.cnic for m in existing_list}
    existing_count = len(existing_cnics)
    has_existing_self = any(m.family_relationship == FamilyRelationshipEnum.SELF for m in existing_list)

    result = validate_family_members(existing_cnics, body.members, existing_count, has_existing_self)
    return FamilyValidationResponse(**result.model_dump())


@router.post(
    "/{tenant_id}/families/{family_id}/floater-policies/{fp_id}/members/confirm",
    response_model=FamilyConfirmResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def confirm_floater_members(
    tenant_id: UUID,
    family_id: UUID,
    fp_id: UUID,
    body: FamilyMembersRequest,
    session: AsyncSession = Depends(get_session),
):
    family_group = await _get_family_group(tenant_id, family_id, session)
    family_policy = await _get_family_policy(tenant_id, family_id, fp_id, FamilyPlanTypeEnum.FLOATER, session)

    # Scoped to THIS policy, not the whole family — the same member is
    # expected to be reused across a family's multiple policies (see
    # family_underwriting.validate_family_members's docstring).
    existing = await session.exec(
        select(Customer.cnic, Customer.family_relationship).join(Policy, Policy.customer_id == Customer.id).where(Policy.family_policy_id == fp_id)
    )
    existing_list = existing.all()
    existing_cnics = {m.cnic for m in existing_list}
    existing_count = len(existing_cnics)
    has_existing_self = any(m.family_relationship == FamilyRelationshipEnum.SELF for m in existing_list)

    result = validate_family_members(existing_cnics, body.members, existing_count, has_existing_self)
    if not result.is_valid:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=result.model_dump())

    household_income = family_group.household_declared_income or 0.0

    # ── Pass 1: parse rows, resolve risk-engine calls ─────────────────────────
    # No DB session/transaction held open across this — network I/O to
    # risk-engine happens entirely before Pass 2 starts writing.
    parsed_rows: List[Dict[str, Any]] = []
    for row in body.members:
        try:
            dob = row["dob"] if isinstance(row["dob"], date) else date.fromisoformat(str(row["dob"]))
            declared_income = float(row["declared_income"])
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid member row for CNIC '{row.get('cnic', '?')}': {exc}",
            )
        parsed_rows.append({**row, "_dob": dob, "_declared_income": declared_income})

    eldest = eldest_age(body.members)
    semaphore = asyncio.Semaphore(_RISK_ENGINE_CONCURRENCY)

    async def _evaluate(row: Dict[str, Any]) -> Optional[dict]:
        customer_payload = {
            "cnic": normalize_cnic(row["cnic"]) or row["cnic"],
            "name": row["name"],
            "dob": row["_dob"].isoformat(),
            "gender": row["gender"],
            "occupation": row["occupation"],
            # Household income, not this member's own — see FamilyGroup.
            # household_declared_income's docstring and the design note in
            # family_underwriting.py. NOTE: this does mean a child/non-earning
            # member's payload can look like "an infant declared 3,000,000
            # income" to risk-engine's fraud-scoring node, which may flag it
            # as suspicious on its own terms — a known, accepted quirk of
            # reusing the per-person evaluate_group_member() payload shape
            # for a shared-pool product, not a bug in the FAMILY_FLOATER band
            # itself (verified separately against services/risk-engine).
            "declared_income": household_income,
            "is_smoker": bool(row.get("is_smoker", False)),
            "height_cm": float(row.get("height_cm", 170)),
            "weight_kg": float(row.get("weight_kg", 70)),
        }
        policy_payload = {
            "product_name": "Family Health Floater",
            "insurance_type": InsuranceTypeEnum.FAMILY_FLOATER.value,
            "coverage_amount": family_policy.total_sum_insured,   # the whole pool, not a per-member share
            "term_years": 1,   # annually-renewable, independent of family_policy.term_years
        }
        async with semaphore:
            return await evaluate_group_member(customer_payload, policy_payload, str(tenant_id))

    results = await asyncio.gather(*[_evaluate(row) for row in parsed_rows])
    risk_results: Dict[str, Optional[dict]] = {row["cnic"]: res for row, res in zip(parsed_rows, results)}

    # ── Pass 2: DB-only — build rows and commit once ─────────────────────────
    floater_plan = (await session.exec(
        select(InsurancePlan).where(
            InsurancePlan.tenant_id == tenant_id,
            InsurancePlan.code == "FAMILY_FLOATER",
        )
    )).first()
    if floater_plan is None:
        logger.warning(
            "no FAMILY_FLOATER InsurancePlan for tenant=%s — pricing at fallback rate", tenant_id
        )

    audit_user = (await session.exec(select(User).where(User.tenant_id == tenant_id))).first()

    created_customers: Dict[str, Customer] = {}
    for row in parsed_rows:
        customer = await _get_or_create_member_customer(
            session, tenant_id, family_id, row, row["_dob"], row["_declared_income"],
        )
        created_customers[row["cnic"]] = customer

    self_cnic = next(row["cnic"] for row in parsed_rows if row["relationship"] == "Self")
    self_customer = created_customers[self_cnic]   # created_customers is keyed by the same raw row["cnic"]
    family_group.primary_member_customer_id = self_customer.id
    session.add(family_group)

    # One shared Policy for the whole pool — see FamilyPolicy's docstring.
    # Starts UnderReview (every floater member always goes through
    # risk-engine — there's no guaranteed-issue branch here) and is
    # reassigned below once every member's decision is in.
    eldest_row = next(r for r in parsed_rows if age_from_dob(r["_dob"]) == eldest)
    shared_policy = Policy(
        tenant_id=tenant_id,
        customer_id=self_customer.id,
        family_policy_id=family_policy.id,
        product_name="Family Health Floater",
        insurance_type=InsuranceTypeEnum.FAMILY_FLOATER,
        coverage_amount=family_policy.total_sum_insured,
        term_years=family_policy.term_years,
        status=PolicyStatusEnum.UNDER_REVIEW,
    )
    session.add(shared_policy)
    await session.flush()

    member_outcomes: Dict[str, FamilyMemberOutcome] = {}
    successful_decisions: List[str] = []

    for row in parsed_rows:
        cnic = row["cnic"]
        customer = created_customers[cnic]
        ai_result = risk_results.get(cnic)

        case = Case(
            tenant_id=tenant_id,
            customer_id=customer.id,
            policy_id=shared_policy.id,
            caseNumber=generate_case_number(),
            caseType=CaseTypeEnum.UNDERWRITING,
            caseStatus=CaseStatusEnum.NEW,
            priorityLevel=CasePriorityEnum.NORMAL,
            sourceChannel=SourceChannelEnum.BRANCH,
        )
        session.add(case)
        await session.flush()

        risk_assessment_id: Optional[UUID] = None
        suggested_loading: Optional[float] = None

        if ai_result is not None:
            assessment = RiskAssessment(
                tenant_id=tenant_id,
                customer_id=customer.id,
                policy_id=shared_policy.id,
                case_id=case.caseld,
                medical_score=ai_result["medical_score"],
                financial_score=ai_result["financial_score"],
                fraud_probability=ai_result["fraud_probability"],
                composite_risk_score=ai_result.get("composite_risk_score"),
                ai_decision=AIDecision(ai_result["ai_decision"]),
                suggested_loading=ai_result.get("suggested_loading"),
                reasons=ai_result.get("reasons"),
            )
            session.add(assessment)
            await session.flush()
            risk_assessment_id = assessment.id
            suggested_loading = assessment.suggested_loading
            successful_decisions.append(ai_result["ai_decision"])

            new_case_status = DECISION_CASE_STATUS.get(ai_result["ai_decision"])
            if new_case_status is not None and new_case_status != case.caseStatus:
                if audit_user is not None:
                    session.add(CaseHistory(
                        caseld=case.caseld,
                        actionType=ActionTypeEnum.DECISION,
                        fromStatus=case.caseStatus.value,
                        toStatus=new_case_status.value,
                        changedBy=audit_user.id,
                        systemGeneratedFlag=True,
                    ))
                case.caseStatus = new_case_status
                session.add(case)
        # else: risk-engine unreachable/errored for this member — their Case
        # stays New; doesn't contribute a decision to the aggregation below.
        # Logged inside risk_client.py.

        member_outcomes[cnic] = FamilyMemberOutcome(
            customer_id=customer.id,
            policy_id=shared_policy.id,
            relationship=_relationship_enum(row["relationship"]),
            status=PolicyStatusEnum.UNDER_REVIEW,   # placeholder — overwritten below once aggregated
            suggested_loading=suggested_loading,
            risk_assessment_id=risk_assessment_id,
        )

    # Conflict rule: N members can each independently return a different AI
    # decision, but there is only one Policy.status for the shared pool —
    # apply the most conservative decision across all members (Decline >
    # Human Review > Approve with Loading > Auto Approve), mirroring how a
    # real floater is underwritten: any one member's adverse risk affects the
    # whole pool's issuability. If risk-engine was unreachable for every
    # member, the Policy stays UnderReview (its initial value above).
    if successful_decisions:
        final_decision = most_conservative_decision(successful_decisions)
        new_policy_status = DECISION_POLICY_STATUS.get(final_decision)
        if new_policy_status is not None:
            shared_policy.status = new_policy_status
            session.add(shared_policy)

    # Always price — one calculation for the whole pool, off the eldest life.
    breakdown = calculate_premium(
        coverage_amount=family_policy.total_sum_insured,
        base_premium_rate=floater_plan.base_premium_rate if floater_plan is not None else _FALLBACK_FLOATER_RATE,
        smoker_factor=floater_plan.smoker_factor if floater_plan is not None else 1.0,
        age=eldest,
        is_smoker=bool(eldest_row.get("is_smoker", False)),
        height_cm=float(eldest_row.get("height_cm", 170)),
        weight_kg=float(eldest_row.get("weight_kg", 70)),
    )
    premium_quote = PremiumQuote(
        tenant_id=tenant_id,
        policy_id=shared_policy.id,
        base_premium=breakdown.base_premium,
        loading_applied=breakdown.loading_applied,
        total_premium=breakdown.total_premium,
        rate_version=floater_plan.rate_version if floater_plan is not None else "fallback-v1",
    )
    session.add(premium_quote)

    outcomes: List[FamilyMemberOutcome] = []
    for row in parsed_rows:
        outcome = member_outcomes[row["cnic"]]
        outcome.status = shared_policy.status
        outcome.premium_total = breakdown.total_premium
        outcomes.append(outcome)

    family_policy.status = "Active"
    session.add(family_policy)

    from shared.models.core import ProfileStatusEnum
    family_group.profile_status = ProfileStatusEnum.POLICYHOLDER
    session.add(family_group)
    for cust in created_customers.values():
        cust.profile_status = ProfileStatusEnum.POLICYHOLDER
        session.add(cust)

    await session.commit()

    return FamilyConfirmResponse(
        family_policy_id=family_policy.id,
        total_sum_insured=family_policy.total_sum_insured,
        members=outcomes,
    )


# ── Life-bundle members ──────────────────────────────────────────────────────────

@router.post(
    "/{tenant_id}/families/{family_id}/life-bundle-policies/{fp_id}/members/validate",
    response_model=FamilyValidationResponse,
    dependencies=[Depends(verify_admin)],
)
async def validate_life_bundle_members(
    tenant_id: UUID,
    family_id: UUID,
    fp_id: UUID,
    body: FamilyMembersRequest,
    session: AsyncSession = Depends(get_session),
):
    await _get_family_policy(tenant_id, family_id, fp_id, FamilyPlanTypeEnum.LIFE_BUNDLE, session)

    # Scoped to THIS policy, not the whole family — the same member is
    # expected to be reused across a family's multiple policies (see
    # family_underwriting.validate_family_members's docstring).
    existing = await session.exec(
        select(Customer.cnic, Customer.family_relationship).join(Policy, Policy.customer_id == Customer.id).where(Policy.family_policy_id == fp_id)
    )
    existing_list = existing.all()
    existing_cnics = {m.cnic for m in existing_list}
    existing_count = len(existing_cnics)
    has_existing_self = any(m.family_relationship == FamilyRelationshipEnum.SELF for m in existing_list)

    result = validate_life_bundle_member_fields(existing_cnics, body.members, existing_count, has_existing_self)
    return FamilyValidationResponse(**result.model_dump())


@router.post(
    "/{tenant_id}/families/{family_id}/life-bundle-policies/{fp_id}/members/confirm",
    response_model=FamilyConfirmResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def confirm_life_bundle_members(
    tenant_id: UUID,
    family_id: UUID,
    fp_id: UUID,
    body: FamilyMembersRequest,
    session: AsyncSession = Depends(get_session),
):
    family_group = await _get_family_group(tenant_id, family_id, session)
    family_policy = await _get_family_policy(tenant_id, family_id, fp_id, FamilyPlanTypeEnum.LIFE_BUNDLE, session)

    # Scoped to THIS policy, not the whole family — the same member is
    # expected to be reused across a family's multiple policies (see
    # family_underwriting.validate_family_members's docstring).
    existing = await session.exec(
        select(Customer.cnic, Customer.family_relationship).join(Policy, Policy.customer_id == Customer.id).where(Policy.family_policy_id == fp_id)
    )
    existing_list = existing.all()
    existing_cnics = {m.cnic for m in existing_list}
    existing_count = len(existing_cnics)
    has_existing_self = any(m.family_relationship == FamilyRelationshipEnum.SELF for m in existing_list)

    result = validate_life_bundle_member_fields(existing_cnics, body.members, existing_count, has_existing_self)
    if not result.is_valid:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=result.model_dump())

    # ── Pass 1: parse rows + resolve each member's own InsurancePlan ─────────
    parsed_rows: List[Dict[str, Any]] = []
    for row in body.members:
        try:
            dob = row["dob"] if isinstance(row["dob"], date) else date.fromisoformat(str(row["dob"]))
            declared_income = float(row["declared_income"])
            coverage_amount = float(row["coverage_amount"])
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid member row for CNIC '{row.get('cnic', '?')}': {exc}",
            )

        plan = (await session.exec(
            select(InsurancePlan).where(
                InsurancePlan.tenant_id == tenant_id,
                InsurancePlan.code == row["plan_code"],
            )
        )).first()
        if plan is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"No plan with code '{row['plan_code']}' found for this tenant (row CNIC '{row.get('cnic', '?')}').",
            )

        parsed_rows.append({
            **row, "_dob": dob, "_declared_income": declared_income,
            "_coverage_amount": coverage_amount, "_plan": plan,
        })

    # ── Pass 2: risk-engine calls — every member always goes through it,
    # no FCL/guaranteed-issue branch exists for family policies ──────────────
    semaphore = asyncio.Semaphore(_RISK_ENGINE_CONCURRENCY)

    async def _evaluate(row: Dict[str, Any]) -> Optional[dict]:
        plan: InsurancePlan = row["_plan"]
        customer_payload = {
            "cnic": normalize_cnic(row["cnic"]) or row["cnic"],
            "name": row["name"],
            "dob": row["_dob"].isoformat(),
            "gender": row["gender"],
            "occupation": row["occupation"],
            "declared_income": row["_declared_income"],   # this member's own income, not household
            "is_smoker": bool(row.get("is_smoker", False)),
            "height_cm": float(row.get("height_cm", 170)),
            "weight_kg": float(row.get("weight_kg", 70)),
        }
        policy_payload = {
            "product_name": plan.label,
            "insurance_type": plan.insurance_type.value,
            "coverage_amount": row["_coverage_amount"],
            "term_years": family_policy.term_years,
        }
        async with semaphore:
            return await evaluate_group_member(customer_payload, policy_payload, str(tenant_id))

    results = await asyncio.gather(*[_evaluate(row) for row in parsed_rows])
    risk_results: Dict[str, Optional[dict]] = {row["cnic"]: res for row, res in zip(parsed_rows, results)}

    # ── Pass 3: DB-only — one Policy per member, commit once ─────────────────
    audit_user = (await session.exec(select(User).where(User.tenant_id == tenant_id))).first()

    outcomes: List[FamilyMemberOutcome] = []
    customers_to_promote: List[Customer] = []
    for row in parsed_rows:
        plan: InsurancePlan = row["_plan"]
        is_smoker = bool(row.get("is_smoker", False))
        height_cm = float(row.get("height_cm", 170))
        weight_kg = float(row.get("weight_kg", 70))

        customer = await _get_or_create_member_customer(
            session, tenant_id, family_id, row, row["_dob"], row["_declared_income"],
        )
        customers_to_promote.append(customer)

        if row["relationship"] == "Self":
            family_group.primary_member_customer_id = customer.id
            session.add(family_group)

        policy = Policy(
            tenant_id=tenant_id,
            customer_id=customer.id,
            family_policy_id=family_policy.id,
            product_name=plan.label,
            insurance_type=plan.insurance_type,
            coverage_amount=row["_coverage_amount"],
            term_years=family_policy.term_years,
            status=PolicyStatusEnum.UNDER_REVIEW,
        )
        session.add(policy)
        await session.flush()

        risk_assessment_id: Optional[UUID] = None
        suggested_loading: Optional[float] = None
        ai_result = risk_results.get(row["cnic"])

        case = Case(
            tenant_id=tenant_id,
            customer_id=customer.id,
            policy_id=policy.id,
            caseNumber=generate_case_number(),
            caseType=CaseTypeEnum.UNDERWRITING,
            caseStatus=CaseStatusEnum.NEW,
            priorityLevel=CasePriorityEnum.NORMAL,
            sourceChannel=SourceChannelEnum.BRANCH,
        )
        session.add(case)
        await session.flush()

        if ai_result is not None:
            assessment = RiskAssessment(
                tenant_id=tenant_id,
                customer_id=customer.id,
                policy_id=policy.id,
                case_id=case.caseld,
                medical_score=ai_result["medical_score"],
                financial_score=ai_result["financial_score"],
                fraud_probability=ai_result["fraud_probability"],
                composite_risk_score=ai_result.get("composite_risk_score"),
                ai_decision=AIDecision(ai_result["ai_decision"]),
                suggested_loading=ai_result.get("suggested_loading"),
                reasons=ai_result.get("reasons"),
            )
            session.add(assessment)
            await session.flush()
            risk_assessment_id = assessment.id
            suggested_loading = assessment.suggested_loading

            new_policy_status = DECISION_POLICY_STATUS.get(ai_result["ai_decision"])
            if new_policy_status is not None:
                policy.status = new_policy_status
                session.add(policy)

            new_case_status = DECISION_CASE_STATUS.get(ai_result["ai_decision"])
            if new_case_status is not None and new_case_status != case.caseStatus:
                if audit_user is not None:
                    session.add(CaseHistory(
                        caseld=case.caseld,
                        actionType=ActionTypeEnum.DECISION,
                        fromStatus=case.caseStatus.value,
                        toStatus=new_case_status.value,
                        changedBy=audit_user.id,
                        systemGeneratedFlag=True,
                    ))
                case.caseStatus = new_case_status
                session.add(case)
        # else: risk-engine unreachable/errored — Policy stays UnderReview,
        # Case stays New; an underwriter can still work it manually.

        # Discount baked into the effective rate (not loading_applied, which
        # has a DB ge=0 constraint and can't hold a negative discount).
        effective_rate = plan.base_premium_rate * (1 - (family_policy.discount_percentage or 0) / 100)
        breakdown = calculate_premium(
            coverage_amount=row["_coverage_amount"],
            base_premium_rate=effective_rate,
            smoker_factor=plan.smoker_factor,
            age=age_from_dob(row["_dob"]),
            is_smoker=is_smoker,
            height_cm=height_cm,
            weight_kg=weight_kg,
        )
        premium_quote = PremiumQuote(
            tenant_id=tenant_id,
            policy_id=policy.id,
            base_premium=breakdown.base_premium,
            loading_applied=breakdown.loading_applied,
            total_premium=breakdown.total_premium,
            rate_version=plan.rate_version,
        )
        session.add(premium_quote)

        outcomes.append(FamilyMemberOutcome(
            customer_id=customer.id,
            policy_id=policy.id,
            relationship=_relationship_enum(row["relationship"]),
            status=policy.status,
            premium_total=breakdown.total_premium,
            suggested_loading=suggested_loading,
            risk_assessment_id=risk_assessment_id,
        ))

    family_policy.status = "Active"
    session.add(family_policy)

    from shared.models.core import ProfileStatusEnum
    family_group.profile_status = ProfileStatusEnum.POLICYHOLDER
    session.add(family_group)
    for cust in customers_to_promote:
        cust.profile_status = ProfileStatusEnum.POLICYHOLDER
        session.add(cust)

    await session.commit()

    return FamilyConfirmResponse(
        family_policy_id=family_policy.id,
        total_sum_insured=None,
        members=outcomes,
    )
