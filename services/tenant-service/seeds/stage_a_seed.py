"""Seed a legitimate end-to-end funnel: Leads → Proposal → Underwriting → Approved.

Every customer below is a distinct fictional Pakistani applicant carried to a
specific point in the lifecycle, with the *full chain of linked rows* so every
screen has real, clickable data instead of hard-coded mock arrays:

    Customer → PremiumQuote → Case (Underwriting) → RiskAssessment → Policy
             → PolicyEvent (immutable audit trail)

Scenarios span the whole funnel so each queue is populated:

  • Lead                — Policy Quoted, no case yet          (Leads / Proposal)
  • Proposed            — Policy Proposed, Case New            (Proposal / Underwriting)
  • Under Review        — Case Under Review, Human Review AI   (Underwriting)
  • Approve w/ Loading  — Case Under Review, loaded AI         (Underwriting → counter-offer)
  • Information Req.     — Policy InformationRequested          (Underwriting)
  • Approved (clean)    — Policy Approved, ready to issue       (Policy Issuance queue)
  • Approved (loaded)   — Policy AcceptedWithLoadings           (Policy Issuance queue)
  • Declined            — Policy Declined, Case Rejected        (audit / reporting)

Idempotent: any CNIC already present for the tenant is skipped, so it is safe to
run repeatedly. Phase 2/3 layer counter-offer, requirement and compliance rows
onto these same customers.

Run inside the tenant-service container:

    docker compose exec tenant-service python -m seeds.stage_a_seed --all-tenants
    docker compose exec tenant-service python -m seeds.stage_a_seed --tenant-id <uuid>
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import random
from datetime import date, datetime, timedelta
from typing import Optional
from uuid import UUID

from sqlalchemy import delete as sa_delete, update as sa_update
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import (
    AIDecision,
    Beneficiary,
    Case,
    CasePriorityEnum,
    CaseStatusEnum,
    CaseTypeEnum,
    ComplianceCheck,
    Customer,
    CounterOffer,
    Gender,
    InsuranceTypeEnum,
    MaritalStatus,
    Policy,
    PolicyEvent,
    PolicyRequirement,
    PolicyStatusEnum,
    PremiumQuote,
    ProfileStatusEnum,
    RiskAssessment,
    SourceChannelEnum,
    Tenant,
    PolicyOnboarding,
    CustomerPortalAccount,
)
from seeds.acquisition_sources_seed import get_or_seed_sources

logger = logging.getLogger("tenant-service.seeds.stage_a")

_POLICY_FEE = 500.0
_TAX_RATE = 0.01


def _price(coverage: float, term: int, base_rate: float, loading_pct: float) -> dict:
    """Small transparent premium calc so seeded numbers look real and consistent."""
    base = round((base_rate / 1000.0) * coverage * (0.5 + term / 40.0), 0)
    loading_amt = round(base * (loading_pct / 100.0), 0)
    tax = round((base + loading_amt + _POLICY_FEE) * _TAX_RATE, 0)
    total = base + loading_amt + _POLICY_FEE + tax
    return {
        "base_premium": base,
        "loading_amount": loading_amt,
        "policy_fee": _POLICY_FEE,
        "tax_amount": tax,
        "total_premium": total,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Funnel cohort — 8 applicants, one per lifecycle stage.
# stage → drives Policy.status, Case.caseStatus, RiskAssessment, profile_status.
# ─────────────────────────────────────────────────────────────────────────────

SCENARIOS: list[dict] = [
    {
        "stage": "lead",
        "cnic": "35202-4419087-1",
        "name": "Hamza Sethi",
        "dob": date(1992, 6, 12),
        "gender": Gender.MALE,
        "marital_status": MaritalStatus.SINGLE,
        "occupation": "UX Designer",
        "declared_income": 2_100_000,
        "is_smoker": False,
        "city": "Lahore",
        "province": "Punjab",
        "product_name": "Term Life 20",
        "insurance_type": InsuranceTypeEnum.TERM_LIFE,
        "coverage_amount": 6_000_000,
        "term_years": 20,
        "base_rate": 3.2,
        "nominee_name": "Sana Sethi",
        "nominee_relationship": "Spouse",
    },
    {
        "stage": "proposed",
        "cnic": "42101-7788213-5",
        "name": "Nadia Qureshi",
        "dob": date(1988, 2, 3),
        "gender": Gender.FEMALE,
        "marital_status": MaritalStatus.MARRIED,
        "occupation": "Marketing Director",
        "declared_income": 4_800_000,
        "is_smoker": False,
        "city": "Karachi",
        "province": "Sindh",
        "product_name": "Term Life 25",
        "insurance_type": InsuranceTypeEnum.TERM_LIFE,
        "coverage_amount": 12_000_000,
        "term_years": 25,
        "base_rate": 3.4,
        "nominee_name": "Imran Qureshi",
        "nominee_relationship": "Spouse",
        "ai": {"decision": AIDecision.AUTO_APPROVE, "medical": 24, "financial": 20,
               "fraud": 0.02, "loading": 0, "composite": 22},
    },
    {
        "stage": "under_review",
        "cnic": "35201-9963471-8",
        "name": "Imtiaz Baig",
        "dob": date(1972, 9, 27),
        "gender": Gender.MALE,
        "marital_status": MaritalStatus.MARRIED,
        "occupation": "Offshore Rig Supervisor",
        "declared_income": 3_600_000,
        "is_smoker": True,
        "city": "Islamabad",
        "province": "Islamabad",
        "product_name": "Term Life 20",
        "insurance_type": InsuranceTypeEnum.TERM_LIFE,
        "coverage_amount": 20_000_000,
        "term_years": 20,
        "base_rate": 4.1,
        "nominee_name": "Rukhsana Baig",
        "nominee_relationship": "Spouse",
        "ai": {"decision": AIDecision.HUMAN_REVIEW, "medical": 74, "financial": 58,
               "fraud": 0.06, "loading": None, "composite": 61,
               "medical_reasons": [
                   "Age 53 (bracket 46–55): +48 pts — elevated mortality exposure",
                   "Smoker: +25 pts — cardiovascular / respiratory risk",
                   "Occupation 'Offshore Rig Supervisor' (high-hazard): +20 pts",
               ],
               "financial_reasons": [
                   "Coverage-to-income ratio 5.6× (moderate tier): +45 pts",
                   "Long policy term (20 yrs): +5 pts",
               ],
               "fraud_reasons": [
                   "CNIC format valid: no signal",
                   "High-hazard occupation with PKR 20M cover: baseline raised to 6%",
               ]},
    },
    {
        "stage": "loading",
        "cnic": "31201-3050912-4",
        "name": "Bushra Yousaf",
        "dob": date(1979, 11, 5),
        "gender": Gender.FEMALE,
        "marital_status": MaritalStatus.MARRIED,
        "occupation": "Textile Factory Owner",
        "declared_income": 6_500_000,
        "is_smoker": False,
        "city": "Faisalabad",
        "province": "Punjab",
        "product_name": "Term Life 20",
        "insurance_type": InsuranceTypeEnum.TERM_LIFE,
        "coverage_amount": 15_000_000,
        "term_years": 20,
        "base_rate": 3.6,
        "nominee_name": "Yousaf Ali",
        "nominee_relationship": "Spouse",
        "ai": {"decision": AIDecision.APPROVE_WITH_LOADING, "medical": 46, "financial": 30,
               "fraud": 0.03, "loading": 25.0, "composite": 38,
               "medical_reasons": [
                   "Age 46 (bracket 46–55): +48 pts",
                   "BMI 31 (obese range): +18 pts — metabolic risk",
               ],
               "financial_reasons": [
                   "Coverage-to-income ratio 2.3× (comfortable): +15 pts",
               ],
               "fraud_reasons": ["No fraud signals; baseline 3%"]},
    },
    {
        "stage": "information_requested",
        "cnic": "17301-6621458-2",
        "name": "Gul Rahman",
        "dob": date(1985, 4, 19),
        "gender": Gender.MALE,
        "marital_status": MaritalStatus.MARRIED,
        "occupation": "Import/Export Trader",
        "declared_income": 2_900_000,
        "is_smoker": False,
        "city": "Peshawar",
        "province": "Khyber Pakhtunkhwa",
        "product_name": "Health Platinum",
        "insurance_type": InsuranceTypeEnum.HEALTH_CASH,
        "coverage_amount": 18_000_000,
        "term_years": 15,
        "base_rate": 3.9,
        "nominee_name": "Shaista Rahman",
        "nominee_relationship": "Spouse",
        "ai": {"decision": AIDecision.HUMAN_REVIEW, "medical": 40, "financial": 62,
               "fraud": 0.09, "loading": None, "composite": 52,
               "financial_reasons": [
                   "Declared income unverified — recent medical + income proof required",
                   "Coverage-to-income ratio 1.9×: +10 pts",
               ]},
    },
    {
        "stage": "approved_clean",
        "cnic": "42201-1145789-6",
        "name": "Ayesha Farooq",
        "dob": date(1994, 8, 30),
        "gender": Gender.FEMALE,
        "marital_status": MaritalStatus.SINGLE,
        "occupation": "General Physician",
        "declared_income": 3_900_000,
        "is_smoker": False,
        "city": "Karachi",
        "province": "Sindh",
        "product_name": "Term Life 20",
        "insurance_type": InsuranceTypeEnum.TERM_LIFE,
        "coverage_amount": 8_000_000,
        "term_years": 20,
        "base_rate": 3.2,
        "nominee_name": "Farooq Ahmed",
        "nominee_relationship": "Father",
        "ai": {"decision": AIDecision.AUTO_APPROVE, "medical": 18, "financial": 20,
               "fraud": 0.02, "loading": 0, "composite": 19},
    },
    {
        # Approved and already in the issuance queue, but a real-estate developer
        # with a high sum-assured-to-income ratio — AML screening deliberately
        # FLAGS this one, so the compliance flag → clear path is one click away.
        "stage": "approved_clean",
        "cnic": "35202-5567810-7",
        "name": "Faisal Abbasi",
        "dob": date(1980, 5, 14),
        "gender": Gender.MALE,
        "marital_status": MaritalStatus.MARRIED,
        "occupation": "Real Estate Developer",
        "declared_income": 3_000_000,
        "is_smoker": False,
        "city": "Islamabad",
        "province": "Islamabad",
        "product_name": "Term Life 20",
        "insurance_type": InsuranceTypeEnum.TERM_LIFE,
        "coverage_amount": 22_000_000,
        "term_years": 20,
        "base_rate": 3.5,
        "nominee_name": "Kiran Abbasi",
        "nominee_relationship": "Spouse",
        "ai": {"decision": AIDecision.AUTO_APPROVE, "medical": 30, "financial": 40,
               "fraud": 0.04, "loading": 0, "composite": 34},
    },
    {
        "stage": "approved_loaded",
        "cnic": "36302-7789541-3",
        "name": "Rehan Dalal",
        "dob": date(1976, 1, 22),
        "gender": Gender.MALE,
        "marital_status": MaritalStatus.MARRIED,
        "occupation": "Commercial Pilot",
        "declared_income": 9_000_000,
        "is_smoker": False,
        "city": "Multan",
        "province": "Punjab",
        "product_name": "Term Life 25",
        "insurance_type": InsuranceTypeEnum.TERM_LIFE,
        "coverage_amount": 25_000_000,
        "term_years": 25,
        "base_rate": 3.8,
        "nominee_name": "Sadia Dalal",
        "nominee_relationship": "Spouse",
        "ai": {"decision": AIDecision.APPROVE_WITH_LOADING, "medical": 42, "financial": 28,
               "fraud": 0.03, "loading": 15.0, "composite": 35,
               "medical_reasons": ["Occupation 'Commercial Pilot' (aviation): +15 pts"],
               "financial_reasons": ["Coverage-to-income ratio 2.8×: +15 pts"]},
    },
    {
        "stage": "declined",
        "cnic": "37401-8830127-9",
        "name": "Sabir Jat",
        "dob": date(1961, 3, 8),
        "gender": Gender.MALE,
        "marital_status": MaritalStatus.MARRIED,
        "occupation": "Long-haul Truck Driver",
        "declared_income": 540_000,
        "is_smoker": True,
        "city": "Rawalpindi",
        "province": "Punjab",
        "product_name": "Health Gold",
        "insurance_type": InsuranceTypeEnum.HEALTH_CASH,
        "coverage_amount": 6_000_000,
        "term_years": 15,
        "base_rate": 4.4,
        "nominee_name": "Nasreen Bibi",
        "nominee_relationship": "Spouse",
        "ai": {"decision": AIDecision.DECLINE, "medical": 90, "financial": 86,
               "fraud": 0.24, "loading": None, "composite": 78,
               "medical_reasons": [
                   "Age 65 (bracket 56–65): +62 pts",
                   "Smoker + hazardous occupation: +30 pts",
               ],
               "financial_reasons": [
                   "Coverage-to-income ratio 11.1× (high tier): +65 pts",
                   "Annual income below minimum stability threshold: +20 pts",
               ],
               "fraud_reasons": ["Multiple compounding signals — probability 24%"]},
    },
]


# stage → (policy status, case status or None, profile status, event trail)
_STAGE_MAP: dict[str, dict] = {
    "lead": {
        "policy": PolicyStatusEnum.QUOTED, "case": None,
        "profile": ProfileStatusEnum.LEAD,
        "trail": [("PolicyQuoted", None, "Quoted")],
    },
    "proposed": {
        "policy": PolicyStatusEnum.PROPOSED, "case": CaseStatusEnum.NEW,
        "profile": ProfileStatusEnum.PROSPECT,
        "trail": [("PolicyQuoted", None, "Quoted"), ("QuoteProposed", "Quoted", "Proposed")],
    },
    "under_review": {
        "policy": PolicyStatusEnum.UNDER_REVIEW, "case": CaseStatusEnum.UNDER_REVIEW,
        "profile": ProfileStatusEnum.UNDERWRITING_READY,
        "trail": [("PolicyQuoted", None, "Quoted"), ("QuoteProposed", "Quoted", "Proposed"),
                  ("SentToUnderwriting", "Proposed", "UnderReview")],
    },
    "loading": {
        "policy": PolicyStatusEnum.UNDER_REVIEW, "case": CaseStatusEnum.UNDER_REVIEW,
        "profile": ProfileStatusEnum.UNDERWRITING_READY,
        "trail": [("PolicyQuoted", None, "Quoted"), ("QuoteProposed", "Quoted", "Proposed"),
                  ("SentToUnderwriting", "Proposed", "UnderReview")],
    },
    "information_requested": {
        "policy": PolicyStatusEnum.INFORMATION_REQUESTED, "case": CaseStatusEnum.PENDING_DOCUMENTS,
        "profile": ProfileStatusEnum.UNDERWRITING_READY,
        "trail": [("PolicyQuoted", None, "Quoted"), ("QuoteProposed", "Quoted", "Proposed"),
                  ("SentToUnderwriting", "Proposed", "UnderReview"),
                  ("InformationRequested", "UnderReview", "InformationRequested")],
    },
    "approved_clean": {
        "policy": PolicyStatusEnum.APPROVED, "case": CaseStatusEnum.APPROVED,
        "profile": ProfileStatusEnum.UNDERWRITING_READY,
        "trail": [("PolicyQuoted", None, "Quoted"), ("QuoteProposed", "Quoted", "Proposed"),
                  ("SentToUnderwriting", "Proposed", "UnderReview"),
                  ("UnderwritingApproved", "UnderReview", "Approved")],
    },
    "approved_loaded": {
        "policy": PolicyStatusEnum.ACCEPTED_WITH_LOADINGS, "case": CaseStatusEnum.APPROVED,
        "profile": ProfileStatusEnum.UNDERWRITING_READY,
        "trail": [("PolicyQuoted", None, "Quoted"), ("QuoteProposed", "Quoted", "Proposed"),
                  ("SentToUnderwriting", "Proposed", "UnderReview"),
                  ("ApprovedWithLoadings", "UnderReview", "AcceptedWithLoadings")],
    },
    "declined": {
        "policy": PolicyStatusEnum.DECLINED, "case": CaseStatusEnum.REJECTED,
        "profile": ProfileStatusEnum.NOT_INTERESTED,
        "trail": [("PolicyQuoted", None, "Quoted"), ("QuoteProposed", "Quoted", "Proposed"),
                  ("SentToUnderwriting", "Proposed", "UnderReview"),
                  ("UnderwritingDeclined", "UnderReview", "Declined")],
    },
}


_SEED_CNICS = [s["cnic"] for s in SCENARIOS]


async def purge_tenant(session: AsyncSession, tenant_id: UUID) -> int:
    """Delete EVERY customer (individual, org-employee, family member) and all
    their funnel data for a tenant, so the leads / proposal / underwriting /
    issuance / applications screens start completely clean.

    ORM cascade from Customer removes policies, cases (+ case children),
    quotes, risk assessments, artifacts, schedules, versions, documents,
    commissions, claims. But the Stage A tables and policy_events have no
    cascade from Policy, and family_groups.primary_member_customer_id RESTRICTs
    the delete — so clear those first. Organizations / family-group shells and
    all catalog data (plans, branches, sources, users) are left untouched.
    """
    from shared.models.core import FamilyGroup

    policy_ids = list((await session.exec(
        select(Policy.id).where(Policy.tenant_id == tenant_id))).all())

    # 1. Break the family primary-member FK so customers can be deleted.
    await session.exec(
        sa_update(FamilyGroup).where(FamilyGroup.tenant_id == tenant_id)
        .values(primary_member_customer_id=None)
    )

    # 2. Delete no-cascade policy children for every policy in the tenant.
    if policy_ids:
        for model in (CounterOffer, PolicyRequirement, ComplianceCheck, Beneficiary, PolicyEvent, PolicyOnboarding):
            await session.exec(sa_delete(model).where(model.policy_id.in_(policy_ids)))  # type: ignore[attr-defined]

    # 3. Delete no-cascade customer children.
    customer_ids = list((await session.exec(select(Customer.id).where(Customer.tenant_id == tenant_id))).all())
    if customer_ids:
        await session.exec(sa_delete(CustomerPortalAccount).where(CustomerPortalAccount.customer_id.in_(customer_ids)))

    # 4. Delete every customer — ORM cascade clears the rest.
    customers = (await session.exec(select(Customer).where(Customer.tenant_id == tenant_id))).all()
    for cust in customers:
        await session.delete(cust)

    await session.commit()
    return len(customers)


async def reset_stage_a(session: AsyncSession, tenant_id: UUID) -> int:
    """Delete the seeded cohort (and everything hanging off it) for a tenant so
    a fresh `seed_stage_a` re-lands the funnel in its initial state. Stage A
    tables and policy_events have no ORM cascade from Policy, so wipe them first,
    then delete the Customer (cascade removes policies / cases / quotes / RAs)."""
    custs = (await session.exec(
        select(Customer).where(Customer.tenant_id == tenant_id, Customer.cnic.in_(_SEED_CNICS))  # type: ignore[attr-defined]
    )).all()
    removed = 0
    for cust in custs:
        # Delete no-cascade customer children
        portals = (await session.exec(select(CustomerPortalAccount).where(CustomerPortalAccount.customer_id == cust.id))).all()
        for portal in portals:
            await session.delete(portal)

        pols = (await session.exec(select(Policy).where(Policy.customer_id == cust.id))).all()
        for p in pols:
            for model in (CounterOffer, PolicyRequirement, ComplianceCheck, Beneficiary, PolicyEvent, PolicyOnboarding):
                for row in (await session.exec(select(model).where(model.policy_id == p.id))).all():
                    await session.delete(row)
        await session.delete(cust)
        removed += 1
    await session.commit()
    return removed


async def seed_stage_a(session: AsyncSession, tenant_id: UUID) -> list[Customer]:
    """Insert the funnel cohort for one tenant. Idempotent by CNIC."""
    existing = set(
        (await session.exec(select(Customer.cnic).where(Customer.tenant_id == tenant_id))).all()
    )
    sources = await get_or_seed_sources(session, tenant_id)
    tshort = str(tenant_id).replace("-", "")[:6].upper()
    created: list[Customer] = []
    now = datetime.utcnow()

    for idx, spec in enumerate(SCENARIOS, start=1):
        if spec["cnic"] in existing:
            continue

        stage = _STAGE_MAP[spec["stage"]]
        loading_pct = 0.0
        ai = spec.get("ai")
        if ai and ai.get("loading"):
            loading_pct = float(ai["loading"])
        pricing = _price(spec["coverage_amount"], spec["term_years"], spec["base_rate"], loading_pct)

        # ── Customer ──────────────────────────────────────────────────────────
        customer = Customer(
            tenant_id=tenant_id,
            cnic=spec["cnic"],
            name=spec["name"],
            dob=spec["dob"],
            gender=spec["gender"],
            marital_status=spec["marital_status"],
            occupation=spec["occupation"],
            declared_income=spec["declared_income"],
            is_smoker=spec["is_smoker"],
            city=spec["city"],
            province=spec["province"],
            profile_status=stage["profile"],
            acquisition_source_id=random.choice(sources).id if sources else None,
        )
        session.add(customer)
        await session.flush()

        # ── Policy ────────────────────────────────────────────────────────────
        policy = Policy(
            tenant_id=tenant_id,
            customer_id=customer.id,
            product_name=spec["product_name"],
            insurance_type=spec["insurance_type"],
            coverage_amount=spec["coverage_amount"],
            term_years=spec["term_years"],
            nominee_name=spec["nominee_name"],
            nominee_relationship=spec["nominee_relationship"],
            status=stage["policy"],
        )
        session.add(policy)
        await session.flush()

        # ── PremiumQuote (every stage past Quoted has an indicative quote) ─────
        session.add(PremiumQuote(
            tenant_id=tenant_id,
            policy_id=policy.id,
            base_premium=pricing["base_premium"],
            loading_applied=pricing["loading_amount"],
            total_premium=pricing["total_premium"],
            rate_version="SEED-1.0",
        ))

        # ── Case (Underwriting) for everything past a bare lead ───────────────
        case_id: Optional[UUID] = None
        if stage["case"] is not None:
            case = Case(
                tenant_id=tenant_id,
                customer_id=customer.id,
                policy_id=policy.id,
                caseNumber=f"UW-{tshort}-{idx:03d}",
                caseType=CaseTypeEnum.UNDERWRITING,
                caseStatus=stage["case"],
                priorityLevel=CasePriorityEnum.HIGH if spec["coverage_amount"] >= 15_000_000
                              else CasePriorityEnum.NORMAL,
                sourceChannel=SourceChannelEnum.AGENT,
                createdAt=now - timedelta(days=6),
            )
            session.add(case)
            await session.flush()
            case_id = case.caseld

        # ── RiskAssessment (once underwriting has an AI verdict) ──────────────
        if ai is not None:
            session.add(RiskAssessment(
                tenant_id=tenant_id,
                customer_id=customer.id,
                policy_id=policy.id,
                case_id=case_id,
                medical_score=ai["medical"],
                financial_score=ai["financial"],
                fraud_probability=ai["fraud"],
                ai_decision=ai["decision"],
                suggested_loading=ai.get("loading"),
                composite_risk_score=ai.get("composite"),
                medical_reasons=ai.get("medical_reasons"),
                financial_reasons=ai.get("financial_reasons"),
                fraud_reasons=ai.get("fraud_reasons"),
            ))

        # ── PolicyEvent audit trail (immutable, back-dated) ───────────────────
        for offset, (evt, frm, to) in enumerate(stage["trail"]):
            session.add(PolicyEvent(
                tenant_id=tenant_id,
                policy_id=policy.id,
                event_type=evt,
                from_status=frm,
                to_status=to,
                actor="seed",
                detail_json={"seeded": True, "stage": spec["stage"]},
                created_at=now - timedelta(days=6 - offset),
            ))

        created.append(customer)

    await session.commit()
    return created


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry-point (mirrors customers_seed.py)
# ─────────────────────────────────────────────────────────────────────────────

async def _run(tenant_id: UUID | None, all_tenants: bool, reset: bool, purge: bool) -> None:
    from database import _session_factory

    async with _session_factory() as session:
        if all_tenants:
            tenants = list((await session.exec(select(Tenant))).all())
            if not tenants:
                print("No tenants found — nothing to seed.")
                return
        else:
            tenant = await session.get(Tenant, tenant_id)
            if tenant is None:
                raise SystemExit(f"Tenant '{tenant_id}' not found.")
            tenants = [tenant]

        for tenant in tenants:
            if purge:
                n = await purge_tenant(session, tenant.id)
                print(f"[{tenant.name}] {tenant.id}: purged — removed {n} customer(s) and all their funnel data")
            elif reset:
                n = await reset_stage_a(session, tenant.id)
                print(f"[{tenant.name}] {tenant.id}: reset — removed {n} seeded applicant(s)")
            created = await seed_stage_a(session, tenant.id)
            skipped = len(SCENARIOS) - len(created)
            print(f"[{tenant.name}] {tenant.id}: created {len(created)} applicant(s) "
                  f"({skipped} already present)")
            for c in created:
                print(f"  ✓ {c.name} ({c.profile_status})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed the Stage A end-to-end funnel cohort.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--tenant-id", type=UUID, help="Seed a single tenant by UUID.")
    group.add_argument("--all-tenants", action="store_true", help="Seed every tenant.")
    parser.add_argument("--reset", action="store_true",
                        help="Wipe just the seeded cohort first, then re-seed a clean funnel.")
    parser.add_argument("--purge", action="store_true",
                        help="Wipe ALL customers + funnel data for the tenant(s), then seed the clean funnel.")
    args = parser.parse_args()
    asyncio.run(_run(args.tenant_id, args.all_tenants, args.reset, args.purge))


if __name__ == "__main__":
    main()
