"""Settings for the evaluation data lake, read from the environment (see .env.example)."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Mapping, Optional

RETENTION_MODES = ("GOVERNANCE", "COMPLIANCE", "NONE")
_BUCKET = re.compile(r"^[a-z0-9][a-z0-9.-]{2,62}$")


@dataclass(frozen=True)
class LakeSettings:
    backend: str = "s3"                      # "s3" (MinIO or any S3 API) | "memory" (tests and throwaway runs only)
    endpoint_url: str = "http://minio:9000"
    access_key: str = ""
    secret_key: str = ""
    bucket: str = "eval-lake"
    region: str = "us-east-1"
    # Object lock on published (Gold) objects. GOVERNANCE can be lifted by a privileged user; COMPLIANCE by nobody until it
    # expires (production only); NONE turns the lock off and leaves the application and database guards.
    retention_mode: str = "GOVERNANCE"
    retention_days: int = 3650
    # A publication still 'publishing' after this long is treated as interrupted and handled by reconcile().
    publish_stale_minutes: int = 15
    max_import_bytes: int = 50 * 1024 * 1024

    @property
    def locks_objects(self) -> bool:
        return self.retention_mode != "NONE"


def load_settings(env: Optional[Mapping[str, str]] = None) -> LakeSettings:
    e = os.environ if env is None else env

    def get(name: str, default: str = "") -> str:
        return (e.get(name) or default).strip()

    backend = get("EVAL_LAKE_BACKEND", "s3").lower()
    if backend not in ("s3", "memory"):
        raise ValueError(f"EVAL_LAKE_BACKEND must be 's3' or 'memory', got {backend!r}")
    mode = get("EVAL_LAKE_RETENTION_MODE", "GOVERNANCE").upper()
    if mode not in RETENTION_MODES:
        raise ValueError(f"EVAL_LAKE_RETENTION_MODE must be one of {RETENTION_MODES}, got {mode!r}")
    bucket = get("EVAL_LAKE_BUCKET", "eval-lake")
    if not _BUCKET.match(bucket):
        raise ValueError(f"EVAL_LAKE_BUCKET {bucket!r} is not a valid bucket name (lower-case letters, digits, dots, hyphens)")
    try:
        days = int(get("EVAL_LAKE_RETENTION_DAYS", "3650"))
        stale = int(get("EVAL_LAKE_PUBLISH_STALE_MINUTES", "15"))
    except ValueError as exc:
        raise ValueError("EVAL_LAKE_RETENTION_DAYS and EVAL_LAKE_PUBLISH_STALE_MINUTES must be whole numbers") from exc
    if days < 1 or stale < 1:
        raise ValueError("EVAL_LAKE_RETENTION_DAYS and EVAL_LAKE_PUBLISH_STALE_MINUTES must be at least 1")
    return LakeSettings(
        backend=backend,
        endpoint_url=get("EVAL_LAKE_ENDPOINT", "http://minio:9000").rstrip("/"),
        access_key=get("EVAL_LAKE_ACCESS_KEY") or get("MINIO_ROOT_USER"),
        secret_key=get("EVAL_LAKE_SECRET_KEY") or get("MINIO_ROOT_PASSWORD"),
        bucket=bucket,
        region=get("EVAL_LAKE_REGION", "us-east-1"),
        retention_mode=mode,
        retention_days=days,
        publish_stale_minutes=stale,
    )
