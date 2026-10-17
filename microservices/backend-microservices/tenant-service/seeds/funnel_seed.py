"""
Minimal funnel seed — 5 leads (3 individual, 1 family, 1 corporate), nothing else.

The user wants the pipeline screens to start with just:
  • Leads page      — 5 leads: 3 Individual (Customer.profile_status = LEAD),
                      1 Family (bare FamilyGroup, no members yet), 1 Corporate
                      (bare Organization, no employees yet).
  • Proposal page   — 3 draft proposals (Policy.status = Quoted), one per
                      individual lead. The family/corporate leads are seeded
                      at the same "just captured, no members" stage a real
                      quick-lead would start at, so they carry no policy yet
                      (a family/org needs at least one member before a plan
                      can be quoted against it) — same reason they're
                      deliberately NOT given a member Customer here: the Leads
                      page lists individual customers on their own, so a
                      member would double up as its own "Individual" row and
                      throw off the 3/1/1 split.
and everything else empty (no underwriting cases, no approved/issuable policies,
no policyholders, no applications).

So each seeded individual is ONE Customer (LEAD) + ONE Policy (Quoted) + a
PremiumQuote — and deliberately NO Case / RiskAssessment / Stage A rows, so the
underwriting / applications / issuance / policyholder screens stay clean.

Runs a full purge of the tenant first (via stage_a_seed.purge_tenant), so it is
a clean slate every time. purge_tenant only deletes Customer rows (and what
cascades from them) — it deliberately leaves Organization/FamilyGroup shells
alone (see its docstring) — so the family/corporate leads here are found-or-
created by name instead of blindly inserted, or every reset would pile up a
fresh duplicate shell.

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
    FamilyGroup,
    Gender,
    InsuranceTypeEnum,
    MaritalStatus,
    Organization,
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
# 3 individual leads, each carrying one draft (Quoted) proposal.
# ─────────────────────────────────────────────────────────────────────────────

INDIVIDUAL_LEADS: list[dict] = [
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
        "cnic": "17301-9920184-6", "name": "Sadia Noor", "dob": date(1993, 9, 28),
        "gender": Gender.FEMALE, "marital_status": MaritalStatus.SINGLE,
        "occupation": "Software Developer", "declared_income": 3_000_000,
        "is_smoker": False, "city": "Peshawar", "province": "Khyber Pakhtunkhwa",
        "product_name": "Term Life 25", "insurance_type": InsuranceTypeEnum.TERM_LIFE,
        "coverage_amount": 8_000_000, "term_years": 25, "base_rate": 3.2,
        "nominee_name": "Noor Muhammad", "nominee_relationship": "Father",
    },
]

# 1 family lead — a bare household shell, same stage a "+ Add Family" quick
# lead starts at before any member is added.
FAMILY_LEAD: dict = {
    "name": "Khan Family",
    "contact_person": "Ahmed Khan",
    "contact_email": "ahmed.khan@example.com",
    "contact_phone": "0300-1234567",
    "city": "Lahore", "province": "Punjab",
}

# 1 corporate lead — a bare employer shell, same stage a "+ Add Corporate"
# quick lead starts at before any employee/census is added.
CORPORATE_LEAD: dict = {
    "name": "Metro Textiles Ltd",
    "registration_number": "REG-2026-00147",
    "industry": "Manufacturing",
    "contact_person": "Farhan Malik",
    "contact_email": "hr@metrotextiles.pk",
    "contact_phone": "042-1112223334",
    "city": "Lahore", "province": "Punjab",
}


async def seed_leads(session: AsyncSession, tenant_id: UUID) -> list[Customer | FamilyGroup | Organization]:
    """Insert the 3 individual leads + their draft proposals, and find-or-create
    the 1 family + 1 corporate lead shell, for one tenant."""
    existing_cnics = set((await session.exec(
        select(Customer.cnic).where(Customer.tenant_id == tenant_id))).all())
    sources = await get_or_seed_sources(session, tenant_id)
    now = datetime.utcnow()
    created: list[Customer | FamilyGroup | Organization] = []

    for spec in INDIVIDUAL_LEADS:
        if spec["cnic"] in existing_cnics:
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

        # The proposal — a draft (Quoted) policy, no case, so it shows on the
        # Proposal page's Draft tab but not in underwriting / issuance.
        policy = Policy(
            tenant_id=tenant_id, customer_id=customer.id,
            product_name=spec["product_name"], insurance_type=spec["insurance_type"],
            coverage_amount=spec["coverage_amount"], term_years=spec["term_years"],
            nominee_name=spec["nominee_name"], nominee_relationship=spec["nominee_relationship"],
            status=PolicyStatusEnum.QUOTED,
        )
        session.add(policy)
        await session.flush()

        session.add(PremiumQuote(
            tenant_id=tenant_id, policy_id=policy.id,
            base_premium=pricing["base_premium"], loading_applied=pricing["loading_amount"],
            total_premium=pricing["total_premium"], rate_version="SEED-1.0",
        ))
        session.add(PolicyEvent(
            tenant_id=tenant_id, policy_id=policy.id, event_type="PolicyQuoted",
            from_status=None, to_status="Quoted", actor="seed",
            detail_json={"seeded": True}, created_at=now - timedelta(days=2),
        ))
        created.append(customer)

    # Family lead — reuse the shell if a previous reset already created it
    # (purge_tenant intentionally never deletes FamilyGroup rows).
    family = (await session.exec(
        select(FamilyGroup).where(FamilyGroup.tenant_id == tenant_id, FamilyGroup.name == FAMILY_LEAD["name"])
    )).first()
    if family is None:
        family = FamilyGroup(
            tenant_id=tenant_id, name=FAMILY_LEAD["name"],
            contact_person=FAMILY_LEAD["contact_person"], contact_email=FAMILY_LEAD["contact_email"],
            contact_phone=FAMILY_LEAD["contact_phone"], city=FAMILY_LEAD["city"], province=FAMILY_LEAD["province"],
            profile_status=ProfileStatusEnum.LEAD,
        )
        session.add(family)
        await session.flush()
    created.append(family)

    # Corporate lead — same find-or-create reasoning as the family above.
    org = (await session.exec(
        select(Organization).where(Organization.tenant_id == tenant_id, Organization.name == CORPORATE_LEAD["name"])
    )).first()
    if org is None:
        org = Organization(
            tenant_id=tenant_id, name=CORPORATE_LEAD["name"],
            registration_number=CORPORATE_LEAD["registration_number"], industry=CORPORATE_LEAD["industry"],
            contact_person=CORPORATE_LEAD["contact_person"], contact_email=CORPORATE_LEAD["contact_email"],
            contact_phone=CORPORATE_LEAD["contact_phone"], city=CORPORATE_LEAD["city"], province=CORPORATE_LEAD["province"],
            profile_status=ProfileStatusEnum.LEAD,
        )
        session.add(org)
        await session.flush()
    created.append(org)

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
                  f"seeded {len(created)} lead(s) (3 individual + 1 family + 1 corporate)")
            for c in created:
                print(f"  ✓ {c.name}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed 5 leads (3 individual + 1 family + 1 corporate).")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--tenant-id", type=UUID, help="Seed a single tenant by UUID.")
    group.add_argument("--all-tenants", action="store_true", help="Seed every tenant.")
    args = parser.parse_args()
    asyncio.run(_run(args.tenant_id, args.all_tenants))


if __name__ == "__main__":
    main()
