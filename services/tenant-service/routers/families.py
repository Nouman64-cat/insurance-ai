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
from decision_status import DECISION_CASE_STATUS
from family_underwriting import (
    age_from_dob,
    eldest_age,
    is_insured_row,
    uses_nominee_model,
    normalize_cnic,
    validate_family_members,
    validate_life_bundle_members as validate_life_bundle_member_fields,
)

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
    Beneficiary,
    BeneficiaryVersion,
    Case,
    CaseAssignment,
    CaseAttachment,
    CaseAuditTrail,
    CaseComment,
    CaseEscalation,
    CaseHistory,
    CasePriorityEnum,
    CaseRequirement,
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
    VerificationFinding,
)
from shared.pricing.calculator import calculate_premium
from routers.auth import optional_oauth2_scheme, source_scope
from routers.users import verify_admin   # reuse existing Admin guard — tenant-scoped for Admin, cross-tenant for SuperAdmin

logger = logging.getLogger("tenant-service.families")

router = APIRouter(prefix="/tenants", tags=["Families"])

# Used only if a tenant has no "FAMILY_FLOATER" InsurancePlan catalog row —
# rather than failing enrollment outright, price at a conservative
# placeholder rate. Same reasoning as organizations.py's _FALLBACK_GROUP_RATE.
_FALLBACK_FLOATER_RATE = 4.0   # PKR per 1,000 sum assured per year



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
    # Members are credited to whoever brought the family in.
    family = await session.get(FamilyGroup, family_id)
    source_id = family.acquisition_source_id if family else None
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
            acquisition_source_id=source_id,
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
    if existing.acquisition_source_id is None:
        existing.acquisition_source_id = source_id
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
    token: Optional[str] = Depends(optional_oauth2_scheme),
) -> FamilyGroup:
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)

    fg = FamilyGroup(tenant_id=tenant_id, **body.model_dump())
    # A source's own login can only bring in groups under its own source.
    scope = await source_scope(token, session)
    if scope is not None and fg.acquisition_source_id not in scope:
        fg.acquisition_source_id = next(iter(scope))
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
    token: Optional[str] = Depends(optional_oauth2_scheme),
):
    query = select(FamilyGroup).where(FamilyGroup.tenant_id == tenant_id)
    scope = await source_scope(token, session)
    if scope is not None:
        query = query.where(FamilyGroup.acquisition_source_id.in_(scope))
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
async def get_family_stats(
    tenant_id: UUID,
    session: AsyncSession = Depends(get_session),
    token: Optional[str] = Depends(optional_oauth2_scheme),
):
    query = select(FamilyGroup).where(FamilyGroup.tenant_id == tenant_id)
    scope = await source_scope(token, session)
    if scope is not None:
        query = query.where(FamilyGroup.acquisition_source_id.in_(scope))
    groups = list((await session.exec(query)).all())
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
async def get_family_group(
    tenant_id: UUID,
    family_id: UUID,
    session: AsyncSession = Depends(get_session),
    token: Optional[str] = Depends(optional_oauth2_scheme),
):
    fg = await _get_family_group(tenant_id, family_id, session)
    scope = await source_scope(token, session)
    if scope is not None and fg.acquisition_source_id not in scope:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Family group not found.")
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
                for cr in (await session.exec(select(CaseRequirement).where(CaseRequirement.case_id == case.caseld))).all(): await session.delete(cr)
                for vf in (await session.exec(select(VerificationFinding).where(VerificationFinding.case_id == case.caseld))).all(): await session.delete(vf)
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
            for cr in (await session.exec(select(CaseRequirement).where(CaseRequirement.case_id == case.caseld))).all(): await session.delete(cr)
            for vf in (await session.exec(select(VerificationFinding).where(VerificationFinding.case_id == case.caseld))).all(): await session.delete(vf)
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



# ── Nominees ─────────────────────────────────────────────────────────────────────
# Only the head and (optionally) the spouse are insured. Everyone else is a nominee: a
# `Beneficiary` row on the head's policy carrying their share of the death benefit.

async def _existing_share_total(session: AsyncSession, fp_id: UUID) -> float:
    total = (await session.exec(
        select(func.coalesce(func.sum(Beneficiary.share_pct), 0.0)).where(
            Beneficiary.policy_id.in_(select(Policy.id).where(Policy.family_policy_id == fp_id))
        )
    )).one()
    return float(total or 0.0)


