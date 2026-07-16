"""Seed a realistic Pakistani insurer network — tenants (insurance companies)
plus their regional-office/branch network — for local development.

Company *names* are real, well-known Pakistani insurers (same convention as
seeds/insurance_plans_seed.py, whose retail catalog is sourced from Adamjee
Life's real product line) — this seed adds a few more of the market's major
players so multi-tenant demos aren't just Adamjee. Company-profile fields
(registration/license numbers, contact details) are synthetic placeholders
derived from each tenant's code — not sourced from real SECP filings.

BRANCH_NETWORK_TEMPLATE is a standard 10-office network (head office +
regional offices + branches + one liaison office) applied identically to
every tenant, spanning Pakistan's four provinces plus Islamabad — mirrors how
INSURANCE_PLAN_SEED_DATA in insurance_plans_seed.py is applied identically to
every tenant. branch_code is unique per tenant only (see
shared/models/core.py Branch.__table_args__), so the same city codes are
reused across tenants. Addresses are generic, well-known commercial districts
per city, not a specific company's verified street address.

Both seed_tenant_catalog() and seed_branches() are idempotent — safe to run
repeatedly; already-present codes are skipped, never duplicated.

Run inside the tenant-service container:

    # Create the demo tenant catalog below (skips any tenant whose `code`
    # already exists) and seed each new tenant's branch network.
    docker compose exec tenant-service python -m seeds.tenants_seed

    # Instead, just backfill the standard branch network onto tenant(s) that
    # already exist (e.g. a tenant created via the SuperAdmin UI) without
    # touching the demo catalog:
    docker compose exec tenant-service python -m seeds.tenants_seed --tenant-id <uuid>
    docker compose exec tenant-service python -m seeds.tenants_seed --all-tenants
"""

from __future__ import annotations

import argparse
import asyncio
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import Branch, Tenant

# ── Standard branch network, applied to every tenant ──────────────────────────

BRANCH_NETWORK_TEMPLATE: list[dict] = [
    {"branch_code": "KHI-HO", "name": "Karachi Head Office", "branch_type": "HEAD_OFFICE",
     "region": "Sindh", "city": "Karachi", "address": "I.I. Chundrigar Road, Karachi",
     "postal_code": "74000", "contact_phone": "+92-21-111-000-100"},
    {"branch_code": "LHR-01", "name": "Lahore Regional Office", "branch_type": "REGIONAL_OFFICE",
     "region": "Punjab", "city": "Lahore", "address": "Egerton Road, Lahore",
     "postal_code": "54000", "contact_phone": "+92-42-111-000-100"},
    {"branch_code": "ISB-01", "name": "Islamabad Regional Office", "branch_type": "REGIONAL_OFFICE",
     "region": "Islamabad Capital Territory", "city": "Islamabad", "address": "Blue Area, Islamabad",
     "postal_code": "44000", "contact_phone": "+92-51-111-000-100"},
    {"branch_code": "RWP-01", "name": "Rawalpindi Branch", "branch_type": "BRANCH",
     "region": "Punjab", "city": "Rawalpindi", "address": "Mall Road, Rawalpindi",
     "postal_code": "46000", "contact_phone": "+92-51-111-000-101"},
    {"branch_code": "FSD-01", "name": "Faisalabad Branch", "branch_type": "BRANCH",
     "region": "Punjab", "city": "Faisalabad", "address": "Susan Road, Faisalabad",
     "postal_code": "38000", "contact_phone": "+92-41-111-000-100"},
    {"branch_code": "MUX-01", "name": "Multan Branch", "branch_type": "BRANCH",
     "region": "Punjab", "city": "Multan", "address": "Abdali Road, Multan",
     "postal_code": "60000", "contact_phone": "+92-61-111-000-100"},
    {"branch_code": "PEW-01", "name": "Peshawar Regional Office", "branch_type": "REGIONAL_OFFICE",
     "region": "Khyber Pakhtunkhwa", "city": "Peshawar", "address": "Saddar Road, Peshawar",
     "postal_code": "25000", "contact_phone": "+92-91-111-000-100"},
    {"branch_code": "UET-01", "name": "Quetta Branch", "branch_type": "BRANCH",
     "region": "Balochistan", "city": "Quetta", "address": "Jinnah Road, Quetta",
     "postal_code": "87300", "contact_phone": "+92-81-111-000-100"},
    {"branch_code": "HYD-01", "name": "Hyderabad Branch", "branch_type": "BRANCH",
     "region": "Sindh", "city": "Hyderabad", "address": "Auto Bhan Road, Hyderabad",
     "postal_code": "71000", "contact_phone": "+92-22-111-000-100"},
    {"branch_code": "SKT-01", "name": "Sialkot Liaison Office", "branch_type": "LIAISON_OFFICE",
     "region": "Punjab", "city": "Sialkot", "address": "Paris Road, Sialkot",
     "postal_code": "51310", "contact_phone": "+92-52-111-000-100"},
]

# ── Demo tenant catalog — real, well-known Pakistani insurers ─────────────────

