"""
Stage B recurring-premium billing — the single source of truth for a policy's
installment ledger, grace/lapse state, reminder cadence, receipts, late-payment
surcharge, agent commission and the collection dashboard.

Both the premiums UI (GET /premiums) and the collection / monitor endpoints in
post_issuance.py call ``compute_billing`` so the ledger the user sees and the
state the server acts on never drift apart. Router-free (mirrors onboarding_gate).

Per-installment derived state (status + today vs due_date):
  paid · waived · upcoming · due_soon (≤7d) · due_today · grace (overdue, within
  the grace window) · past_grace (overdue beyond grace → lapse-eligible).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from services.insurer_config import (
    AGENT_COMMISSION_PCT,
    LATE_PAYMENT_SURCHARGE_PCT,
    REMINDER_SCHEDULE,
)
from services.pricing_engine import GRACE_PERIOD_DAYS
from shared.models.core import (
    Policy,
    PolicyStatusEnum,
    PremiumReceipt,
    PremiumReminder,
    PremiumSchedule,
    PremiumScheduleStatusEnum,
)

IN_FORCE_STATUSES = frozenset({
    PolicyStatusEnum.ACTIVE.value,
    PolicyStatusEnum.GRACE_PERIOD.value,
})

DUE_SOON_DAYS = 7


def _v(x) -> str:
    return x.value if hasattr(x, "value") else str(x)


def _row_state(s: PremiumSchedule, today: date) -> str:
    st = _v(s.status)
    if st == PremiumScheduleStatusEnum.PAID.value:
        return "paid"
    if st == PremiumScheduleStatusEnum.WAIVED.value:
        return "waived"
    if s.due_date > today:
        return "due_soon" if (s.due_date - today).days <= DUE_SOON_DAYS else "upcoming"
    if s.due_date == today:
        return "due_today"
    return "grace" if today <= s.due_date + timedelta(days=GRACE_PERIOD_DAYS) else "past_grace"


def surcharge_for(base: float, state: str) -> float:
    """Late-payment surcharge only applies once an installment is overdue."""
    if state in ("grace", "past_grace"):
        return round(base * LATE_PAYMENT_SURCHARGE_PCT / 100.0, 2)
    return 0.0


def _reminder_plan(s: PremiumSchedule, today: date, sent_kinds: set[str]) -> list[dict]:
    """The T-7 / T-0 / T+3 / T+7 cadence for one installment with sent/due flags."""
    plan = []
    for r in REMINDER_SCHEDULE:
        when = s.due_date + timedelta(days=r["offset"])
        plan.append({
            "key": r["key"], "kind": r["kind"], "label": r["label"],
            "date": when.isoformat(),
            "due": today >= when,
            "sent": r["kind"] in sent_kinds,
        })
    return plan


def _row_dict(s: PremiumSchedule, today: date, sent_kinds: set[str], receipt: PremiumReceipt | None) -> dict:
    state = _row_state(s, today)
    outstanding = round(max(s.amount_due - s.amount_paid, 0.0), 2)
    surcharge = surcharge_for(s.amount_due, state)
    return {
        "id": str(s.id),
        "installment_no": s.installment_no,
        "billing_frequency": _v(s.billing_frequency),
        "due_date": s.due_date.isoformat(),
        "amount_due": s.amount_due,
        "amount_paid": s.amount_paid,
        "outstanding": outstanding,
        "surcharge": surcharge,
        "payable": round(outstanding + surcharge, 2),
        "status": _v(s.status),
        "state": state,
        "days_until": (s.due_date - today).days,
        "reminder_count": s.reminder_count,
        "last_reminder_at": s.last_reminder_at.isoformat() if s.last_reminder_at else None,
        "reminder_plan": _reminder_plan(s, today, sent_kinds),
        "paid_at": s.paid_at.isoformat() if s.paid_at else None,
        "payment_reference": s.payment_reference,
        "receipt": ({"id": str(receipt.id), "receipt_no": receipt.receipt_no,
                     "total_amount": receipt.total_amount, "method": receipt.method} if receipt else None),
    }


async def compute_billing(session: AsyncSession, policy: Policy) -> dict:
    today = date.today()
    rows = (await session.exec(
        select(PremiumSchedule).where(PremiumSchedule.policy_id == policy.id)
    )).all()
    rows = sorted(rows, key=lambda s: (s.due_date, s.installment_no))

    receipts = (await session.exec(
        select(PremiumReceipt).where(PremiumReceipt.policy_id == policy.id)
    )).all()
    reminders = (await session.exec(
        select(PremiumReminder).where(PremiumReminder.policy_id == policy.id)
    )).all()

    receipt_by_sched = {r.schedule_id: r for r in receipts if r.schedule_id}
    sent_kinds_by_sched: dict = {}
    for rem in reminders:
        sent_kinds_by_sched.setdefault(rem.schedule_id, set()).add(rem.kind)

    unpaid = [s for s in rows if _v(s.status) in
              (PremiumScheduleStatusEnum.PENDING.value, PremiumScheduleStatusEnum.OVERDUE.value)]
    arrears = [s for s in unpaid if s.due_date < today]
    next_due = min(unpaid, key=lambda s: s.due_date) if unpaid else None
    earliest_arrear = min(arrears, key=lambda s: s.due_date) if arrears else None

    grace_until = (earliest_arrear.due_date + timedelta(days=GRACE_PERIOD_DAYS)) if earliest_arrear else None
    in_grace = bool(grace_until and today <= grace_until)
    lapse_due = bool(grace_until and today > grace_until)

    total_outstanding = round(sum(max(s.amount_due - s.amount_paid, 0.0) for s in unpaid), 2)
    paid_count = sum(1 for s in rows if _v(s.status) == PremiumScheduleStatusEnum.PAID.value)

    # ── Collection dashboard ──────────────────────────────────────────────────
    month_start = today.replace(day=1)
    total_collected = round(sum(r.total_amount for r in receipts), 2)
    collected_this_month = round(sum(
        r.total_amount for r in receipts if r.created_at.date() >= month_start), 2)
    commission_earned = round(sum(r.commission_amount for r in receipts), 2)
    billable = [s for s in rows if _v(s.status) != PremiumScheduleStatusEnum.WAIVED.value]
    collection_rate = round(paid_count / len(billable) * 100, 1) if billable else 0.0

    return {
        "policy_id": str(policy.id),
        "policy_status": _v(policy.status),
        "can_collect": _v(policy.status) in IN_FORCE_STATUSES,
        "autopay_enabled": bool(getattr(policy, "autopay_enabled", False)),
        "surcharge_pct": LATE_PAYMENT_SURCHARGE_PCT,
        "commission_pct": AGENT_COMMISSION_PCT,
        "installments": [
            _row_dict(s, today, sent_kinds_by_sched.get(s.id, set()), receipt_by_sched.get(s.id))
            for s in rows
        ],
        "summary": {
            "total": len(rows),
            "paid": paid_count,
            "outstanding_count": len(unpaid),
            "arrears_count": len(arrears),
            "total_outstanding": total_outstanding,
            "next_due_date": next_due.due_date.isoformat() if next_due else None,
            "next_due_amount": (round(next_due.amount_due - next_due.amount_paid, 2)) if next_due else None,
            "in_grace": in_grace,
            "grace_until": grace_until.isoformat() if grace_until else None,
            "grace_days_left": (grace_until - today).days if in_grace else None,
            "lapse_due": lapse_due,
        },
        "dashboard": {
            "total_collected": total_collected,
            "collected_this_month": collected_this_month,
            "overdue_amount": round(sum(s.amount_due - s.amount_paid for s in arrears), 2),
            "collection_rate": collection_rate,
            "commission_earned": commission_earned,
            "receipts_count": len(receipts),
        },
    }
