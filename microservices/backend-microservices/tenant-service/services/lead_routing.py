"""Walk-in lead routing: who picks up a lead that came in through the customer portal, and making sure someone does.

The lead itself is an ordinary Customer (profile_status LEAD). This module only decides the OWNER (Customer.assigned_agent_id),
records why, tells that person, and escalates when nobody acts.

Eligibility is strict and comes from verified internal records only (never from the AI, never from the customer):
  * same tenant, role "Agent", active, status ACTIVE, not deleted, and has signed in at least once (an invited agent who has
    never logged in cannot see or act on a lead — same rule the agent pickers use);
  * the agent's branch, if any, is active.
Ranking: location (agent's branch city = the customer's city) → relevant experience (policies already written by this agent's
customers on the same insurance type — there is NO specialization field, so this is derived from real records) → current open
workload → a stable id order. The AI only ever chooses among the top few eligible candidates, by opaque alias; its answer is
validated, and on any failure (no key, timeout, bad JSON, unknown alias) the assignment is the deterministic LEAST-WORKLOAD agent
(ties: location, experience, id).

"Assigned" is only ever written after the agent is saved on the customer, in the same transaction as the routing record.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import String, cast, func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import (
    AcquisitionSource,
    AcquisitionSourceType,
    Branch,
    Case,
    Customer,
    FamilyGroup,
    Policy,
    ProfileStatusEnum,
    Role,
    User,
    UserProfile,
    UserStatus,
    WalkInLead,
    WalkInLeadEvent,
)

log = logging.getLogger("tenant-service.lead_routing")

ACK_MINUTES = int(os.environ.get("WALKIN_ACK_MINUTES", "60"))              # how long an agent has to acknowledge
NOTIFY_MAX_ATTEMPTS = int(os.environ.get("WALKIN_NOTIFY_MAX_ATTEMPTS", "5"))
AI_TIMEOUT_SECONDS = float(os.environ.get("WALKIN_AI_TIMEOUT_SECONDS", "8"))
AI_SHORTLIST = 5
SOURCE_NAME = "Digital Walk-In"
POOL_CODE = "DWI-POOL"
OPEN_STATUSES = (ProfileStatusEnum.LEAD, ProfileStatusEnum.PROSPECT, ProfileStatusEnum.DRAFT, ProfileStatusEnum.UNDERWRITING_READY)


def _now() -> datetime:
    return datetime.utcnow()


def _ai_enabled() -> bool:
    return os.environ.get("WALKIN_ROUTING_AI", "true").lower() == "true" and bool(os.environ.get("GEMINI_API_KEY"))


@dataclass
class Candidate:
    user_id: UUID
    name: str
    email: str
    phone: Optional[str]
    branch_id: Optional[UUID]
    branch_name: Optional[str]
    branch_city: Optional[str]
    workload: int
    experience: int
    location: int                      # 1 when the agent's branch is in the customer's city

    def rank_key(self):                # best first: nearby, experienced, lightly loaded
        return (-self.location, -self.experience, self.workload, str(self.user_id))

    def fallback_key(self):            # deterministic least-workload, stable tie-breaks
        return (self.workload, -self.location, -self.experience, str(self.user_id))


async def subject_of(session: AsyncSession, lead: WalkInLead):
    """What the lead is about: the Customer for an individual request, the FamilyGroup for a family one. Both carry the fields
    routing needs (name, city, branch, assigned agent, acquisition source, profile status)."""
    if lead.family_group_id:
        return await session.get(FamilyGroup, lead.family_group_id)
    return await session.get(Customer, lead.customer_id) if lead.customer_id else None


# ── events ────────────────────────────────────────────────────────────────────

def add_event(session: AsyncSession, lead: WalkInLead, event_type: str, actor: str = "system", **detail: Any) -> None:
    session.add(WalkInLeadEvent(tenant_id=lead.tenant_id, walk_in_lead_id=lead.id, event_type=event_type, actor=actor, detail_json=detail or None))


# ── eligibility ───────────────────────────────────────────────────────────────

async def _agent_role_id(session: AsyncSession) -> Optional[UUID]:
    return (await session.exec(select(Role.id).where(Role.name == "Agent"))).first()


async def agent_is_eligible(session: AsyncSession, tenant_id: UUID, user_id: Optional[UUID]) -> bool:
    if user_id is None:
        return False
    return any(c.user_id == user_id for c in await eligible_agents(session, tenant_id, None, None))


async def eligible_agents(session: AsyncSession, tenant_id: UUID, city: Optional[str], insurance_type: Optional[str]) -> list[Candidate]:
    from routers.users import _not_pending_invite          # an invited agent who never signed in cannot act on a lead
    role_id = await _agent_role_id(session)
    if role_id is None:
        return []
    users = (await session.exec(select(User).where(
        User.tenant_id == tenant_id, User.role_id == role_id, User.is_active.is_(True), User.status == UserStatus.ACTIVE,
        _not_pending_invite()))).all()
    if not users:
        return []
    ids = [u.id for u in users]
    branches = {b.id: b for b in (await session.exec(select(Branch).where(Branch.tenant_id == tenant_id))).all()}
    workload: dict[UUID, int] = {}
    # customers.profile_status is a Postgres enum but family_groups.profile_status is VARCHAR(50), while the model declares both as the
    # enum. Comparing the text of the column works for either; the enum comparison fails on family_groups ("operator does not exist:
    # character varying = profilestatusenum") and made every walk-in application fail.
    open_statuses = [s.value for s in OPEN_STATUSES]
    for model in (Customer, FamilyGroup):                 # a family lead is as much work as an individual one
        for agent_id, n in (await session.exec(select(model.assigned_agent_id, func.count()).where(
                model.tenant_id == tenant_id, model.assigned_agent_id.in_(ids), cast(model.profile_status, String).in_(open_statuses))
                .group_by(model.assigned_agent_id))).all():
            workload[agent_id] = workload.get(agent_id, 0) + int(n)
    experience: dict[UUID, int] = {}
    if insurance_type:
        experience = dict((await session.exec(select(Customer.assigned_agent_id, func.count()).select_from(Policy)
                                              .join(Customer, Customer.id == Policy.customer_id)
                                              .where(Customer.tenant_id == tenant_id, Customer.assigned_agent_id.in_(ids),
                                                     Policy.insurance_type == insurance_type)
                                              .group_by(Customer.assigned_agent_id))).all())
    profiles = {p.user_id: p for p in (await session.exec(select(UserProfile).where(UserProfile.user_id.in_(ids)))).all()}
    want_city = (city or "").strip().lower()
    out: list[Candidate] = []
    for u in users:
        b = branches.get(u.branch_id) if u.branch_id else None
        if u.branch_id and (b is None or not b.is_active):
            continue                                        # their branch is closed or unknown: not available
        prof = profiles.get(u.id)
        out.append(Candidate(
            user_id=u.id, name=u.full_name, email=u.email, phone=prof.phone if prof else None, branch_id=u.branch_id,
            branch_name=b.name if b else None, branch_city=b.city if b else None, workload=int(workload.get(u.id, 0)),
            experience=int(experience.get(u.id, 0)), location=1 if (b and want_city and (b.city or "").strip().lower() == want_city) else 0))
    return out


# ── sources: the walk-in source credited to the lead is visible to exactly the agent who owns it ──

async def _source(session: AsyncSession, tenant_id: UUID, code: str, user_id: Optional[UUID]) -> AcquisitionSource:
    row = (await session.exec(select(AcquisitionSource).where(AcquisitionSource.tenant_id == tenant_id, AcquisitionSource.code == code))).first()
    if row is None:
        row = AcquisitionSource(tenant_id=tenant_id, source_type=AcquisitionSourceType.DIGITAL, name=SOURCE_NAME, code=code, user_id=user_id, is_active=True)
        session.add(row)
        await session.flush()
    return row


async def pool_source(session: AsyncSession, tenant_id: UUID) -> AcquisitionSource:
    """Shared "Digital Walk-In" source for leads nobody owns yet (staff with tenant-wide access see it)."""
    return await _source(session, tenant_id, POOL_CODE, None)


async def agent_source(session: AsyncSession, tenant_id: UUID, user_id: UUID) -> AcquisitionSource:
    """The agent's own "Digital Walk-In" source. A source-scoped agent login sees only customers of sources linked to it, so crediting
    the lead here is what makes it appear in THEIR leads list (and nobody else's)."""
    return await _source(session, tenant_id, f"DWI-{str(user_id)[:8].upper()}", user_id)


def _is_walk_in_source(src: Optional[AcquisitionSource]) -> bool:
    return src is not None and src.name == SOURCE_NAME and src.code.startswith("DWI-")


# ── AI recommendation (optional; always validated) ───────────────────────────

async def _ask_ai(shortlist: dict[str, Candidate], city: Optional[str], plan_label: str, plan_category: str) -> Optional[dict]:
    """Ask the configured LLM to pick one of the shortlisted agents by ALIAS. Returns {"choice", "reason"} or None. Patchable in tests."""
    from google import genai
    from google.genai import types

    prompt = {
        "task": "Pick the single best insurance agent for a new walk-in lead. Choose ONLY from the candidates.",
        "lead": {"city": city, "interest": plan_label, "category": plan_category},
        "candidates": [{"id": alias, "branch_city": c.branch_city, "same_city": bool(c.location), "open_leads": c.workload,
                        "policies_of_this_type": c.experience} for alias, c in shortlist.items()],
        "rules": "Prefer same city, then relevant experience, then fewer open leads. Reply with JSON only: {\"choice\": \"<id>\", \"reason\": \"<one short sentence>\"}",
    }

    def call() -> str:
        client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        resp = client.models.generate_content(
            model=os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"), contents=json.dumps(prompt),
            config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0))
        return resp.text or ""

    raw = await asyncio.wait_for(asyncio.to_thread(call), timeout=AI_TIMEOUT_SECONDS)
    data = json.loads(raw)
    return data if isinstance(data, dict) else None


