"""Signed service-to-service calls (HMAC-SHA256).

One key per integration, never a general-purpose credential: the key in
REQUEST_MGMT_SERVICE_KEY is only accepted by tenant-service's
/internal/request-management/* endpoints (routers/request_management_internal.py),
which perform a short list of narrowly scoped operations and still validate the
tenant and the human actors named in the request.

The signature covers a timestamp, the HTTP method, the path and a hash of the body,
so a captured request can't be altered or replayed after the time window.
"""

import hashlib
import hmac
import json
import time

SIGNATURE_HEADER = "X-Service-Signature"
TIMESTAMP_HEADER = "X-Service-Timestamp"
CALLER_HEADER = "X-Service-Caller"
MAX_SKEW_SECONDS = 300
VERSION_HEADER = "X-Service-Signature-Version"
BOUND_HEADERS = ('idempotency-key', 'x-portal-tenant', 'x-portal-customer', 'x-portal-name', 'x-service-caller')


def _bound_message(timestamp, method, path, body, headers):
    lowered = {k.lower(): v for k, v in headers.items()}
    context = json.dumps({k: lowered.get(k, '') for k in BOUND_HEADERS}, sort_keys=True, separators=(',', ':'))
    return b'v2\n' + _message(timestamp, method, path, body) + b'\n' + context.encode()



def _message(timestamp: str, method: str, path: str, body: bytes) -> bytes:
    body_hash = hashlib.sha256(body or b"").hexdigest()
    return f"{timestamp}\n{method.upper()}\n{path}\n{body_hash}".encode()


def sign(key: str, method: str, path: str, body: bytes = b"", caller: str = "request-management", now: float | None = None, *, bound_headers: dict[str, str] | None = None) -> dict[str, str]:
    """Headers to send with a request. `path` is the URL path plus query string."""
    if not key:
        raise ValueError("service key is not configured")
    timestamp = str(int(now if now is not None else time.time()))
    headers = {**(bound_headers or {}), TIMESTAMP_HEADER: timestamp, CALLER_HEADER: caller}
    message = _message(timestamp, method, path, body)
    if bound_headers is not None:
        headers[VERSION_HEADER] = '2'
        message = _bound_message(timestamp, method, path, body, headers)
    headers[SIGNATURE_HEADER] = hmac.new(key.encode(), message, hashlib.sha256).hexdigest()
    return headers


def verify(key: str, method: str, path: str, body: bytes, headers, now: float | None = None) -> bool:
    """True if the headers carry a valid, fresh signature for this exact request."""
    if not key:
        return False
    headers = {k.lower(): v for k, v in headers.items()}
    signature = headers.get(SIGNATURE_HEADER.lower()) or ""
    timestamp = headers.get(TIMESTAMP_HEADER.lower()) or ""
    if not signature or not timestamp.isdigit():
        return False
    current = now if now is not None else time.time()
    if abs(current - int(timestamp)) > MAX_SKEW_SECONDS:
        return False
    version = headers.get(VERSION_HEADER.lower(), '1')
    if version not in ('1', '2'):
        return False
    message = _bound_message(timestamp, method, path, body, headers) if version == '2' else _message(timestamp, method, path, body)
    expected = hmac.new(key.encode(), message, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
