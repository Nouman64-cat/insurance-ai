"""Signed calls to tenant-service's customer-portal adapter (routers/customer_portal_internal.py).

Customer Management never calls tenant-service's staff API and never forwards a customer token to it. Every request is
signed with CM_TO_TENANT_KEY and names the customer by (tenant_id, customer_id) taken from the signed-in ACCOUNT row —
never from the browser. tenant-service re-checks ownership of every object on its side.

`client` is a module-level instance so tests can replace it.
"""
import json
import logging
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import urlencode

import httpx

from app.config import settings
from app.errors import ApiError, not_found, unavailable
from shared.security.service_auth import sign

log = logging.getLogger("customer-management.tenant")
CALLER = "customer-management"
PREFIX = "/internal/customer-portal/v1"


@dataclass
class Upstream:
    status: int
    body: Any
    content: bytes = b""
    headers: Optional[dict] = None


def raise_for(resp: Upstream) -> None:
    """Turn an upstream refusal into a customer-safe ApiError. Upstream bodies are never passed through verbatim."""
    if resp.status < 400:
        return
    if resp.status == 404:
        raise not_found()
    if resp.status >= 500 or resp.status in (401, 403):
        log.error("tenant-service returned %s", resp.status)
        raise unavailable()
    detail = (resp.body or {}).get("detail") if isinstance(resp.body, dict) else None
    if isinstance(detail, dict) and detail.get("code"):
        extra = {k: v for k, v in detail.items() if k not in ("code", "message")}
        raise ApiError(409 if resp.status == 409 else resp.status, str(detail["code"]), str(detail.get("message") or "Request refused"), extra)
    message = detail if isinstance(detail, str) else "The request could not be completed"
    code = {402: "PAYMENT_DECLINED", 409: "CONFLICT", 413: "FILE_TOO_LARGE", 422: "VALIDATION"}.get(resp.status, "REJECTED")
    raise ApiError(resp.status if resp.status in (400, 402, 409, 413, 422) else 400, code, message)


class TenantClient:
    def __init__(self, base_url: Optional[str] = None, key: Optional[str] = None):
        self.base_url = (base_url or settings.tenant_service_url).rstrip("/")
        self.key = key if key is not None else settings.to_tenant_key
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0))

    def scope(self, tenant_id, customer_id) -> str:
        return f"{PREFIX}/tenants/{tenant_id}/customers/{customer_id}"

    async def _send(self, method: str, path: str, *, json_body: Any = None, files: Any = None, data: Any = None) -> Upstream:
        try:
            req = self._http.build_request(method, self.base_url + path, json=json_body, files=files, data=data)
            req.read()
            body = b"" if files is not None else (req.content if req.content else b"")  # multipart: signed with an empty body (see tenant-service)
            req.headers.update(sign(self.key, method, path, body, caller=CALLER))
            resp = await self._http.send(req)
        except (httpx.HTTPError, ValueError) as exc:
            log.error("tenant-service unreachable: %s", type(exc).__name__)
            raise unavailable() from exc
        ctype = resp.headers.get("content-type", "")
        parsed = None
        if ctype.startswith("application/json"):
            try:
                parsed = resp.json()
            except ValueError:
                parsed = None
        return Upstream(resp.status_code, parsed, resp.content, dict(resp.headers))

    async def get(self, path: str, **query: Any) -> Any:
        q = {k: v for k, v in query.items() if v is not None}
        resp = await self._send("GET", path + (f"?{urlencode(q)}" if q else ""))
        raise_for(resp)
        return resp.body

    async def post(self, path: str, payload: Any = None) -> Any:
        resp = await self._send("POST", path, json_body=payload if payload is not None else {})
        raise_for(resp)
        return resp.body

    async def patch(self, path: str, payload: Any) -> Any:
        resp = await self._send("PATCH", path, json_body=payload)
        raise_for(resp)
        return resp.body

    async def upload(self, path: str, filename: str, content: bytes, content_type: str, note: Optional[str]) -> Any:
        resp = await self._send("POST", path, files={"file": (filename, content, content_type)}, data={"note": note} if note else None)
        raise_for(resp)
        return resp.body

    async def download(self, path: str, **query: Any) -> Upstream:
        q = {k: v for k, v in query.items() if v is not None}
        resp = await self._send("GET", path + (f"?{urlencode(q)}" if q else ""))
        raise_for(resp)
        return resp

    async def legacy_accounts(self, offset: int, limit: int = 200) -> list[dict]:
        return await self.get(f"{PREFIX}/legacy-accounts", offset=offset, limit=limit)


client: Any = TenantClient()


def set_client(new_client: Any) -> None:
    global client
    client = new_client


def get_client() -> Any:
    return client