async def choose_agent(candidates: list[Candidate], city: Optional[str], plan_label: str, plan_category: str) -> tuple[Optional[Candidate], str, str]:
    """(candidate, method, reason). Never returns an agent outside `candidates`."""
    if not candidates:
        return None, "none", "No eligible agent is available."
    ranked = sorted(candidates, key=Candidate.rank_key)
    fallback = min(candidates, key=Candidate.fallback_key)
    if len(candidates) == 1:
        return candidates[0], "deterministic", "Only one eligible agent."
    if _ai_enabled():
        shortlist = {f"A{i + 1}": c for i, c in enumerate(ranked[:AI_SHORTLIST])}
        try:
            answer = await _ask_ai(shortlist, city, plan_label, plan_category)
            choice = str((answer or {}).get("choice", "")).strip()
            if choice in shortlist:                          # validated against the eligible list
                reason = str((answer or {}).get("reason", "")).strip()[:300] or "Recommended by the routing assistant."
                for alias, cand in shortlist.items():                # the model only ever saw opaque aliases: show the agent's name
                    reason = re.sub(rf"\b{alias}\b", cand.name, reason)
                return shortlist[choice], "ai", reason
            log.warning("walk-in routing: AI returned an unusable choice %r; using least-workload", choice)
        except Exception as exc:                             # unavailable, timed out, bad JSON …
            log.warning("walk-in routing: AI unavailable (%s); using least-workload", type(exc).__name__)
    return fallback, "deterministic", (f"Least open workload ({fallback.workload} open lead(s))"
                                       + (", same city" if fallback.location else "") + ".")


