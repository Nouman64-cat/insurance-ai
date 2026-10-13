"""
Stage B — Renewals router (step 7 of the post-issuance journey).

Two different processes, never mixed (see services/renewal_engine.py):

  Premium Renewal   — collect the next scheduled premium of a policy that continues
                      (Individual, Family). Risk evaluation and acceptance are skipped
                      unless the product requires them.
  Contract Renewal  — renew cover for another contractual term (eligible annually
                      renewable products). Needs risk evaluation + acceptance, binds a
                      new policy version N.0. Group Life renews at master-policy level
                      (group_renewals.py) and is only pointed to from here.

Workflow (the 8 steps, shown to the user as five/seven processing rows):
  1 identify upcoming   GET  /renewals                      (plan + live eligibility)
  2 verify eligibility  POST /renewals                      (opens the cycle)
  3 renewal notice      POST /renewals/{id}/notice
  4 evaluate risk       POST /renewals/{id}/risk/evaluate, /risk/decision (Underwriter)
  5 capture acceptance  POST /renewals/{id}/acceptance
  6 collect + reconcile POST /renewals/{id}/payment, /reconcile
  7 complete renewal    POST /renewals/{id}/complete
  8 documents           GET/POST /renewals/{id}/confirmation/...

The premium itself always lives in the PremiumSchedule ledger and is collected by the
same code as Step 3 (post_issuance.collect_installment), so a payment taken in either
place is seen by both. Every status change goes through policy_state_machine and every
action writes a PolicyEvent carrying the renewal_no.
"""

import logging
import os
from datetime import date, datetime, timedelta
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import email_utils
from database import get_session
from routers.auth import require_roles
from routers.policies import _get_policy, _price_breakdown, _publish_policy_event, _st
from routers.post_issuance import CollectBody, collect_installment
from services import document_generator, insurer_config
from services import renewal_engine as eng
from services.billing_gate import _row_state, surcharge_for
from services.email_templates import renewal_confirmation_email, renewal_notice_email
from services.pricing_engine import GRACE_PERIOD_DAYS
from shared.models.core import (
    BillingFrequencyEnum,
    CommissionAccrual,
    Customer,
    GroupRenewal,
    MasterPolicy,
    Policy,
    PolicyEvent,
    PolicyRenewal,
    PolicyStatusEnum,
    PolicyVersion,
    PremiumReceipt,
    PremiumReminder,
    PremiumSchedule,
    PremiumScheduleStatusEnum,
    RenewalStatusEnum,
    RenewalTransaction,
    Tenant,
)
from shared.services.policy_state_machine import IllegalStateTransition, apply_transition, record_event

log = logging.getLogger(__name__)
router = APIRouter(tags=["Stage B — Renewals"])

_UNDERWRITING_ROLES = ("SuperAdmin", "Admin", "Underwriter")
_ADMIN_ROLES = ("SuperAdmin", "Admin")
ACCEPTANCE_METHODS = ["Portal", "Signed form", "Branch", "Phone (recorded)"]


# ── Request bodies ────────────────────────────────────────────────────────────

class OpenBody(BaseModel):
    actor: Optional[str] = None


class NoticeBody(BaseModel):
    channel: Optional[str] = None          # Email | SMS | WhatsApp | Letter
    sent_by: Optional[str] = None


class RiskDecisionBody(BaseModel):
    decision: Literal["Approve", "ApproveWithLoading", "Decline"]
    loading_pct: Optional[float] = None
    notes: Optional[str] = None


class AcceptanceBody(BaseModel):
    accepted: bool
    accepted_by: Optional[str] = None
    method: str = "Portal"
    note: Optional[str] = None


class ReconcileBody(BaseModel):
    actor: Optional[str] = None
    note: Optional[str] = None             # required to reconcile despite an exception


class CompleteBody(BaseModel):
    actor: Optional[str] = None


class CancelBody(BaseModel):
    reason: Optional[str] = None
    actor: Optional[str] = None


class SweepBody(BaseModel):
    send_notices: bool = False
    dry_run: bool = False
    actor: Optional[str] = None


# ── helpers ───────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.utcnow()


def _iso(d) -> Optional[str]:
    return d.isoformat() if d else None


def _touch(case: PolicyRenewal) -> None:
    case.updated_at = _now()


def _json_safe(obj):
    """Dates → ISO strings so a dict can sit in a JSON column."""
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    if isinstance(obj, UUID):
        return str(obj)
    return obj


async def _next_renewal_no(session: AsyncSession, tenant_id: UUID) -> str:
    existing = (await session.exec(select(PolicyRenewal).where(PolicyRenewal.tenant_id == tenant_id))).all()
    return f"RW-{_now().year}-{len(existing) + 1:05d}"


async def _get_case(session: AsyncSession, policy_id: UUID, case_id: UUID) -> PolicyRenewal:
    case = await session.get(PolicyRenewal, case_id)
    if not case or case.policy_id != policy_id:
        raise HTTPException(404, "Renewal case not found")
    return case


def _assert_open(case: PolicyRenewal) -> None:
    if case.status not in eng.OPEN_STATUSES:
        raise HTTPException(409, f"Renewal {case.renewal_no} is closed ({case.status}).")


def _audit(session, policy: Policy, case: PolicyRenewal, event_type: str, actor: Optional[str],
           detail: Optional[dict] = None) -> PolicyEvent:
    return record_event(session, policy, event_type=event_type, actor=actor or "ops",
                        detail={"renewal_no": case.renewal_no, "case_id": str(case.id),
                                "renewal_type": case.renewal_type, **(detail or {})})


async def _publish(request: Optional[Request], policy: Policy, events: list) -> None:
    for ev in events:
        await _publish_policy_event(request, policy, ev)


def _contact(customer: Optional[Customer]) -> tuple[Optional[str], Optional[str]]:
    d = (customer.details if customer else None) or {}
    return (d.get("contact_email") or d.get("email"),
            d.get("contact_phone") or d.get("phone") or d.get("mobile_number"))


async def _schedule_of(session: AsyncSession, case: PolicyRenewal) -> Optional[PremiumSchedule]:
    return await session.get(PremiumSchedule, case.schedule_id) if case.schedule_id else None


