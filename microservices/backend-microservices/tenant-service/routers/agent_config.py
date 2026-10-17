"""Persisted SuperAdmin control for progressive chat skills."""
import os
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, StrictBool
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import require_roles
from shared.models.core import PlatformAgentConfig

router = APIRouter(tags=["Platform — AI Agents"])
superadmin = require_roles("SuperAdmin")
INTERNAL_API_SECRET = os.getenv("INTERNAL_API_SECRET", "").strip()


class AgentConfigUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_agent_enabled: StrictBool


class AgentConfigRead(BaseModel):
    skill_agent_enabled: bool
    updated_at: datetime | None = None
    updated_by: UUID | None = None
    propagation_seconds: int = 5


def view(row: PlatformAgentConfig | None) -> AgentConfigRead:
    return AgentConfigRead(skill_agent_enabled=row.skill_agent_enabled if row else True,
                           updated_at=row.updated_at if row else None,
                           updated_by=row.updated_by if row else None)


@router.get("/platform/agent-config", response_model=AgentConfigRead)
async def get_agent_config(user=Depends(superadmin), session: AsyncSession = Depends(get_session)):
    return view(await session.get(PlatformAgentConfig, "default"))


@router.put("/platform/agent-config", response_model=AgentConfigRead)
async def update_agent_config(body: AgentConfigUpdate, user=Depends(superadmin),
                              session: AsyncSession = Depends(get_session)):
    # Atomic upsert also handles two SuperAdmins saving the initial setting at once.
    from sqlalchemy.dialects.postgresql import insert
    values = {"id": "default", "skill_agent_enabled": body.skill_agent_enabled,
              "updated_by": user.id, "updated_at": datetime.utcnow()}
    statement = insert(PlatformAgentConfig).values(**values)
    await session.exec(statement.on_conflict_do_update(index_elements=["id"], set_=values))
    await session.commit()
    row = await session.get(PlatformAgentConfig, "default", populate_existing=True)
    return view(row)


@router.get("/internal/agent-config", response_model=AgentConfigRead, include_in_schema=False)
async def internal_agent_config(x_internal_secret: str = Header(default=""), session: AsyncSession = Depends(get_session)):
    if INTERNAL_API_SECRET and x_internal_secret != INTERNAL_API_SECRET:
        raise HTTPException(401, "bad internal secret")
    return view(await session.get(PlatformAgentConfig, "default"))
