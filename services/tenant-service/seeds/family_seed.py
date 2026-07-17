"""Seed a demo family (FamilyGroup) + a shared health floater + a life-bundle
policy for a tenant.

Exercises the full family-insurance vertical slice end to end: creates a
FamilyGroup, a floater FamilyPolicy confirmed for all 5 members (self,
spouse, 2 children, 1 parent — spanning risk-engine's FAMILY_FLOATER age band
from a minor to a retiree), and — if the tenant has an active TERM_LIFE
catalog plan — a second life-bundle FamilyPolicy confirmed for 2 of those
same members (reusing their existing Customer rows rather than re-creating
them; see routers/families.py's _get_or_create_member_customer), each with
their own coverage amount and plan.

Reuses the actual router functions (create_family_group/create_floater_policy/
confirm_floater_members/create_life_bundle_policy/confirm_life_bundle_members)
rather than re-deriving their pricing/risk-engine logic here — same reasoning
as seeds/organizations_seed.py's docstring: these are plain async functions
with an explicit `session` argument, so calling them directly (bypassing the
`Depends(verify_admin)` route-level dependency, which FastAPI only enforces
at the HTTP layer) exercises the real code path instead of a seed-only
reimplementation that could drift.

Idempotent: skips a tenant that already has a FamilyGroup named FAMILY_NAME —
safe to run multiple times.

Run inside the tenant-service container:

    # Seed one tenant
    docker compose exec tenant-service python -m seeds.family_seed \\
        --tenant-id 05788cf6-5bf0-4895-b73d-28bbe334518d

    # Seed every tenant in the database
    docker compose exec tenant-service python -m seeds.family_seed --all-tenants
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import date
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from schemas import FamilyGroupCreate, FamilyMembersRequest, FloaterPolicyCreate, LifeBundlePolicyCreate
from shared.models.core import FamilyGroup, InsurancePlan, InsuranceTypeEnum, PlanStatusEnum, Tenant
from routers.families import (
    confirm_floater_members,
    confirm_life_bundle_members,
    create_family_group,
    create_floater_policy,
    create_life_bundle_policy,
)

FAMILY_NAME = "Chaudhry Family"

# 5 synthetic members — CNIC series distinct from customers_seed.py's
# (35202-...), organizations_seed.py's (61101-1000...), and any tenant's
# manually-tested family data, to avoid a tenant-wide CNIC collision.
# Spans risk-engine's FAMILY_FLOATER age band (0-80): a 10-year-old child up
# to a 68-year-old parent.
_MEMBERS: list[dict] = [
    {"cnic": "61105-5000001-1", "name": "Imtiaz Chaudhry",  "dob": date(1980, 4, 18), "gender": "Male",   "occupation": "Civil Engineer", "declared_income": 2_200_000, "relationship": "Self",   "is_smoker": False, "height_cm": 176, "weight_kg": 80},
    {"cnic": "61105-5000002-2", "name": "Nadia Chaudhry",   "dob": date(1984, 9, 2),  "gender": "Female", "occupation": "Pharmacist",     "declared_income": 1_100_000, "relationship": "Spouse", "is_smoker": False, "height_cm": 161, "weight_kg": 60},
    {"cnic": "61105-5000003-3", "name": "Bilal Chaudhry",   "dob": date(2015, 6, 25), "gender": "Male",   "occupation": "Student",        "declared_income": 0,         "relationship": "Child",  "is_smoker": False, "height_cm": 120, "weight_kg": 25},
    {"cnic": "61105-5000004-4", "name": "Areeba Chaudhry",  "dob": date(2018, 12, 3), "gender": "Female", "occupation": "Student",        "declared_income": 0,         "relationship": "Child",  "is_smoker": False, "height_cm": 100, "weight_kg": 17},
    {"cnic": "61105-5000005-5", "name": "Shaukat Chaudhry", "dob": date(1957, 2, 11), "gender": "Male",   "occupation": "Retired",        "declared_income": 0,         "relationship": "Parent", "is_smoker": False, "height_cm": 168, "weight_kg": 72},
]


async def seed_family(session: AsyncSession, tenant_id: UUID) -> dict | None:
    """Create one demo family + floater (all 5 members) + life bundle (the
    first 2 members, if the tenant has an active TERM_LIFE plan) for
    `tenant_id`. Returns a summary dict, or None if this tenant already has
    FAMILY_NAME (idempotent skip)."""
    existing = await session.exec(
        select(FamilyGroup).where(FamilyGroup.tenant_id == tenant_id, FamilyGroup.name == FAMILY_NAME)
    )
    if existing.first() is not None:
        return None

    family = await create_family_group(
        tenant_id=tenant_id,
        body=FamilyGroupCreate(
            name=FAMILY_NAME,
            contact_person="Imtiaz Chaudhry",
            contact_email="imtiaz.chaudhry@example.pk",
            contact_phone="+92-321-9988776",
            household_declared_income=3_300_000,
        ),
        session=session,
    )

    floater_policy = await create_floater_policy(
        tenant_id=tenant_id,
        family_id=family.id,
        body=FloaterPolicyCreate(total_sum_insured=5_000_000, term_years=1, effective_date=date.today()),
        session=session,
    )
    floater_response = await confirm_floater_members(
        tenant_id=tenant_id,
        family_id=family.id,
        fp_id=floater_policy.id,
        body=FamilyMembersRequest(members=_MEMBERS),
        session=session,
    )

    # Life bundle only if the tenant has an active TERM_LIFE catalog plan to
    # price against — a tenant that hasn't run insurance_plans_seed.py (or
    # whose catalog has no TERM_LIFE row) still gets the floater half of this
    # seed rather than failing outright.
    term_life_plan = (await session.exec(
        select(InsurancePlan).where(
            InsurancePlan.tenant_id == tenant_id,
            InsurancePlan.insurance_type == InsuranceTypeEnum.TERM_LIFE,
            InsurancePlan.status == PlanStatusEnum.ACTIVE,
        )
    )).first()

    life_bundle_response = None
    if term_life_plan is not None:
        life_bundle_policy = await create_life_bundle_policy(
            tenant_id=tenant_id,
            family_id=family.id,
            body=LifeBundlePolicyCreate(term_years=10, effective_date=date.today(), discount_percentage=10.0),
            session=session,
        )
        life_bundle_members = [
            {**_MEMBERS[0], "coverage_amount": 12_000_000, "plan_code": term_life_plan.code},
            {**_MEMBERS[1], "coverage_amount": 9_000_000, "plan_code": term_life_plan.code},
        ]
        life_bundle_response = await confirm_life_bundle_members(
            tenant_id=tenant_id,
            family_id=family.id,
            fp_id=life_bundle_policy.id,
            body=FamilyMembersRequest(members=life_bundle_members),
            session=session,
        )

    return {
        "floater": floater_response.model_dump(),
        "life_bundle": life_bundle_response.model_dump() if life_bundle_response else None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry-point  (mirrors organizations_seed.py)
# ─────────────────────────────────────────────────────────────────────────────

async def _run(tenant_id: UUID | None, all_tenants: bool) -> None:
    from database import _session_factory  # lazy import — avoids DB engine at module load

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
            outcome = await seed_family(session, tenant.id)
            if outcome is None:
                print(f"[{tenant.name}] {tenant.id}: '{FAMILY_NAME}' already exists — skipped.")
                continue

            floater = outcome["floater"]
            msg = (
                f"[{tenant.name}] {tenant.id}: created '{FAMILY_NAME}' — "
                f"floater pool={floater['total_sum_insured']:,.0f} ({len(floater['members'])} members)"
            )
            if outcome["life_bundle"] is not None:
                msg += f", life bundle ({len(outcome['life_bundle']['members'])} members)."
            else:
                msg += "; no active TERM_LIFE plan for this tenant — life bundle skipped."
            print(msg)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed a demo family (floater + life bundle) for a tenant."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--tenant-id",   type=UUID, help="UUID of the tenant to seed.")
    group.add_argument("--all-tenants", action="store_true", help="Seed every tenant in the database.")
    args = parser.parse_args()

    asyncio.run(_run(args.tenant_id, args.all_tenants))


if __name__ == "__main__":
    main()