def _risk_cleared(case: PolicyRenewal) -> bool:
    return (not case.risk_required) or case.risk_outcome in ("STP", "Approved")


def _gate_open(case: PolicyRenewal) -> bool:
    """Collection opens once risk is cleared and any renewed/revised terms are accepted."""
    return _risk_cleared(case) and (not case.acceptance_required or bool(case.accepted_at))


async def _ensure_schedule(session: AsyncSession, policy: Policy, case: PolicyRenewal) -> PremiumSchedule:
    """Make sure the instalment this cycle collects exists in the ledger."""
    existing = await _schedule_of(session, case)
    if existing is not None:
        return existing
    version = await eng.current_version(session, policy)
    quote = case.quote_json or {}
    freq = quote.get("frequency") or "Annual"
    rows = (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy.id))).all()
    row = PremiumSchedule(
        policy_id=policy.id, policy_version_id=version.id if version else None,
        billing_frequency=BillingFrequencyEnum(freq), due_date=case.due_date,
        amount_due=case.quoted_amount, amount_paid=0.0, status=PremiumScheduleStatusEnum.PENDING,
        installment_no=max((r.installment_no for r in rows), default=0) + 1,
    )
    session.add(row)
    await session.flush()
    case.schedule_id, case.schedule_created = row.id, True
    return row


# ── views ─────────────────────────────────────────────────────────────────────

async def _timeline(session: AsyncSession, policy_id: UUID, case: PolicyRenewal) -> list[dict]:
    rows = (await session.exec(
        select(PolicyEvent).where(PolicyEvent.policy_id == policy_id)
        .order_by(PolicyEvent.created_at.desc())  # type: ignore[arg-type]
    )).all()
    out = []
    for e in rows:
        d = e.detail_json or {}
        if d.get("renewal_no") != case.renewal_no:
            continue
        out.append({
            "id": str(e.id), "event_type": e.event_type, "actor": e.actor,
            "from_status": e.from_status, "to_status": e.to_status, "at": e.created_at.isoformat(),
            "detail": {k: v for k, v in d.items() if k not in ("renewal_no", "case_id", "renewal_type")},
        })
    return out


async def _payment_view(session: AsyncSession, case: PolicyRenewal, sched: Optional[PremiumSchedule]) -> Optional[dict]:
    if sched is None:
        return None
    today = date.today()
    outstanding = round(max(sched.amount_due - sched.amount_paid, 0.0), 2)
    surcharge = surcharge_for(sched.amount_due, _row_state(sched, today)) if outstanding > 0 else 0.0
    receipts = (await session.exec(select(PremiumReceipt).where(PremiumReceipt.schedule_id == sched.id))).all()
    return {
        "schedule_id": str(sched.id), "installment_no": sched.installment_no, "due_date": sched.due_date.isoformat(),
        "status": sched.status.value if hasattr(sched.status, "value") else str(sched.status),
        "amount_due": sched.amount_due, "amount_paid": sched.amount_paid, "outstanding": outstanding,
        "surcharge": surcharge, "payable": round(outstanding + surcharge, 2),
        "paid_at": _iso(sched.paid_at), "payment_reference": sched.payment_reference,
        "receipts": [{"id": str(r.id), "receipt_no": r.receipt_no, "total_amount": r.total_amount,
                      "surcharge_amount": r.surcharge_amount, "method": r.method} for r in receipts],
    }


async def _case_view(session: AsyncSession, policy: Policy, case: PolicyRenewal, live_eligibility: Optional[dict] = None) -> dict:
    sched = await _schedule_of(session, case)
    risk_applies, accept_applies = case.risk_required, case.acceptance_required
    stages = eng.project_stages(case, live_eligibility=live_eligibility, renewal_type=case.renewal_type,
                                schedule=sched, risk_applies=risk_applies, acceptance_applies=accept_applies)
    payment = await _payment_view(session, case, sched)
    paid = bool(payment and payment["status"] == PremiumScheduleStatusEnum.PAID.value)
    is_open = case.status in eng.OPEN_STATUSES
    pol_status = _st(policy)
    return {
        "id": str(case.id), "renewal_no": case.renewal_no, "renewal_type": case.renewal_type,
        "renewal_type_label": eng.TYPE_LABELS[case.renewal_type], "status": case.status,
        "cycle_label": case.cycle_label, "renewal_year": case.renewal_year, "due_date": case.due_date.isoformat(),
        "period_start": _iso(case.period_start), "period_end": _iso(case.period_end),
        "source": case.source, "opened_by": case.opened_by, "created_at": case.created_at.isoformat(),
        "is_open": is_open, "closed_reason": case.closed_reason,
        "eligibility": case.eligibility_json, "rules": case.rules_json, "quote": case.quote_json,
        "quoted_amount": case.quoted_amount,
        "notice": {"sent_at": _iso(case.notice_sent_at), "channel": case.notice_channel, "count": case.notice_count,
                   "delivered": case.notice_delivered, "has_document": bool(case.notice_path)},
        "risk": {"required": case.risk_required, "outcome": case.risk_outcome, "detail": case.risk_json,
                 "evaluated_at": _iso(case.risk_evaluated_at), "decided_by": case.risk_decided_by,
                 "decided_at": _iso(case.risk_decided_at), "notes": case.risk_notes, "loading_pct": case.loading_pct},
        "acceptance": {"required": case.acceptance_required, "accepted_at": _iso(case.accepted_at),
                       "accepted_by": case.accepted_by, "method": case.acceptance_method,
                       "methods": ACCEPTANCE_METHODS},
        "payment": payment,
        "reconciliation": {"result": case.reconciliation_json, "reconciled_at": _iso(case.reconciled_at),
                           "reconciled_by": case.reconciled_by, "note": case.reconciliation_note},
        "completion": {"completed_at": _iso(case.completed_at), "completed_by": case.completed_by,
                       "next_due_date": _iso(case.next_due_date), "new_version_id": str(case.new_version_id) if case.new_version_id else None},
        "confirmation": {"generated_at": _iso(case.confirmation_generated_at), "sent_at": _iso(case.confirmation_sent_at),
                         "sent_to": case.confirmation_sent_to},
        "stages": stages,
        "can": {
            "notice": is_open and pol_status in eng.IN_FORCE,
            "risk_decide": is_open and case.risk_outcome == "Referred",
            "accept": is_open and case.acceptance_required and not case.accepted_at and _risk_cleared(case),
            "pay": is_open and _gate_open(case) and not paid and pol_status in eng.IN_FORCE,
            "reconcile": is_open and paid and not case.reconciled_at,
            "complete": is_open and paid and bool(case.reconciled_at) and _gate_open(case) and pol_status in eng.IN_FORCE,
            "cancel": is_open,
        },
        "timeline": await _timeline(session, policy.id, case),
    }


