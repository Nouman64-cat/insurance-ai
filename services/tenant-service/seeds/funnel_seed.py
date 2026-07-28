"""
Minimal funnel seed — N leads, each with an in-progress proposal, nothing else.

The user wants the pipeline screens to start with just:
  • Leads page      — 5 leads (Customer.profile_status = LEAD)
  • Proposal page   — 5 in-progress proposals (Policy.status = Proposed) against
                      those same leads
and everything else empty (no underwriting cases, no approved/issuable policies,
no policyholders, no applications).

So each seeded person is ONE Customer (LEAD) + ONE Policy (Proposed) + a
PremiumQuote — and deliberately NO Case / RiskAssessment / Stage A rows, so the
underwriting / applications / issuance / policyholder screens stay clean.

Runs a full purge of the tenant first (via stage_a_seed.purge_tenant), so it is
a clean slate every time. Extend LEADS below to add more, or add other stages
later (5 per stage) — the purge + insert pattern stays the same.

Run inside the tenant-service container:

    docker compose exec tenant-service python -m seeds.funnel_seed --all-tenants
    docker compose exec tenant-service python -m seeds.funnel_seed --tenant-id <uuid>
"""

from __future__ import annotations

import argparse
import asyncio
import random
from datetime import date, datetime, timedelta
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import (
    Customer,
    Gender,
    InsuranceTypeEnum,
    MaritalStatus,
    Policy,
    PolicyEvent,
    PolicyStatusEnum,
    PremiumQuote,
    ProfileStatusEnum,
    Tenant,
)
from seeds.acquisition_sources_seed import get_or_seed_sources
from seeds.stage_a_seed import purge_tenant

_POLICY_FEE = 500.0
_TAX_RATE = 0.01


def _price(coverage: float, term: int, base_rate: float) -> dict:
    base = round((base_rate / 1000.0) * coverage * (0.5 + term / 40.0), 0)
    tax = round((base + _POLICY_FEE) * _TAX_RATE, 0)
    return {"base_premium": base, "loading_amount": 0.0, "total_premium": base + _POLICY_FEE + tax}


# ─────────────────────────────────────────────────────────────────────────────
# 5 leads, each carrying one in-progress (Proposed) proposal.
# ─────────────────────────────────────────────────────────────────────────────

LEADS: list[dict] = [
    {
        "cnic": "35202-6710453-9", "name": "Zoya Kamal", "dob": date(1995, 3, 21),
        "gender": Gender.FEMALE, "marital_status": MaritalStatus.SINGLE,
        "occupation": "Graphic Designer", "declared_income": 1_800_000,
        "is_smoker": False, "city": "Lahore", "province": "Punjab",
        "product_name": "Term Life 20", "insurance_type": InsuranceTypeEnum.TERM_LIFE,
        "coverage_amount": 5_000_000, "term_years": 20, "base_rate": 3.2,
        "nominee_name": "Kamal Uddin", "nominee_relationship": "Father",
    },
    {
        "cnic": "42101-4488210-3", "name": "Bilal Ansari", "dob": date(1987, 8, 9),
        "gender": Gender.MALE, "marital_status": MaritalStatus.MARRIED,
        "occupation": "Bank Manager", "declared_income": 3_600_000,
        "is_smoker": False, "city": "Karachi", "province": "Sindh",
        "product_name": "Term Life 25", "insurance_type": InsuranceTypeEnum.TERM_LIFE,
        "coverage_amount": 10_000_000, "term_years": 25, "base_rate": 3.4,
        "nominee_name": "Sana Ansari", "nominee_relationship": "Spouse",
    },
    {
        "cnic": "61101-7752104-1", "name": "Hina Tariq", "dob": date(1991, 12, 2),
        "gender": Gender.FEMALE, "marital_status": MaritalStatus.MARRIED,
        "occupation": "Pharmacist", "declared_income": 2_400_000,
        "is_smoker": False, "city": "Islamabad", "province": "Islamabad",
        "product_name": "Health Platinum", "insurance_type": InsuranceTypeEnum.HEALTH_CASH,
        "coverage_amount": 4_000_000, "term_years": 15, "base_rate": 3.6,
        "nominee_name": "Tariq Javed", "nominee_relationship": "Spouse",
    },
    {
        "cnic": "33100-3391827-5", "name": "Usman Ghani", "dob": date(1984, 5, 17),
        "gender": Gender.MALE, "marital_status": MaritalStatus.MARRIED,
        "occupation": "School Principal", "declared_income": 2_100_000,
        "is_smoker": False, "city": "Faisalabad", "province": "Punjab",
        "product_name": "Term Life 20", "insurance_type": InsuranceTypeEnum.TERM_LIFE,
        "coverage_amount": 6_000_000, "term_years": 20, "base_rate": 3.3,
        "nominee_name": "Ayesha Ghani", "nominee_relationship": "Spouse",
    },
    {
        "cnic": "17301-9920184-6", "name": "Sadia Noor", "dob": date(1993, 9, 28),
        "gender": Gender.FEMALE, "marital_status": MaritalStatus.SINGLE,
        "occupation": "Software Developer", "declared_income": 3_000_000,
        "is_smoker": False, "city": "Peshawar", "province": "Khyber Pakhtunkhwa",
        "product_name": "Term Life 25", "insurance_type": InsuranceTypeEnum.TERM_LIFE,
        "coverage_amount": 8_000_000, "term_years": 25, "base_rate": 3.2,
        "nominee_name": "Noor Muhammad", "nominee_relationship": "Father",
    },
]


