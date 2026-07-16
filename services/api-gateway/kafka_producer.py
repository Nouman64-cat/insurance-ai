"""
AIOKafka producer — created once at startup, stored on app.state.

Settings are read from environment variables so Docker Compose / Kubernetes
can inject them without code changes.
"""

import os

from aiokafka import AIOKafkaProducer
from fastapi import Request

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
PROPOSAL_TOPIC = "insurance.proposal.submitted.v1"


async def create_producer() -> AIOKafkaProducer:
    """Start and return a ready-to-use producer instance."""
    producer = AIOKafkaProducer(
        bootstrap_servers=KAFKA_BOOTSTRAP,
        # Serialise str → bytes at the transport layer so callers pass plain str.
        value_serializer=lambda v: v.encode("utf-8"),
        key_serializer=lambda k: k.encode("utf-8") if k else None,
        # Wait for all in-sync replicas before acknowledging — no silent data loss.
        acks="all",
        # Idempotent producer deduplicates retries at the broker level.
        enable_idempotence=True,
    )
    await producer.start()
    return producer


# ── FastAPI dependency ────────────────────────────────────────────────────────

async def get_kafka_producer(request: Request) -> AIOKafkaProducer:
    """Inject the shared producer from app.state into route handlers."""
    return request.app.state.kafka_producer
