"""
Policy document persistence — bridges the pure PDF renderer
(services/document_generator.py) to the DB.

Kept router-free so both routers/policies.py (issuance) and
routers/pre_issuance.py (regenerate endpoint) can call it without an import
cycle.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from services import document_generator
from services.insurer_config import NOTICE_VALIDITY_DAYS
from shared.models.core import (
    Beneficiary,
    Customer,
    Policy,
    PolicyDocument,
    PolicyDocumentTypeEnum,
    PolicyVersion,
    PremiumQuote,
    PremiumSchedule,
    Tenant,
    User,
)


async def build_document_context(session: AsyncSession, policy: Policy) -> dict:
    """Flatten Policy / Customer / Tenant / PolicyVersion / Beneficiary /
    PremiumSchedule / Agent into the dict the PDF renderer consumes.

    Extended fields added for the enriched Premium Notice:
    - customer_dob, customer_city, customer_province (from Customer)
    - tenant_address, tenant_reg_no, tenant_license_no, tenant_phone,
      tenant_email, tenant_website (from Tenant)
    - billing_frequency, billing_period_start, billing_period_end, due_date
      (from PremiumSchedule)
    - agent_name (from Customer.assigned_agent_id → User)
    - loadings_text (from PolicyVersion.loadings_json)
    - issue_date, challan_ref (computed)
    """
    customer = await session.get(Customer, policy.customer_id)
    tenant = await session.get(Tenant, policy.tenant_id)
    tenant_name = tenant.name if tenant else "Insurer"

    version = (await session.exec(
        select(PolicyVersion).where(PolicyVersion.policy_id == policy.id)
        .order_by(PolicyVersion.created_at.desc())  # type: ignore[arg-type]
    )).first()

    if version:
        pb = {"base_premium": version.base_premium, "loading_amount": version.loading_amount,
              "policy_fee": version.policy_fee, "tax_amount": version.tax_amount,
              "total_premium": version.total_premium}
        exclusions = list(version.exclusions_json.get("items", [])) if version.exclusions_json else []
        # Build a human-readable underwriting-terms line
        if version.loading_amount and version.loading_amount > 0:
            loadings_json = version.loadings_json or {}
            reasons = loadings_json.get("reasons", [])
            reasons_str = "; ".join(reasons) if reasons else "medical/occupational factors"
            loadings_text = f"Accepted with underwriting loading of PKR {version.loading_amount:,.0f} ({reasons_str})."
        else:
            loadings_text = "Accepted at ordinary (standard) rates — no underwriting loading applied."
    else:
        quote = (await session.exec(
            select(PremiumQuote).where(PremiumQuote.policy_id == policy.id)
            .order_by(PremiumQuote.created_at.desc())  # type: ignore[arg-type]
        )).first()
        pb = {"base_premium": quote.base_premium, "loading_amount": quote.loading_applied,
              "total_premium": quote.total_premium} if quote else {}
        exclusions = []
        loadings_text = "Terms to be confirmed by underwriting."

    bens = (await session.exec(select(Beneficiary).where(Beneficiary.policy_id == policy.id))).all()

    # ── PremiumSchedule — billing frequency + period ──────────────────────────
    schedule = (await session.exec(
        select(PremiumSchedule).where(PremiumSchedule.policy_id == policy.id)
        .order_by(PremiumSchedule.created_at.desc())  # type: ignore[arg-type]
    )).first()

    billing_frequency = schedule.billing_frequency.value if schedule and hasattr(schedule.billing_frequency, "value") else (schedule.billing_frequency if schedule else "Annual")
    schedule_due_date: Optional[date] = schedule.due_date if schedule else None
    payment_reference: Optional[str] = schedule.payment_reference if schedule else None

    # ── Agent lookup ──────────────────────────────────────────────────────────
    agent_name: Optional[str] = None
    if customer and customer.assigned_agent_id:
        agent = await session.get(User, customer.assigned_agent_id)
        if agent:
            agent_name = agent.full_name

    # ── Computed notice fields ─────────────────────────────────────────────────
    issue_date = date.today()
    due_date = schedule_due_date or (issue_date + timedelta(days=NOTICE_VALIDITY_DAYS))
    policy_num = policy.policy_number or "DRAFT"
    challan_ref = payment_reference or f"CHALLAN-{policy_num}"

    # ── Customer calculated age ───────────────────────────────────────────────
    customer_age: Optional[int] = None
    if customer and customer.dob:
        today = date.today()
        customer_age = today.year - customer.dob.year - (
            (today.month, today.day) < (customer.dob.month, customer.dob.day)
        )

    return {
        # Core policy fields
        "policy_id": policy.id,
        "policy_number": policy.policy_number,
        "product_name": policy.product_name,
        "insurance_type": policy.insurance_type.value if hasattr(policy.insurance_type, "value") else str(policy.insurance_type),
        "coverage_amount": policy.coverage_amount,
        "term_years": policy.term_years,
        "effective_date": policy.effective_date.isoformat() if policy.effective_date else None,
        "expiry_date": policy.expiry_date.isoformat() if policy.expiry_date else None,

        # Customer
        "customer_name": customer.name if customer else "—",
        "customer_cnic": customer.cnic if customer else None,
        "customer_dob": customer.dob.isoformat() if (customer and customer.dob) else None,
        "customer_age": customer_age,
        "customer_city": customer.city if customer else None,
        "customer_province": customer.province if customer else None,

        # Tenant / insurer
        "tenant_name": tenant_name,
        "tenant_address": tenant.head_office_address if tenant else None,
        "tenant_city": tenant.city if tenant else None,
        "tenant_province": tenant.province if tenant else None,
        "tenant_reg_no": tenant.registration_number if tenant else None,
        "tenant_license_no": tenant.license_number if tenant else None,
        "tenant_phone": tenant.contact_phone if tenant else None,
        "tenant_email": tenant.contact_email if tenant else None,
        "tenant_website": tenant.website if tenant else None,

        # Premium
        "premium_breakdown": pb,
        "billing_frequency": billing_frequency,
        "due_date": due_date.isoformat(),

        # Notice meta
        "issue_date": issue_date.isoformat(),
        "challan_ref": challan_ref,

        # Underwriting
        "loadings_text": loadings_text,
        "exclusions": exclusions,

        # Beneficiaries & agent
        "beneficiaries": [{"name": b.name, "relationship": b.relationship, "share_pct": b.share_pct} for b in bens],
        "agent_name": agent_name,
    }


async def generate_and_store_documents(session: AsyncSession, policy: Policy,
                                       policy_version_id: Optional[UUID] = None) -> list[PolicyDocument]:
    """Render the three PDFs and (re)write their PolicyDocument rows. Rows are
    added to the session; the caller commits."""
    ctx = await build_document_context(session, policy)
    generated = document_generator.generate_policy_documents(ctx)

    for old in (await session.exec(select(PolicyDocument).where(PolicyDocument.policy_id == policy.id))).all():
        if (old.document_type.value if hasattr(old.document_type, "value") else str(old.document_type)) != PolicyDocumentTypeEnum.PREMIUM_NOTICE.value:
            await session.delete(old)

    rows: list[PolicyDocument] = []
    for g in generated:
        doc = PolicyDocument(
            policy_id=policy.id,
            policy_version_id=policy_version_id,
            document_type=PolicyDocumentTypeEnum(g["document_type"]),
            document_name=g["document_name"],
            storage_url=g["file_path"],
            stub_content=None,
            is_stub=False,
        )
        session.add(doc)
        rows.append(doc)
    return rows


async def generate_and_store_premium_notice(session: AsyncSession, policy: Policy,
                                            policy_version_id: Optional[UUID] = None) -> PolicyDocument:
    """Render the Premium Notice PDF and (re)write its PolicyDocument row.
    Row is added to the session; the caller commits."""
    ctx = await build_document_context(session, policy)
    g = document_generator.generate_premium_notice(ctx)

    for old in (await session.exec(select(PolicyDocument).where(
            PolicyDocument.policy_id == policy.id,
            PolicyDocument.document_type == PolicyDocumentTypeEnum.PREMIUM_NOTICE
    ))).all():
        await session.delete(old)

    doc = PolicyDocument(
        policy_id=policy.id,
        policy_version_id=policy_version_id,
        document_type=PolicyDocumentTypeEnum(g["document_type"]),
        document_name=g["document_name"],
        storage_url=g["file_path"],
        stub_content=None,
        is_stub=False,
    )
    session.add(doc)
    return doc


async def render_welcome_kit(session: AsyncSession, policy: Policy, extra: Optional[dict] = None) -> dict:
    """Render the Stage B welcome-kit PDF and return {document_name, file_path}.

    The caller (post_issuance onboarding endpoint) persists the path on
    PolicyOnboarding — the kit is an onboarding artifact, not a legal
    PolicyDocument, so no document row / enum value is created here.
    ``extra`` carries the onboarding-only context (policyholder_id, portal_url,
    portal_username, free_look_end_date) not present in the base document context.
    """
    ctx = await build_document_context(session, policy)
    if policy.free_look_end_date:
        ctx["free_look_end_date"] = policy.free_look_end_date.isoformat()
    if extra:
        ctx.update(extra)
    return document_generator.generate_welcome_kit(ctx)
