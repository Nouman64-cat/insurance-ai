"""The signer's HTTP API. Internal network only: it is never published to the host and never proxied by the gateway.

Every route except /v1/health needs a signed request (shared/security/service_auth.py: HMAC-SHA256 over method, path, body
and a timestamp) from the Audit Service. Note what is NOT in this API: no way to submit a hash, a payload or a signature to be
signed, and no way to read a private key. The only signing operation is "checkpoint this chain" and the signer works out the rest.
"""
import logging
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from shared.audit.signer.config import SignerSettings
from shared.audit.signer.errors import SignerError
from shared.audit.signer.service import SignerService
from shared.audit.signer.source import DbEventSource
from shared.security import service_auth

log = logging.getLogger("audit.signer.api")
CALLER = "audit-service"


class SignRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    chain_id: str = Field(min_length=1, max_length=128)
    end_sequence: Optional[int] = Field(default=None, ge=1)
    # What the caller expects (checked against what the signer computes, never trusted): number, range, hashes.
    proposal: Optional[dict] = None


class ArchiveSignRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    manifest: dict      # the proposed manifest (shared/audit/archive_manifest.PROPOSED_FIELDS): checked, never signed blindly


def create_app(service: Optional[SignerService] = None, settings: Optional[SignerSettings] = None) -> FastAPI:
    settings = settings or SignerSettings()
    svc = service or SignerService(settings, DbEventSource(settings.database_url, settings.schema))
    app = FastAPI(title="Audit checkpoint signer", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.service = svc

    @app.exception_handler(SignerError)
    async def _signer_error(_: Request, exc: SignerError):
        return JSONResponse(status_code=exc.status, content={"error": {"code": exc.code, "message": exc.message}})

    async def authenticated(request: Request) -> None:
        body = await request.body()
        path = request.url.path + ("?" + request.url.query if request.url.query else "")
        ok = request.headers.get(service_auth.CALLER_HEADER) == CALLER and service_auth.verify(
            settings.service_key, request.method, path, body, request.headers)
        if not ok:
            raise HTTPException(401, "invalid service signature")

    @app.get("/v1/health")
    async def health():
        status = await svc.status()
        return {"status": "ok" if status["key_available"] else "degraded", "key_available": status["key_available"], "problem": status["problem"]}

    @app.get("/v1/status", dependencies=[Depends(authenticated)])
    async def status():
        return await svc.status()

    @app.get("/v1/keys", dependencies=[Depends(authenticated)])
    async def keys():
        return await svc.registry_public()

    @app.post("/v1/checkpoints/sign", dependencies=[Depends(authenticated)])
    async def sign(body: SignRequest):
        return await svc.sign_checkpoint(body.chain_id, end_sequence=body.end_sequence, proposal=body.proposal)

    @app.post("/v1/archives/sign", dependencies=[Depends(authenticated)])
    async def sign_archive(body: ArchiveSignRequest):
        return await svc.sign_archive(body.manifest)

    @app.post("/v1/keys/rotate", dependencies=[Depends(authenticated)])
    async def rotate():
        return await svc.rotate()

    return app
