"""Seed a realistic per-tenant roster of acquisition sources — the agents,
brokers, partner banks, corporate tie-ups, direct desk and digital funnel that
"bring" customers to the insurer.

The roster below is a fixed set of original, realistic Pakistani distribution
producers, applied identically to every tenant (same convention as
seeds/tenants_seed.py's branch network and insurance_plans_seed.py's catalog).
`code` is unique per tenant (see shared/models/core.py
AcquisitionSource.__table_args__), so the same producer codes are reused across
tenants without colliding.

Idempotent — any (tenant_id, code) already present is skipped, never
duplicated. Safe to run repeatedly.

Run inside the tenant-service container:

    # Seed one tenant
    docker compose exec tenant-service python -m seeds.acquisition_sources_seed \
        --tenant-id 05788cf6-5bf0-4895-b73d-28bbe334518d

    # Seed every tenant in the database
    docker compose exec tenant-service python -m seeds.acquisition_sources_seed --all-tenants
"""

from __future__ import annotations

import argparse
import asyncio
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import AcquisitionSource, Tenant


# ─────────────────────────────────────────────────────────────────────────────
# Seed roster — 12 original producers spanning every channel type.
# Each dict mirrors the AcquisitionSource columns.
# ─────────────────────────────────────────────────────────────────────────────

SOURCE_SEED_DATA: list[dict] = [
    # ── Individual agents ─────────────────────────────────────────────────────
    {"code": "AGT-0417", "source_type": "AGENT", "name": "Zafar Iqbal",
     "partner_name": None, "contact_person": "Zafar Iqbal",
     "contact_phone": "0300-4417802", "contact_email": "zafar.iqbal.agent@gmail.com", "city": "Lahore"},
    {"code": "AGT-0392", "source_type": "AGENT", "name": "Saima Riaz",
     "partner_name": None, "contact_person": "Saima Riaz",
     "contact_phone": "0321-6639214", "contact_email": "saima.riaz.agent@gmail.com", "city": "Karachi"},
    {"code": "AGT-0588", "source_type": "AGENT", "name": "Naveed Anjum",
     "partner_name": None, "contact_person": "Naveed Anjum",
     "contact_phone": "0333-9902155", "contact_email": "naveed.anjum.agent@gmail.com", "city": "Islamabad"},
    {"code": "AGT-0631", "source_type": "AGENT", "name": "Rabia Aslam",
     "partner_name": None, "contact_person": "Rabia Aslam",
     "contact_phone": "0301-7745620", "contact_email": "rabia.aslam.agent@gmail.com", "city": "Faisalabad"},

    # ── Brokerage firms ───────────────────────────────────────────────────────
    {"code": "BRK-1102", "source_type": "BROKER", "name": "Horizon Insurance Brokers (Pvt) Ltd",
     "partner_name": None, "contact_person": "Imran Sheikh",
     "contact_phone": "021-35630012", "contact_email": "clients@horizonbrokers.pk", "city": "Karachi"},
    {"code": "BRK-1140", "source_type": "BROKER", "name": "SafeGuard Risk Advisors",
     "partner_name": None, "contact_person": "Hina Tariq",
     "contact_phone": "042-35778890", "contact_email": "advisory@safeguardrisk.pk", "city": "Lahore"},

    # ── Bancassurance (partner banks) ─────────────────────────────────────────
    {"code": "BNC-2201", "source_type": "BANCASSURANCE", "name": "HBL Bancassurance Desk",
     "partner_name": "Habib Bank Limited", "contact_person": "Bancassurance Relationship Team",
     "contact_phone": "021-111-111-425", "contact_email": "bancassurance@hbl.com.pk", "city": "Karachi"},
    {"code": "BNC-2208", "source_type": "BANCASSURANCE", "name": "Meezan Bank Takaful Window",
     "partner_name": "Meezan Bank", "contact_person": "Takaful Sales Desk",
     "contact_phone": "021-111-331-331", "contact_email": "takaful@meezanbank.com", "city": "Karachi"},
    {"code": "BNC-2215", "source_type": "BANCASSURANCE", "name": "UBL Insurance Counter",
     "partner_name": "United Bank Limited", "contact_person": "Insurance Services Desk",
     "contact_phone": "051-111-825-888", "contact_email": "insurance@ubl.com.pk", "city": "Islamabad"},

    # ── Corporate agent / employee-benefits tie-up ────────────────────────────
    {"code": "COR-3301", "source_type": "CORPORATE_AGENT", "name": "Systems Ltd Employee Benefits",
     "partner_name": "Systems Limited", "contact_person": "HR Benefits Office",
     "contact_phone": "042-111-797-836", "contact_email": "benefits@systemsltd.com", "city": "Lahore"},

    # ── Insurer's own direct sales team ───────────────────────────────────────
    {"code": "DIR-9001", "source_type": "DIRECT", "name": "Direct Sales — Head Office",
     "partner_name": None, "contact_person": "Direct Sales Desk",
     "contact_phone": "021-111-000-100", "contact_email": "directsales@insurer.pk", "city": "Karachi"},

    # ── Online / digital funnel ───────────────────────────────────────────────
    {"code": "DGT-8001", "source_type": "DIGITAL", "name": "Website / Online Funnel",
     "partner_name": None, "contact_person": "Digital Team",
     "contact_phone": "021-111-000-200", "contact_email": "online@insurer.pk", "city": "Karachi"},
]


