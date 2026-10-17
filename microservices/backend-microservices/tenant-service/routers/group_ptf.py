"""PTF surplus / deficit report for a Takaful scheme (GROUP_LIFE_PLAN.md Phase 6)."""

from typing import Any, Dict
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.group_policies import _business_type, _plan_for
from routers.organizations import _get_master_policy
from routers.users import verify_admin
from services.group_ptf import ptf_report

router = APIRouter(prefix="/tenants", tags=["Group Takaful"])


@router.get("/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/ptf-report", dependencies=[Depends(verify_admin)])
async def get_ptf_report(tenant_id: UUID, org_id: UUID, mp_id: UUID, session: AsyncSession = Depends(get_session)) -> Dict[str, Any]:
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    if _business_type(await _plan_for(mp, session)) != "Takaful":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a Takaful scheme has a Participants' Takaful Fund.")
    return await ptf_report(session, tenant_id, mp)