# ── assignment ────────────────────────────────────────────────────────────────

async def assign(session: AsyncSession, lead: WalkInLead, customer: Customer, cand: Candidate, method: str, reason: str, actor: str = "system") -> None:
    """Save the agent on the customer and the routing record together. Caller commits."""
    await session.refresh(customer, with_for_update=True)             # serialise concurrent routings of the same customer
    previous = customer.assigned_agent_id
    customer.assigned_agent_id = cand.user_id
    if cand.branch_id and customer.branch_id is None:
        customer.branch_id = cand.branch_id
    src = await session.get(AcquisitionSource, customer.acquisition_source_id) if customer.acquisition_source_id else None
    if src is None or _is_walk_in_source(src):                        # never overwrite a real producer's credit
        customer.acquisition_source_id = (await agent_source(session, lead.tenant_id, cand.user_id)).id
    session.add(customer)
    now = _now()
    lead.routing_status, lead.routing_method, lead.routing_reason = "Assigned", method, reason
    lead.assigned_agent_id, lead.assigned_at = cand.user_id, now
    lead.ack_due_at = now + timedelta(minutes=ACK_MINUTES)
    lead.acknowledged_at = lead.acknowledged_by = lead.escalated_at = lead.escalation_reason = None
    lead.notify_status, lead.notify_attempts, lead.notified_at, lead.next_notify_at = "Pending", 0, None, now
    lead.updated_at = now
    session.add(lead)
    add_event(session, lead, "Assigned", actor, agent=cand.name, method=method, reason=reason, previous_agent=str(previous) if previous else None)


