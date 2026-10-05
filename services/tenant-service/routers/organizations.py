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
from group_benefits import (
    basic_monthly_salary,
    member_cover,
    optional_text,
    parse_date,
    validate_benefit_class,
    validate_scheme_census,
)
from group_underwriting import (
    average_age,
    age_from_dob,
    compute_free_cover_limit,
    normalize_cnic,
    validate_sum_assured_multiple,
)
from risk_client import evaluate_group_member
from routers.cases import generate_case_number
from schemas import (
    BenefitClassCreate,
    BenefitClassRead,
    CensusConfirmResponse,
    CensusEmployeeOutcome,
    CensusRequest,
    CensusValidationResponse,
    CustomerRead,
    MasterPolicyCreate,
    MasterPolicyRead,
    OrganizationCreate,
    OrganizationUpdate,
    OrganizationRead,
    OrganizationStatsRead,
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
    GroupBenefitClass,
    GroupClassCoverage,
    GroupCoverageType,
    GroupMember,
    GroupMemberStatus,
    InsurancePlan,
    InsuranceTypeEnum,
    MasterPolicy,
    Organization,
    PlanCategoryEnum,
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
from routers.users import verify_admin   # reuse existing Admin guard — tenant-scoped for Admin, cross-tenant for SuperAdmin

logger = logging.getLogger("tenant-service.organizations")

router = APIRouter(prefix="/tenants", tags=["Organizations"])

# Used only if a tenant has no "GROUP_LIFE" InsurancePlan catalog row (e.g. a
# tenant that hasn't run seeds/insurance_plans_seed.py) — rather than failing
# enrollment outright, price at a conservative placeholder rate.
_FALLBACK_GROUP_RATE = 3.5   # PKR per 1,000 sum assured per year
_RISK_ENGINE_CONCURRENCY = 5


def _verify_tenant(tenant: Tenant | None, tenant_id: UUID) -> Tenant:
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Tenant '{tenant_id}' not found.")
    return tenant


async def _get_organization(tenant_id: UUID, org_id: UUID, session: AsyncSession) -> Organization:
    org = await session.get(Organization, org_id)
    if not org or org.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found.")
    return org


async def _get_master_policy(tenant_id: UUID, org_id: UUID, mp_id: UUID, session: AsyncSession) -> MasterPolicy:
    mp = await session.get(MasterPolicy, mp_id)
    if not mp or mp.tenant_id != tenant_id or mp.organization_id != org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Master policy not found.")
    return mp


OrganizationCategory = Literal["active", "in_progress", "new"]


async def _employee_ids_by_org(tenant_id: UUID, session: AsyncSession) -> Dict[UUID, set]:
    """Distinct employees per organization: census-created customers
    (organization_id) plus reused customers enrolled via GroupMember."""
    members: Dict[UUID, set] = {}
    for oid, cid in (await session.execute(
        select(Customer.organization_id, Customer.id)
        .where(Customer.tenant_id == tenant_id, Customer.organization_id.is_not(None))
    )).all():
        members.setdefault(oid, set()).add(cid)
    for oid, cid in (await session.execute(
        select(MasterPolicy.organization_id, GroupMember.customer_id)
        .join(MasterPolicy, MasterPolicy.id == GroupMember.master_policy_id)
        .where(GroupMember.tenant_id == tenant_id)
    )).all():
        members.setdefault(oid, set()).add(cid)
    return members


async def _org_employee_ids(tenant_id: UUID, org_id: UUID, session: AsyncSession) -> set:
    return (await _employee_ids_by_org(tenant_id, session)).get(org_id, set())


async def _org_certificates(tenant_id: UUID, org_id: UUID, session: AsyncSession, customer_id: Optional[UUID] = None) -> List[Policy]:
    """Certificate Policy rows under any of this organization's master policies."""
    q = (
        select(Policy)
        .join(MasterPolicy, MasterPolicy.id == Policy.master_policy_id)
        .where(Policy.tenant_id == tenant_id, MasterPolicy.organization_id == org_id)
    )
    if customer_id is not None:
        q = q.where(Policy.customer_id == customer_id)
    return list((await session.exec(q)).all())


async def _delete_policy_cascade(session: AsyncSession, policy: Policy) -> None:
    """Delete a certificate and everything hanging off it (GroupMember rows go
    with it via ON DELETE CASCADE)."""
    cases = await session.exec(select(Case).where(Case.policy_id == policy.id))
    for case in cases.all():
        for model in (CaseHistory, CaseWorkflow, CaseAssignment, CaseEscalation, CaseComment, CaseAttachment, CaseAuditTrail):
            for row in (await session.exec(select(model).where(model.caseld == case.caseld))).all():
                await session.delete(row)
        for art in (await session.exec(select(Artifact).where(Artifact.case_id == case.caseld))).all(): await session.delete(art)
        for ra in (await session.exec(select(RiskAssessment).where(RiskAssessment.case_id == case.caseld))).all(): await session.delete(ra)
        for cr in (await session.exec(select(CaseRequirement).where(CaseRequirement.case_id == case.caseld))).all(): await session.delete(cr)
        for vf in (await session.exec(select(VerificationFinding).where(VerificationFinding.case_id == case.caseld))).all(): await session.delete(vf)
        await session.delete(case)

    for model in (RiskAssessment, PremiumQuote, Beneficiary, BeneficiaryVersion):
        for row in (await session.exec(select(model).where(model.policy_id == policy.id))).all():
            await session.delete(row)

    claims = await session.exec(select(Claim).where(Claim.policy_id == policy.id))
    for c in claims.all():
        for art in (await session.exec(select(Artifact).where(Artifact.claim_id == c.id))).all(): await session.delete(art)
        await session.delete(c)

    await session.flush()
    await session.delete(policy)
    await session.flush()


async def _release_employee(session: AsyncSession, customer: Customer, org_id: UUID) -> None:
    """After an employee's certificates are gone: delete the Customer only if
    the census created it for this organization and nothing else of theirs
    remains (another policy, another scheme). A reused customer — e.g. an
    individual policyholder — is left exactly as it was."""
    if customer.organization_id != org_id:
        return
    remaining_policy = (await session.exec(select(Policy.id).where(Policy.customer_id == customer.id))).first()
    remaining_member = (await session.exec(select(GroupMember.id).where(GroupMember.customer_id == customer.id))).first()
    if remaining_policy or remaining_member:
        customer.organization_id = None
        session.add(customer)
        return
    for model in (Artifact, RiskAssessment):
        for row in (await session.exec(select(model).where(model.customer_id == customer.id))).all():
            await session.delete(row)
    await session.delete(customer)


async def _resolve_group_plan(tenant_id: UUID, plan_code: Optional[str], session: AsyncSession) -> Optional[InsurancePlan]:
    """The Group-category catalog plan a master policy is written under.
    An explicit plan_code must exist; omitted falls back to GROUP_LIFE, and to
    None for a tenant whose catalog was never seeded (priced at the fallback rate)."""
    code = plan_code or "GROUP_LIFE"
    plan = (await session.exec(
        select(InsurancePlan).where(InsurancePlan.tenant_id == tenant_id, InsurancePlan.code == code)
    )).first()
    if plan is None and plan_code:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Plan '{plan_code}' not found.")
    if plan is not None:
        category = plan.category.value if hasattr(plan.category, "value") else plan.category
        if category != PlanCategoryEnum.GROUP.value:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Plan '{code}' is not a group plan.")
    return plan


async def _master_policy_read(mp: MasterPolicy, session: AsyncSession) -> MasterPolicyRead:
    dto = MasterPolicyRead.model_validate(mp)
    plan = await session.get(InsurancePlan, mp.plan_id) if mp.plan_id else None
    if plan is not None:
        dto.plan_code = plan.code
        dto.plan_label = plan.label
        dto.business_type = plan.product_category.value if hasattr(plan.product_category, "value") else plan.product_category
    return dto


async def _benefit_classes(master_policy_id: UUID, session: AsyncSession) -> List[GroupBenefitClass]:
    return list((await session.exec(
        select(GroupBenefitClass)
        .where(GroupBenefitClass.master_policy_id == master_policy_id)
        .order_by(GroupBenefitClass.created_at)
    )).all())


async def _enrolled_cnics(master_policy_id: UUID, session: AsyncSession) -> set:
    rows = await session.exec(
        select(Customer.cnic)
        .join(GroupMember, GroupMember.customer_id == Customer.id)
        .where(GroupMember.master_policy_id == master_policy_id)
    )
    return {c for c in rows.all() if c}


async def _master_policy_status_map(tenant_id: UUID, session: AsyncSession) -> Dict[UUID, str]:
    """One representative status per organization — "Active" wins if any master
    policy has cleared setup, otherwise the first non-Active status seen (in
    practice just "Pending", the only other value any endpoint writes today)."""
    rows = (await session.execute(
        select(MasterPolicy.organization_id, MasterPolicy.status)
        .where(MasterPolicy.tenant_id == tenant_id)
    )).all()
    status_map: Dict[UUID, str] = {}
    for oid, mp_status in rows:
        if status_map.get(oid) == "Active":
            continue
        status_map[oid] = mp_status
    return status_map


def _org_category(dto: OrganizationRead) -> OrganizationCategory:
    if dto.master_policy_status == "Active":
        return "active"
    if dto.master_policy_status:
        return "in_progress"
    return "new"


async def _enrich_organizations(tenant_id: UUID, orgs: List[Organization], session: AsyncSession) -> List[OrganizationRead]:
    emp_ids = await _employee_ids_by_org(tenant_id, session)
    policy_status = await _master_policy_status_map(tenant_id, session)
    results = []
    for org in orgs:
        dto = OrganizationRead.model_validate(org)
        dto.employee_count = len(emp_ids.get(org.id, ()))
        dto.master_policy_status = policy_status.get(org.id)
        results.append(dto)
    return results


# ── Organizations ───────────────────────────────────────────────────────────────

@router.post(
    "/{tenant_id}/organizations",
    response_model=OrganizationRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_organization(
    tenant_id: UUID,
    body: OrganizationCreate,
    session: AsyncSession = Depends(get_session),
) -> Organization:
    tenant = await session.get(Tenant, tenant_id)
    _verify_tenant(tenant, tenant_id)

    org = Organization(tenant_id=tenant_id, **body.model_dump())
    session.add(org)
    await session.commit()
    await session.refresh(org)
    return org


@router.get(
    "/{tenant_id}/organizations",
    response_model=List[OrganizationRead],
    dependencies=[Depends(verify_admin)],
)
async def list_organizations(
    tenant_id: UUID,
    search: Optional[str] = Query(None, description="Matches name, registration number, industry, or contact person"),
    category: Optional[OrganizationCategory] = Query(None, description="active | in_progress | new"),
    branch_id: Optional[UUID] = None,
    assigned_agent_id: Optional[UUID] = None,
    city: Optional[str] = None,
    province: Optional[str] = None,
    created_from: Optional[date] = None,
    created_to: Optional[date] = None,
    session: AsyncSession = Depends(get_session),
):
    query = select(Organization).where(Organization.tenant_id == tenant_id)
    term = (search or "").strip()
    if term:
        like = f"%{term}%"
        query = query.where(
            or_(
                Organization.name.ilike(like),
                Organization.registration_number.ilike(like),
                Organization.industry.ilike(like),
                Organization.contact_person.ilike(like),
            )
        )
    if branch_id:
        query = query.where(Organization.branch_id == branch_id)
    if assigned_agent_id:
        query = query.where(Organization.assigned_agent_id == assigned_agent_id)
    if city:
        query = query.where(Organization.city.ilike(f"%{city}%"))
    if province:
        query = query.where(Organization.province.ilike(f"%{province}%"))
    if created_from:
        query = query.where(Organization.created_at >= created_from)
    if created_to:
        query = query.where(Organization.created_at < created_to + timedelta(days=1))
    query = query.order_by(Organization.created_at.desc())
    orgs = list((await session.exec(query)).all())

    results = await _enrich_organizations(tenant_id, orgs, session)
    if category:
        results = [dto for dto in results if _org_category(dto) == category]
    return results


@router.get(
    "/{tenant_id}/organizations/stats",
    response_model=OrganizationStatsRead,
    dependencies=[Depends(verify_admin)],
)
async def get_organization_stats(tenant_id: UUID, session: AsyncSession = Depends(get_session)):
    orgs = list((await session.exec(select(Organization).where(Organization.tenant_id == tenant_id))).all())
    enriched = await _enrich_organizations(tenant_id, orgs, session)
    active = sum(1 for dto in enriched if _org_category(dto) == "active")
    in_progress = sum(1 for dto in enriched if _org_category(dto) == "in_progress")
    return OrganizationStatsRead(
        total_organizations=len(enriched),
        active=active,
        in_progress=in_progress,
        new_no_policy=len(enriched) - active - in_progress,
    )


@router.get(
    "/{tenant_id}/organizations/{org_id}",
    response_model=OrganizationRead,
    dependencies=[Depends(verify_admin)],
)
async def get_organization(tenant_id: UUID, org_id: UUID, session: AsyncSession = Depends(get_session)):
    org = await _get_organization(tenant_id, org_id, session)
    return (await _enrich_organizations(tenant_id, [org], session))[0]


@router.get(
    "/{tenant_id}/organizations/{org_id}/employees",
    response_model=List[CustomerRead],
    dependencies=[Depends(verify_admin)],
)
async def list_organization_employees(tenant_id: UUID, org_id: UUID, session: AsyncSession = Depends(get_session)):
    await _get_organization(tenant_id, org_id, session)
    employee_ids = await _org_employee_ids(tenant_id, org_id, session)
    if not employee_ids:
        return []
    result = await session.exec(
        select(Customer).where(Customer.tenant_id == tenant_id, Customer.id.in_(employee_ids))
    )
    return list(result.all())

@router.get(
    "/{tenant_id}/organizations/{org_id}/cases",
    dependencies=[Depends(verify_admin)],
)
async def list_organization_cases(tenant_id: UUID, org_id: UUID, session: AsyncSession = Depends(get_session)):
    """One row per employee that has an underwriting Case — powers the
    per-employee "Proceed to Underwriting" action on the roster. Guaranteed-
    issue employees (at/under the Free Cover Limit) never get a Case, so
    they're simply absent from this list."""
    await _get_organization(tenant_id, org_id, session)

    # Census-created employees: all their cases (unchanged behaviour). Reused
    # customers (e.g. individual policyholders): only cases on their group
    # certificate — their individual underwriting cases aren't this org's.
    own_ids = list((await session.exec(
        select(Customer.id).where(Customer.tenant_id == tenant_id, Customer.organization_id == org_id)
    )).all())
    certificate_ids = [p.id for p in await _org_certificates(tenant_id, org_id, session)]
    if not own_ids and not certificate_ids:
        return []

    cases = (await session.exec(
        select(Case)
        .where(
            Case.tenant_id == tenant_id,
            or_(Case.customer_id.in_(own_ids), Case.policy_id.in_(certificate_ids)),
        )
        .order_by(Case.createdAt.desc())
    )).all()

    seen: set = set()
    out = []
    for c in cases:
        if c.customer_id in seen:
            continue
        seen.add(c.customer_id)
        out.append({
            "customer_id": str(c.customer_id),
            "case_id": str(c.caseld),
            "case_number": c.caseNumber,
            "case_status": c.caseStatus.value,
        })
    return out


@router.delete(
    "/{tenant_id}/organizations/{org_id}/employees/{employee_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_organization_employee(tenant_id: UUID, org_id: UUID, employee_id: UUID, session: AsyncSession = Depends(get_session)):
    """Remove an employee from this organization's group cover: their group
    certificates (and memberships) go; the Customer itself goes only if the
    census created it and nothing else of theirs remains (_release_employee)."""
    await _get_organization(tenant_id, org_id, session)
    customer = await session.get(Customer, employee_id)
    if not customer or customer.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found.")
    certificates = await _org_certificates(tenant_id, org_id, session, customer_id=employee_id)
    if customer.organization_id != org_id and not certificates:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found.")

    for policy in certificates:
        await _delete_policy_cascade(session, policy)
    await _release_employee(session, customer, org_id)
    await session.commit()
    return None


@router.patch(
    "/{tenant_id}/organizations/{org_id}",
    response_model=OrganizationRead,
    dependencies=[Depends(verify_admin)],
)
async def update_organization(
    tenant_id: UUID,
    org_id: UUID,
    body: OrganizationUpdate,
    session: AsyncSession = Depends(get_session)
):
    org = await _get_organization(tenant_id, org_id, session)
    update_data = body.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(org, key, value)
    
    session.add(org)
    await session.commit()
    await session.refresh(org)
    return org


@router.delete(
    "/{tenant_id}/organizations/{org_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_organization(
    tenant_id: UUID,
    org_id: UUID,
    session: AsyncSession = Depends(get_session)
):
    org = await _get_organization(tenant_id, org_id, session)

    # 1. Every group certificate under this organization's master policies.
    employee_ids = await _org_employee_ids(tenant_id, org_id, session)
    employees = list((await session.exec(
        select(Customer).where(Customer.tenant_id == tenant_id, Customer.id.in_(employee_ids))
    )).all()) if employee_ids else []
    for policy in await _org_certificates(tenant_id, org_id, session):
        await _delete_policy_cascade(session, policy)

    # 2. Employees — census-created ones are deleted, reused customers kept.
    for employee in employees:
        await _release_employee(session, employee, org_id)
    await session.flush()

    # 3. Master policies (benefit classes / members cascade in the DB), then the org.
    for mp in (await session.exec(select(MasterPolicy).where(MasterPolicy.organization_id == org_id))).all():
        await session.delete(mp)
    await session.flush()
    await session.delete(org)
    await session.commit()


# ── Master policies ─────────────────────────────────────────────────────────────

@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies",
    response_model=MasterPolicyRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_master_policy(
    tenant_id: UUID,
    org_id: UUID,
    body: MasterPolicyCreate,
    session: AsyncSession = Depends(get_session),
) -> MasterPolicyRead:
    await _get_organization(tenant_id, org_id, session)

    errors = validate_sum_assured_multiple(body.sum_assured_multiple)
    if errors:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=errors)
    plan = await _resolve_group_plan(tenant_id, body.plan_code, session)

    mp = MasterPolicy(
        tenant_id=tenant_id,
        organization_id=org_id,
        insurance_type=InsuranceTypeEnum.GROUP_LIFE,
        sum_assured_multiple=body.sum_assured_multiple,
        term_years=body.term_years,
        effective_date=body.effective_date,
        status="Pending",
        plan_id=plan.id if plan is not None else None,
    )
    session.add(mp)
    await session.commit()
    await session.refresh(mp)
    return await _master_policy_read(mp, session)


@router.get(
    "/{tenant_id}/organizations/{org_id}/master-policies",
    response_model=List[MasterPolicyRead],
    dependencies=[Depends(verify_admin)],
)
async def list_master_policies(tenant_id: UUID, org_id: UUID, session: AsyncSession = Depends(get_session)):
    await _get_organization(tenant_id, org_id, session)
    result = await session.exec(
        select(MasterPolicy).where(MasterPolicy.tenant_id == tenant_id, MasterPolicy.organization_id == org_id)
    )
    return [await _master_policy_read(mp, session) for mp in result.all()]


# ── Benefit classes ─────────────────────────────────────────────────────────────
# Editable only while the master policy has no members: changing a class after
# enrolment changes members' cover, which is an endorsement (Phase 4).

async def _benefit_class_read(cls: GroupBenefitClass, session: AsyncSession) -> BenefitClassRead:
    dto = BenefitClassRead.model_validate(cls)
    dto.coverages = list((await session.exec(
        select(GroupClassCoverage).where(GroupClassCoverage.benefit_class_id == cls.id)
    )).all())
    return dto


async def _require_no_members(master_policy_id: UUID, session: AsyncSession) -> None:
    if (await session.exec(select(GroupMember.id).where(GroupMember.master_policy_id == master_policy_id))).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Benefit classes can't change once employees are enrolled — use an endorsement.",
        )


@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/benefit-classes",
    response_model=BenefitClassRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def create_benefit_class(
    tenant_id: UUID,
    org_id: UUID,
    mp_id: UUID,
    body: BenefitClassCreate,
    session: AsyncSession = Depends(get_session),
) -> BenefitClassRead:
    await _get_master_policy(tenant_id, org_id, mp_id, session)
    await _require_no_members(mp_id, session)

    spec = body.model_dump()
    errors = validate_benefit_class(spec)
    if errors:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=errors)

    existing = await _benefit_classes(mp_id, session)
    if any(c.name.strip().lower() == body.name.strip().lower() for c in existing):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Benefit class '{body.name}' already exists.")
    if body.is_default and any(c.is_default for c in existing):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This master policy already has a default class.")
    if body.grades:
        taken = {str(g).strip().lower(): c.name for c in existing for g in (c.grades or [])}
        clashes = sorted({g for g in body.grades if g.strip().lower() in taken})
        if clashes:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Grade(s) already mapped to another class: {', '.join(clashes)}")

    cls = GroupBenefitClass(
        tenant_id=tenant_id,
        master_policy_id=mp_id,
        name=body.name.strip(),
        basis=body.basis,
        flat_amount=body.flat_amount,
        salary_multiple=body.salary_multiple,
        service_bands=spec["service_bands"],
        grades=body.grades,
        min_cover=body.min_cover,
        max_cover=body.max_cover,
        is_default=body.is_default,
    )
    session.add(cls)
    await session.flush()
    session.add(GroupClassCoverage(
        tenant_id=tenant_id, benefit_class_id=cls.id,
        coverage_type=GroupCoverageType.LIFE.value, percent_of_base=100.0,
    ))
    await session.commit()
    await session.refresh(cls)
    return await _benefit_class_read(cls, session)


