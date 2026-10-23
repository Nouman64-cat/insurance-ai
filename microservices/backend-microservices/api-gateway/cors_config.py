"""Browser origins from the root Compose environment; no wildcard credentialed CORS."""
import os
from urllib.parse import urlsplit

LOCAL_ORIGIN_REGEX = r"https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?"


def cors_options(value: str | None = None) -> dict:
    raw = os.environ.get("CORS_ALLOWED_ORIGINS", "") if value is None else value
    origins = []
    for item in raw.split(","):
        origin = item.strip().rstrip("/")
        if not origin:
            continue
        parsed = urlsplit(origin)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname or
                parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise ValueError("CORS_ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins without paths or credentials")
        # Accessing port also rejects malformed/non-numeric ports at startup.
        _ = parsed.port
        if origin not in origins:
            origins.append(origin)
    return {
        "allow_origins": origins,
        "allow_origin_regex": None if origins else LOCAL_ORIGIN_REGEX,
        "allow_credentials": True,
        "allow_methods": ["*"],
        "allow_headers": ["*"],
        # Let the browser read how an idempotent request was answered and when to retry an in-flight one.
        "expose_headers": ["Idempotency-Replayed", "Retry-After"],
    }