async def route_lead(session: AsyncSession, lead: WalkInLead, customer: Customer, actor: str = "system") -> WalkInLead:
    """Pick and save an owner, or park the lead explicitly as Unassigned. Never drops it."""
    plan_type = None
    if lead.plan_id:
        from shared.models.core import InsurancePlan
        plan = await session.get(InsurancePlan, lead.plan_id)
        plan_type = plan.insurance_type.value if plan and hasattr(plan.insurance_type, "value") else (str(plan.insurance_type) if plan else None)
    candidates = await eligible_agents(session, lead.tenant_id, customer.city, plan_type)

    existing = next((c for c in candidates if c.user_id == customer.assigned_agent_id), None)
    if existing is not None:
        await assign(session, lead, customer, existing, "existing", "The customer already has an assigned agent.", actor)
        return lead
    chosen, method, reason = await choose_agent(candidates, customer.city, lead.plan_label or "", lead.plan_category or "")
    if chosen is None:
        lead.routing_status, lead.routing_method, lead.routing_reason = "Unassigned", "none", reason
        lead.updated_at = _now()
        if customer.acquisition_source_id is None:
            customer.acquisition_source_id = (await pool_source(session, lead.tenant_id)).id
            session.add(customer)
        session.add(lead)
        add_event(session, lead, "Unassigned", actor, reason=reason)
        return lead
    await assign(session, lead, customer, chosen, method, reason, actor)
    return lead


# ── notifications (retry-safe) ────────────────────────────────────────────────

async def _send(to: str, subject: str, body: str) -> bool:
    import email_utils
    try:
        return bool(await asyncio.wait_for(email_utils.send_email(to, subject, body), timeout=12))
    except Exception:
        return False


async def notify_assigned_agent(session: AsyncSession, lead: WalkInLead, customer: Customer) -> bool:
    """Email the assigned agent. Marks Sent only when the mail really went out; otherwise Failed with a back-off for the sweep.
    (The lead is also in the agent's leads list the moment it is assigned — that is the in-app notification.)"""
    agent = await session.get(User, lead.assigned_agent_id) if lead.assigned_agent_id else None
    if agent is None:
        return False
    now = _now()
    sent = await _send(agent.email, f"New walk-in lead {lead.reference}",
                       f"A new walk-in lead has been assigned to you.\n\nReference: {lead.reference}\nName: {customer.name}\nCity: {customer.city or '—'}\n"
                       f"Interested in: {lead.plan_label or '—'}\nPreferred contact: {lead.preferred_contact or 'any'}\n\n"
                       f"Please open it in Leads and acknowledge it within {ACK_MINUTES} minutes; otherwise it is escalated to the branch manager.")
    lead.notify_attempts += 1
    if sent:
        lead.notify_status, lead.notified_at, lead.next_notify_at = "Sent", now, None
    else:
        lead.notify_status = "Failed"
        lead.next_notify_at = None if lead.notify_attempts >= NOTIFY_MAX_ATTEMPTS else now + timedelta(seconds=min(60 * 2 ** lead.notify_attempts, 3600))
    lead.updated_at = now
    session.add(lead)
    add_event(session, lead, "AgentNotified" if sent else "AgentNotificationFailed", attempt=lead.notify_attempts)
    return sent