@router.get(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/benefit-classes",
    response_model=List[BenefitClassRead],
    dependencies=[Depends(verify_admin)],
)
async def list_benefit_classes(tenant_id: UUID, org_id: UUID, mp_id: UUID, session: AsyncSession = Depends(get_session)):
    await _get_master_policy(tenant_id, org_id, mp_id, session)
    return [await _benefit_class_read(c, session) for c in await _benefit_classes(mp_id, session)]


@router.delete(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/benefit-classes/{class_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_admin)],
)
async def delete_benefit_class(tenant_id: UUID, org_id: UUID, mp_id: UUID, class_id: UUID, session: AsyncSession = Depends(get_session)):
    await _get_master_policy(tenant_id, org_id, mp_id, session)
    await _require_no_members(mp_id, session)
    cls = await session.get(GroupBenefitClass, class_id)
    if not cls or cls.master_policy_id != mp_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Benefit class not found.")
    await session.delete(cls)
    await session.commit()
    return None


# ── Employee census ──────────────────────────────────────────────────────────────

async def _census_context(master_policy: MasterPolicy, session: AsyncSession):
    """(already-enrolled CNICs, benefit classes, plan, min_group_size). The
    plan's minimum group size applies to a master policy's first census only —
    a top-up batch for an existing roster can be any size."""
    enrolled = await _enrolled_cnics(master_policy.id, session)
    classes = await _benefit_classes(master_policy.id, session)
    plan = await session.get(InsurancePlan, master_policy.plan_id) if master_policy.plan_id else None
    min_group_size = plan.min_group_size if plan is not None and not enrolled else None
    return enrolled, classes, plan, min_group_size


