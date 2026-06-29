"""
OCR Worker — Kafka consumer daemon for async artifact processing.

Lifecycle
---------
1. Poll insurance.artifact.ocr.requested.v1 (group: tenant-service-ocr-group).
2. Deserialise ArtifactOCRRequestedEvent.
3. Download the file from S3 using the s3_key in the event payload.
4. POST the bytes to the OCR engine /extract endpoint.
5. Update the artifacts row with ocr_result, confidence score, and final status.
6. Commit the Kafka offset only after a successful DB write (at-least-once).

If OCR fails (engine down, timeout, bad file) the artifact is marked
"Re-submission Requested" with confidence 0.0 — the offset is still committed
so a permanently broken file never blocks the partition.

If the DB write itself fails the offset is NOT committed, so the message will
be reprocessed after a worker restart.
"""

import asyncio
import logging
import os

import boto3
import httpx
from aiokafka import AIOKafkaConsumer
from pydantic import ValidationError
from sqlmodel.ext.asyncio.session import AsyncSession

from database import _session_factory
from shared.events.kafka_events import ArtifactOCRRequestedEvent
from shared.models.core import Artifact

logger = logging.getLogger("tenant-service.ocr-worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ── Config ─────────────────────────────────────────────────────────────────────

KAFKA_BOOTSTRAP  = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092")
CONSUMER_GROUP   = "tenant-service-ocr-group"
INBOUND_TOPIC    = "insurance.artifact.ocr.requested.v1"

_OCR_URL    = os.getenv("OCR_ENGINE_URL", "http://ocr-engine:8004")
_S3_BUCKET  = os.getenv("S3_BUCKET_NAME", "insurance-ai-dev")
_AWS_REGION = os.getenv("AWS_REGION", "us-east-1")


# ── S3 helpers ─────────────────────────────────────────────────────────────────

def _s3_client():
    return boto3.client(
        "s3",
        region_name=_AWS_REGION,
        aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
    )


def _download_from_s3(key: str) -> bytes:
    try:
        # Check if dummy credentials are used to avoid slow timeout
        access_key = os.getenv("AWS_ACCESS_KEY_ID", "")
        if not access_key or "your_aws_access_key" in access_key:
            raise ValueError("Dummy AWS credentials detected")

        resp = _s3_client().get_object(Bucket=_S3_BUCKET, Key=key)
        return resp["Body"].read()
    except Exception as exc:
        local_path = os.path.join("/app/shared/storage", key)
        if os.path.exists(local_path):
            logger.info("S3 download failed (%s). Found file in local storage fallback: %s", exc, local_path)
            with open(local_path, "rb") as f:
                return f.read()
        raise exc


# ── OCR helper ─────────────────────────────────────────────────────────────────

async def _run_ocr(file_bytes: bytes, file_name: str, mime_type: str) -> str:
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{_OCR_URL}/extract",
            files={"file": (file_name, file_bytes, mime_type)},
        )
        resp.raise_for_status()
        return resp.json().get("extracted_text", "")


def _confidence(ocr_text: str) -> float:
    if not ocr_text or not ocr_text.strip():
        return 0.1
    n = len(ocr_text.strip())
    if n > 200:
        return 0.9
    if n > 50:
        return 0.7
    return 0.5


# ── Core processing ─────────────────────────────────────────────────────────────

async def _process(event: ArtifactOCRRequestedEvent) -> None:
    p = event.payload

    # 1. Download from S3
    loop = asyncio.get_running_loop()
    try:
        file_bytes: bytes = await loop.run_in_executor(
            None, lambda: _download_from_s3(p.s3_key)
        )
    except Exception as exc:
        logger.error("S3 download failed | artifact=%s key=%s error=%s", p.artifact_id, p.s3_key, exc)
        await _update_artifact(p.artifact_id, "", 0.0, "Re-submission Requested")
        return

    # 2. Call OCR engine
    ocr_text = ""
    try:
        ocr_text = await _run_ocr(file_bytes, p.file_name, p.mime_type)
        logger.info("OCR done | artifact=%s chars=%d", p.artifact_id, len(ocr_text))
    except Exception as exc:
        logger.exception("OCR engine error | artifact=%s", p.artifact_id)

    # 3. Derive confidence + status
    confidence = _confidence(ocr_text)
    final_status = "Accepted" if confidence >= 0.7 else "Re-submission Requested"

    # 4. Persist result
    await _update_artifact(p.artifact_id, ocr_text, confidence, final_status)


async def _update_artifact(artifact_id, ocr_text: str, confidence: float, status: str) -> None:
    from uuid import UUID
    async with _session_factory() as session:
        artifact = await session.get(Artifact, UUID(str(artifact_id)))
        if artifact is None:
            logger.error("artifact not found in DB | id=%s", artifact_id)
            return
        artifact.ocr_result = ocr_text
        artifact.ocr_confidence_score = confidence
        artifact.status = status
        session.add(artifact)
        await session.commit()
    logger.info("artifact updated | id=%s status=%s confidence=%.2f", artifact_id, status, confidence)


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
    logger.info("OCR worker started — polling %s", INBOUND_TOPIC)

    try:
        async for msg in consumer:
            if stop_event and stop_event.is_set():
                break

            logger.info("received | partition=%s offset=%s", msg.partition, msg.offset)

            # Deserialise
            try:
                event = ArtifactOCRRequestedEvent.model_validate_json(msg.value)
            except ValidationError as exc:
                logger.error("invalid event schema, skipping | error=%s", exc)
                await consumer.commit()
                continue

            # Process — OCR failures are handled inside _process; only DB failures propagate
            try:
                await _process(event)
            except Exception as exc:
                # DB write failed — do NOT commit; retry on next worker restart
                logger.exception(
                    "DB update failed, will retry | artifact=%s error=%s",
                    event.payload.artifact_id,
                    exc,
                )
                continue

            await consumer.commit()

    finally:
        await consumer.stop()
        logger.info("OCR worker shut down cleanly")


# ── FastAPI lifespan helper ─────────────────────────────────────────────────────

def start_ocr_worker(stop_event: asyncio.Event) -> asyncio.Task:
    return asyncio.create_task(run_consumer(stop_event), name="ocr-worker")