# ─────────────────────────────────────────────────────────────────────────────
# Core seed function
# ─────────────────────────────────────────────────────────────────────────────

async def seed_acquisition_sources(session: AsyncSession, tenant_id: UUID) -> list[AcquisitionSource]:
    """Insert the producer roster for a single tenant.

    Idempotent — skips any `code` already registered for this tenant.
    Commits once at the end; returns the rows actually created.
    """
    existing_result = await session.exec(
        select(AcquisitionSource.code).where(AcquisitionSource.tenant_id == tenant_id)
    )
    existing_codes: set[str] = set(existing_result.all())

    created: list[AcquisitionSource] = []
    for spec in SOURCE_SEED_DATA:
        if spec["code"] in existing_codes:
            continue
        source = AcquisitionSource(
            tenant_id=tenant_id,
            source_type=spec["source_type"],
            name=spec["name"],
            code=spec["code"],
            partner_name=spec.get("partner_name"),
            contact_person=spec.get("contact_person"),
            contact_phone=spec.get("contact_phone"),
            contact_email=spec.get("contact_email"),
            city=spec.get("city"),
        )
        session.add(source)
        created.append(source)

    await session.commit()
    for s in created:
        await session.refresh(s)
    return created


async def get_or_seed_sources(session: AsyncSession, tenant_id: UUID) -> list[AcquisitionSource]:
    """Ensure the roster exists for a tenant, then return every source row for
    it. Used by customers_seed to pick a random source per customer."""
    await seed_acquisition_sources(session, tenant_id)
    result = await session.exec(
        select(AcquisitionSource).where(AcquisitionSource.tenant_id == tenant_id)
    )
    return list(result.all())


# ─────────────────────────────────────────────────────────────────────────────
# CLI entry-point  (mirrors insurance_plans_seed.py / customers_seed.py)
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
            created = await seed_acquisition_sources(session, tenant.id)
            skipped = len(SOURCE_SEED_DATA) - len(created)
            print(
                f"[{tenant.name}] {tenant.id}: "
                f"created {len(created)} source(s) ({skipped} already present)"
            )
            for s in created:
                print(f"  ✓ {s.code}  {s.source_type.value:<15} {s.name}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed the per-tenant acquisition-source roster (agents / brokers / banks / etc.)."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--tenant-id",   type=UUID, help="UUID of the tenant to seed.")
    group.add_argument("--all-tenants", action="store_true", help="Seed every tenant in the database.")
    args = parser.parse_args()

    asyncio.run(_run(args.tenant_id, args.all_tenants))


if __name__ == "__main__":
    main()
