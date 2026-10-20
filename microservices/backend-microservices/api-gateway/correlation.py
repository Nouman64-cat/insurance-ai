"""Correlation id for every request.

The gateway is the public entry point, so it stamps each request with an X-Correlation-Id (keeping a well-formed one
the caller supplied) before proxying. Downstream services record it on their audit events, which ties together every
audit entry produced by one user action across services. The id is echoed on the response.
"""
import re
from uuid import uuid4

HEADER = b"x-correlation-id"
_VALID = re.compile(rb"^[A-Za-z0-9._-]{8,64}$")


class CorrelationIdMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = list(scope["headers"])
        correlation_id = next((v for k, v in headers if k == HEADER), b"")
        if not _VALID.match(correlation_id):
            correlation_id = uuid4().hex.encode()
            headers = [(k, v) for k, v in headers if k != HEADER] + [(HEADER, correlation_id)]
        scope = dict(scope, headers=headers)

        async def send_with_header(message):
            if message["type"] == "http.response.start":
                message = dict(message, headers=[(k, v) for k, v in message.get("headers", []) if k.lower() != HEADER] + [(HEADER, correlation_id)])
            await send(message)

        await self.app(scope, receive, send_with_header)