async def _group_info(session: AsyncSession, policy: Policy) -> Optional[dict]:
    if not policy.master_policy_id:
        return None
    mp = await session.get(MasterPolicy, policy.master_policy_id)
    latest = (await session.exec(
        select(GroupRenewal).where(GroupRenewal.master_policy_id == policy.master_policy_id)
        .order_by(GroupRenewal.created_at.desc())  # type: ignore[arg-type]
    )).first()
    return {
        "master_policy_id": str(policy.master_policy_id),
        "organization_id": str(mp.organization_id) if mp else None,
        "master_policy_number": mp.policy_number if mp else None,
        "expiry_date": _iso(mp.expiry_date) if mp else None,
        "latest_renewal_status": latest.status if latest else None,
        "latest_renewal_period_end": _iso(latest.new_period_end) if latest else None,
    }


async def _overview(session: AsyncSession, policy: Policy, resumed: bool = False) -> dict:
    plan = await eng.plan_for_policy(session, policy)
    customer = await session.get(Customer, policy.customer_id)
    cases = (await session.exec(
        select(PolicyRenewal).where(PolicyRenewal.policy_id == policy.id)
        .order_by(PolicyRenewal.created_at.desc())  # type: ignore[arg-type]
    )).all()
    open_case = next((c for c in cases if c.status in eng.OPEN_STATUSES), None)
    shown = open_case or (cases[0] if cases else None)
    elig = plan["eligibility"]

    case_view = await _case_view(session, policy, shown, elig) if shown else None
    upcoming_stages = eng.project_stages(
        None, live_eligibility=elig, renewal_type=plan["renewal_type"],
        risk_applies=eng.risk_required(plan["renewal_type"], plan["rules"]),
        acceptance_applies=plan["renewal_type"] == eng.CONTRACT)
    tm = plan["timing"]
    next_up = None
    if plan["due_date"]:
        payable = round((plan["amount"] or 0.0) + plan["surcharge"], 2)
        next_up = {
            "due_date": plan["due_date"].isoformat(), "amount": plan["amount"], "surcharge": plan["surcharge"],
            "payable": payable, "renewal_type": plan["renewal_type"], "renewal_type_label": plan["renewal_type_label"],
            "frequency": plan["cycle"]["frequency"] if plan["cycle"] else None,
            "in_ledger": bool(plan["cycle"] and plan["cycle"]["in_ledger"]),
            "installment_no": plan["cycle"]["installment_no"] if plan["cycle"] else None,
            "window_opens_on": tm["window_opens_on"].isoformat(), "days_until": tm["days_until"], "state": tm["state"],
            "notice_days": int(plan["rules"]["notice_days"]),
            "period_end": _iso(plan["period_end"]),
        }
    return {
        "policy": {"id": str(policy.id), "policy_number": policy.policy_number, "status": _st(policy),
                   "product_name": policy.product_name, "sum_assured": policy.coverage_amount,
                   "customer_name": customer.name if customer else None,
                   "maturity_date": _iso(policy.maturity_date), "expiry_date": _iso(policy.expiry_date)},
        "annual_premium": plan["annual_premium"],
        "contract_renewable": bool(plan["rules"].get("contract_renewable")),
        "next": next_up,
        "eligibility": elig,
        "stages": (case_view["stages"] if open_case else upcoming_stages),
        "case": case_view,
        "resumed": resumed,
        "history": [{"id": str(c.id), "renewal_no": c.renewal_no, "renewal_type": c.renewal_type, "status": c.status,
                     "due_date": c.due_date.isoformat(), "quoted_amount": c.quoted_amount,
                     "completed_at": _iso(c.completed_at), "closed_reason": c.closed_reason} for c in cases],
        "group_scheme": await _group_info(session, policy),
        "options": {"channels": insurer_config.RENEWAL_NOTICE_CHANNELS, "acceptance_methods": ACCEPTANCE_METHODS},
    }


