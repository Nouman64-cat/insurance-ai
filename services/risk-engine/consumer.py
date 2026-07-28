"""
Risk Engine — Kafka consumer/producer daemon.

Lifecycle
---------
1. Poll insurance.proposal.submitted.v1 (consumer group: risk-engine-group).
2. Deserialise the ProposalSubmittedEvent envelope.
3. Run the LangGraph risk workflow.
4. Publish a RiskEvaluatedEvent to insurance.risk.evaluated.v1.
5. Commit the offset only after a successful publish (at-least-once delivery).

Run standalone:
    python consumer.py

Or embed in the FastAPI lifespan (optional) by calling start_consumer_task().
"""

import asyncio
import logging
import os
import signal
from typing import Any, Dict

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from aiokafka.errors import KafkaConnectionError
from pydantic import ValidationError

from graph_writer import write_customer_to_graph
from workflow import run_evaluation

from shared.events.kafka_events import (
    ProposalSubmittedEvent,
    RiskEvaluatedEvent,
    RiskEvaluatedPayload,
    RiskScores,
)

logger = logging.getLogger("risk-engine.consumer")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ── Config ────────────────────────────────────────────────────────────────────

KAFKA_BOOTSTRAP   = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
CONSUMER_GROUP    = "risk-engine-group"
INBOUND_TOPIC     = "insurance.proposal.submitted.v1"
OUTBOUND_TOPIC    = "insurance.risk.evaluated.v1"

# ─────────────────────────────────────────────────────────────────────────────
# Core processing
# ─────────────────────────────────────────────────────────────────────────────

def _coerce_reasons(raw: list) -> list[str]:
    """Ensure every item in the AI's 'reasons' list is a plain string.

    The LLM occasionally returns a list of dicts like:
        {"parameter": "Age", "observation": "...", "risk_rating": "Low"}
    instead of a list of strings.  This helper normalises both formats so
    RiskEvaluatedPayload(reasons: list[str]) never fails validation.
    """
    out: list[str] = []
    for item in raw:
        if isinstance(item, str):
            out.append(item)
        elif isinstance(item, dict):
            param = item.get("parameter", "")
            obs   = item.get("observation", "")
            rating = item.get("risk_rating", "")
            parts = [p for p in [param, obs] if p]
            text  = ": ".join(parts) if parts else str(item)
            if rating:
                text += f" (risk rating: {rating})"
            out.append(text)
        else:
            out.append(str(item))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Core processing
# ─────────────────────────────────────────────────────────────────────────────

async def _process(
    event: ProposalSubmittedEvent,
    producer: AIOKafkaProducer,
) -> None:
    """Run the workflow for one event and publish the result."""

    customer = event.payload.customer.model_dump()
    policy    = event.payload.policy.model_dump()
    tenant_id = str(event.tenant_id)

    # Run the synchronous LangGraph workflow off the event loop.
    loop = asyncio.get_running_loop()
    result: Dict[str, Any] = await loop.run_in_executor(
        None, run_evaluation, customer, policy, tenant_id
    )

    # Fire-and-forget: persist the evaluated customer into Memgraph before
    # publishing. Runs in an executor and swallows its own errors so a Memgraph
    # outage never blocks the Kafka publish.
    if result.get("is_valid", False):
        await loop.run_in_executor(
            None,
            lambda: write_customer_to_graph(
                cnic              = customer.get("cnic", ""),
                tenant_id         = tenant_id,
                occupation        = customer.get("occupation", ""),
                declared_income   = float(customer.get("declared_income", 0)),
                coverage_amount   = float(policy.get("coverage_amount", 0)),
                medical_score     = int(result.get("medical_score", 0)),
                financial_score   = int(result.get("financial_score", 0)),
                fraud_probability = float(result.get("fraud_probability", 0.0)),
            ),
        )

    result_event = RiskEvaluatedEvent(
        correlation_id=event.event_id,
        payload=RiskEvaluatedPayload(
            proposal_id=event.payload.proposal_id,
            scores=RiskScores(
                medical_score=result["medical_score"],
                financial_score=result["financial_score"],
                fraud_probability=result["fraud_probability"],
                composite_risk_score=result["composite_risk_score"],
            ),
            ai_decision=result["ai_decision"],
            reasons=_coerce_reasons(result.get("reasons", [])),
        ),
    )

    # Key by correlation_id so the gateway can route replies to the right waiter.
    await producer.send_and_wait(
        OUTBOUND_TOPIC,
        value=result_event.model_dump_json(),
        key=str(event.event_id),
    )

    logger.info(
        "published RiskEvaluated | proposal=%s correlation=%s decision=%s",
        event.payload.proposal_id,
        event.event_id,
        result["ai_decision"],
    )


