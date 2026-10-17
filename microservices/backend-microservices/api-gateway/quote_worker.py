"""
Quote Worker — Kafka consumer daemon for background quotation generation.

Lifecycle
---------
1. Poll insurance.customer.created.v1 (group: api-gateway-quote-worker-group).
2. Deserialise CustomerCreatedEvent.
3. Look up the tenant's active, individually-underwritten InsurancePlans
   (GROUP_LIFE and CHILD_EDUCATION_MARRIAGE are skipped — the former is priced
   per-MasterPolicy, the latter needs dependent details this event doesn't
   carry).
4. For each plan the customer is age-eligible for, pick a default coverage
   amount and term within the plan's bands and price it via
   shared.pricing.calculator — the same math POST /quote uses.
5. Persist one Policy + PremiumQuote pair per eligible plan, so the
   Quotation page has offers ready the moment the customer is created.
6. Commit the Kafka offset only after a successful DB write (at-least-once).

An customer who doesn't qualify for any plan simply gets zero quotes —
this is an enhancement, not a hard requirement, so it never blocks or fails
customer creation itself (see routers/customers.py in tenant-service).
"""

import asyncio
import logging
import os
from datetime import date

from aiokafka import AIOKafkaConsumer
from pydantic import ValidationError
from sqlmodel import select

from database import _session_factory
from shared.events.kafka_events import CUSTOMER_CREATED_TOPIC, CustomerCreatedEvent
from shared.models.core import Customer, InsurancePlan, InsuranceTypeEnum, PlanStatusEnum, Policy, PremiumQuote
from shared.pricing.calculator import PremiumBreakdown, calculate_premium

