"""Staff view of walk-in leads: the pending / escalated queue, acknowledgement, manual reassignment.

Strict authentication here (a valid staff token of this tenant is required). Agents only see and act on leads assigned to them;
Admin / SuperAdmin / Underwriter see the whole tenant queue and may reassign.
"""

from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, _role_name, oauth2_scheme
from services import lead_routing as routing
from shared.models.core import User, WalkInLead, WalkInLeadEvent

router = APIRouter(prefix="/tenants/{tenant_id}/walk-in-leads", tags=["Walk-in leads"])
MANAGERS = ("Admin", "SuperAdmin", "Underwriter")


async def staff(tenant_id: UUID, token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)) -> tuple[User, str]:
    user = await _get_current_user(token, session)
    role = await _role_name(user, session)
    if role != "SuperAdmin" and user.tenant_id != tenant_id:
        raise HTTPException(403, "Not allowed for this tenant")
    if role not in (*MANAGERS, "Agent"):
        raise HTTPException(403, "Not allowed")
    return user, role


def _row(lead: WalkInLead, customer, agent: Optional[User], now: datetime) -> dict:
    awaiting = lead.routing_status == "Assigned" and lead.acknowledged_at is None
    return {
        "id": str(lead.id), "reference": lead.reference, "customer_id": str(lead.customer_id) if lead.customer_id else None,
        "applicant_type": lead.applicant_type, "family_group_id": str(lead.family_group_id) if lead.family_group_id else None, "customer_name": customer.name if customer else None,
        "city": customer.city if customer else None, "plan_label": lead.plan_label, "plan_category": lead.plan_category,
        "routing_status": lead.routing_status, "routing_method": lead.routing_method, "routing_reason": lead.routing_reason,
        "assigned_agent_id": str(lead.assigned_agent_id) if lead.assigned_agent_id else None, "assigned_agent_name": agent.full_name if agent else None,
        "assigned_at": lead.assigned_at.isoformat() if lead.assigned_at else None,
        "ack_due_at": lead.ack_due_at.isoformat() if lead.ack_due_at else None, "acknowledged_at": lead.acknowledged_at.isoformat() if lead.acknowledged_at else None,
        "awaiting_acknowledgement": awaiting, "overdue": bool(awaiting and lead.ack_due_at and lead.ack_due_at <= now),
        "escalated": lead.routing_status == "Escalated", "escalation_reason": lead.escalation_reason,
        "notify_status": lead.notify_status, "created_at": lead.created_at.isoformat(), "linked_existing": lead.linked_existing,
    }


@router.get("")
async def list_walk_in_leads(tenant_id: UUID, queue: str = Query("all", pattern="^(all|pending|escalated|unassigned|mine)$"),
                             who: tuple[User, str] = Depends(staff), session: AsyncSession = Depends(get_session)) -> list[dict]:
    user, role = who
    q = select(WalkInLead).where(WalkInLead.tenant_id == tenant_id)
    if role == "Agent" or queue == "mine":
        q = q.where(WalkInLead.assigned_agent_id == user.id)
    if queue == "pending":
        q = q.where(WalkInLead.routing_status.in_(("Pending", "Unassigned", "Escalated")) | ((WalkInLead.routing_status == "Assigned") & WalkInLead.acknowledged_at.is_(None)))
    elif queue == "escalated":
        q = q.where(WalkInLead.routing_status == "Escalated")
    elif queue == "unassigned":
        q = q.where(WalkInLead.routing_status.in_(("Pending", "Unassigned")))
    rows = (await session.exec(q.order_by(WalkInLead.created_at.desc()).limit(500))).all()
    now = datetime.utcnow()
    out = []
    for lead in rows:
        out.append(_row(lead, await routing.subject_of(session, lead), await session.get(User, lead.assigned_agent_id) if lead.assigned_agent_id else None, now))
    return out


