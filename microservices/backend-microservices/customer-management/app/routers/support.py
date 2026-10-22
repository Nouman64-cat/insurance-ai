"""Support tickets for the signed-in customer. The tickets live in the Customer Service service: this router only identifies the
customer from the session, checks that a linked policy is theirs, and relays signed calls. The customer sees and writes only their
own tickets; staff-only notes never reach them."""
import json
import logging
import uuid
from typing import Any, Literal, Optional
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, ConfigDict, Field

from app import tenant_client
from app.accounts import Principal
from app.config import settings
from app.deps import current_customer
from app.errors import ApiError, not_found, unavailable, validation
from shared.security.service_auth import sign

log = logging.getLogger("customer-management.support")
router = APIRouter(prefix="/v1/support", tags=["Support"])
BASE = "/internal/v1/portal/tickets"
CATEGORIES = ("GENERAL", "POLICY_SERVICING", "BILLING", "CLAIM_ENQUIRY", "COMPLAINT", "DOCUMENTS")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


async def _call(p: Principal, method: str, path: str, body: Optional[dict] = None, operation_key: Optional[str] = None) -> Any:
    if not settings.support_key:
        raise ApiError(503, "SUPPORT_UNAVAILABLE", "Support tickets are not available right now.")
    data = json.dumps(body).encode() if body is not None else b""
    context = {"x-portal-tenant": str(p.tenant_id), "x-portal-customer": str(p.customer_id),
               "x-portal-name": (p.display_name or "Customer")[:120].encode("ascii", "ignore").decode() or "Customer"}
    if operation_key:
        context["Idempotency-Key"] = operation_key
    headers = {**sign(settings.support_key, method, path, data, caller="customer-management", bound_headers=context),
               "content-type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.request(method, settings.support_url + path, content=data, headers=headers)
    except httpx.HTTPError as exc:
        log.error("customer-service unreachable: %s", type(exc).__name__)
        raise unavailable() from exc
    if r.status_code == 404:
        raise not_found("Ticket")
    if r.status_code in (409, 422):
        detail = r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else None
        raise ApiError(r.status_code, "CONFLICT" if r.status_code == 409 else "VALIDATION", detail if isinstance(detail, str) else "The request could not be completed")
    if r.status_code >= 400:
        log.error("customer-service returned %s", r.status_code)
        raise unavailable()
    return r.json()


class TicketIn(Strict):
    title: str = Field(min_length=3, max_length=200)
    description: str = Field(min_length=10, max_length=5000)
    category: Literal["GENERAL", "POLICY_SERVICING", "BILLING", "CLAIM_ENQUIRY", "COMPLAINT", "DOCUMENTS"] = "GENERAL"
    policy_id: Optional[UUID] = None


class ReplyIn(Strict):
    body: str = Field(min_length=1, max_length=5000)


def _idem(key: Optional[str]) -> UUID:
    try:
        return uuid.UUID(key or "")
    except ValueError:
        raise ApiError(400, "IDEMPOTENCY_KEY_INVALID", "An Idempotency-Key header (a UUID) is required")


@router.get("/tickets")
async def list_tickets(p: Principal = Depends(current_customer)):
    return await _call(p, "GET", BASE)


@router.post("/tickets")
async def create_ticket(body: TicketIn, p: Principal = Depends(current_customer), idempotency_key: Optional[str] = Header(None)):
    key = _idem(idempotency_key)
    if body.policy_id:                       # must be one of this customer's own policies (404 otherwise, like anywhere else in the portal)
        c = tenant_client.get_client()
        await c.get(f"{c.scope(p.tenant_id, p.customer_id)}/policies/{body.policy_id}")
    return await _call(p, "POST", BASE, body.model_dump(mode="json", exclude_none=True), operation_key=str(key))


@router.get("/tickets/{ticket_id}")
async def ticket(ticket_id: UUID, p: Principal = Depends(current_customer)):
    return await _call(p, "GET", f"{BASE}/{ticket_id}")


@router.post("/tickets/{ticket_id}/reply")
async def reply(ticket_id: UUID, body: ReplyIn, p: Principal = Depends(current_customer), idempotency_key: Optional[str] = Header(None)):
    # Optional for older clients: a supplied key makes a retried reply the same reply (namespaced by account, bound into the signature).
    if idempotency_key and not (8 <= len(idempotency_key) <= 64 and all(ch.isalnum() or ch in "-_" for ch in idempotency_key)):
        raise ApiError(400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key must be 8-64 letters, digits, - or _")
    await _call(p, "POST", f"{BASE}/{ticket_id}/reply", body.model_dump(),
                operation_key=f"{p.account_id}:{idempotency_key}" if idempotency_key else None)
    return await _call(p, "GET", f"{BASE}/{ticket_id}")


@router.post("/tickets/{ticket_id}/withdraw")
async def withdraw(ticket_id: UUID, p: Principal = Depends(current_customer)):
    await _call(p, "POST", f"{BASE}/{ticket_id}/withdraw", {})
    return await _call(p, "GET", f"{BASE}/{ticket_id}")


@router.post("/tickets/{ticket_id}/reopen")
async def reopen(ticket_id: UUID, body: ReplyIn, p: Principal = Depends(current_customer)):
    await _call(p, "POST", f"{BASE}/{ticket_id}/reopen", body.model_dump())
    return await _call(p, "GET", f"{BASE}/{ticket_id}")
