"""Client for the isolated local signer service (microservices/backend-microservices/audit-signer).

Requests are signed with the shared service key (HMAC over method, path, body and time; shared/security/service_auth.py),
so only the Audit Service can ask the signer to do anything, and a captured request can't be altered or replayed later.
The request names a chain and, optionally, what the caller expects; it can never carry a hash or payload to be signed.
"""
import json
from typing import Optional

import httpx

from app.signing.interface import SignedCheckpoint, SigningError
from shared.security import service_auth

CALLER = "audit-service"
RETRYABLE_HTTP = {429, 500, 502, 503, 504}


class LocalSignerClient:
    def __init__(self, base_url: str, service_key: str, timeout: float = 60.0, transport: Optional[httpx.AsyncBaseTransport] = None):
        self.base_url, self.service_key, self.timeout, self.transport = base_url.rstrip("/"), service_key, timeout, transport

    async def _call(self, method: str, path: str, payload: Optional[dict] = None) -> dict:
        body = json.dumps(payload).encode() if payload is not None else b""
        try:
            headers = service_auth.sign(self.service_key, method, path, body, caller=CALLER)
        except ValueError:
            raise SigningError("SIGNER_NOT_CONFIGURED", "AUDIT_SIGNER_SERVICE_KEY is not set", retryable=False) from None
        headers["content-type"] = "application/json"
        try:
            async with httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout, transport=self.transport) as client:
                response = await client.request(method, path, content=body or None, headers=headers)
        except httpx.HTTPError as exc:
            raise SigningError("SIGNER_UNAVAILABLE", f"the signer cannot be reached ({type(exc).__name__})") from exc
        if response.status_code == 200:
            return response.json()
        try:
            error = response.json()["error"]
            code, message = error["code"], error["message"]
        except (ValueError, KeyError, TypeError):
            code, message = f"SIGNER_HTTP_{response.status_code}", response.text[:200]
        raise SigningError(code, message, retryable=response.status_code in RETRYABLE_HTTP or code in {"KEY_UNAVAILABLE", "STORAGE_FAILED", "REPLICA_FAILED"})

    async def sign_checkpoint(self, chain_id: str, *, end_sequence: Optional[int] = None, proposal: Optional[dict] = None) -> SignedCheckpoint:
        body: dict = {"chain_id": chain_id}
        if end_sequence is not None:
            body["end_sequence"] = end_sequence
        if proposal:
            body["proposal"] = proposal
        result = await self._call("POST", "/v1/checkpoints/sign", body)
        return SignedCheckpoint(result["envelope"], result["path"], result["replica"], result["idempotent"])

    async def status(self) -> dict:
        try:
            return await self._call("GET", "/v1/status")
        except SigningError as exc:
            return {"key_available": False, "problem": f"{exc.code}: {exc.message}", "reachable": False}

    async def public_keys(self) -> dict:
        return await self._call("GET", "/v1/keys")

    async def rotate(self) -> dict:
        return await self._call("POST", "/v1/keys/rotate", {})
