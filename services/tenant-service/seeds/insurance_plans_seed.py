"""Seed the insurance_plans catalog for one or more tenants.

Single source of truth for the standard plan catalog. Both the
``POST /tenants/{tenant_id}/insurance-plans/seed-defaults`` endpoint and this
CLI import ``INSURANCE_PLAN_SEED_DATA`` / ``seed_insurance_plans`` from here, so
the data lives in exactly one place.

Every plan is tenant-scoped — it is written with the ``tenant_id`` you pass in,
so the same catalog can be reproduced on any machine by pointing at that
tenant's id. Seeding is idempotent: a plan whose ``code`` already exists for the
tenant is skipped, never duplicated.

Run inside the tenant-service container:

    # Seed one tenant
    docker compose exec tenant-service python -m seeds.insurance_plans_seed \
        --tenant-id 05788cf6-5bf0-4895-b73d-28bbe334518d

    # Seed every tenant in the database
    docker compose exec tenant-service python -m seeds.insurance_plans_seed --all-tenants
"""

from __future__ import annotations

import argparse
import asyncio
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import InsurancePlan, Tenant

# ── Repeated literals (kept as constants to avoid duplication) ─────────────────

TIER_NONE = "No medical exam required"
TIER_PARAMEDICAL = "Paramedical exam required"
TIER_FULL = "Full medical exam + financial underwriting required"
TIER_GROUP = "No medical exam required — guaranteed issue"

DOC_CNIC = "CNIC"
DOC_MEDICAL = "Medical Report"
DOC_SALARY = "Salary Slip"
DOC_BANK = "Bank Statement"
DOC_BIRTH = "Child's Birth Certificate"
DOC_CENSUS = "Employee Census"
DOC_BUSINESS_REG = "Business Registration"


# ── The catalog — 8 plans (5 core types + 3 variants) ─────────────────────────
# Each entry is a dict of InsurancePlan column values (minus tenant_id / status,
# which seed_insurance_plans() fills in). `code` is unique per tenant.

