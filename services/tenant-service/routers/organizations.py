import asyncio
import logging
from datetime import date
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from decision_status import DECISION_CASE_STATUS, DECISION_POLICY_STATUS
from group_underwriting import (
    average_age,
    age_from_dob,
    compute_free_cover_limit,
    normalize_cnic,
    validate_census,
    validate_sum_assured_multiple,
)
from risk_client import evaluate_group_member
from routers.cases import generate_case_number
from schemas import (
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
    InsurancePlan,
    InsuranceTypeEnum,
    MasterPolicy,
    Organization,
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


async def _employee_counts(tenant_id: UUID, session: AsyncSession) -> Dict[UUID, int]:
    rows = (await session.execute(
        select(Customer.organization_id, func.count())
        .where(Customer.tenant_id == tenant_id, Customer.organization_id.is_not(None))
        .group_by(Customer.organization_id)
    )).all()
    return {oid: cnt for oid, cnt in rows}


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
    emp_counts = await _employee_counts(tenant_id, session)
    policy_status = await _master_policy_status_map(tenant_id, session)
    results = []
    for org in orgs:
        dto = OrganizationRead.model_validate(org)
        dto.employee_count = emp_counts.get(org.id, 0)
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
    result = await session.exec(
        select(Customer).where(Customer.tenant_id == tenant_id, Customer.organization_id == org_id)
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

    employee_ids = list((await session.exec(
        select(Customer.id).where(Customer.tenant_id == tenant_id, Customer.organization_id == org_id)
    )).all())
    if not employee_ids:
        return []

    cases = (await session.exec(
        select(Case)
        .where(Case.tenant_id == tenant_id, Case.customer_id.in_(employee_ids))
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
    await _get_organization(tenant_id, org_id, session)
    customer = await session.get(Customer, employee_id)
    if not customer or customer.tenant_id != tenant_id or customer.organization_id != org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found.")

    # Cascading delete for related records
    # 1. Artifacts & Risk Assessments (linked to customer)
    artifacts = await session.exec(select(Artifact).where(Artifact.customer_id == employee_id))
    for a in artifacts.all(): await session.delete(a)

    assessments = await session.exec(select(RiskAssessment).where(RiskAssessment.customer_id == employee_id))
    for a in assessments.all(): await session.delete(a)

    # 2. Policies and their downstream dependents
    policies = await session.exec(select(Policy).where(Policy.customer_id == employee_id))
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

    # 1. Cascade delete Master Policies
    master_policies = await session.exec(select(MasterPolicy).where(MasterPolicy.organization_id == org_id))
    for mp in master_policies.all():
        await session.delete(mp)

    # 2. Cascade delete all Employees
    employees = await session.exec(select(Customer).where(Customer.organization_id == org_id))
    for employee in employees.all():
        artifacts = await session.exec(select(Artifact).where(Artifact.customer_id == employee.id))
        for a in artifacts.all(): await session.delete(a)

        assessments = await session.exec(select(RiskAssessment).where(RiskAssessment.customer_id == employee.id))
        for a in assessments.all(): await session.delete(a)

        policies = await session.exec(select(Policy).where(Policy.customer_id == employee.id))
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

        await session.delete(employee)

    # 3. Finally, delete the Organization itself
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
) -> MasterPolicy:
    await _get_organization(tenant_id, org_id, session)

    errors = validate_sum_assured_multiple(body.sum_assured_multiple)
    if errors:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=errors)

    mp = MasterPolicy(
        tenant_id=tenant_id,
        organization_id=org_id,
        insurance_type=InsuranceTypeEnum.GROUP_LIFE,
        sum_assured_multiple=body.sum_assured_multiple,
        term_years=body.term_years,
        effective_date=body.effective_date,
        status="Pending",
    )
    session.add(mp)
    await session.commit()
    await session.refresh(mp)
    return mp


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
    return list(result.all())


# ── Employee census ──────────────────────────────────────────────────────────────

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
    await _get_master_policy(tenant_id, org_id, mp_id, session)

    existing = await session.exec(select(Customer.cnic).where(Customer.organization_id == org_id))
    existing_cnics = set(existing.all())

    result = validate_census(existing_cnics, body.employees)

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

    existing = await session.exec(select(Customer.cnic).where(Customer.organization_id == org_id))
    existing_cnics = set(existing.all())

    result = validate_census(existing_cnics, body.employees)
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

    for row in parsed_rows:
        row["_coverage_amount"] = (row["_declared_income"] / 12) * master_policy.sum_assured_multiple

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
    group_plan = (await session.exec(
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

    outcomes: List[CensusEmployeeOutcome] = []
    customers_to_promote: List[Customer] = []
    for row in parsed_rows:
        is_smoker = bool(row.get("is_smoker", False))
        height_cm = float(row.get("height_cm", 170))
        weight_kg = float(row.get("weight_kg", 70))

        customer = Customer(
            tenant_id=tenant_id,
            organization_id=org_id,
            cnic=normalize_cnic(row["cnic"]) or row["cnic"],
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

        policy = Policy(
            tenant_id=tenant_id,
            customer_id=customer.id,
            master_policy_id=master_policy.id,
            product_name="Group Life",
            insurance_type=master_policy.insurance_type,
            coverage_amount=coverage_amount,
            term_years=master_policy.term_years,
            status=PolicyStatusEnum.UNDER_REVIEW if above_fcl else PolicyStatusEnum.APPROVED,
        )
        session.add(policy)
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
            # else: risk-engine unreachable/errored (or returned a non-200) —
            # Policy stays UnderReview, Case stays New; an underwriter can
            # still work it manually. Logged inside risk_client.py.

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
        ))

    master_policy.status = "Active"
    if master_policy.free_cover_limit is None:
        master_policy.free_cover_limit = free_cover_limit
    session.add(master_policy)

    from shared.models.core import ProfileStatusEnum, Organization
    org = await session.get(Organization, org_id)
    if org:
        org.profile_status = ProfileStatusEnum.POLICYHOLDER
        session.add(org)
        
    for cust in customers_to_promote:
        cust.profile_status = ProfileStatusEnum.POLICYHOLDER
        session.add(cust)

    await session.commit()

    return CensusConfirmResponse(free_cover_limit=free_cover_limit, employees=outcomes)