async def staff_recipients(session: AsyncSession, tenant_id: UUID, branch_id: Optional[UUID]) -> list[User]:
    """Who must act when a lead cannot be handled by its agent: the branch manager, else the tenant's admins."""
    people: list[User] = []
    if branch_id:
        branch = await session.get(Branch, branch_id)
        if branch and branch.manager_user_id:
            mgr = await session.get(User, branch.manager_user_id)
            if mgr and mgr.is_active and not mgr.is_deleted:
                people.append(mgr)
    if not people:
        admin_role = (await session.exec(select(Role.id).where(Role.name == "Admin"))).first()
        if admin_role:
            people = list((await session.exec(select(User).where(User.tenant_id == tenant_id, User.role_id == admin_role,
                                                                 User.is_active.is_(True), User.is_deleted.is_(False)))).all())
    return people


async def alert_staff(session: AsyncSession, lead: WalkInLead, customer: Customer, headline: str) -> int:
    sent = 0
    for person in await staff_recipients(session, lead.tenant_id, customer.branch_id):
        if await _send(person.email, f"{headline}: walk-in lead {lead.reference}",
                       f"{headline}.\n\nReference: {lead.reference}\nCustomer: {customer.name} ({customer.city or '—'})\nInterested in: {lead.plan_label or '—'}\n"
                       f"Why: {lead.escalation_reason or lead.routing_reason or '—'}\n\nOpen Leads → Walk-in queue to reassign it."):
            sent += 1
    add_event(session, lead, "StaffAlerted", headline=headline, emailed=sent)
    return sent


# ── acknowledgement, escalation, sweep ────────────────────────────────────────

def acknowledge(session: AsyncSession, lead: WalkInLead, by: str, how: str) -> None:
    now = _now()
    lead.acknowledged_at, lead.acknowledged_by = now, by
    if lead.routing_status == "Escalated" and lead.assigned_agent_id:
        lead.routing_status, lead.escalated_at, lead.escalation_reason = "Assigned", None, None
    lead.updated_at = now
    session.add(lead)
    add_event(session, lead, "Acknowledged", by, how=how)


async def escalate(session: AsyncSession, lead: WalkInLead, customer: Customer, reason: str) -> None:
    if lead.routing_status == "Escalated":
        return
    lead.routing_status, lead.escalated_at, lead.escalation_reason, lead.updated_at = "Escalated", _now(), reason, _now()
    session.add(lead)
    add_event(session, lead, "Escalated", reason=reason)
    await alert_staff(session, lead, customer, "Walk-in lead needs reassignment")


async def _has_progressed(session: AsyncSession, lead: WalkInLead, customer) -> bool:
    """The agent has started handling it without pressing Acknowledge: the lead moved past LEAD, or a proposal / case exists."""
    if customer.profile_status != ProfileStatusEnum.LEAD:
        return not lead.linked_existing
    if lead.linked_existing or lead.family_group_id:
        return False
    pol = (await session.exec(select(Policy.id).where(Policy.customer_id == customer.id, Policy.created_at >= lead.created_at - timedelta(minutes=1)))).first()
    case = (await session.exec(select(Case.caseld).where(Case.customer_id == customer.id, Case.createdAt >= lead.created_at - timedelta(minutes=1)))).first()
    return pol is not None or case is not None


