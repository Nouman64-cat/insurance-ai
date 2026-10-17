"""Publish case events (insurance.case.events.v1) for things that happen
outside a staff member's own session — the customer submitting their
e-application, the panel clinic completing a medical. api-gateway's
case_event_hub pushes them to connected browsers over SSE so the copilot can
move the workflow forward on its own.

Best-effort by design: callers publish AFTER their own commit, and a Kafka
hiccup must never fail the customer's/clinic's request.
"""

import logging
from typing import Optional
from uuid import UUID

from fastapi import Request
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.events.kafka_events import CASE_EVENTS_TOPIC, CaseEvent, CaseEventPayload
from shared.models.core import Case, Customer

logger = logging.getLogger(__name__)


async def publish_case_event(
    request: Request,
    session: AsyncSession,
    *,
    event_type: str,
    tenant_id: UUID,
    case_id: UUID,
    customer_id: Optional[UUID] = None,
    detail: Optional[dict] = None,
) -> None:
    try:
        producer = getattr(request.app.state, "kafka_producer", None)
        if not producer:
            return
        case = await session.get(Case, case_id)
        customer = await session.get(Customer, customer_id) if customer_id else None
        event = CaseEvent(
            event_type=event_type,
            tenant_id=tenant_id,
            payload=CaseEventPayload(
                case_id=case_id,
                case_number=case.caseNumber if case else None,
                customer_id=customer_id,
                customer_name=customer.name if customer else None,
                detail=detail,
            ),
        )
        await producer.send_and_wait(CASE_EVENTS_TOPIC, value=event.model_dump_json(), key=str(tenant_id))
    except Exception:
        logger.exception("Failed to publish %s | case_id=%s", event_type, case_id)


async def publish_data_changed(producer, *, tenant_id: UUID, resource: str, method: str) -> None:
    """Generic "something under /tenants/{id}/<resource> was written" event for
    live clients. Fire-and-forget, never raises (see the middleware in main.py)."""
    try:
        event = CaseEvent(
            event_type="DataChanged",
            tenant_id=tenant_id,
            payload=CaseEventPayload(detail={"resource": resource, "method": method}),
        )
        await producer.send_and_wait(CASE_EVENTS_TOPIC, value=event.model_dump_json(), key=str(tenant_id))
    except Exception:
        logger.exception("Failed to publish DataChanged | resource=%s", resource)
