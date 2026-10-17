"""
Demo / funnel-reset router.

Backs the frontend "Reset demo data" button. Because taking a lead all the way
through the pipeline moves it off the Leads page (it becomes a policyholder),
this endpoint restores the canonical starting state in one click:

  • wipe every customer + all funnel data for the tenant, then
  • re-seed the 5 leads (3 individual + 1 family + 1 corporate) + 3 draft
    proposals (seeds/funnel_seed.py).

Everything else (underwriting / applications / issuance / policyholders) returns
to 0 records. The seed data lives in the seeds files, so the same reset works on
any machine that runs this service.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from seeds.funnel_seed import seed_leads
from seeds.stage_a_seed import purge_tenant

log = logging.getLogger(__name__)
router = APIRouter(tags=["Demo"])


@router.post("/tenants/{tenant_id}/demo/reset-funnel")
async def reset_funnel(tenant_id: UUID, session: AsyncSession = Depends(get_session)):
    """Purge the tenant and re-seed the canonical 5 leads (3 individual + 1 family + 1 corporate)."""
    purged = await purge_tenant(session, tenant_id)
    created = await seed_leads(session, tenant_id)
    log.info("Demo funnel reset for tenant %s — purged %d, seeded %d", tenant_id, purged, len(created))
    return {
        "purged_customers": purged,
        "seeded_leads": len(created),
        "leads": [c.name for c in created],
    }
