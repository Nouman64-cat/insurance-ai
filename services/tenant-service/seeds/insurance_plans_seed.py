"""Seed the insurance_plans catalog for one or more tenants.

Single source of truth for the standard plan catalog. Both the
``POST /tenants/{tenant_id}/insurance-plans/seed-defaults`` endpoint and this
CLI import ``INSURANCE_PLAN_SEED_DATA`` / ``seed_insurance_plans`` from here, so
the data lives in exactly one place.

The individual-life catalog (everything except GROUP_LIFE/GROUP_LIFE_SME) is
Adamjee Life Insurance's real retail product line, sourced from
insurance_categories_and_plans.txt plus adamjeelife.com, spanning three
business/distribution channels (``product_category``):
Conventional, Takaful (Shariah-compliant), and Bancassurance (bank-partnered).

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


# ── Underwriting bands, shared across every plan of a given mechanic ──────────
# (mirrors services/risk-engine/underwriting_rules.py and
# services/tenant-service/document_requirements.py, which key off the same
# insurance_type buckets)

_BANDS: dict[str, dict] = {
    "TERM_LIFE": {
        "color": "blue",
        "entry_age_min": 18, "entry_age_max": 65, "entry_age_label": "Proposer",
        "term_min_years": 5, "term_max_years": 30, "max_maturity_age": 70, "max_income_multiple": 20,
        "medical_exam_tiers": [
            {"minSumAssured": 0, "tier": TIER_NONE},
            {"minSumAssured": 5_000_000, "tier": TIER_PARAMEDICAL},
            {"minSumAssured": 20_000_000, "tier": TIER_FULL},
        ],
        "required_documents": [DOC_CNIC, DOC_MEDICAL, DOC_SALARY],
    },
    "SAVINGS": {
        "color": "amber",
        "entry_age_min": 18, "entry_age_max": 65, "entry_age_label": "Proposer",
        "term_min_years": 5, "term_max_years": 25, "max_maturity_age": 75, "max_income_multiple": 15,
        "medical_exam_tiers": [
            {"minSumAssured": 0, "tier": TIER_NONE},
            {"minSumAssured": 5_000_000, "tier": TIER_PARAMEDICAL},
            {"minSumAssured": 15_000_000, "tier": TIER_FULL},
        ],
        "required_documents": [DOC_CNIC, DOC_SALARY, DOC_BANK],
    },
    "SINGLE_PREMIUM": {
        "color": "violet",
        "entry_age_min": 18, "entry_age_max": 70, "entry_age_label": "Proposer",
        "term_min_years": 1, "term_max_years": 10, "max_maturity_age": 75, "max_income_multiple": 10,
        "medical_exam_tiers": [
            {"minSumAssured": 0, "tier": TIER_NONE},
            {"minSumAssured": 10_000_000, "tier": TIER_PARAMEDICAL},
        ],
        "required_documents": [DOC_CNIC, DOC_BANK],
    },
    "HEALTH_CASH": {
        "color": "rose",
        "entry_age_min": 18, "entry_age_max": 59, "entry_age_label": "Proposer",
        "term_min_years": 1, "term_max_years": 5, "max_maturity_age": 65, "max_income_multiple": 5,
        "medical_exam_tiers": [{"minSumAssured": 0, "tier": TIER_NONE}],
        "required_documents": [DOC_CNIC],
    },
    "CHILD_EDUCATION_MARRIAGE": {
        "color": "emerald",
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
}


def _plan(
    code: str,
    label: str,
    insurance_type: str,
    product_category: str,
    description: str,
    partner_bank: str | None = None,
) -> dict:
    """Build a plan spec from its mechanic band, plus per-plan identity fields."""
    band = _BANDS[insurance_type]
    spec = {
        "code": code, "label": label, "insurance_type": insurance_type,
        "category": "Individual", "product_category": product_category,
        "partner_bank": partner_bank, "color": band["color"], "description": description,
        **{k: v for k, v in band.items() if k != "color"},
    }
    return spec


# ── The catalog — Adamjee Life's real retail life-insurance products ──────────
# (Conventional / Takaful / Bancassurance) plus the two generic Group plans
# that back the unrelated Organization/MasterPolicy group-insurance feature.

INSURANCE_PLAN_SEED_DATA: list[dict] = [
    # ── Conventional ────────────────────────────────────────────────────────
    _plan(
        "ROSHAN_AAJ_AUR_KAL", "Roshan Aaj Aur Kal", "CHILD_EDUCATION_MARRIAGE", "Conventional",
        "Goal-based savings plan for a child's education or wedding, investing across three "
        "risk-based fund options. Includes a premium-waiver benefit — Adamjee Life pays future "
        "premiums if the proposer dies — and a loyalty bonus.",
    ),
    _plan(
        "SALARY_PROTECTION_PLAN", "Salary Protection Plan", "TERM_LIFE", "Conventional",
        "Term life plan that replaces a selected percentage of the insured's monthly salary for "
        "the beneficiary(ies) for a fixed term on death or permanent total disability, with an "
        "optional annual benefit-increase rider.",
    ),
    _plan(
        "APNA_SAVINGS", "Apna Savings", "SAVINGS", "Conventional",
        "Low-entry-cost savings plan balancing basic protection with savings — minimum annual "
        "premium of PKR 8,000, three fund investment options, and a loyalty bonus.",
    ),
    _plan(
        "PAY_SMART_PLAN", "Pay Smart Plan", "SAVINGS", "Conventional",
        "Flexible savings plan with high premium allocation and 8+ year payment terms, bundling "
        "a hospital cash-back rider alongside education, wedding, retirement, or property goals.",
    ),
    _plan(
        "SHANDAR_SARMAYA", "Shandar Sarmaya", "SINGLE_PREMIUM", "Conventional",
        "Single-premium (one-time payment) plan focused on high-yield investment — life "
        "protection up to 10x the amount invested, a minimal 5% bid/offer spread, and partial "
        "withdrawals allowed after 6 months.",
    ),
    _plan(
        "MUSTAKIL_YAQEEN", "Mustakil Yaqeen", "SAVINGS", "Conventional",
        "Long-term savings plan geared towards retirement or property goals, with three fund "
        "options matched to risk appetite and a loyalty bonus for long-term policyholders.",
    ),
    _plan(
        "MEHFOOZ_MUNAFA", "Mehfooz Munafa", "SAVINGS", "Conventional",
        "High premium-allocation savings plan for maximum fund growth — minimum 5-year flexible "
        "payment term, three investment funds, and a loyalty bonus.",
    ),
    _plan(
        "TAHAFUZZ_PLAN", "Tahafuzz Plan", "SAVINGS", "Conventional",
        "Adamjee Life's flagship 10-year flexible savings and protection plan, with a loyalty "
        "bonus from year 6 and a loan facility of up to 50% of the surrender value.",
    ),
    _plan(
        "SEHAT_ZAMANAT", "Sehat Zamanat", "HEALTH_CASH", "Conventional",
        "Micro-health plan providing lump-sum and daily cash benefits during hospitalization, "
        "plus accidental-disability coverage up to PKR 750,000, with digital policy management.",
    ),
    _plan(
        "SEHAT_KAFALAT", "Sehat Kafalat", "HEALTH_CASH", "Conventional",
        "Ultra-low-cost hospital cash-back plan — annual premium as low as PKR 500 — paying "
        "PKR 2,000/day for up to 30 days of hospitalization, for ages 18–59.",
    ),
    _plan(
        "PROTECT_PLAN", "Protect Plan", "TERM_LIFE", "Conventional",
        "Low-cost, digital-first pure life cover (term insurance) of up to PKR 1 million, with "
        "premiums starting from PKR 625 annually.",
    ),
    _plan(
        "COVID19_PROTECTION_PLAN", "COVID-19 Protection Plan", "HEALTH_CASH", "Conventional",
        "Short-term coverage designed specifically for pandemic-related hospitalization, sold in "
        "individual or family options across three coverage levels for 3- or 6-month terms.",
    ),

    # ── Takaful (Shariah-compliant) ─────────────────────────────────────────
    _plan(
        "NIBAH", "Nibah", "CHILD_EDUCATION_MARRIAGE", "Takaful",
        "Shariah-compliant goal-based savings for a child's education or wedding, investing "
        "across three Takaful funds, with a loyalty benefit of 5x the annual contribution paid "
        "as a lump sum plus ongoing contributions funded by Adamjee Life.",
    ),
    _plan(
        "ZORAIZ_SAVINGS_TAKAFUL", "Zoraiz Savings Takaful", "SAVINGS", "Takaful",
        "Unit-linked Takaful investment plan with built-in Hajj coverage — PKR 1 million "
        "accidental-death benefit during Hajj — alongside multiple risk-based Shariah-compliant "
        "fund options.",
    ),
    _plan(
        "SALSABIL_PLUS_FAMILY_TAKAFUL", "Salsabil Plus Family Takaful", "SAVINGS", "Takaful",
        "Family Takaful plan allowing highly flexible payment terms (minimum 5 years), high "
        "premium allocation, PKR 1 million Hajj accidental-death coverage, and three "
        "Shariah-compliant fund choices.",
    ),
    _plan(
        "ADAMJEE_BARAKAH_PLAN", "Barakah Plan", "SAVINGS", "Takaful",
        "Highly flexible Takaful savings plan offering loyalty bonuses for long-term "
        "participants, PKR 1 million Hajj coverage, and three Shariah-compliant fund options.",
    ),
    _plan(
        "KEFAYAT_PLAN", "Kefayat Plan", "CHILD_EDUCATION_MARRIAGE", "Takaful",
        "Low-entry Takaful plan for basic Islamic education/wedding savings — minimum "
        "contribution of PKR 8,000 annually — with a loyalty bonus and three fund options.",
    ),
    _plan(
        "ASAAN_TAKAFUL", "Asaan Takaful", "SINGLE_PREMIUM", "Takaful",
        "Single-payment Islamic investment architecture with no bid/offer spread, Takaful "
        "protection up to 10x the amount invested, and partial withdrawals allowed after 6 "
        "months.",
    ),
    _plan(
        "ZAYED_SAVINGS_TAKAFUL", "Zayed Savings Takaful", "SAVINGS", "Takaful",
        "Fixed 8-year term Takaful savings plan with high allocation, PKR 1 million Hajj "
        "coverage, a hospital cash-back rider, and three Shariah-compliant fund options.",
    ),

    # ── Bancassurance (bank-partnered) ──────────────────────────────────────
    _plan(
        "ADAMJEE_LIFE_PROTECTION_PLUS", "Life Protection Plus", "TERM_LIFE", "Bancassurance",
        "Premium core protection plan sold through MCB Bank — coverage up to PKR 2.5 million, a "
        "14-day free-look period, complimentary e-health consultations, and premiums starting "
        "from PKR 3,450 annually.",
        partner_bank="MCB Bank",
    ),
    _plan(
        "ADAMJEE_LIFE_SIGNATURE_PLUS", "Life Signature Plus", "SAVINGS", "Bancassurance",
        "High-tier bancassurance investment and savings plan — 75% first-year premium "
        "allocation, coverage flexible between 5–30x the premium, a savings booster of 103%, "
        "multiple fund options, and continuation bonuses of up to 50%.",
    ),
    _plan(
        "ADAMJEE_LIFE_MAYMAR_MUSTAKBIL", "Life Maymar Mustakbil", "SAVINGS", "Bancassurance",
        "Long-term future-planning bancassurance savings plan — 70% first-year allocation, low "
        "minimum premiums (PKR 25,000–50,000), a maturity payout equal to the account value, and "
        "an optional savings booster.",
    ),
    _plan(
        "ADAMJEE_LIFE_SAVE_AND_ASSURE", "Life Save And Assure", "SAVINGS", "Bancassurance",
        "General balanced savings and life-cover bancassurance plan — high loyalty bonuses, "
        "coverage multiples of 5–200x the premium, customizable riders, and a minimum "
        "investment of PKR 20,000.",
    ),
    _plan(
        "ADAMJEE_LIFE_TAMEER_EDUCATION", "Life Tameer Education", "CHILD_EDUCATION_MARRIAGE", "Bancassurance",
        "Bancassurance education-savings plan tuned for university fee maturity, sold through "
        "MCB Bank — multiple professionally managed funds, a low minimum premium of PKR 20,000, "
        "and no policy fees.",
        partner_bank="MCB Bank",
    ),
    _plan(
        "ADAMJEE_LIFE_PARVAAZ_SAVINGS", "Life Parvaaz – Savings", "SAVINGS", "Bancassurance",
        "Modular Parvaaz savings variant — coverage 5–200x the premium, up to 100% bonus at the "
        "20th policy year, minimum investment PKR 20,000, entry age 18–70.",
    ),
    _plan(
        "ADAMJEE_LIFE_PARVAAZ_HEALTH", "Life Parvaaz – Savings & Health", "HEALTH_CASH", "Bancassurance",
        "Modular Parvaaz Savings & Health variant, integrating savings and life protection with "
        "a hospitalization cash-back rider and multiple fund options.",
    ),
    _plan(
        "ADAMJEE_LIFE_PARVAAZ_EDUCATION_MARRIAGE", "Life Parvaaz – Education & Marriage",
        "CHILD_EDUCATION_MARRIAGE", "Bancassurance",
        "Modular Parvaaz Education & Marriage variant — a one-time life-event bonus equal to the "
        "initial basic premium after 10 policy years, a free premium-waiver rider, and 100%+ "
        "allocation from year 6.",
    ),
    _plan(
        "PASBAAN_PROTECTION_PLAN", "Pasbaan Protection Plan", "SAVINGS", "Bancassurance",
        "Standard financial safety-net plan for Khushhali Bank clients — loyalty bonuses from "
        "year 5, coverage 5–200x the premium, customizable riders, minimum premium PKR 175,000.",
        partner_bank="Khushhali Bank",
    ),
    _plan(
        "WASEELA_ZINDAGI", "Waseela Zindagi", "SAVINGS", "Bancassurance",
        "Inclusive life-protection savings plan sold through Mobilink Microfinance Bank — "
        "investment from PKR 8,000 annually, a minimum 5-year premium term, and coverage "
        "5–200x the premium.",
        partner_bank="Mobilink Microfinance Bank",
    ),
    _plan(
        "WASEELA_ZINDAGI_PLUS", "Waseela Zindagi Plus", "SAVINGS", "Bancassurance",
        "Enhanced Waseela Zindagi variant with a 25% loyalty bonus after year 5, a fixed 5-year "
        "term and paying period, and coverage 5–200x the premium.",
        partner_bank="Mobilink Microfinance Bank",
    ),
    _plan(
        "ZAMANAT_SAVINGS_PLAN", "Zamanat Savings Plan", "SAVINGS", "Bancassurance",
        "High-security savings engine sold through Khushhali Bank — annual premium from "
        "PKR 12,000, coverage 5–200x the premium, and continuation loyalty bonuses.",
        partner_bank="Khushhali Bank",
    ),
    _plan(
        "KHIDMAT_EDUCATION_AND_MARRIAGE_PLAN", "Khidmat Education and Marriage Plan",
        "CHILD_EDUCATION_MARRIAGE", "Bancassurance",
        "Dedicated family goal-funding plan sold through Khushhali Bank — loyalty bonus from "
        "year 5, coverage 5–200x the premium, policy term up to 40 years or age 80.",
        partner_bank="Khushhali Bank",
    ),
    _plan(
        "MUSTAQBIL_KI_ZAMANAT_PLAN", "Mustaqbil Ki Zamanat Plan", "TERM_LIFE", "Bancassurance",
        "Direct monthly income-replacement plan sold through Bank Alfalah — three coverage tiers "
        "with monthly benefits of PKR 20,000–40,000, for ages 18–59.",
        partner_bank="Bank Alfalah",
    ),
    _plan(
        "NIGRAAN", "Nigraan", "TERM_LIFE", "Bancassurance",
        "Tiered medical and life coverage sold through Bank Alfalah in Silver, Gold, and "
        "Platinum levels, for ages 18–59, with maximum coverage of PKR 1 million.",
        partner_bank="Bank Alfalah",
    ),

    # ── Group (unrelated to the Adamjee retail catalog above — backs the
    #    Organization/MasterPolicy group-insurance feature) ─────────────────
    {
        "code": "GROUP_LIFE", "label": "Group Life", "insurance_type": "GROUP_LIFE",
        "category": "Group", "product_category": "Conventional", "partner_bank": None, "color": "indigo",
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
        "category": "Group", "product_category": "Conventional", "partner_bank": None, "color": "indigo",
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
