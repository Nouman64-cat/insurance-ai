"""
Risk Result Worker — Kafka consumer daemon that lands async underwriting results.

Lifecycle
---------
1. Poll insurance.risk.evaluated.v1 (group: api-gateway-risk-result-group).
2. Deserialise RiskEvaluatedEvent.
3. Resolve the Customer / Policy / Case the API Gateway persisted before it
   published the proposal (their ids are echoed back on the payload).
4. Write the RiskAssessment and advance the policy/case, via the same
   risk_persistence.persist_assessment the streaming path uses.
5. Commit the Kafka offset only after a successful DB write (at-least-once).

Why this exists
---------------
`POST /evaluate` returns 202 and publishes to insurance.proposal.submitted.v1;
the Risk Engine consumer evaluates it and publishes a RiskEvaluatedEvent to
insurance.risk.evaluated.v1. Nothing subscribed to that topic, so the async path
computed a full underwriting result and threw it away — the documented
"downstream result consumer" was never written. This is that consumer.

Mirrors quote_worker.py's shape (same start/stop contract, same at-least-once
offset handling) so main.py's lifespan drives both identically.
"""

import asyncio
import logging
import os

from aiokafka import AIOKafkaConsumer
from aiokafka.errors import KafkaConnectionError
from pydantic import ValidationError
from sqlmodel import select

from database import _session_factory
from risk_persistence import persist_assessment
from shared.events.kafka_events import RISK_EVALUATED_TOPIC, RiskEvaluatedEvent
from shared.models.core import Case, Customer, Policy, RiskAssessment

logger = logging.getLogger("api-gateway.risk-result-worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ── Config ─────────────────────────────────────────────────────────────────────

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
CONSUMER_GROUP  = "api-gateway-risk-result-group"
INBOUND_TOPIC   = RISK_EVALUATED_TOPIC


# ─────────────────────────────────────────────────────────────────────────────
# Core processing
# ─────────────────────────────────────────────────────────────────────────────

async def _process(event: RiskEvaluatedEvent) -> None:
    """Persist one evaluated proposal. Raises on failure so the caller can
    withhold the offset commit and let the message be redelivered."""
    payload = event.payload

    if not payload.is_valid:
        logger.info(
            "skipping invalid proposal=%s — %s",
            payload.proposal_id, "; ".join(payload.validation_errors) or "no detail",
        )
        return

    if payload.tenant_id is None or payload.customer_id is None or payload.policy_id is None:
        # Emitted by a gateway older than the identity-carrying payload. There is
        # no safe way to guess which rows this belongs to, so drop it rather than
        # attach an assessment to the wrong customer.
        logger.warning(
            "proposal=%s carries no customer/policy identity — cannot persist "
            "(re-submit through the current gateway)", payload.proposal_id,
        )
        return

    async with _session_factory() as db:
        customer = await db.get(Customer, payload.customer_id)
        policy = await db.get(Policy, payload.policy_id)
        if customer is None or policy is None:
            logger.warning(
                "proposal=%s references a missing customer/policy — skipping",
                payload.proposal_id,
            )
            return
        if customer.tenant_id != payload.tenant_id or policy.tenant_id != payload.tenant_id:
            logger.warning("proposal=%s tenant mismatch — skipping", payload.proposal_id)
            return

        case = await db.get(Case, payload.case_id) if payload.case_id else None
        if case is not None and case.tenant_id != payload.tenant_id:
            case = None

        # At-least-once delivery means a redelivered message must not write a
        # second assessment. correlation_id is stable across redeliveries of the
        # same evaluation, so it is the idempotency key.
        already = (await db.exec(
            select(RiskAssessment).where(
                RiskAssessment.policy_id == policy.id,
                RiskAssessment.correlation_id == event.correlation_id,
            )
        )).first()
        if already is not None:
            logger.info("proposal=%s already persisted — skipping", payload.proposal_id)
            return

        scores = payload.scores
        assessment = await persist_assessment(
            db, payload.tenant_id,
            customer=customer,
            policy=policy,
            case=case,
            final_risk={
                "medical_score": scores.medical_score,
                "financial_score": scores.financial_score,
                "fraud_probability": scores.fraud_probability,
                "composite_risk_score": scores.composite_risk_score,
                "ai_decision": payload.ai_decision,
                "suggested_loading": payload.suggested_loading,
                "reasons": payload.reasons,
                "medical_reasons": payload.medical_reasons,
                "financial_reasons": payload.financial_reasons,
                "fraud_reasons": payload.fraud_reasons,
            },
        )
        assessment.correlation_id = event.correlation_id
        db.add(assessment)
        await db.commit()

    logger.info(
        "persisted RiskAssessment | proposal=%s policy=%s decision=%s loading=%s",
        payload.proposal_id, payload.policy_id, payload.ai_decision, payload.suggested_loading,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Consumer loop
# ─────────────────────────────────────────────────────────────────────────────

async def run_consumer(stop_event: asyncio.Event | None = None) -> None:
    """Poll INBOUND_TOPIC until stop_event is set (or forever if None).

    Offsets are committed manually after a successful DB write, so a crash
    mid-write causes the message to be reprocessed (at-least-once) — which the
    correlation_id guard in _process() makes safe.
    """
    consumer = AIOKafkaConsumer(
        INBOUND_TOPIC,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id=CONSUMER_GROUP,
        auto_offset_reset="earliest",
        enable_auto_commit=False,
        value_deserializer=lambda raw: raw.decode("utf-8"),
    )

    try:
        await consumer.start()
    except KafkaConnectionError as exc:
        # Kafka is optional in local/dev runs — the synchronous /evaluate/stream
        # path still works, so log and bow out rather than killing startup.
        logger.warning("risk result worker could not reach Kafka (%s) — not started", exc)
        return

    logger.info("risk result worker listening on %s", INBOUND_TOPIC)
    try:
        while stop_event is None or not stop_event.is_set():
            batch = await consumer.getmany(timeout_ms=1000)
            for _tp, messages in batch.items():
                for message in messages:
                    try:
                        event = RiskEvaluatedEvent.model_validate_json(message.value)
                    except ValidationError as exc:
                        # Malformed payloads can never succeed on redelivery —
                        # commit past them instead of blocking the partition.
                        logger.error("dropping unparseable RiskEvaluated event: %s", exc)
                        await consumer.commit()
                        continue
                    try:
                        await _process(event)
                    except Exception:       # noqa: BLE001 — retry on redelivery
                        logger.exception(
                            "failed to persist proposal=%s — offset not committed",
                            event.payload.proposal_id,
                        )
                        continue
                    await consumer.commit()
    finally:
        await consumer.stop()
        logger.info("risk result worker stopped")


def start_risk_result_worker(stop_event: asyncio.Event) -> asyncio.Task:
    """Launch the consumer as a background task (called from main.py lifespan)."""
    return asyncio.create_task(run_consumer(stop_event))


if __name__ == "__main__":
    asyncio.run(run_consumer())