@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/census/validate",
    response_model=CensusValidationResponse,
    dependencies=[Depends(verify_admin)],
)
async def validate_employee_census(
    tenant_id: UUID,
    org_id: UUID,
    mp_id: UUID,
    body: CensusRequest,
    session: AsyncSession = Depends(get_session),
):
    master_policy = await _get_master_policy(tenant_id, org_id, mp_id, session)
    enrolled, classes, _plan, min_group_size = await _census_context(master_policy, session)
    result = validate_scheme_census(enrolled, body.employees, classes, min_group_size)

    # Preview only — nothing persisted. Only computed when the batch is valid;
    # a malformed row (e.g. bad dob) would otherwise crash average_age() before
    # the caller ever sees the validation errors.
    computed_fcl: Optional[float] = None
    if result.is_valid:
        computed_fcl = compute_free_cover_limit(len(body.employees), average_age(body.employees))

    return CensusValidationResponse(
        **result.model_dump(),
        computed_free_cover_limit=computed_fcl,
    )


@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/census/confirm",
    response_model=CensusConfirmResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def confirm_employee_census(
    tenant_id: UUID,
    org_id: UUID,
    mp_id: UUID,
    body: CensusRequest,
    session: AsyncSession = Depends(get_session),
):
    master_policy = await _get_master_policy(tenant_id, org_id, mp_id, session)
    enrolled, classes, scheme_plan, min_group_size = await _census_context(master_policy, session)
    result = validate_scheme_census(enrolled, body.employees, classes, min_group_size)
    if not result.is_valid:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=result.model_dump())

    # ── Pass 1: parse rows, resolve FCL, resolve risk-engine calls ───────────
    # No DB session/transaction held open across this — network I/O to
    # risk-engine happens entirely before Pass 2 starts writing.
    parsed_rows: List[Dict[str, Any]] = []
    for row in body.employees:
        try:
            dob = row["dob"] if isinstance(row["dob"], date) else date.fromisoformat(str(row["dob"]))
            declared_income = float(row["declared_income"])
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid employee row for CNIC '{row.get('cnic', '?')}': {exc}",
            )
        parsed_rows.append({**row, "_dob": dob, "_declared_income": declared_income})

    # Only computed on the first confirm — a later top-up batch reuses the
    # existing FCL so it can't retroactively change the guaranteed-issue/
    # above-FCL split already applied to the existing roster.
    if master_policy.free_cover_limit is None:
        free_cover_limit = compute_free_cover_limit(len(parsed_rows), average_age(body.employees))
    else:
        free_cover_limit = master_policy.free_cover_limit

    # Benefit-class cover (or the legacy flat multiple when the scheme has no
    # classes); service is measured to the scheme's effective date.
    for row in parsed_rows:
        row["_class"], row["_coverage_amount"] = member_cover(
            row, classes, master_policy.sum_assured_multiple, as_of=master_policy.effective_date,
        )

    above_fcl_rows = [row for row in parsed_rows if row["_coverage_amount"] > free_cover_limit]

    risk_results: Dict[str, Optional[dict]] = {}
    if above_fcl_rows:
        semaphore = asyncio.Semaphore(_RISK_ENGINE_CONCURRENCY)

        async def _evaluate(row: Dict[str, Any]) -> Optional[dict]:
            customer_payload = {
                "cnic": normalize_cnic(row["cnic"]) or row["cnic"],
                "name": row["name"],
                "dob": row["_dob"].isoformat(),
                "gender": row["gender"],
                "occupation": row["occupation"],
                "declared_income": row["_declared_income"],
                "is_smoker": bool(row.get("is_smoker", False)),
                "height_cm": float(row.get("height_cm", 170)),
                "weight_kg": float(row.get("weight_kg", 70)),
            }
            policy_payload = {
                "product_name": "Group Life",
                "insurance_type": master_policy.insurance_type.value,
                "coverage_amount": row["_coverage_amount"],
                # Always 1 — risk-engine's GROUP_LIFE band is an
                # annually-renewable certificate, independent of
                # master_policy.term_years (the multi-year contract term
                # persisted on Policy.term_years below).
                "term_years": 1,
            }
            async with semaphore:
                return await evaluate_group_member(customer_payload, policy_payload, str(tenant_id))

        results = await asyncio.gather(*[_evaluate(row) for row in above_fcl_rows])
        risk_results = {row["cnic"]: res for row, res in zip(above_fcl_rows, results)}

    # ── Pass 2: DB-only — build rows and commit once ─────────────────────────
    group_plan = scheme_plan or (await session.exec(
        select(InsurancePlan).where(
            InsurancePlan.tenant_id == tenant_id,
            InsurancePlan.code == "GROUP_LIFE",
        )
    )).first()
    if group_plan is None:
        logger.warning(
            "no GROUP_LIFE InsurancePlan for tenant=%s — pricing at fallback rate", tenant_id
        )

    audit_user = (await session.exec(select(User).where(User.tenant_id == tenant_id))).first()

    # A CNIC that already belongs to this insurer's customer (an individual
    # policyholder, a family member, an employee of another scheme) is reused —
    # CNIC is unique per tenant — and that profile is left untouched.
    batch_cnics = [normalize_cnic(r["cnic"]) or r["cnic"] for r in parsed_rows]
    existing_customers = {
        c.cnic: c for c in (await session.exec(
            select(Customer).where(Customer.tenant_id == tenant_id, Customer.cnic.in_(batch_cnics))
        )).all()
    }

    outcomes: List[CensusEmployeeOutcome] = []
    customers_to_promote: List[Customer] = []
    for row in parsed_rows:
        is_smoker = bool(row.get("is_smoker", False))
        height_cm = float(row.get("height_cm", 170))
        weight_kg = float(row.get("weight_kg", 70))
        cnic = normalize_cnic(row["cnic"]) or row["cnic"]

        customer = existing_customers.get(cnic)
        reused = customer is not None
        if customer is None:
            customer = Customer(
                tenant_id=tenant_id,
                organization_id=org_id,
                cnic=cnic,
                name=row["name"],
                dob=row["_dob"],
                gender=row["gender"],
                occupation=row["occupation"],
                declared_income=row["_declared_income"],
                is_smoker=is_smoker,
                height_cm=height_cm,
                weight_kg=weight_kg,
            )
            session.add(customer)
            customers_to_promote.append(customer)
            await session.flush()

        coverage_amount = row["_coverage_amount"]
        above_fcl = coverage_amount > free_cover_limit

        # Starts as a Quoted DRAFT — the employee is still risk-scored below (and
        # the guaranteed-issue vs above-FCL split is recorded on the Case), but
        # the proposal surfaces in the Proposal Draft section and is advanced to
        # Under Review / Approved manually via the status control, not auto-set.
        policy = Policy(
            tenant_id=tenant_id,
            customer_id=customer.id,
            master_policy_id=master_policy.id,
            product_name=group_plan.label if group_plan is not None else "Group Life",
            insurance_type=master_policy.insurance_type,
            coverage_amount=coverage_amount,
            term_years=master_policy.term_years,
            status=PolicyStatusEnum.QUOTED,
        )
        session.add(policy)
        await session.flush()

        benefit_class = row["_class"]
        member = GroupMember(
            tenant_id=tenant_id,
            master_policy_id=master_policy.id,
            customer_id=customer.id,
            policy_id=policy.id,
            benefit_class_id=benefit_class.id if benefit_class is not None else None,
            employee_id=optional_text(row.get("employee_id")),
            designation=optional_text(row.get("designation")),
            grade=optional_text(row.get("grade")),
            basic_monthly_salary=basic_monthly_salary(row),
            joining_date=parse_date(row.get("joining_date")),
            coverage_amount=coverage_amount,
            cover_start_date=master_policy.effective_date,
            status=GroupMemberStatus.PENDING.value,
        )
        session.add(member)
        await session.flush()

        risk_assessment_id: Optional[UUID] = None
        suggested_loading: Optional[float] = None

        if above_fcl:
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

            ai_result = risk_results.get(row["cnic"])
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

                # AI decision is recorded on the Case (below); the proposal Policy
                # stays a Quoted DRAFT and is advanced via the Proposal status control.
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
            # else: risk-engine unreachable/errored (or returned a non-200) —
            # Case stays New; an underwriter can still work it manually. The
            # proposal Policy is a Quoted DRAFT regardless. Logged in risk_client.py.

        # Always price — both guaranteed-issue and above-FCL members get an
        # indicative premium, same reuse of calculate_premium() as
        # api-gateway/quote_worker.py uses for individual plans.
        age = age_from_dob(row["_dob"])
        breakdown = calculate_premium(
            coverage_amount=coverage_amount,
            base_premium_rate=group_plan.base_premium_rate if group_plan is not None else _FALLBACK_GROUP_RATE,
            smoker_factor=group_plan.smoker_factor if group_plan is not None else 1.0,
            age=age,
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
            rate_version=group_plan.rate_version if group_plan is not None else "fallback-v1",
        )
        session.add(premium_quote)

        outcomes.append(CensusEmployeeOutcome(
            customer_id=customer.id,
            policy_id=policy.id,
            coverage_amount=coverage_amount,
            status=policy.status,
            premium_total=breakdown.total_premium,
            suggested_loading=suggested_loading,
            risk_assessment_id=risk_assessment_id,
            group_member_id=member.id,
            benefit_class=benefit_class.name if benefit_class is not None else None,
            reused_existing_customer=reused,
        ))

    # Confirming the employee census produces a PROPOSAL, not an in-force group
    # contract — the MasterPolicy is "Proposed" so the org stays on the Leads
    # board (category in_progress) with its quotes in the Proposal Draft section.
    # profile_status is left as-is (LEAD) so the org keeps its manual "In Progress"
    # button, just like an individual lead. Only a later issuance step marks the
    # master policy "Active" / the org a POLICYHOLDER.
    master_policy.status = "Proposed"
    if master_policy.free_cover_limit is None:
        master_policy.free_cover_limit = free_cover_limit
    session.add(master_policy)

    from shared.models.core import Organization
    org = await session.get(Organization, org_id)
    if org:
        session.add(org)

    for cust in customers_to_promote:
        session.add(cust)

    await session.commit()

    return CensusConfirmResponse(free_cover_limit=free_cover_limit, employees=outcomes)
