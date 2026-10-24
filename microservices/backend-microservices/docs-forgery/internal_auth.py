"""Only authenticated internal callers may invoke the HTTP engine."""
import hmac
import os
from fastapi import Header, HTTPException


def require_internal(x_internal_secret: str = Header(default="")):
    expected = os.getenv("INTERNAL_API_SECRET", "").strip()
    if not expected:
        raise HTTPException(503, "Internal service authentication is not configured")
    if not hmac.compare_digest(x_internal_secret.encode(), expected.encode()):
        raise HTTPException(401, "Internal service authentication required")
