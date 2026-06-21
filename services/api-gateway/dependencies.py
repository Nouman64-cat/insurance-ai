"""
Reusable FastAPI dependencies for the API Gateway.

  get_tenant_id  — extracts and type-validates the X-Tenant-Id header.
                   Every route that touches the database must declare this
                   dependency to enforce per-tenant data isolation.

  get_settings   — returns a cached Settings object read from env vars.
                   Use this instead of os.environ.get() in route handlers
                   so the values can be overridden in tests.
"""

import os
from functools import lru_cache
from uuid import UUID

from fastapi import Header, HTTPException, Request, status
from aiokafka import AIOKafkaProducer


# ─────────────────────────────────────────────────────────────────────────────
# Settings
# ─────────────────────────────────────────────────────────────────────────────

class Settings:
    risk_engine_url: str = os.environ.get(
        "RISK_ENGINE_URL", "http://risk-engine:8002"
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


# ─────────────────────────────────────────────────────────────────────────────
# Tenant identity
# ─────────────────────────────────────────────────────────────────────────────

async def get_kafka_producer(request: Request) -> AIOKafkaProducer:
    """Inject the shared AIOKafka producer from app.state into route handlers."""
    return request.app.state.kafka_producer


async def get_tenant_id(
    x_tenant_id: UUID = Header(
        ...,
        description=(
            "UUID of the tenant making this request. "
            "Must match an existing row in the `tenants` table."
        ),
    ),
) -> UUID:
    """
    Validates that the X-Tenant-Id header is present and is a well-formed UUID.
    FastAPI raises HTTP 422 automatically if the value cannot be parsed as UUID.

    The returned UUID is passed to route handlers as `tenant_id` and applied
    as a WHERE clause on every database query to enforce multi-tenant isolation.
    """
    return x_tenant_id