# ══════════════════════════════════════════════════════════════════════════════
# Steps 1–2 — plan + open the cycle
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/tenants/{tenant_id}/policies/{policy_id}/renewals")
async def renewals_overview(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    """The upcoming renewal (next due date, premium, type), live eligibility, the
    processing tracker, the current case with its audit timeline, and the history."""
    policy = await _get_policy(session, tenant_id, policy_id)
    return await _overview(session, policy)


async def _create_case(
    session: AsyncSession, policy: Policy, plan: dict, actor: Optional[str], source: str,
) -> tuple[PolicyRenewal, list]:
    """Open a renewal cycle from a (eligible) plan. Adds rows to the session; caller commits."""
    rules, rtype, today = plan["rules"], plan["renewal_type"], date.today()
    cycle, due = plan["cycle"], plan["due_date"]
    version = await eng.current_version(session, policy)
    current_annual = version.total_premium if version else plan["annual_premium"]
    freq = cycle["frequency"]

    period_start = period_end = None
    renewal_year = None
    quote: dict
    schedule_id = cycle["schedule_id"] if cycle["in_ledger"] else None
    if rtype == eng.CONTRACT:
        period_start, period_end = due, eng.add_years(due, int(rules["renewal_term_years"]))
        completed = await eng.completed_period_ends(session, policy.id)
        renewal_year = len(completed) + 2
        breakdown, _ = await _price_breakdown(session, policy.tenant_id, policy)
        quote = eng.build_quote(current_annual=current_annual, renewal_annual=breakdown.total_premium, loading_pct=0.0,
                                frequency=freq, period_start=period_start, period_end=period_end,
                                rating_basis=getattr(breakdown, "rating_basis", ""))
        quote["breakdown"] = {"base_premium": breakdown.base_premium, "loading_amount": breakdown.loading_amount,
                              "policy_fee": breakdown.policy_fee, "tax_amount": breakdown.tax_amount,
                              "total_premium": breakdown.total_premium}
        quoted = quote["instalment"]
        label = f"Contract renewal · year {renewal_year}"
    else:
        quote = eng.build_quote(current_annual=current_annual, renewal_annual=current_annual, loading_pct=0.0,
                                frequency=freq, period_start=None, period_end=None)
        quoted = cycle["amount"]
        quote["instalment"] = quoted
        label = f"Premium due {due.strftime('%d %b %Y')}"

    risk = eng.evaluate_risk(
        renewal_type=rtype, rules=rules, age_at_due=plan["age_at_due"],
        claims_in_period=plan["claims"]["in_period"], open_claims=plan["claims"]["open"])
    now = _now()
    case = PolicyRenewal(
        tenant_id=policy.tenant_id, policy_id=policy.id, renewal_no=await _next_renewal_no(session, policy.tenant_id),
        renewal_type=rtype, status="Referred" if risk["outcome"] == "Referred" else "Open",
        cycle_label=label, renewal_year=renewal_year, due_date=due, period_start=period_start, period_end=period_end,
        schedule_id=schedule_id, opened_by=actor or "ops", source=source,
        eligibility_json=_json_safe({"checks": plan["eligibility"]["checks"], "evaluated_at": now.isoformat()}),
        rules_json=_json_safe(rules), quote_json=_json_safe(quote), quoted_amount=quoted,
        risk_required=risk["required"], risk_json=_json_safe(risk), risk_outcome=risk["outcome"],
        risk_evaluated_at=now if risk["required"] else None,
        acceptance_required=(rtype == eng.CONTRACT),
    )
    session.add(case)
    # A premium renewal's instalment goes into the ledger straight away so it is also
    # visible (and collectable) in Step 3. A contract renewal's row waits for acceptance,
    # because its amount depends on risk / underwriter terms.
    if rtype == eng.PREMIUM and not cycle["in_ledger"]:
        await _ensure_schedule(session, policy, case)
    events = [_audit(session, policy, case, "RenewalOpened", actor, {
        "due_date": due.isoformat(), "amount": quoted, "source": source, "label": label})]
    if risk["required"]:
        events.append(_audit(session, policy, case, "RenewalRiskEvaluated", "system",
                             {"outcome": risk["outcome"], "reasons": risk["reasons"]}))
    return case, events


@router.post("/tenants/{tenant_id}/policies/{policy_id}/renewals")
async def open_renewal(
    tenant_id: UUID, policy_id: UUID,
    body: OpenBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Open the upcoming renewal cycle. Re-validates eligibility server-side; an open
    cycle is resumed rather than duplicated."""
    policy = await _get_policy(session, tenant_id, policy_id)
    await session.refresh(policy, with_for_update=True)
    plan = await eng.plan_for_policy(session, policy)
    elig = plan["eligibility"]
    if elig["outcome"] == "resume":
        return await _overview(session, policy, resumed=True)
    if not elig["eligible"]:
        raise HTTPException(409, elig["message"])

    case, events = await _create_case(session, policy, plan, body.actor, "Manual")
    await session.commit()
    await _publish(request, policy, events)
    log.info("Renewal %s (%s) opened for policy %s", case.renewal_no, case.renewal_type, policy.policy_number)
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Step 3 — renewal notice
# ══════════════════════════════════════════════════════════════════════════════

async def _render_notice(session: AsyncSession, policy: Policy, case: PolicyRenewal) -> str:
    customer = await session.get(Customer, policy.customer_id)
    tenant = await session.get(Tenant, policy.tenant_id)
    q = case.quote_json or {}
    doc = document_generator.generate_renewal_notice({
        "policy_id": policy.id, "tenant_name": tenant.name if tenant else "Insurer",
        "customer_name": customer.name if customer else "Policyholder", "policy_number": policy.policy_number,
        "product_name": policy.product_name, "sum_assured": policy.coverage_amount, "renewal_no": case.renewal_no,
        "renewal_type": case.renewal_type, "due_date": case.due_date.isoformat(), "amount": case.quoted_amount,
        "frequency": q.get("frequency"), "new_annual": q.get("new_annual"),
        "period_start": q.get("period_start"), "period_end": q.get("period_end"),
    })
    case.notice_path = doc["file_path"]
    return doc["file_path"]


async def _send_notice(
    session: AsyncSession, policy: Policy, case: PolicyRenewal, channel: Optional[str], actor: Optional[str],
) -> tuple[PolicyEvent, bool]:
    customer = await session.get(Customer, policy.customer_id)
    email, phone = _contact(customer)
    chosen = channel if channel in insurer_config.RENEWAL_NOTICE_CHANNELS else ("Email" if email else "SMS" if phone else "Letter")
    if chosen in ("Email", "SMS", "WhatsApp") and not (email or phone):
        raise HTTPException(400, "No email or phone on record — add a contact or use the Letter channel")
    if chosen == "Email" and not email:
        raise HTTPException(400, "No email on record — choose SMS/WhatsApp (phone on file) or Letter")
    if chosen in ("SMS", "WhatsApp") and not phone:
        raise HTTPException(400, f"No phone on record — choose Email or Letter instead of {chosen}")

    path = await _render_notice(session, policy, case)
    tenant = await session.get(Tenant, policy.tenant_id)
    subject, text, html = renewal_notice_email(
        customer_name=customer.name if customer else "Policyholder", tenant_name=tenant.name if tenant else "Your Insurer",
        policy_number=policy.policy_number or "—", renewal_no=case.renewal_no, renewal_type=case.renewal_type,
        due_date=case.due_date.isoformat(), amount=case.quoted_amount,
        frequency=(case.quote_json or {}).get("frequency") or "Annual",
        tenant_phone=tenant.contact_phone if tenant else None, tenant_email=tenant.contact_email if tenant else None)
    delivered = True
    if chosen == "Email":
        delivered = bool(await email_utils.send_email(email, subject, text, html, [path]))
    # SMS / WhatsApp / Letter are simulated (logged), like the payment gateway and Step 3 reminders.

    days = (case.due_date - date.today()).days
    kind = "Upcoming" if days > 0 else "Due" if days == 0 else "Overdue"
    to_address = email if chosen == "Email" else (phone if chosen in ("SMS", "WhatsApp") else "postal")
    sched = await _schedule_of(session, case)
    session.add(PremiumReminder(
        tenant_id=policy.tenant_id, policy_id=policy.id, schedule_id=sched.id if sched else None,
        kind=kind, channel=chosen, template="Standard", to_address=to_address,
        message=f"{eng.TYPE_LABELS[case.renewal_type]} notice {case.renewal_no} — PKR {case.quoted_amount:,.0f} due {case.due_date.isoformat()}",
        sent_by=actor or "ops"))
    if sched is not None:
        sched.reminder_count = (sched.reminder_count or 0) + 1
        sched.last_reminder_at = _now()
        session.add(sched)

    case.notice_sent_at, case.notice_channel, case.notice_delivered = _now(), chosen, delivered
    case.notice_count = (case.notice_count or 0) + 1
    _touch(case)
    ev = _audit(session, policy, case, "RenewalNoticeIssued", actor,
                {"channel": chosen, "delivered": delivered, "to": to_address, "amount": case.quoted_amount})
    return ev, delivered


@router.post("/tenants/{tenant_id}/policies/{policy_id}/renewals/{case_id}/notice")
async def issue_renewal_notice(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    body: NoticeBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Generate the renewal notice (PDF) and send it by email / SMS / WhatsApp / letter.
    Can be repeated — each send is counted and logged with the Step 3 reminders."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if _st(policy) not in eng.IN_FORCE:
        raise HTTPException(409, f"A renewal notice needs an in-force policy (current: {_st(policy)}).")
    ev, _delivered = await _send_notice(session, policy, case, body.channel, body.sent_by)
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


@router.get("/tenants/{tenant_id}/policies/{policy_id}/renewals/{case_id}/notice/download")
async def download_notice(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    if not case.notice_path or not os.path.exists(case.notice_path):
        await _render_notice(session, policy, case)
        await session.commit()
    return FileResponse(case.notice_path, media_type="application/pdf", filename=f"renewal_notice_{case.renewal_no}.pdf")


# ══════════════════════════════════════════════════════════════════════════════
# Step 4 — risk evaluation
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/policies/{policy_id}/renewals/{case_id}/risk/evaluate")
async def reevaluate_risk(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Re-run the straight-through rules (e.g. after a claim was registered). Only
    before an underwriter has decided or funds were taken."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if not case.risk_required:
        raise HTTPException(409, "Risk evaluation is not required for this renewal.")
    if case.risk_decided_at:
        raise HTTPException(409, "An underwriter has already decided this renewal.")
    sched = await _schedule_of(session, case)
    if sched is not None and sched.amount_paid > 0:
        raise HTTPException(409, "Payment has already been taken against this renewal.")

    plan = await eng.plan_for_policy(session, policy)
    age = await eng.applicant_age_on(session, policy, case.due_date)
    since = eng.add_years(case.due_date, -int((case.rules_json or {}).get("renewal_term_years", 1)))
    claims = await eng.claims_facts(session, policy.id, since)
    risk = eng.evaluate_risk(renewal_type=case.renewal_type, rules=case.rules_json or plan["rules"], age_at_due=age,
                             claims_in_period=claims["in_period"], open_claims=claims["open"])
    case.risk_json, case.risk_outcome, case.risk_evaluated_at = _json_safe(risk), risk["outcome"], _now()
    case.status = "Referred" if risk["outcome"] == "Referred" else "Open"
    _touch(case)
    ev = _audit(session, policy, case, "RenewalRiskEvaluated", "system",
                {"outcome": risk["outcome"], "reasons": risk["reasons"], "rerun": True})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


async def _apply_loading(session: AsyncSession, policy: Policy, case: PolicyRenewal, pct: float) -> None:
    """Re-price the cycle for an underwriter's loading. Refuses once money has moved."""
    sched = await _schedule_of(session, case)
    if sched is not None and sched.amount_paid > 0:
        raise HTTPException(409, "Payment has already been taken — the terms can no longer change.")
    q = case.quote_json or {}
    quote = eng.build_quote(
        current_annual=q["current_annual"], renewal_annual=q["renewal_annual"], loading_pct=pct, frequency=q["frequency"],
        period_start=case.period_start, period_end=case.period_end, rating_basis=q.get("rating_basis", ""))
    if "breakdown" in q:
        quote["breakdown"] = q["breakdown"]
    case.quote_json, case.quoted_amount, case.loading_pct = _json_safe(quote), quote["instalment"], pct
    if sched is not None:
        sched.amount_due = case.quoted_amount
        session.add(sched)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/renewals/{case_id}/risk/decision")
async def decide_risk(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    body: RiskDecisionBody,
    request: Request,
    user=Depends(require_roles(*_UNDERWRITING_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Underwriter decision on a referred renewal: approve, approve with a loading
    (revised terms the customer must accept), or decline. Underwriter / Admin only."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if case.risk_outcome != "Referred":
        raise HTTPException(409, "This renewal is not awaiting an underwriting decision.")
    actor = getattr(user, "email", None) or getattr(user, "username", None) or "underwriter"
    notes = (body.notes or "").strip()
    if body.decision != "Approve" and not notes:
        raise HTTPException(400, "Notes are required for this decision.")

    now = _now()
    if body.decision == "Decline":
        case.risk_outcome, case.status, case.closed_reason = "Declined", "Declined", notes
    else:
        if body.decision == "ApproveWithLoading":
            max_pct = float((case.rules_json or {}).get("max_loading_pct", 300))
            if not body.loading_pct or body.loading_pct <= 0 or body.loading_pct > max_pct:
                raise HTTPException(400, f"Loading must be between 0 and {max_pct:g}%.")
            await _apply_loading(session, policy, case, float(body.loading_pct))
            case.acceptance_required, case.accepted_at, case.accepted_by = True, None, None   # revised terms need consent
        case.risk_outcome, case.status = "Approved", "Open"
    case.risk_decided_by, case.risk_decided_at, case.risk_notes = actor, now, notes or None
    _touch(case)
    ev = _audit(session, policy, case, "RenewalRiskDecision", actor,
                {"decision": body.decision, "notes": notes or None, "loading_pct": case.loading_pct or None})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Step 5 — acceptance
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/policies/{policy_id}/renewals/{case_id}/acceptance")
async def capture_acceptance(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    body: AcceptanceBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Record the customer's consent to the renewed (or revised) terms. Declining closes
    the case; the policy then simply runs to the end of its current period."""
    policy = await _get_policy(session, tenant_id, policy_id)
    await session.refresh(policy, with_for_update=True)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if not case.acceptance_required:
        raise HTTPException(409, "Acceptance is not required for an ordinary premium renewal.")
    if not _risk_cleared(case):
        raise HTTPException(409, "Underwriting must clear the renewal before the customer is asked to accept.")
    if body.method not in ACCEPTANCE_METHODS:
        raise HTTPException(400, f"Unknown acceptance method '{body.method}'")
    if case.accepted_at:
        raise HTTPException(409, "The renewed terms have already been accepted.")

    if body.accepted:
        case.accepted_at, case.accepted_by, case.acceptance_method = _now(), body.accepted_by or "customer", body.method
        await _ensure_schedule(session, policy, case)     # collection opens: the instalment now exists in the ledger
    else:
        case.status, case.closed_reason = "Declined", (body.note or "Renewed terms declined by the customer").strip()
    _touch(case)
    ev = _audit(session, policy, case, "RenewalAccepted" if body.accepted else "RenewalDeclined",
                body.accepted_by, {"method": body.method, "note": body.note})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Step 6 — collect + reconcile
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/policies/{policy_id}/renewals/{case_id}/payment")
async def collect_renewal_premium(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    body: CollectBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Collect the renewal instalment — through the very same path as Step 3, so the
    receipt, commission accrual and grace-period revival behave identically. Opens only
    after risk is cleared and any renewed/revised terms are accepted."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if not _risk_cleared(case):
        raise HTTPException(409, "Collection opens once underwriting clears the renewal.")
    if case.acceptance_required and not case.accepted_at:
        raise HTTPException(409, "Collection opens once the customer accepts the renewed terms.")
    sched = await _ensure_schedule(session, policy, case)
    if sched.status not in (PremiumScheduleStatusEnum.PENDING, PremiumScheduleStatusEnum.OVERDUE):
        raise HTTPException(409, "This instalment has already been settled.")
    await session.commit()          # persist a freshly-created ledger row before collect re-locks the policy
    await collect_installment(tenant_id, policy_id, sched.id, body, request, session)
    return await _overview(session, policy)


def _expected_for(sched: PremiumSchedule) -> float:
    return sched.amount_due


@router.post("/tenants/{tenant_id}/policies/{policy_id}/renewals/{case_id}/reconcile")
async def reconcile_payment(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    body: ReconcileBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Reconcile what was actually received against what was due: ledger status, a
    single receipt, amount, payment reference, policy state and commission accrual.
    A failed blocking check is an Exception — it can only be signed off with a note."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    sched = await _schedule_of(session, case)
    if sched is None or sched.status != PremiumScheduleStatusEnum.PAID:
        raise HTTPException(409, "There is no collected premium to reconcile yet.")

    receipts = (await session.exec(select(PremiumReceipt).where(PremiumReceipt.schedule_id == sched.id))).all()
    accruals = []
    for r in receipts:
        accruals += [a.status for a in (await session.exec(select(CommissionAccrual).where(CommissionAccrual.receipt_id == r.id))).all()]
    result = eng.reconcile_facts(
        expected=_expected_for(sched), schedule_status=sched.status.value, schedule_amount_due=sched.amount_due,
        schedule_amount_paid=sched.amount_paid, schedule_reference=sched.payment_reference,
        receipts=[{"base_amount": r.base_amount, "surcharge_amount": r.surcharge_amount, "total_amount": r.total_amount,
                   "payment_reference": r.payment_reference} for r in receipts],
        accrual_statuses=accruals, policy_status=_st(policy))
    if abs(sched.amount_due - case.quoted_amount) >= 0.01:
        result["checks"].append(eng.check("quote", "Matches the renewal quote", False,
                                          f"The ledger amount PKR {sched.amount_due:,.2f} differs from the quoted PKR {case.quoted_amount:,.2f}.", "review"))
        result["reviews"] = [c for c in result["checks"] if c["severity"] == "review"]

    note = (body.note or "").strip()
    if result["status"] == "Exception" and not note:
        case.reconciliation_json = _json_safe(result)
        _touch(case)
        ev = _audit(session, policy, case, "RenewalReconciliationException", body.actor,
                    {"variance": result["variance"], "failed": [c["key"] for c in result["checks"] if c["severity"] == "block"]})
        await session.commit()
        await _publish(request, policy, [ev])
        return await _overview(session, policy)

    case.reconciliation_json = _json_safe(result)
    case.reconciled_at, case.reconciled_by, case.reconciliation_note = _now(), body.actor or "ops", note or None
    _touch(case)
    ev = _audit(session, policy, case, "RenewalReconciled", body.actor,
                {"status": result["status"], "received": result["received"], "expected": result["expected"],
                 "note": note or None})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Steps 7–8 — complete the renewal + documents
# ══════════════════════════════════════════════════════════════════════════════

async def _bind_contract_renewal(session: AsyncSession, policy: Policy, case: PolicyRenewal, actor: str) -> PolicyVersion:
    """Bind the renewed contract: close the running version, append N.0 with the renewed
    premium (and any accepted loading), record the RenewalTransaction and extend the
    policy dates when the new period runs past them."""
    q = case.quote_json or {}
    bd = q.get("breakdown") or {}
    current = await eng.current_version(session, policy)
    if current is not None and current.effective_to is None:
        current.effective_to = case.period_start or case.due_date
        session.add(current)
    try:
        major = int((current.version_number if current else "1.0").split(".")[0]) + 1
    except (ValueError, AttributeError):
        major = (case.renewal_year or 2)
    additional = float(q.get("additional_annual") or 0.0)
    loadings = {**(current.loadings_json or {}), "renewal": {
        "renewal_no": case.renewal_no, "loading_pct": case.loading_pct, "additional_annual": additional}} if current else None
    version = PolicyVersion(
        policy_id=policy.id, version_number=f"{major}.0", effective_from=case.period_start or case.due_date,
        effective_to=None,
        base_premium=bd.get("base_premium", current.base_premium if current else 0.0),
        loading_amount=round(bd.get("loading_amount", current.loading_amount if current else 0.0) + additional, 2),
        policy_fee=bd.get("policy_fee", current.policy_fee if current else 0.0),
        tax_amount=bd.get("tax_amount", current.tax_amount if current else 0.0),
        total_premium=q.get("new_annual", current.total_premium if current else 0.0),
        loadings_json=loadings, exclusions_json=current.exclusions_json if current else None,
        created_by=actor, event_type="Renewal",
    )
    session.add(version)
    await session.flush()
    policy.current_version_id = version.id
    if case.period_end and (policy.expiry_date is None or case.period_end > policy.expiry_date):
        policy.expiry_date = case.period_end
        policy.grace_period_end_date = case.period_end + timedelta(days=GRACE_PERIOD_DAYS)
        if policy.maturity_date is None or case.period_end > policy.maturity_date:
            policy.maturity_date = case.period_end
    session.add(policy)

    risk = case.risk_json or {}
    session.add(RenewalTransaction(
        policy_id=policy.id, old_version_id=current.id if current else None, new_version_id=version.id,
        renewal_year=case.renewal_year or major, status=RenewalStatusEnum.BOUND,
        renewal_premium=version.total_premium, renewal_loading=additional,
        claims_count=int((risk.get("metrics") or {}).get("claims_in_period", 0)),
        is_stp=case.risk_outcome in ("STP", "NotRequired"), bound_at=_now()))
    return version


async def _render_confirmation(session: AsyncSession, policy: Policy, case: PolicyRenewal,
                               version: Optional[PolicyVersion]) -> str:
    customer = await session.get(Customer, policy.customer_id)
    tenant = await session.get(Tenant, policy.tenant_id)
    sched = await _schedule_of(session, case)
    receipt = None
    if sched is not None:
        receipt = (await session.exec(select(PremiumReceipt).where(PremiumReceipt.schedule_id == sched.id)
                                      .order_by(PremiumReceipt.created_at.desc()))).first()  # type: ignore[arg-type]
    q = case.quote_json or {}
    doc = document_generator.generate_renewal_confirmation({
        "policy_id": policy.id, "tenant_name": tenant.name if tenant else "Insurer",
        "customer_name": customer.name if customer else "Policyholder", "policy_number": policy.policy_number,
        "product_name": policy.product_name, "sum_assured": policy.coverage_amount, "renewal_no": case.renewal_no,
        "renewal_type": case.renewal_type, "amount_received": sched.amount_paid if sched else None,
        "payment_reference": sched.payment_reference if sched else None, "receipt_no": receipt.receipt_no if receipt else None,
        "period_start": q.get("period_start"), "period_end": q.get("period_end"), "new_annual": q.get("new_annual"),
        "loading_pct": case.loading_pct, "version_number": version.version_number if version else None,
        "next_due_date": case.next_due_date.isoformat() if case.next_due_date else None,
    })
    case.confirmation_path, case.confirmation_generated_at = doc["file_path"], _now()
    return doc["file_path"]


@router.post("/tenants/{tenant_id}/policies/{policy_id}/renewals/{case_id}/complete")
async def complete_renewal(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    body: CompleteBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Complete the cycle. Premium Renewal: the ledger is already updated, so this records
    the completion and the next due date — the contract is untouched. Contract Renewal:
    binds the renewed contract (new version N.0, renewal transaction, extended dates).
    Needs a reconciled payment; generates the confirmation."""
    policy = await _get_policy(session, tenant_id, policy_id)
    await session.refresh(policy, with_for_update=True)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    sched = await _schedule_of(session, case)
    unmet = []
    if not _risk_cleared(case):
        unmet.append("underwriting clearance")
    if case.acceptance_required and not case.accepted_at:
        unmet.append("customer acceptance")
    if sched is None or sched.status != PremiumScheduleStatusEnum.PAID:
        unmet.append("collected premium")
    if not case.reconciled_at:
        unmet.append("payment reconciliation")
    if unmet:
        raise HTTPException(409, "Cannot complete the renewal yet — outstanding: " + ", ".join(unmet))
    if _st(policy) not in eng.IN_FORCE:
        raise HTTPException(409, f"The policy is {_st(policy)} — it must be in force to complete a renewal.")

    actor = body.actor or "ops"
    try:
        events = []
        version = None
        if case.renewal_type == eng.CONTRACT:
            version = await _bind_contract_renewal(session, policy, case, actor)
            case.new_version_id = version.id
            events.append(apply_transition(
                session, policy, PolicyStatusEnum.ACTIVE, event_type="PolicyRenewed", actor=actor,
                detail={"renewal_no": case.renewal_no, "case_id": str(case.id), "renewal_type": case.renewal_type,
                        "version": version.version_number, "period_start": _iso(case.period_start),
                        "period_end": _iso(case.period_end), "premium": version.total_premium,
                        "loading_pct": case.loading_pct or None}))
        else:
            events.append(_audit(session, policy, case, "PremiumRenewalCompleted", actor,
                                 {"amount": sched.amount_paid, "reference": sched.payment_reference}))
        await session.flush()
        rows = list((await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy.id))).all())
        version_now = version or await eng.current_version(session, policy)
        nxt = eng.plan_premium_cycle(rows=rows, effective_date=policy.effective_date, maturity_date=policy.maturity_date,
                                     annual_premium=version_now.total_premium if version_now else 0.0, today=date.today())
        case.next_due_date = nxt["due_date"] if nxt and not nxt.get("term_complete") else None
        case.status, case.completed_at, case.completed_by = "Completed", _now(), actor
        await _render_confirmation(session, policy, case, version)
        _touch(case)
        events.append(_audit(session, policy, case, "RenewalConfirmationIssued", "system",
                             {"document": f"Renewal Confirmation {case.renewal_no}"}))
        await session.commit()
    except IllegalStateTransition as exc:
        await session.rollback()
        raise HTTPException(409, str(exc)) from exc
    except HTTPException:
        await session.rollback()
        raise
    except Exception as exc:
        await session.rollback()
        log.exception("Renewal %s failed to complete for policy %s — rolled back", case.renewal_no, policy_id)
        raise HTTPException(500, f"Completing the renewal failed and was rolled back: {exc}") from exc

    await _publish(request, policy, events)
    log.info("Renewal %s (%s) completed for policy %s", case.renewal_no, case.renewal_type, policy.policy_number)
    return await _overview(session, policy)


@router.get("/tenants/{tenant_id}/policies/{policy_id}/renewals/{case_id}/confirmation/download")
async def download_renewal_confirmation(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    if case.status != "Completed":
        raise HTTPException(409, "The confirmation is issued once the renewal is complete.")
    if not case.confirmation_path or not os.path.exists(case.confirmation_path):
        version = await session.get(PolicyVersion, case.new_version_id) if case.new_version_id else None
        await _render_confirmation(session, policy, case, version)
        await session.commit()
    return FileResponse(case.confirmation_path, media_type="application/pdf",
                        filename=f"renewal_confirmation_{case.renewal_no}.pdf")


@router.post("/tenants/{tenant_id}/policies/{policy_id}/renewals/{case_id}/confirmation/send")
async def send_renewal_confirmation(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Email the confirmation to the policyholder (best-effort; `delivered` reports
    whether the mail provider accepted it)."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    if case.status != "Completed":
        raise HTTPException(409, "The confirmation can be sent once the renewal is complete.")
    customer = await session.get(Customer, policy.customer_id)
    email, _phone = _contact(customer)
    if not email:
        raise HTTPException(400, "No email on record — add a contact before sending the confirmation")
    tenant = await session.get(Tenant, policy.tenant_id)
    sched = await _schedule_of(session, case)
    subject, text, html = renewal_confirmation_email(
        customer_name=customer.name if customer else "Policyholder", tenant_name=tenant.name if tenant else "Your Insurer",
        policy_number=policy.policy_number or "—", renewal_no=case.renewal_no, renewal_type=case.renewal_type,
        amount_received=sched.amount_paid if sched else 0.0, next_due_date=_iso(case.next_due_date),
        period_end=_iso(case.period_end), tenant_phone=tenant.contact_phone if tenant else None,
        tenant_email=tenant.contact_email if tenant else None)
    attachments = [case.confirmation_path] if case.confirmation_path and os.path.exists(case.confirmation_path) else None
    ok = await email_utils.send_email(email, subject, text, html, attachments)
    if ok:
        case.confirmation_sent_at, case.confirmation_sent_to = _now(), email
        _touch(case)
    ev = _audit(session, policy, case, "RenewalConfirmationSent", "ops", {"to": email, "delivered": ok})
    await session.commit()
    await _publish(request, policy, [ev])
    return {"sent_to": email, "sent_at": _now().isoformat(), "delivered": ok, "subject": subject}


# ══════════════════════════════════════════════════════════════════════════════
# Cancel + portfolio sweep
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/policies/{policy_id}/renewals/{case_id}/cancel")
async def cancel_renewal(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    body: CancelBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Close an unfinished cycle. A ledger row this case created and nobody has paid is
    removed again; a row that already carries money is left alone."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    sched = await _schedule_of(session, case)
    removed = False
    if sched is not None and case.schedule_created and sched.amount_paid == 0 and sched.status in (
            PremiumScheduleStatusEnum.PENDING, PremiumScheduleStatusEnum.OVERDUE):
        case.schedule_id = None
        await session.flush()
        await session.delete(sched)
        removed = True
    case.status, case.closed_reason = "Cancelled", (body.reason or "Cancelled by ops").strip()
    _touch(case)
    ev = _audit(session, policy, case, "RenewalCancelled", body.actor,
                {"reason": case.closed_reason, "ledger_row_removed": removed})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


@router.post("/tenants/{tenant_id}/renewals/sweep")
async def sweep_renewals(
    tenant_id: UUID,
    body: SweepBody,
    request: Request,
    user=Depends(require_roles(*_ADMIN_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """The on-demand equivalent of the daily renewal job: open a cycle for every in-force
    individual/family policy whose renewal notice window has begun (30 days before the
    due date by default). Notices are only sent when `send_notices` is true. `dry_run`
    reports what would happen without changing anything."""
    actor = body.actor or getattr(user, "email", None) or "sweep"
    rows = (await session.exec(select(Policy.id, Policy.policy_number).where(
        Policy.tenant_id == tenant_id, Policy.master_policy_id.is_(None)))).all()   # type: ignore[union-attr]
    report = {"scanned": 0, "opened": [], "skipped": [], "notices_sent": 0, "dry_run": body.dry_run}
    # Work from ids: a rollback after one policy expires every loaded object, so each
    # iteration re-fetches its own policy instead of touching stale instances.
    for policy_id, policy_number in rows:
        policy = await session.get(Policy, policy_id)
        if policy is None or _st(policy) not in eng.IN_FORCE:
            continue
        report["scanned"] += 1
        try:
            await session.refresh(policy, with_for_update=True)
            plan = await eng.plan_for_policy(session, policy)
            tm, elig = plan["timing"], plan["eligibility"]
            if not plan["due_date"] or not elig["eligible"] or tm["state"] == "Upcoming":
                report["skipped"].append({"policy_number": policy_number,
                                          "reason": elig["message"] if not elig["eligible"] else "Renewal window not open yet"})
                await session.rollback()
                continue
            entry = {"policy_number": policy_number, "due_date": plan["due_date"].isoformat(),
                     "renewal_type": plan["renewal_type"], "amount": plan["amount"]}
            if body.dry_run:
                report["opened"].append(entry)
                await session.rollback()
                continue
            case, events = await _create_case(session, policy, plan, actor, "Sweep")
            if body.send_notices and case.status == "Open":
                try:
                    ev, _ = await _send_notice(session, policy, case, None, actor)
                    events.append(ev)
                    report["notices_sent"] += 1
                except HTTPException as exc:
                    entry["notice_error"] = exc.detail
            await session.commit()
            await _publish(request, policy, events)
            entry["renewal_no"] = case.renewal_no
            report["opened"].append(entry)
        except Exception as exc:   # one bad policy must not stop the sweep
            await session.rollback()
            log.exception("Renewal sweep failed for policy %s", policy_id)
            report["skipped"].append({"policy_number": policy_number, "reason": f"error: {exc}"})
    return report
