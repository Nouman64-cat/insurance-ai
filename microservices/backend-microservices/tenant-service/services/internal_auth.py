"""The shared-secret check for endpoints only the platform's own services may call (they send X-Internal-Secret).

It fails closed: an endpoint that hands out decrypted provider keys or platform settings must never be open because a deployment forgot to set the secret.
No secret configured is a 503 (the operator's mistake, visible at once), a wrong or missing header is a 401, and the comparison takes the same time whatever the guess."""
import hmac

from fastapi import HTTPException, status


def check_internal_secret(expected: str, provided: str) -> None:
    expected = (expected or "").strip()
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "INTERNAL_API_SECRET is not configured, so this internal endpoint is closed.")
    if not hmac.compare_digest((provided or "").encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad internal secret")