async def seed_leads(session: AsyncSession, tenant_id: UUID) -> list[Customer]:
    """Insert the leads + their in-progress proposals for one tenant."""
    existing = set((await session.exec(
        select(Customer.cnic).where(Customer.tenant_id == tenant_id))).all())
    sources = await get_or_seed_sources(session, tenant_id)
    now = datetime.utcnow()
    created: list[Customer] = []

    for spec in LEADS:
        if spec["cnic"] in existing:
            continue
        pricing = _price(spec["coverage_amount"], spec["term_years"], spec["base_rate"])

        customer = Customer(
            tenant_id=tenant_id, cnic=spec["cnic"], name=spec["name"], dob=spec["dob"],
            gender=spec["gender"], marital_status=spec["marital_status"],
            occupation=spec["occupation"], declared_income=spec["declared_income"],
            is_smoker=spec["is_smoker"], city=spec["city"], province=spec["province"],
            profile_status=ProfileStatusEnum.LEAD,
            acquisition_source_id=random.choice(sources).id if sources else None,
        )
        session.add(customer)
        await session.flush()

        # The proposal — an in-progress (Proposed / "Submitted") policy, no case,
        # so it shows on the Proposal page but not in underwriting / issuance.
        policy = Policy(
            tenant_id=tenant_id, customer_id=customer.id,
            product_name=spec["product_name"], insurance_type=spec["insurance_type"],
            coverage_amount=spec["coverage_amount"], term_years=spec["term_years"],
            nominee_name=spec["nominee_name"], nominee_relationship=spec["nominee_relationship"],
            status=PolicyStatusEnum.PROPOSED,
        )
        session.add(policy)
        await session.flush()

        session.add(PremiumQuote(
            tenant_id=tenant_id, policy_id=policy.id,
            base_premium=pricing["base_premium"], loading_applied=pricing["loading_amount"],
            total_premium=pricing["total_premium"], rate_version="SEED-1.0",
        ))
        for offset, (evt, frm, to) in enumerate(
            [("PolicyQuoted", None, "Quoted"), ("QuoteProposed", "Quoted", "Proposed")]
        ):
            session.add(PolicyEvent(
                tenant_id=tenant_id, policy_id=policy.id, event_type=evt,
                from_status=frm, to_status=to, actor="seed",
                detail_json={"seeded": True}, created_at=now - timedelta(days=2 - offset),
            ))
        created.append(customer)

    await session.commit()
    return created


async def _run(tenant_id: UUID | None, all_tenants: bool) -> None:
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
            purged = await purge_tenant(session, tenant.id)
            created = await seed_leads(session, tenant.id)
            print(f"[{tenant.name}] {tenant.id}: purged {purged} customer(s), "
                  f"seeded {len(created)} lead(s) + in-progress proposal(s)")
            for c in created:
                print(f"  ✓ {c.name}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed 5 leads + in-progress proposals (clean funnel).")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--tenant-id", type=UUID, help="Seed a single tenant by UUID.")
    group.add_argument("--all-tenants", action="store_true", help="Seed every tenant.")
    args = parser.parse_args()
    asyncio.run(_run(args.tenant_id, args.all_tenants))


if __name__ == "__main__":
    main()