TENANT_SEED_DATA: list[dict] = [
    {
        "name": "EFU Life Assurance Ltd",
        "code": "EFULIFE",
        "head_office_address": "EFU Life House, Karachi",
        "city": "Karachi", "province": "Sindh",
        "contact_person": "Client Services Desk",
    },
    {
        "name": "Jubilee Life Insurance Company Limited",
        "code": "JUBILEELIFE",
        "head_office_address": "Jubilee Insurance House, I.I. Chundrigar Road, Karachi",
        "city": "Karachi", "province": "Sindh",
        "contact_person": "Client Services Desk",
    },
    {
        "name": "State Life Insurance Corporation of Pakistan",
        "code": "STATELIFE",
        "head_office_address": "State Life Building No. 9, Karachi",
        "city": "Karachi", "province": "Sindh",
        "contact_person": "Client Services Desk",
    },
    {
        "name": "IGI Life Insurance Limited",
        "code": "IGILIFE",
        "head_office_address": "IGI House, Karachi",
        "city": "Karachi", "province": "Sindh",
        "contact_person": "Client Services Desk",
    },
    {
        "name": "Pak-Qatar Family Takaful Limited",
        "code": "PAKQATARTAKAFUL",
        "head_office_address": "Federation House, Karachi",
        "city": "Karachi", "province": "Sindh",
        "contact_person": "Client Services Desk",
    },
    {
        "name": "TPL Life Insurance Limited",
        "code": "TPLLIFE",
        "head_office_address": "TPL Corp Centre, Karachi",
        "city": "Karachi", "province": "Sindh",
        "contact_person": "Client Services Desk",
    },
]


def _synthetic_profile_fields(code: str, seq: int) -> dict:
    """Placeholder company-profile values — not real SECP filings."""
    return {
        "registration_number": f"SECP-DEMO-{seq:04d}",
        "license_number": f"SECP-INS-DEMO-{seq:04d}",
        "contact_email": f"info@{code.lower()}-demo.pk",
        "contact_phone": "+92-21-111-000-000",
    }


async def seed_branches(session: AsyncSession, tenant_id: UUID) -> list[Branch]:
    """Insert the standard branch network for one tenant, skipping codes that
    already exist. Idempotent — safe to run repeatedly. Returns the branches
    actually created."""
    existing = await session.exec(
        select(Branch.branch_code).where(Branch.tenant_id == tenant_id)
    )
    existing_codes = set(existing.all())

    created: list[Branch] = []
    for spec in BRANCH_NETWORK_TEMPLATE:
        if spec["branch_code"] in existing_codes:
            continue
        branch = Branch(tenant_id=tenant_id, **spec)
        session.add(branch)
        created.append(branch)

    await session.commit()
    for branch in created:
        await session.refresh(branch)
    return created


async def seed_tenant_catalog(session: AsyncSession) -> list[Tenant]:
    """Create the demo tenant catalog (skipping any code/name that already
    exists) and seed each new tenant's branch network. Returns tenants
    actually created."""
    existing_codes = set((await session.exec(select(Tenant.code))).all())
    existing_names = set((await session.exec(select(Tenant.name))).all())

    created: list[Tenant] = []
    for seq, spec in enumerate(TENANT_SEED_DATA, start=1):
        if spec["code"] in existing_codes or spec["name"] in existing_names:
            continue
        tenant = Tenant(**spec, **_synthetic_profile_fields(spec["code"], seq))
        session.add(tenant)
        await session.flush()
        created.append(tenant)

    await session.commit()
    for tenant in created:
        await session.refresh(tenant)
        await seed_branches(session, tenant.id)

    return created


async def _run(tenant_id: UUID | None, all_tenants: bool) -> None:
    # Imported lazily so importing the catalogs from the API layer never pulls
    # in a DB engine/connection (same reasoning as insurance_plans_seed.py).
    from database import _session_factory

    async with _session_factory() as session:
        if tenant_id or all_tenants:
            # Branches-only mode — backfill the standard network onto
            # tenant(s) that already exist, without touching the demo catalog.
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
                branches_created = await seed_branches(session, tenant.id)
                skipped = len(BRANCH_NETWORK_TEMPLATE) - len(branches_created)
                print(
                    f"[{tenant.name}] {tenant.id}: created {len(branches_created)} branch(es)"
                    f" ({skipped} already present)"
                    f" — {sorted(b.branch_code for b in branches_created)}"
                )
            return

        # Default mode — create the demo tenant catalog + branch networks.
        created_tenants = await seed_tenant_catalog(session)
        skipped = len(TENANT_SEED_DATA) - len(created_tenants)
        print(f"Created {len(created_tenants)} tenant(s) ({skipped} already present).")
        for tenant in created_tenants:
            print(
                f"  [{tenant.name}] {tenant.id} ({tenant.code})"
                f" — {len(BRANCH_NETWORK_TEMPLATE)} branches seeded"
            )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed Pakistani insurer tenants + their branch network, "
        "or backfill just the branch network onto existing tenant(s)."
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--tenant-id", type=UUID,
        help="Backfill the standard branch network onto this existing tenant only.",
    )
    group.add_argument(
        "--all-tenants", action="store_true",
        help="Backfill the standard branch network onto every existing tenant.",
    )
    args = parser.parse_args()

    asyncio.run(_run(args.tenant_id, args.all_tenants))


if __name__ == "__main__":
    main()