INSURANCE_PLAN_SEED_DATA: list[dict] = [
    {
        "code": "TERM_LIFE", "label": "Term Life", "insurance_type": "TERM_LIFE",
        "category": "Individual", "color": "blue",
        "description": "Pure protection for a fixed term — no maturity value. The cheapest way to secure a large sum assured; pays out only on death within the term.",
        "entry_age_min": 18, "entry_age_max": 65, "entry_age_label": "Proposer",
        "term_min_years": 5, "term_max_years": 30, "max_maturity_age": 70, "max_income_multiple": 20,
        "medical_exam_tiers": [
            {"minSumAssured": 0, "tier": TIER_NONE},
            {"minSumAssured": 5_000_000, "tier": TIER_PARAMEDICAL},
            {"minSumAssured": 20_000_000, "tier": TIER_FULL},
        ],
        "required_documents": [DOC_CNIC, DOC_MEDICAL, DOC_SALARY],
    },
    {
        "code": "TERM_LIFE_PREMIER", "label": "Term Life Premier", "insurance_type": "TERM_LIFE",
        "category": "Individual", "color": "blue",
        "description": "A high-coverage term plan for higher earners — larger sum-assured limits and financial underwriting, with the same pure-protection structure as standard Term Life.",
        "entry_age_min": 25, "entry_age_max": 60, "entry_age_label": "Proposer",
        "term_min_years": 10, "term_max_years": 30, "max_maturity_age": 70, "max_income_multiple": 30,
        "medical_exam_tiers": [
            {"minSumAssured": 0, "tier": TIER_PARAMEDICAL},
            {"minSumAssured": 10_000_000, "tier": TIER_FULL},
        ],
        "required_documents": [DOC_CNIC, DOC_MEDICAL, DOC_SALARY, DOC_BANK],
    },
    {
        "code": "WHOLE_LIFE", "label": "Whole Life", "insurance_type": "WHOLE_LIFE",
        "category": "Individual", "color": "violet",
        "description": "Lifetime coverage with an accumulating cash value. Typically more expensive than term life, but the policy never expires and can be borrowed against.",
        "entry_age_min": 18, "entry_age_max": 65, "entry_age_label": "Proposer",
        "term_min_years": 1, "term_max_years": 40, "max_maturity_age": 99, "max_income_multiple": 25,
        "medical_exam_tiers": [
            {"minSumAssured": 0, "tier": TIER_NONE},
            {"minSumAssured": 5_000_000, "tier": TIER_PARAMEDICAL},
            {"minSumAssured": 15_000_000, "tier": TIER_FULL},
        ],
        "required_documents": [DOC_CNIC, DOC_MEDICAL, DOC_SALARY, DOC_BANK],
    },
    {
        "code": "ENDOWMENT", "label": "Endowment / Savings Plan", "insurance_type": "ENDOWMENT",
        "category": "Individual", "color": "amber",
        "description": "A with-profits savings policy that pays a lump sum (sum assured plus accrued bonuses) at maturity, or a death benefit if the proposer dies during the term.",
        "entry_age_min": 18, "entry_age_max": 60, "entry_age_label": "Proposer",
        "term_min_years": 10, "term_max_years": 30, "max_maturity_age": 70, "max_income_multiple": 15,
        "medical_exam_tiers": [
            {"minSumAssured": 0, "tier": TIER_NONE},
            {"minSumAssured": 5_000_000, "tier": TIER_PARAMEDICAL},
            {"minSumAssured": 15_000_000, "tier": TIER_FULL},
        ],
        "required_documents": [DOC_CNIC, DOC_MEDICAL, DOC_SALARY, DOC_BANK],
    },
    {
        "code": "RETIREMENT_SAVINGS", "label": "Retirement Savings Plan", "insurance_type": "ENDOWMENT",
        "category": "Individual", "color": "amber",
        "description": "A long-horizon endowment aimed at retirement — builds a lump sum payable at the chosen maturity age, with a death benefit during the accumulation term.",
        "entry_age_min": 25, "entry_age_max": 55, "entry_age_label": "Proposer",
        "term_min_years": 10, "term_max_years": 35, "max_maturity_age": 65, "max_income_multiple": 20,
        "medical_exam_tiers": [
            {"minSumAssured": 0, "tier": TIER_NONE},
            {"minSumAssured": 5_000_000, "tier": TIER_PARAMEDICAL},
            {"minSumAssured": 20_000_000, "tier": TIER_FULL},
        ],
        "required_documents": [DOC_CNIC, DOC_SALARY, DOC_BANK],
    },
    {
        "code": "CHILD_EDUCATION_MARRIAGE", "label": "Child Education & Marriage Plan",
        "insurance_type": "CHILD_EDUCATION_MARRIAGE", "category": "Individual", "color": "emerald",
        "description": "An endowment plan tied to a dependent's milestone age (typically 18, 21, or 25) rather than the proposer's — pays out for education or marriage expenses. If the proposer dies during the term, future premiums are waived and the policy stays in force for the child.",
        "entry_age_min": 20, "entry_age_max": 60, "entry_age_label": "Proposer",
        "dependent_age_min": 1, "dependent_age_max": 15,
        "term_min_years": 10, "term_max_years": 24, "max_maturity_age": 70, "max_income_multiple": 15,
        "medical_exam_tiers": [
            {"minSumAssured": 0, "tier": TIER_NONE},
            {"minSumAssured": 3_000_000, "tier": TIER_PARAMEDICAL},
            {"minSumAssured": 10_000_000, "tier": TIER_FULL},
        ],
        "required_documents": [DOC_CNIC, DOC_SALARY, DOC_BANK, DOC_BIRTH],
    },
    {
        "code": "GROUP_LIFE", "label": "Group Life", "insurance_type": "GROUP_LIFE",
        "category": "Group", "color": "indigo",
        "description": "A single Master Policy issued to a business, covering its staff under one contract — employees get a Certificate of Insurance, not their own individual policy. Pays out only on death during employment; no maturity/surrender value.",
        "entry_age_min": 18, "entry_age_max": 65, "entry_age_label": "Employee",
        "term_min_years": 1, "term_max_years": 1, "max_maturity_age": 70, "max_income_multiple": 36,
        "min_group_size": 10,
        "underwriting_basis": "Group-level (size, industry, claims history) — guaranteed issue, no medical underwriting",
        "medical_exam_tiers": [{"minSumAssured": 0, "tier": TIER_GROUP}],
        "required_documents": [DOC_CENSUS, DOC_BUSINESS_REG],
    },
    {
        "code": "GROUP_LIFE_SME", "label": "Group Life — SME", "insurance_type": "GROUP_LIFE",
        "category": "Group", "color": "indigo",
        "description": "A group life contract sized for small businesses — a lower minimum group size and reduced sum-assured multiple, otherwise guaranteed-issue like standard Group Life.",
        "entry_age_min": 18, "entry_age_max": 60, "entry_age_label": "Employee",
        "term_min_years": 1, "term_max_years": 1, "max_maturity_age": 65, "max_income_multiple": 24,
        "min_group_size": 5,
        "underwriting_basis": "Group-level (size, industry) — guaranteed issue for small teams",
        "medical_exam_tiers": [{"minSumAssured": 0, "tier": TIER_GROUP}],
        "required_documents": [DOC_CENSUS, DOC_BUSINESS_REG],
    },
]


async def seed_insurance_plans(session: AsyncSession, tenant_id: UUID) -> list[InsurancePlan]:
    """Insert the catalog for a single tenant, skipping codes that already exist.

    Idempotent — safe to run repeatedly. Returns the plans actually created.
    Commits before returning so the caller gets refreshed rows.
    """
    existing = await session.exec(
        select(InsurancePlan.code).where(InsurancePlan.tenant_id == tenant_id)
    )
    existing_codes = set(existing.all())

    created: list[InsurancePlan] = []
    for spec in INSURANCE_PLAN_SEED_DATA:
        if spec["code"] in existing_codes:
            continue
        plan = InsurancePlan(tenant_id=tenant_id, status="Active", **spec)
        session.add(plan)
        created.append(plan)

    await session.commit()
    for plan in created:
        await session.refresh(plan)
    return created


async def _run(tenant_id: UUID | None, all_tenants: bool) -> None:
    # Imported lazily so importing the catalog (INSURANCE_PLAN_SEED_DATA) from the
    # API layer never pulls in a DB engine/connection.
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
            created = await seed_insurance_plans(session, tenant.id)
            skipped = len(INSURANCE_PLAN_SEED_DATA) - len(created)
            print(
                f"[{tenant.name}] {tenant.id}: created {len(created)} plan(s)"
                f" ({skipped} already present) — {sorted(p.code for p in created)}"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed the insurance_plans catalog for a tenant.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--tenant-id", type=UUID, help="UUID of the tenant to seed.")
    group.add_argument("--all-tenants", action="store_true", help="Seed every tenant in the database.")
    args = parser.parse_args()

    asyncio.run(_run(args.tenant_id, args.all_tenants))


if __name__ == "__main__":
    main()
