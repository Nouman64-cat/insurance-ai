"""
Renewal scheduler — runs daily inside the uvicorn process.

Multi-worker safety (Refinement 1):
  Uses PostgreSQL pg_try_advisory_lock(42) so only ONE worker executes the
  batch when --workers > 1. The lock is automatically released when the
  connection closes (end of the async with block), so no cleanup is needed.
  Combined with --workers 1 in the Dockerfile (documented in migrate.py) this
  gives two independent guards against duplicate job execution.

Grace period (Refinement Q4):
  GRACE_PERIOD_DAYS is read from the environment (default: 30), not hardcoded.
  P&C products can override to 14 days without code changes.

State transitions managed:
  ACTIVE      → GRACE_PERIOD  when expiry_date passes without a bound renewal
  GRACE_PERIOD → LAPSED        when grace_period_end_date passes
  Creates RenewalTransaction(INITIATED) at 90d and 30d before expiry
"""

import asyncio
import logging
from datetime import date, datetime, timedelta

from sqlalchemy import text
from sqlmodel import select

from services.pricing_engine import GRACE_PERIOD_DAYS

log = logging.getLogger("renewal-scheduler")

# Arbitrary non-conflicting integer key for the advisory lock.
# Choose a value outside the range used by other subsystems in your org.
_ADVISORY_LOCK_KEY = 420_001


async def _run_renewal_job() -> None:
    """Single execution of the renewal batch with multi-worker advisory lock."""
    try:
        from database import _session_factory
        from shared.models.core import (
            Policy, PolicyStatusEnum,
            RenewalTransaction, RenewalStatusEnum, Claim,
        )

        async with _session_factory() as session:
            # ── Advisory lock: bail out if another worker is already running ──
            lock_result = await session.exec(
                text(f"SELECT pg_try_advisory_lock({_ADVISORY_LOCK_KEY})")  # type: ignore
            )
            acquired = lock_result.scalar()
            if not acquired:
                log.info("Renewal job skipped — lock held by another worker")
                return

            try:
                await _process_renewals(session)
            finally:
                # Release immediately so next scheduled run can acquire it
                await session.exec(
                    text(f"SELECT pg_advisory_unlock({_ADVISORY_LOCK_KEY})")  # type: ignore
                )

    except Exception as exc:
        log.error("Renewal scheduler error: %s", exc, exc_info=True)


async def _process_renewals(session) -> None:
    from shared.models.core import (
        Policy, PolicyStatusEnum,
        RenewalTransaction, RenewalStatusEnum, Claim,
    )

    today = date.today()

    # Fetch all non-terminal policies; filter in Python to avoid VARCHAR/enum
    # cast errors (documented in migrate.py v7a).
    all_res = await session.exec(select(Policy))
    all_policies = list(all_res.all())

    def st(p):
        return p.status.value if hasattr(p.status, "value") else str(p.status)

    active_policies = [p for p in all_policies if st(p) == "Active"]
    grace_policies  = [p for p in all_policies if st(p) == "GracePeriod"]

    # ── 1. ACTIVE → GRACE_PERIOD  ─────────────────────────────────────────────
    for policy in active_policies:
        if not policy.expiry_date:
            continue

        days_left = (policy.expiry_date - today).days

        if days_left > 0:
            # Upcoming renewal: create INITIATED transaction at 90d and 30d
            if days_left in (90, 30):
                existing = await session.exec(
                    select(RenewalTransaction).where(
                        RenewalTransaction.policy_id == policy.id,
                    )
                )
                existing_statuses = [
                    (r.status.value if hasattr(r.status, "value") else str(r.status))
                    for r in existing.all()
                ]
                if "Initiated" not in existing_statuses:
                    claims_res = await session.exec(
                        select(Claim).where(Claim.policy_id == policy.id)
                    )
                    claims_count = len(list(claims_res.all()))

                    rt_res = await session.exec(
                        select(RenewalTransaction).where(RenewalTransaction.policy_id == policy.id)
                    )
                    renewal_year = len(list(rt_res.all())) + 2

                    session.add(RenewalTransaction(
                        policy_id=policy.id,
                        renewal_year=renewal_year,
                        status=RenewalStatusEnum.INITIATED,
                        claims_count=claims_count,
                        is_stp=claims_count == 0,
                    ))
                    log.info(
                        "RenewalTransaction INITIATED — policy=%s days_left=%d",
                        policy.policy_number, days_left,
                    )
        else:
            # Expiry date has passed — move to GRACE_PERIOD
            policy.status = PolicyStatusEnum.GRACE_PERIOD
            if not policy.grace_period_end_date:
                policy.grace_period_end_date = (
                    policy.expiry_date + timedelta(days=GRACE_PERIOD_DAYS)
                )
            policy.updated_at = datetime.utcnow()
            session.add(policy)
            log.info("Policy %s → GRACE_PERIOD (expired %s)", policy.policy_number, policy.expiry_date)

    # ── 2. GRACE_PERIOD → LAPSED ──────────────────────────────────────────────
    for policy in grace_policies:
        if not policy.grace_period_end_date or today <= policy.grace_period_end_date:
            continue

        policy.status = PolicyStatusEnum.LAPSED
        policy.updated_at = datetime.utcnow()
        session.add(policy)

        # Close any open renewal transactions
        rt_res = await session.exec(
            select(RenewalTransaction).where(RenewalTransaction.policy_id == policy.id)
        )
        for rt in rt_res.all():
            rt_st = rt.status.value if hasattr(rt.status, "value") else str(rt.status)
            if rt_st in ("Initiated", "Quoted", "UnderwritingReview"):
                rt.status = RenewalStatusEnum.LAPSED
                rt.lapsed_at = datetime.utcnow()
                session.add(rt)

        log.info(
            "Policy %s → LAPSED (grace ended %s)",
            policy.policy_number, policy.grace_period_end_date,
        )

    await session.commit()


# ── Asyncio loop ──────────────────────────────────────────────────────────────

def start_renewal_scheduler(stop_event: asyncio.Event) -> asyncio.Task:
    """
    Start a lightweight asyncio-based daily scheduler.
    The pg_try_advisory_lock inside _run_renewal_job() ensures only one
    worker executes the batch even if --workers > 1 is accidentally set.

    Returns the background task so the lifespan can await it on shutdown.
    """
    async def _loop() -> None:
        log.info(
            "Renewal scheduler started (24h interval, GRACE_PERIOD_DAYS=%d, "
            "advisory_lock_key=%d)",
            GRACE_PERIOD_DAYS, _ADVISORY_LOCK_KEY,
        )
        while not stop_event.is_set():
            await _run_renewal_job()
            # Poll stop_event every 60s so shutdown is fast
            for _ in range(24 * 60):
                if stop_event.is_set():
                    break
                await asyncio.sleep(60)
        log.info("Renewal scheduler stopped")

    return asyncio.create_task(_loop())