logger = logging.getLogger("api-gateway.quote-worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ── Config ─────────────────────────────────────────────────────────────────────

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
CONSUMER_GROUP  = "api-gateway-quote-worker-group"
INBOUND_TOPIC   = CUSTOMER_CREATED_TOPIC

# Plans that can't be auto-quoted from an CustomerCreated event alone:
# GROUP_LIFE is priced per-MasterPolicy, CHILD_EDUCATION_MARRIAGE needs
# dependent_name/dependent_dob which the customer record doesn't carry.
_SKIPPED_TYPES = {InsuranceTypeEnum.GROUP_LIFE, InsuranceTypeEnum.CHILD_EDUCATION_MARRIAGE}

# Default term (years) offered before clamping to the plan's own band /
# maturity-age limit — a reasonable mid-length policy, not a real quote
# request, since the customer hasn't chosen one yet.
_DEFAULT_TERM_YEARS = 15

# Default coverage multiple of annual income offered before clamping to the
# plan's max_income_multiple.
_DEFAULT_INCOME_MULTIPLE = 5.0


def _age_from_dob(dob: date) -> int:
    return (date.today() - dob).days // 365


def _default_coverage(annual_income: float, plan: InsurancePlan) -> float:
    multiple = min(_DEFAULT_INCOME_MULTIPLE, plan.max_income_multiple)
    return annual_income * multiple


def _default_term(age: int, plan: InsurancePlan) -> int | None:
    """Returns None if no term in the plan's band keeps the policy within
    max_maturity_age — i.e. the customer can't be quoted for this plan."""
    term = min(max(_DEFAULT_TERM_YEARS, plan.term_min_years), plan.term_max_years)
    if age + term > plan.max_maturity_age:
        term = plan.max_maturity_age - age
    if term < plan.term_min_years:
        return None
    return term


# ── Core processing ─────────────────────────────────────────────────────────────

async def _process(event: CustomerCreatedEvent) -> None:
    p = event.payload
    tenant_id = event.tenant_id
    dob = date.fromisoformat(p.dob)
    age = _age_from_dob(dob)

    async with _session_factory() as session:
        customer = await session.get(Customer, p.customer_id)
        if customer is None or customer.tenant_id != tenant_id:
            logger.warning("customer not found, skipping | customer_id=%s", p.customer_id)
            return

        plans = (
            await session.exec(
                select(InsurancePlan).where(
                    InsurancePlan.tenant_id == tenant_id,
                    InsurancePlan.status == PlanStatusEnum.ACTIVE,
                    InsurancePlan.is_active == True,  # noqa: E712
                )
            )
        ).all()

        # Many tenant catalogs carry several near-clone plans per insurance
        # type (same age band, rates, multiples — just different marketing
        # names). Quoting every one of them produces a wall of numerically
        # identical rows, so we only keep the cheapest eligible candidate per
        # insurance_type — one meaningfully distinct quote per product line.
        best_by_type: dict[InsuranceTypeEnum, tuple[InsurancePlan, int, float, PremiumBreakdown]] = {}

        for plan in plans:
            if plan.insurance_type in _SKIPPED_TYPES:
                continue
            if age < plan.entry_age_min or age > plan.entry_age_max:
                continue

            term = _default_term(age, plan)
            if term is None:
                continue

            coverage = _default_coverage(p.declared_income, plan)
            if coverage <= 0:
                continue

            breakdown = calculate_premium(
                coverage_amount=coverage,
                base_premium_rate=plan.base_premium_rate,
                smoker_factor=plan.smoker_factor,
                age=age,
                is_smoker=p.is_smoker,
                height_cm=p.height_cm,
                weight_kg=p.weight_kg,
            )

            current_best = best_by_type.get(plan.insurance_type)
            if current_best is None or breakdown.total_premium < current_best[3].total_premium:
                best_by_type[plan.insurance_type] = (plan, term, coverage, breakdown)

        for plan, term, coverage, breakdown in best_by_type.values():
            policy = Policy(
                tenant_id=tenant_id,
                customer_id=customer.id,
                product_name=plan.label,
                insurance_type=plan.insurance_type,
                coverage_amount=coverage,
                term_years=term,
            )
            session.add(policy)
            await session.flush()

            quote = PremiumQuote(
                tenant_id=tenant_id,
                policy_id=policy.id,
                base_premium=breakdown.base_premium,
                loading_applied=breakdown.loading_applied,
                total_premium=breakdown.total_premium,
                rate_version=plan.rate_version,
            )
            session.add(quote)

        await session.commit()
        logger.info(
            "quotes generated | customer_id=%s tenant_id=%s plans_checked=%d quotes=%d",
            p.customer_id, tenant_id, len(plans), len(best_by_type),
        )


# ── Consumer loop ───────────────────────────────────────────────────────────────

async def run_consumer(stop_event: asyncio.Event | None = None) -> None:
    consumer = AIOKafkaConsumer(
        INBOUND_TOPIC,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id=CONSUMER_GROUP,
        auto_offset_reset="earliest",
        enable_auto_commit=False,
        value_deserializer=lambda raw: raw.decode("utf-8"),
    )

    await consumer.start()
    logger.info("Quote worker started — polling %s", INBOUND_TOPIC)

    try:
        # getmany(timeout_ms=...) returns (possibly empty) on a bounded wait,
        # unlike `async for msg in consumer` which blocks indefinitely for the
        # next message. That's what lets this loop notice stop_event promptly
        # even when the topic is idle — required for --reload to ever be able
        # to tear this task down (see main.py's lifespan shutdown).
        while not (stop_event and stop_event.is_set()):
            batches = await consumer.getmany(timeout_ms=1000)
            for msgs in batches.values():
                for msg in msgs:
                    logger.info("received | partition=%s offset=%s", msg.partition, msg.offset)

                    try:
                        event = CustomerCreatedEvent.model_validate_json(msg.value)
                    except ValidationError as exc:
                        logger.error("invalid event schema, skipping | error=%s", exc)
                        await consumer.commit()
                        continue

                    try:
                        await _process(event)
                    except Exception as exc:
                        # DB write failed — do NOT commit; retry on next worker restart
                        logger.exception(
                            "quote generation failed, will retry | customer_id=%s error=%s",
                            event.payload.customer_id,
                            exc,
                        )
                        continue

                    await consumer.commit()

    finally:
        await consumer.stop()
        logger.info("Quote worker shut down cleanly")


# ── FastAPI lifespan helper ─────────────────────────────────────────────────────

def start_quote_worker(stop_event: asyncio.Event) -> asyncio.Task:
    return asyncio.create_task(run_consumer(stop_event), name="quote-worker")
