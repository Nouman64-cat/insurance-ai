"""
AIOKafka producer — created once at startup, stored on app.state.

Settings are read from environment variables so Docker Compose / Kubernetes
can inject them without code changes.
"""

import os
import logging
import asyncio

from aiokafka import AIOKafkaProducer
from aiokafka.errors import KafkaConnectionError
from fastapi import Request

logger = logging.getLogger("api-gateway.kafka_producer")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
PROPOSAL_TOPIC = "insurance.proposal.submitted.v1"


async def create_producer() -> AIOKafkaProducer:
    """Start and return a ready-to-use producer instance with retry logic."""
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
    
    retries = 30
    delay = 2
    for attempt in range(1, retries + 1):
        try:
            logger.info(f"Connecting to Kafka at {KAFKA_BOOTSTRAP} (attempt {attempt}/{retries})...")
            await producer.start()
            logger.info("Successfully connected to Kafka.")
            return producer
        except (KafkaConnectionError, Exception) as e:
            if attempt == retries:
                logger.error(f"Failed to connect to Kafka after {retries} attempts: {e}")
                raise e
            logger.warning(f"Kafka connection attempt {attempt} failed, retrying in {delay}s...")
            await asyncio.sleep(delay)



# ── FastAPI dependency ────────────────────────────────────────────────────────

async def get_kafka_producer(request: Request) -> AIOKafkaProducer:
    """Inject the shared producer from app.state into route handlers."""
    return request.app.state.kafka_producer