# ─────────────────────────────────────────────────────────────────────────────
# Consumer loop
# ─────────────────────────────────────────────────────────────────────────────

async def run_consumer(stop_event: asyncio.Event | None = None) -> None:
    """
    Poll INBOUND_TOPIC until stop_event is set (or forever if None).

    Offsets are committed manually after a successful publish so a crash
    before publishing causes the message to be reprocessed (at-least-once).
    """
    consumer = AIOKafkaConsumer(
        INBOUND_TOPIC,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id=CONSUMER_GROUP,
        # Start from the beginning on first run; resume from committed on restart.
        auto_offset_reset="earliest",
        # Manual offset control — commit only after successful downstream publish.
        enable_auto_commit=False,
        value_deserializer=lambda raw: raw.decode("utf-8"),
    )

    producer = AIOKafkaProducer(
        bootstrap_servers=KAFKA_BOOTSTRAP,
        value_serializer=lambda v: v.encode("utf-8"),
        key_serializer=lambda k: k.encode("utf-8") if k else None,
        acks="all",
        enable_idempotence=True,
    )

    retries = 30
    delay = 2
    for attempt in range(1, retries + 1):
        try:
            logger.info(f"Starting Kafka consumer & producer at {KAFKA_BOOTSTRAP} (attempt {attempt}/{retries})...")
            await consumer.start()
            try:
                await producer.start()
                logger.info("Successfully connected consumer and producer to Kafka.")
                break
            except Exception as prod_err:
                await consumer.stop()
                raise prod_err
        except (KafkaConnectionError, Exception) as e:
            if attempt == retries:
                logger.error(f"Failed to start consumer/producer after {retries} attempts: {e}")
                raise e
            logger.warning(f"Kafka connection attempt {attempt} failed, retrying in {delay}s...")
            await asyncio.sleep(delay)

    logger.info("consumer started — polling %s", INBOUND_TOPIC)

    try:
        # getmany(timeout_ms=...) returns (possibly empty) on a bounded wait,
        # unlike `async for msg in consumer` which blocks indefinitely for the
        # next message. That's what lets this loop notice stop_event promptly
        # even when the topic is idle — required for --reload (or any embedder
        # calling start_consumer_task) to ever be able to tear this down.
        while not (stop_event and stop_event.is_set()):
            batches = await consumer.getmany(timeout_ms=1000)
            for msgs in batches.values():
                for msg in msgs:
                    logger.info(
                        "received message | partition=%s offset=%s",
                        msg.partition,
                        msg.offset,
                    )

                    # ── Deserialise ───────────────────────────────────────────
                    try:
                        event = ProposalSubmittedEvent.model_validate_json(msg.value)
                    except ValidationError as exc:
                        # Poison-pill: log and skip — never block the partition.
                        logger.error("invalid event schema, skipping | error=%s", exc)
                        await consumer.commit()
                        continue

                    # ── Process + publish ─────────────────────────────────────
                    try:
                        await _process(event, producer)
                    except Exception as exc:
                        # Do NOT commit — retry on next consumer restart.
                        logger.exception(
                            "processing failed, offset will be retried | event_id=%s error=%s",
                            event.event_id,
                            exc,
                        )
                        continue

                    # ── Commit only after successful publish ──────────────────
                    await consumer.commit()

    finally:
        await consumer.stop()
        await producer.stop()
        logger.info("consumer shut down cleanly")


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI lifespan helper (optional embedding)
# ─────────────────────────────────────────────────────────────────────────────

def start_consumer_task(stop_event: asyncio.Event) -> asyncio.Task:
    """
    Spawn the consumer as a background asyncio task — call from a FastAPI lifespan.

    Example
    -------
    @asynccontextmanager
    async def lifespan(app):
        stop = asyncio.Event()
        task = start_consumer_task(stop)
        yield
        stop.set()
        await task
    """
    return asyncio.create_task(run_consumer(stop_event), name="kafka-consumer")


# ─────────────────────────────────────────────────────────────────────────────
# Standalone entry point
# ─────────────────────────────────────────────────────────────────────────────

async def _main() -> None:
    stop = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    await run_consumer(stop)


if __name__ == "__main__":
    asyncio.run(_main())