async def _own(tenant_id: UUID, lead_id: UUID, session: AsyncSession) -> WalkInLead:
    lead = await session.get(WalkInLead, lead_id, with_for_update=True)
    if lead is None or lead.tenant_id != tenant_id:
        raise HTTPException(404, "Walk-in lead not found")
    return lead


@router.post("/{lead_id}/acknowledge")
async def acknowledge_lead(tenant_id: UUID, lead_id: UUID, who: tuple[User, str] = Depends(staff), session: AsyncSession = Depends(get_session)) -> dict:
    user, role = who
    lead = await _own(tenant_id, lead_id, session)
    if role == "Agent" and lead.assigned_agent_id != user.id:
        raise HTTPException(404, "Walk-in lead not found")
    if lead.acknowledged_at is None:
        routing.acknowledge(session, lead, user.full_name, "manual")
        await session.commit()
    return _row(lead, await routing.subject_of(session, lead), await session.get(User, lead.assigned_agent_id) if lead.assigned_agent_id else None, datetime.utcnow())


class ReassignBody(BaseModel):
    agent_id: UUID


@router.post("/{lead_id}/reassign")
async def reassign_lead(tenant_id: UUID, lead_id: UUID, body: ReassignBody, who: tuple[User, str] = Depends(staff), session: AsyncSession = Depends(get_session)) -> dict:
    user, role = who
    if role not in MANAGERS:
        raise HTTPException(403, "Only a manager can reassign a lead")
    lead = await _own(tenant_id, lead_id, session)
    customer = await routing.subject_of(session, lead)
    cand = next((c for c in await routing.eligible_agents(session, tenant_id, customer.city, None) if c.user_id == body.agent_id), None)
    if cand is None:
        raise HTTPException(422, "That person is not an available agent")
    await routing.assign(session, lead, customer, cand, "manual", f"Reassigned by {user.full_name}.", user.full_name)
    await session.commit()
    await routing.notify_assigned_agent(session, lead, customer)
    await session.commit()
    return _row(lead, customer, await session.get(User, lead.assigned_agent_id), datetime.utcnow())


@router.post("/sweep")
async def run_sweep(tenant_id: UUID, who: tuple[User, str] = Depends(staff), session: AsyncSession = Depends(get_session)) -> dict:
    if who[1] not in MANAGERS:
        raise HTTPException(403, "Not allowed")
    from database import _session_factory
    return await routing.sweep(_session_factory)


@router.get("/{lead_id}/events")
async def lead_events(tenant_id: UUID, lead_id: UUID, who: tuple[User, str] = Depends(staff), session: AsyncSession = Depends(get_session)) -> list[dict]:
    user, role = who
    lead = await _own(tenant_id, lead_id, session)
    if role == "Agent" and lead.assigned_agent_id != user.id:
        raise HTTPException(404, "Walk-in lead not found")
    ev = (await session.exec(select(WalkInLeadEvent).where(WalkInLeadEvent.walk_in_lead_id == lead.id).order_by(WalkInLeadEvent.created_at))).all()
    return [{"type": e.event_type, "actor": e.actor, "detail": e.detail_json, "at": e.created_at.isoformat()} for e in ev]


@router.get("/{lead_id}")
async def walk_in_lead_detail(tenant_id: UUID, lead_id: UUID, who: tuple[User, str] = Depends(staff), session: AsyncSession = Depends(get_session)) -> dict:
    """What the visitor submitted for a family request: the head's details and the household. (An individual request's details
    are on the customer record itself.)"""
    user, role = who
    lead = await _own(tenant_id, lead_id, session)
    if role == "Agent" and lead.assigned_agent_id != user.id:
        raise HTTPException(404, "Walk-in lead not found")
    row = _row(lead, await routing.subject_of(session, lead), await session.get(User, lead.assigned_agent_id) if lead.assigned_agent_id else None, datetime.utcnow())
    return {**row, "contact_email": lead.contact_email, "contact_phone": lead.contact_phone, "preferred_contact": lead.preferred_contact, "message": lead.message,
            "household": lead.household_json}