async def sweep(session_factory, now: Optional[datetime] = None) -> dict:
    """One pass of the safety net. Idempotent; safe to run from several processes (each lead is handled in its own transaction)."""
    now = now or _now()
    counts = {"routed": 0, "escalated": 0, "acknowledged": 0, "resynced": 0, "notified": 0, "checked": 0}
    async with session_factory() as s:
        ids = [x for x in (await s.exec(select(WalkInLead.id).where(WalkInLead.routing_status.in_(("Pending", "Unassigned", "Assigned", "Escalated")))
                                        .order_by(WalkInLead.created_at))).all()]
    for lead_id in ids:
        async with session_factory() as s:
            lead = await s.get(WalkInLead, lead_id, with_for_update=True)
            if lead is None:
                continue
            customer = await subject_of(s, lead)
            if customer is None:
                continue
            counts["checked"] += 1
            try:
                if lead.routing_status in ("Pending", "Unassigned"):
                    await route_lead(s, lead, customer, "sweep")
                    if lead.routing_status == "Assigned":
                        counts["routed"] += 1
                        await notify_assigned_agent(s, lead, customer)
                    elif (now - lead.created_at) > timedelta(minutes=ACK_MINUTES) and lead.routing_status == "Unassigned":
                        await escalate(s, lead, customer, "No eligible agent could be found.")
                        counts["escalated"] += 1
                    await s.commit()
                    continue

                # someone changed the owner through the normal lead form: follow it
                if customer.assigned_agent_id != lead.assigned_agent_id:
                    if customer.assigned_agent_id is None:
                        lead.routing_status, lead.assigned_agent_id = "Unassigned", None
                        add_event(s, lead, "Unassigned", "staff", reason="Agent removed from the lead.")
                    else:
                        agent = (await s.exec(select(User).where(User.id == customer.assigned_agent_id))).first()
                        lead.routing_status, lead.routing_method, lead.routing_reason = "Assigned", "manual", "Reassigned by staff."
                        lead.assigned_agent_id, lead.assigned_at = customer.assigned_agent_id, now
                        lead.ack_due_at = now + timedelta(minutes=ACK_MINUTES)
                        lead.acknowledged_at = lead.acknowledged_by = lead.escalated_at = lead.escalation_reason = None
                        lead.notify_status, lead.notify_attempts, lead.next_notify_at = "Pending", 0, now
                        add_event(s, lead, "Assigned", "staff", agent=agent.full_name if agent else None, method="manual")
                    lead.updated_at = now
                    s.add(lead)
                    counts["resynced"] += 1

                if lead.routing_status == "Assigned" and lead.acknowledged_at is None and await _has_progressed(s, lead, customer):
                    acknowledge(s, lead, "agent activity", "lead progressed")
                    counts["acknowledged"] += 1

                if lead.routing_status == "Assigned" and lead.acknowledged_at is None:
                    if not await agent_is_eligible(s, lead.tenant_id, lead.assigned_agent_id):
                        await escalate(s, lead, customer, "The assigned agent is no longer available.")
                        counts["escalated"] += 1
                    elif lead.ack_due_at and lead.ack_due_at <= now:
                        await escalate(s, lead, customer, f"Not acknowledged within {ACK_MINUTES} minutes.")
                        counts["escalated"] += 1

                if (lead.routing_status == "Assigned" and lead.notify_status in ("Pending", "Failed") and lead.next_notify_at
                        and lead.next_notify_at <= now and lead.notify_attempts < NOTIFY_MAX_ATTEMPTS):
                    if await notify_assigned_agent(s, lead, customer):
                        counts["notified"] += 1
                await s.commit()
            except Exception:
                await s.rollback()
                log.exception("walk-in sweep failed for lead %s", lead_id)
    return counts


def start_sweeper(stop_event, session_factory):
    """Background safety net: runs the sweep every WALKIN_SWEEP_SECONDS (default 60). Off with WALKIN_SWEEP=false."""
    interval = float(os.environ.get("WALKIN_SWEEP_SECONDS", "60"))

    async def loop():
        while not stop_event.is_set():
            try:
                await sweep(session_factory)
            except Exception:
                log.exception("walk-in sweep cycle failed")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass
    return asyncio.create_task(loop())