def _parse_dob(value: Any) -> Optional[date]:
    if value in (None, ""):
        return None
    try:
        return value if isinstance(value, date) else date.fromisoformat(str(value))
    except ValueError:
        return None


async def _save_nominees(
    session: AsyncSession, tenant_id: UUID, policy_id: UUID, rows: List[Dict[str, Any]],
    head_name: Optional[str], base_amount: Optional[float],
) -> List[Dict[str, Any]]:
    """Record each non-head row's share on the head's policy (the real Beneficiary table, so the
    pre-issuance 100% check and the claim payout split see them) and snapshot the roster."""
    incoming = [r for r in rows if r.get("relationship") != "Self" and r.get("share_pct") not in (None, "")]
    if not incoming:
        return []
    for r in incoming:
        dob = _parse_dob(r.get("dob"))
        minor = bool(dob and age_from_dob(dob) < 18)
        session.add(Beneficiary(
            tenant_id=tenant_id, policy_id=policy_id, name=str(r["name"]).strip(),
            cnic=(normalize_cnic(r["cnic"]) or None) if r.get("cnic") else None,
            relationship=r["relationship"], share_pct=float(r["share_pct"]), date_of_birth=dob,
            is_minor=minor, guardian_name=head_name if minor else None,
        ))
    await session.flush()
    roster = (await session.exec(select(Beneficiary).where(Beneficiary.policy_id == policy_id))).all()
    last_seq = (await session.exec(
        select(BeneficiaryVersion.version_sequence).where(BeneficiaryVersion.policy_id == policy_id)
        .order_by(BeneficiaryVersion.version_sequence.desc())  # type: ignore[arg-type]
    )).first()
    total = round(sum(b.share_pct for b in roster), 2)
    session.add(BeneficiaryVersion(
        tenant_id=tenant_id, policy_id=policy_id, version_sequence=(last_seq or 0) + 1,
        beneficiaries_json=[{
            "name": b.name, "cnic": b.cnic, "relationship": b.relationship, "share_pct": b.share_pct,
            "date_of_birth": b.date_of_birth.isoformat() if b.date_of_birth else None,
            "is_minor": b.is_minor, "guardian_name": b.guardian_name,
        } for b in roster],
        total_share=min(total, 100.0), changed_by="system", change_reason="Family enrolment",
    ))
    return [nominee_dict(b, base_amount) for b in roster]


def nominee_dict(b: Beneficiary, base_amount: Optional[float]) -> Dict[str, Any]:
    return {
        "name": b.name, "relationship": b.relationship, "cnic": b.cnic, "share_pct": b.share_pct,
        "amount": round(b.share_pct / 100.0 * base_amount, 2) if base_amount else None,
        "is_minor": b.is_minor, "guardian_name": b.guardian_name,
    }


