"""Who is acting, for the audit events produced while a request (or a background job) runs.

A service sets the context once at the edge (its HTTP middleware decodes the caller's session); the audit helpers
read it when they build an event, so business code never has to pass actor details around. Background jobs have no
HTTP caller and run with the default SYSTEM context unless they set their own.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, replace
from typing import Iterator, Optional
from uuid import UUID, uuid4


@dataclass(frozen=True)
class AuditContext:
    actor_id: Optional[str] = None
    actor_type: str = "SYSTEM"
    actor_role: Optional[str] = None
    actor_name: Optional[str] = None
    tenant_id: Optional[UUID] = None
    correlation_id: Optional[str] = None
    client_ip: Optional[str] = None
    request_path: Optional[str] = None


_current: ContextVar[Optional[AuditContext]] = ContextVar("audit_context", default=None)


def get_context() -> AuditContext:
    return _current.get() or AuditContext()


def set_context(ctx: AuditContext):
    """Returns a token for reset_context()."""
    return _current.set(ctx)


def reset_context(token) -> None:
    _current.reset(token)


@contextmanager
def audit_context(**changes) -> Iterator[AuditContext]:
    """Run a block with some context fields overridden (e.g. a scheduler acting as SYSTEM for one tenant)."""
    ctx = replace(get_context(), **changes)
    token = _current.set(ctx)
    try:
        yield ctx
    finally:
        _current.reset(token)


def new_correlation_id() -> str:
    return str(uuid4())


class CorrelationContextMiddleware:
    """Pure ASGI middleware for services that resolve the caller themselves: it records the request's correlation id
    (X-Correlation-Id from the gateway) and client address, so every audit event the request produces carries them.
    The actor is passed explicitly where the event is built."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        correlation = headers.get("x-correlation-id") or headers.get("x-request-id") or ""
        if not (8 <= len(correlation) <= 64 and all(c.isalnum() or c in "._-" for c in correlation)):
            correlation = None
        forwarded = headers.get("x-forwarded-for", "").split(",")[0].strip()
        client = scope.get("client")
        token = set_context(AuditContext(correlation_id=correlation, client_ip=forwarded or (client[0] if client else None),
                                         request_path=scope.get("path")))
        try:
            await self.app(scope, receive, send)
        finally:
            reset_context(token)
