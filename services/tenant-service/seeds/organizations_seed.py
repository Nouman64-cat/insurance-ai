"""Seed a demo corporate organization + master policy + employee census for a tenant.

Exercises the full group-life vertical slice end to end: creates an
Organization, a MasterPolicy, then confirms a synthetic ~15-employee census
with a deliberate spread of ages/incomes so some employees land above the
computed Free Cover Limit (routed through risk-engine) and some at/under it
(guaranteed issue) — see routers/organizations.py's confirm_employee_census.

Reuses the actual router functions (create_organization/create_master_policy/
confirm_employee_census) rather than re-deriving their FCL/pricing/risk-engine
logic here — those functions are plain async functions with an explicit
`session` argument, so calling them directly (bypassing the `Depends(verify_admin)`
route-level dependency, which FastAPI only enforces at the HTTP layer) exercises
the real code path instead of a seed-only reimplementation that could drift.

Idempotent: skips a tenant that already has an organization named
ORG_NAME — safe to run multiple times.

Run inside the tenant-service container:

    # Seed one tenant
    docker compose exec tenant-service python -m seeds.organizations_seed \\
        --tenant-id 05788cf6-5bf0-4895-b73d-28bbe334518d

    # Seed every tenant in the database
    docker compose exec tenant-service python -m seeds.organizations_seed --all-tenants
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import date
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from schemas import CensusRequest, MasterPolicyCreate, OrganizationCreate
from shared.models.core import Organization, Tenant
from routers.organizations import confirm_employee_census, create_master_policy, create_organization

ORG_NAME = "Meridian Textiles (Pvt) Ltd"

# 15 synthetic employees — CNIC series distinct from customers_seed.py's
# hand-picked profiles (35202-...) to avoid any tenant-wide CNIC collision.
# Ages/incomes deliberately spread so the computed Free Cover Limit (based on
# this batch's size=15 and average age) is crossed by roughly half the group.
_EMPLOYEES: list[dict] = [
    {"cnic": "61101-1000001-1", "name": "Imran Sheikh",      "dob": date(1985, 3, 12), "gender": "Male",   "occupation": "Production Supervisor", "declared_income": 1_800_000},
    {"cnic": "61101-1000002-2", "name": "Bushra Aslam",      "dob": date(1990, 7, 24), "gender": "Female", "occupation": "HR Officer",             "declared_income": 1_200_000},
    {"cnic": "61101-1000003-3", "name": "Waqas Farooqi",     "dob": date(1979, 1, 5),  "gender": "Male",   "occupation": "Plant Manager",          "declared_income": 3_600_000},
    {"cnic": "61101-1000004-4", "name": "Sana Iftikhar",     "dob": date(1996, 11, 2), "gender": "Female", "occupation": "Accounts Assistant",     "declared_income": 720_000},
    {"cnic": "61101-1000005-5", "name": "Adnan Baig",        "dob": date(1988, 5, 30), "gender": "Male",   "occupation": "Loom Operator",          "declared_income": 480_000},
    {"cnic": "61101-1000006-6", "name": "Farah Naveed",      "dob": date(1992, 9, 18), "gender": "Female", "occupation": "Quality Inspector",      "declared_income": 900_000},
    {"cnic": "61101-1000007-7", "name": "Kashif Rasheed",    "dob": date(1975, 2, 14), "gender": "Male",   "occupation": "Finance Manager",        "declared_income": 4_200_000},
    {"cnic": "61101-1000008-8", "name": "Mehwish Tariq",     "dob": date(1994, 4, 9),  "gender": "Female", "occupation": "Dispatch Clerk",         "declared_income": 540_000},
    {"cnic": "61101-1000009-9", "name": "Zeeshan Qadir",     "dob": date(1983, 8, 21), "gender": "Male",   "occupation": "Maintenance Engineer",   "declared_income": 1_500_000},
    {"cnic": "61101-1000010-0", "name": "Rabia Hameed",      "dob": date(1998, 6, 3),  "gender": "Female", "occupation": "Junior Weaver",           "declared_income": 420_000},
    {"cnic": "61101-1000011-1", "name": "Naveed Akhtar",     "dob": date(1981, 12, 27), "gender": "Male",  "occupation": "Warehouse Supervisor",   "declared_income": 1_650_000},
    {"cnic": "61101-1000012-2", "name": "Ayesha Noor",       "dob": date(1993, 3, 16), "gender": "Female", "occupation": "Payroll Officer",        "declared_income": 960_000},
    {"cnic": "61101-1000013-3", "name": "Tahir Mahmood",     "dob": date(1977, 10, 8), "gender": "Male",   "occupation": "General Manager",        "declared_income": 5_400_000},
    {"cnic": "61101-1000014-4", "name": "Sidra Yousaf",      "dob": date(1995, 1, 20), "gender": "Female", "occupation": "Machine Operator",       "declared_income": 460_000},
    {"cnic": "61101-1000015-5", "name": "Bilal Sarwar",      "dob": date(1987, 7, 11), "gender": "Male",   "occupation": "Shift Supervisor",       "declared_income": 1_350_000},
]


async def seed_organization(session: AsyncSession, tenant_id: UUID) -> dict | None:
    """Create one demo organization + master policy + confirmed census for
    `tenant_id`. Returns the confirm-census response dict, or None if this
    tenant already has ORG_NAME (idempotent skip)."""
    existing = await session.exec(
        select(Organization).where(Organization.tenant_id == tenant_id, Organization.name == ORG_NAME)
    )
    if existing.first() is not None:
        return None

    org = await create_organization(
        tenant_id=tenant_id,
        body=OrganizationCreate(
            name=ORG_NAME,
            registration_number="SECP-0071223",
            industry="Textiles Manufacturing",
            contact_person="Farrukh Zaman",
            contact_email="hr@meridiantextiles.example.pk",
            contact_phone="+92-42-111-2233",
        ),
        session=session,
    )

    master_policy = await create_master_policy(
        tenant_id=tenant_id,
        org_id=org.id,
        body=MasterPolicyCreate(
            sum_assured_multiple=24.0,
            term_years=1,
            effective_date=date.today(),
        ),
        session=session,
    )

    confirm_response = await confirm_employee_census(
        tenant_id=tenant_id,
        org_id=org.id,
        mp_id=master_policy.id,
        body=CensusRequest(employees=_EMPLOYEES),
        session=session,
    )
    return confirm_response.model_dump()


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry-point  (mirrors customers_seed.py / insurance_plans_seed.py)
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
            outcome = await seed_organization(session, tenant.id)
            if outcome is None:
                print(f"[{tenant.name}] {tenant.id}: '{ORG_NAME}' already exists — skipped.")
                continue

            employees = outcome["employees"]
            above_fcl = sum(1 for e in employees if e["coverage_amount"] > outcome["free_cover_limit"])
            print(
                f"[{tenant.name}] {tenant.id}: created '{ORG_NAME}' — "
                f"free_cover_limit={outcome['free_cover_limit']:,.0f}, "
                f"{len(employees)} employees enrolled ({above_fcl} above FCL / routed to underwriting)."
            )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed a demo organization + master policy + employee census for a tenant."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--tenant-id",   type=UUID, help="UUID of the tenant to seed.")
    group.add_argument("--all-tenants", action="store_true", help="Seed every tenant in the database.")
    args = parser.parse_args()

    asyncio.run(_run(args.tenant_id, args.all_tenants))


if __name__ == "__main__":
    main()