@router.get(
    "/{tenant_id}/families/{family_id}/family-policies/{fp_id}/nominees",
    dependencies=[Depends(verify_admin)],
)
async def list_family_nominees(tenant_id: UUID, family_id: UUID, fp_id: UUID, session: AsyncSession = Depends(get_session)):
    """Who receives the head's death benefit under this policy, with their share and rupee amount. The
    spouse appears here too — as a nominee, and separately in the roster if they are fully insured."""
    family_group = await _get_family_group(tenant_id, family_id, session)
    family_policy = (await session.exec(select(FamilyPolicy).where(
        FamilyPolicy.id == fp_id, FamilyPolicy.family_group_id == family_id, FamilyPolicy.tenant_id == tenant_id))).first()
    if family_policy is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Family policy not found.")
    policies = (await session.exec(select(Policy).where(Policy.family_policy_id == fp_id).order_by(Policy.id))).all()
    head = next((p for p in policies if p.customer_id == family_group.primary_member_customer_id), policies[0] if policies else None)
    if head is None:
        return {"nominees": [], "total_share": 0.0, "base_amount": None}
    base = family_policy.total_sum_insured if family_policy.plan_type == FamilyPlanTypeEnum.FLOATER else head.coverage_amount
    rows = (await session.exec(select(Beneficiary).where(Beneficiary.policy_id == head.id))).all()
    return {"nominees": [nominee_dict(b, base) for b in rows], "total_share": round(sum(b.share_pct for b in rows), 2), "base_amount": base}


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

    result = validate_family_members(existing_cnics, body.members, existing_count, has_existing_self,
                                     await _existing_share_total(session, fp_id))
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

    result = validate_family_members(existing_cnics, body.members, existing_count, has_existing_self,
                                     await _existing_share_total(session, fp_id))
    if not result.is_valid:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=result.model_dump())

    household_income = family_group.household_declared_income or 0.0

    # ── Pass 1: parse rows ──────────────────────────────────────────────────
    # Only insured rows (the head, and a spouse who is fully insured) become customers with cases;
    # the rest are nominees, saved below as beneficiaries of the head's policy.
    parsed_rows: List[Dict[str, Any]] = []
    for row in body.members:
        if not is_insured_row(row):
            continue
        try:
            dob = row["dob"] if isinstance(row["dob"], date) else date.fromisoformat(str(row["dob"]))
            declared_income = float(row["declared_income"])
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid member row for CNIC '{row.get('cnic', '?')}': {exc}",
            )
        parsed_rows.append({**row, "_dob": dob, "_declared_income": declared_income})

    # Members already on this floater (an add-on enrolment). The pool is priced off the eldest life
    # across everyone, and the shared Policy that already exists is reused rather than duplicated.
    prior_members = (await session.exec(
        select(Customer).where(Customer.id.in_(select(Policy.customer_id).where(Policy.family_policy_id == fp_id)))
    )).all()
    prior_rows = [
        {"dob": c.dob, "is_smoker": c.is_smoker, "height_cm": c.height_cm, "weight_kg": c.weight_kg}
        for c in prior_members if c.dob
    ]
    eldest = eldest_age([*prior_rows, *parsed_rows])

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

    # The "Self" row arrives with the first batch only; a later batch adds to a family that already has one.
    self_row = next((row for row in parsed_rows if row["relationship"] == "Self"), None)
    if self_row is not None:
        family_group.primary_member_customer_id = created_customers[self_row["cnic"]].id   # keyed by the same raw row["cnic"]
        session.add(family_group)

    # One shared Policy for the whole pool — see FamilyPolicy's docstring.
    # Starts as a Quoted DRAFT: every floater member is still risk-scored below
    # (assessments/cases are created), but the proposal itself surfaces in the
    # Proposal page's Draft section and is advanced to Under Review manually via
    # the status control — it does not jump straight to Under Review.
    shared_policy = (await session.exec(
        select(Policy).where(Policy.family_policy_id == fp_id).order_by(Policy.id)
    )).first()
    if shared_policy is None:
        holder_id = created_customers[self_row["cnic"]].id if self_row is not None else family_group.primary_member_customer_id
        shared_policy = Policy(
            tenant_id=tenant_id,
            customer_id=holder_id,
            family_policy_id=family_policy.id,
            product_name="Family Health Floater",
            insurance_type=InsuranceTypeEnum.FAMILY_FLOATER,
            coverage_amount=family_policy.total_sum_insured,
            term_years=family_policy.term_years,
            status=PolicyStatusEnum.QUOTED,
        )
        session.add(shared_policy)
        await session.flush()

    # Pricing basis: the eldest insured life, whether it joined now or earlier.
    candidates = [{**r, "_dob": r["dob"]} for r in prior_rows] + parsed_rows
    eldest_row = next((r for r in candidates if age_from_dob(r["_dob"]) == eldest), {})

    head_name = (created_customers[self_row["cnic"]].name if self_row is not None
                 else (await session.get(Customer, family_group.primary_member_customer_id)).name
                 if family_group.primary_member_customer_id else None)
    nominees = await _save_nominees(session, tenant_id, shared_policy.id, body.members, head_name, family_policy.total_sum_insured)

    member_outcomes: Dict[str, FamilyMemberOutcome] = {}

    for row in parsed_rows:
        cnic = row["cnic"]
        customer = created_customers[cnic]

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

        member_outcomes[cnic] = FamilyMemberOutcome(
            customer_id=customer.id,
            policy_id=shared_policy.id,
            case_id=case.caseld,
            case_number=case.caseNumber,
            relationship=_relationship_enum(row["relationship"]),
            status=PolicyStatusEnum.UNDER_REVIEW,   # placeholder — overwritten below once aggregated
            suggested_loading=None,
            risk_assessment_id=None,
        )

    # Each member's AI decision is surfaced on its own Case above, but the
    # shared proposal Policy stays a Quoted DRAFT — it is advanced out of Draft
    # via the Proposal page's status control, not auto-promoted to the pool's
    # aggregated decision status.

    # Always price — one calculation for the whole pool, off the eldest insured life. A batch that only
    # adds nominees changes nobody's cover, so it leaves the pricing alone.
    breakdown = None
    if parsed_rows:
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
        outcome.premium_total = breakdown.total_premium if breakdown else None
        outcomes.append(outcome)

    # Enrolling & underwriting members produces a PROPOSAL, not an in-force
    # policy. The FamilyPolicy is marked "Proposed" so the group stays on the
    # Leads board (category in_progress) and its quote surfaces on the Proposal
    # page's Draft section. The group's profile_status is deliberately left as-is
    # (LEAD) so it keeps the manual "In Progress" button on the Leads board, just
    # like an individual lead — the underwriter advances it explicitly. Only a
    # later issuance step marks the policy "Active" / the group a POLICYHOLDER.
    family_policy.status = "Proposed"
    session.add(family_policy)

    session.add(family_group)
    for cust in created_customers.values():
        session.add(cust)

    await session.commit()

    return FamilyConfirmResponse(
        family_policy_id=family_policy.id,
        total_sum_insured=family_policy.total_sum_insured,
        members=outcomes,
        nominees=nominees,
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

    result = validate_life_bundle_member_fields(existing_cnics, body.members, existing_count, has_existing_self,
                                                await _existing_share_total(session, fp_id))
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

    result = validate_life_bundle_member_fields(existing_cnics, body.members, existing_count, has_existing_self,
                                                await _existing_share_total(session, fp_id))
    if not result.is_valid:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=result.model_dump())

    # ── Pass 1: parse rows ──────────────────────────────────────────────────
    parsed_rows: List[Dict[str, Any]] = []
    for row in body.members:
        if not is_insured_row(row):
            continue          # a nominee — saved below as a beneficiary of the head's policy
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

    # ── Pass 3: DB-only — one Policy per member, commit once ─────────────────
    audit_user = (await session.exec(select(User).where(User.tenant_id == tenant_id))).first()

    outcomes: List[FamilyMemberOutcome] = []
    customers_to_promote: List[Customer] = []
    head_policy: Optional[Policy] = None
    head_customer: Optional[Customer] = None
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

        # Starts as a Quoted DRAFT — the member is still risk-scored below, but
        # the proposal surfaces in the Proposal Draft section and is advanced to
        # Under Review manually via the status control, not auto-promoted.
        policy = Policy(
            tenant_id=tenant_id,
            customer_id=customer.id,
            family_policy_id=family_policy.id,
            product_name=plan.label,
            insurance_type=plan.insurance_type,
            coverage_amount=row["_coverage_amount"],
            term_years=family_policy.term_years,
            status=PolicyStatusEnum.QUOTED,
        )
        session.add(policy)
        await session.flush()
        if row["relationship"] == "Self":
            head_policy, head_customer = policy, customer

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
            case_id=case.caseld,
            case_number=case.caseNumber,
            relationship=_relationship_enum(row["relationship"]),
            status=policy.status,
            premium_total=breakdown.total_premium,
            suggested_loading=None,
            risk_assessment_id=None,
        ))

    # Life-bundle enrollment is a PROPOSAL too — the FamilyPolicy is "Proposed"
    # so the group stays on the Leads board (category in_progress) with its quote
    # in the Proposal Draft section. profile_status is left as-is (LEAD) so the
    # group keeps its manual "In Progress" button, just like an individual lead.
    # (See the floater confirm above for the full rationale.)
    family_policy.status = "Proposed"
    session.add(family_policy)

    # Nominees' shares sit on the head's policy: this batch's, or the one enrolled earlier.
    nominees: List[Dict[str, Any]] = []
    if head_policy is None and family_group.primary_member_customer_id:
        head_policy = (await session.exec(
            select(Policy).where(Policy.family_policy_id == fp_id, Policy.customer_id == family_group.primary_member_customer_id)
        )).first()
        head_customer = await session.get(Customer, family_group.primary_member_customer_id)
    if head_policy is not None:
        nominees = await _save_nominees(session, tenant_id, head_policy.id, body.members,
                                        head_customer.name if head_customer else None, head_policy.coverage_amount)

    session.add(family_group)
    for cust in customers_to_promote:
        session.add(cust)

    await session.commit()

    return FamilyConfirmResponse(
        family_policy_id=family_policy.id,
        total_sum_insured=None,
        members=outcomes,
        nominees=nominees,
    )
