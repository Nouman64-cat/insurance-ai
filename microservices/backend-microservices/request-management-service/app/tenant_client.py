"""Calls to tenant-service, which owns users, customers and commission earnings.

Two kinds of call:
  * With the signed-in user's own token (me, get_customer, get_earning): tenant-service applies its usual rules,
    so a lookup only succeeds for records that user may see (an agent sees only their own customers/earnings).
  * Signed with REQUEST_MGMT_SERVICE_KEY (users, apply_profile_correction): the narrow endpoints in tenant-service's
    routers/request_management_internal.py. Each is scoped to one tenant and names the human actors involved.

`client` is a module-level instance so tests can replace it.
"""
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import urlencode
from uuid import UUID

import httpx

from app.config import settings
from shared.security.service_auth import sign


class TenantServiceUnavailable(Exception):
    pass


@dataclass
class DomainResponse:
    status: int
    body: Any


class TenantClient:
    def __init__(self, base_url: str | None = None, key: str | None = None):
        self.base_url = (base_url or settings.tenant_service_url).rstrip("/")
        self.key = key if key is not None else settings.service_key
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0))

    async def _user_get(self, token: str, path: str) -> DomainResponse:
        try:
            resp = await self._http.get(f"{self.base_url}{path}", headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError as exc:
            raise TenantServiceUnavailable(str(exc)) from exc
        try:
            body = resp.json()
        except ValueError:
            body = None
        return DomainResponse(resp.status_code, body)

    async def _signed(self, method: str, path: str, json_body: Any = None) -> DomainResponse:
        import json as _json
        body = _json.dumps(json_body, default=str).encode() if json_body is not None else b""
        headers = sign(self.key, method, path, body)
        if json_body is not None:
            headers["Content-Type"] = "application/json"
        try:
            resp = await self._http.request(method, f"{self.base_url}{path}", content=body, headers=headers)
        except httpx.HTTPError as exc:
            raise TenantServiceUnavailable(str(exc)) from exc
        try:
            parsed = resp.json()
        except ValueError:
            parsed = None
        return DomainResponse(resp.status_code, parsed)

    async def me(self, token: str) -> DomainResponse:
        return await self._user_get(token, "/auth/me")

    async def get_customer(self, token: str, tenant_id: UUID, customer_id: UUID) -> Optional[dict]:
        resp = await self._user_get(token, f"/tenants/{tenant_id}/customers/{customer_id}")
        if resp.status >= 500:
            raise TenantServiceUnavailable(f"customer lookup failed with {resp.status}")
        return resp.body if resp.status == 200 and isinstance(resp.body, dict) else None

    async def get_earning(self, token: str, tenant_id: UUID, earning_id: UUID) -> Optional[dict]:
        resp = await self._user_get(token, f"/tenants/{tenant_id}/commissions/earnings/{earning_id}")
        if resp.status >= 500:
            raise TenantServiceUnavailable(f"earning lookup failed with {resp.status}")
        return resp.body if resp.status == 200 and isinstance(resp.body, dict) else None

    async def users(self, tenant_id: UUID, ids: Optional[list[UUID]] = None, roles: Optional[list[str]] = None) -> list[dict]:
        query = {}
        if ids:
            query["ids"] = ",".join(str(i) for i in ids)
        if roles:
            query["roles"] = ",".join(roles)
        path = f"/internal/request-management/tenants/{tenant_id}/users" + (f"?{urlencode(query)}" if query else "")
        resp = await self._signed("GET", path)
        if resp.status != 200 or not isinstance(resp.body, list):
            raise TenantServiceUnavailable(f"user directory failed with {resp.status}")
        return resp.body

    async def apply_profile_correction(self, tenant_id: UUID, customer_id: UUID, body: dict) -> DomainResponse:
        path = f"/internal/request-management/tenants/{tenant_id}/customers/{customer_id}/profile-corrections"
        return await self._signed("POST", path, body)


client: Any = TenantClient()


def set_client(new_client: Any) -> None:
    global client
    client = new_client


def get_client() -> Any:
    return client
