"""
POST /quote — instant, deterministic premium quotation.

Deliberately separate from POST /evaluate (routers/evaluate.py): that endpoint
runs the LangGraph AI underwriting pipeline (medical/financial/fraud scoring
via Gemini, over Kafka) and can take seconds to minutes. A quotation is pure
actuarial math — coverage, term, age, smoker/BMI factors against the tenant's
InsurancePlan rate table — and returns in one synchronous round-trip, the same
way a real insurer shows an indicative premium the moment you fill in the
onboarding form, before formal underwriting ever runs.

No Kafka, no LLM. Eligibility and rates are read straight from the tenant's
own InsurancePlan row (entry age band, term band, max_maturity_age,
max_income_multiple, base_premium_rate, smoker_factor) so a tenant admin's
edits via the Insurance Plans UI take effect immediately.
"""

from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from dependencies import get_tenant_id
from schemas import QuoteListItem, QuoteRequest, QuoteResponse
from shared.models.core import Applicant, InsurancePlan, InsuranceTypeEnum, Policy, PremiumQuote, Tenant
from shared.pricing.calculator import calculate_premium

router = APIRouter(tags=["Quotation"])


@router.get(
    "/quotes",
    response_model=list[QuoteListItem],
    summary="List all generated quotations for this tenant (manual + auto-generated)",
)
async def list_quotes(
    tenant_id: UUID = Depends(get_tenant_id),
    session: AsyncSession = Depends(get_session),
) -> list[QuoteListItem]:
    stmt = (
        select(PremiumQuote, Policy, Applicant)
        .join(Policy, PremiumQuote.policy_id == Policy.id)
        .join(Applicant, Policy.applicant_id == Applicant.id)
        .where(PremiumQuote.tenant_id == tenant_id)
        .order_by(PremiumQuote.created_at.desc())
    )
    rows = (await session.exec(stmt)).all()

    return [
        QuoteListItem(
            quote_id=quote.id,
            applicant_id=applicant.id,
            applicant_name=applicant.name,
            applicant_cnic=applicant.cnic,
            policy_id=policy.id,
            plan_label=policy.product_name,
            insurance_type=policy.insurance_type,
            coverage_amount=policy.coverage_amount,
            term_years=policy.term_years,
            base_premium=quote.base_premium,
            loading_applied=quote.loading_applied,
            total_premium=quote.total_premium,
            rate_version=quote.rate_version,
            created_at=quote.created_at,
        )
        for quote, policy, applicant in rows
    ]


def _age_from_dob(dob: date) -> int:
    return (date.today() - dob).days // 365


@router.post(
    "/quote",
    response_model=QuoteResponse,
    summary="Get an instant premium quote (no AI, no Kafka — synchronous)",
)
async def get_quote(
    request: QuoteRequest,
    tenant_id: UUID = Depends(get_tenant_id),
    session: AsyncSession = Depends(get_session),
) -> QuoteResponse:
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tenant '{tenant_id}' not found. Create it first via POST /tenants.",
        )

    # ── 1. Plan lookup ────────────────────────────────────────────────────────
    plan_stmt = select(InsurancePlan).where(
        InsurancePlan.tenant_id == tenant_id,
        InsurancePlan.code == request.policy.plan_code,
    )
    plan = (await session.exec(plan_stmt)).first()
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No plan with code '{request.policy.plan_code}' found for this tenant.",
        )
    if plan.insurance_type == InsuranceTypeEnum.GROUP_LIFE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="GROUP_LIFE plans are priced per-MasterPolicy, not via /quote.",
        )

    # ── 2. Eligibility — against the plan's own DB-stored bands ───────────────
    applicant_in = request.applicant
    policy_in = request.policy
    age = _age_from_dob(applicant_in.dob)
    annual_income = applicant_in.monthly_income * 12

    errors: list[str] = []
    if age < plan.entry_age_min or age > plan.entry_age_max:
        errors.append(
            f"[{plan.label}] Applicant age {age} is outside the eligible entry band "
            f"({plan.entry_age_min}-{plan.entry_age_max})."
        )
    if policy_in.term_years < plan.term_min_years or policy_in.term_years > plan.term_max_years:
        errors.append(
            f"[{plan.label}] Policy term must be between {plan.term_min_years} and "
            f"{plan.term_max_years} years (got {policy_in.term_years})."
        )
    if age + policy_in.term_years > plan.max_maturity_age:
        errors.append(
            f"[{plan.label}] Maturity age ({age + policy_in.term_years}) exceeds "
            f"maximum of {plan.max_maturity_age}."
        )
    if policy_in.coverage_amount > annual_income * plan.max_income_multiple:
        errors.append(
            f"[{plan.label}] Coverage amount ({policy_in.coverage_amount:,.0f}) exceeds "
            f"{plan.max_income_multiple:g}x annual income "
            f"({annual_income * plan.max_income_multiple:,.0f})."
        )

    if errors:
        return QuoteResponse(eligible=False, eligibility_errors=errors)

    # ── 3. Premium calculation ─────────────────────────────────────────────────
    breakdown = calculate_premium(
        coverage_amount=policy_in.coverage_amount,
        base_premium_rate=plan.base_premium_rate,
        smoker_factor=plan.smoker_factor,
        age=age,
        is_smoker=applicant_in.is_smoker,
        height_cm=applicant_in.height_cm,
        weight_kg=applicant_in.weight_kg,
    )

    # ── 4. Persist — find-or-create Applicant, create Policy + PremiumQuote ──
    applicant_stmt = select(Applicant).where(
        Applicant.tenant_id == tenant_id,
        Applicant.cnic == applicant_in.cnic,
    )
    applicant = (await session.exec(applicant_stmt)).first()
    if applicant is None:
        applicant = Applicant(
            tenant_id=tenant_id,
            cnic=applicant_in.cnic,
            name=applicant_in.name,
            dob=applicant_in.dob,
            gender=applicant_in.gender,
            occupation=applicant_in.occupation,
            declared_income=annual_income,
            is_smoker=applicant_in.is_smoker,
            height_cm=applicant_in.height_cm,
            weight_kg=applicant_in.weight_kg,
        )
        session.add(applicant)
        await session.flush()

    policy = Policy(
        tenant_id=tenant_id,
        applicant_id=applicant.id,
        product_name=plan.label,
        insurance_type=plan.insurance_type,
        coverage_amount=policy_in.coverage_amount,
        term_years=policy_in.term_years,
        nominee_name=policy_in.nominee_name,
        nominee_relationship=policy_in.nominee_relationship,
    )
    session.add(policy)
    await session.flush()

    quote = PremiumQuote(
        tenant_id=tenant_id,
        policy_id=policy.id,
        base_premium=breakdown.base_premium,
        loading_applied=breakdown.loading_applied,
        total_premium=breakdown.total_premium,
        rate_version=plan.rate_version,
    )
    session.add(quote)
    await session.commit()
    await session.refresh(quote)

    return QuoteResponse(
        eligible=True,
        quote_id=quote.id,
        applicant_id=applicant.id,
        policy_id=policy.id,
        annual_income=annual_income,
        plan_code=plan.code,
        plan_label=plan.label,
        coverage_amount=policy_in.coverage_amount,
        term_years=policy_in.term_years,
        base_premium=breakdown.base_premium,
        loading_applied=breakdown.loading_applied,
        total_premium=breakdown.total_premium,
        rate_version=plan.rate_version,
        reasons=breakdown.reasons,
        created_at=quote.created_at,
    )
