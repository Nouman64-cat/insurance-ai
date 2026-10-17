"""Settings, all from the environment. See README.md, "Configuration"."""
import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    # The application connects as a role that can only use the request_management schema.
    database_url: str = field(default_factory=lambda: os.environ.get("REQUEST_MGMT_DATABASE_URL", ""))
    # Migrations run as the schema owner. Unset: migrations are not run by the service.
    migration_database_url: str = field(default_factory=lambda: os.environ.get("REQUEST_MGMT_MIGRATION_DATABASE_URL", ""))
    schema: str = field(default_factory=lambda: os.environ.get("REQUEST_MGMT_DB_SCHEMA", "request_management"))
    run_migrations_on_start: bool = field(default_factory=lambda: os.environ.get("REQUEST_MGMT_RUN_MIGRATIONS", "true").lower() == "true")

    tenant_service_url: str = field(default_factory=lambda: os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001").rstrip("/"))
    service_key: str = field(default_factory=lambda: os.environ.get("REQUEST_MGMT_SERVICE_KEY", ""))
    # How long a verified session is trusted before /auth/me is asked again (a revoked user is cut off within this).
    identity_cache_seconds: int = field(default_factory=lambda: _int("REQUEST_MGMT_IDENTITY_CACHE_SECONDS", 15))

    kafka_bootstrap: str = field(default_factory=lambda: os.environ.get("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092"))
    # Background workers (outbox relay, executor, notifier, schedulers). Off in tests.
    workers_enabled: bool = field(default_factory=lambda: os.environ.get("REQUEST_MGMT_WORKERS", "true").lower() == "true")

    max_execution_attempts: int = field(default_factory=lambda: _int("REQUEST_MGMT_MAX_EXECUTION_ATTEMPTS", 5))
    retry_base_seconds: int = field(default_factory=lambda: _int("REQUEST_MGMT_RETRY_BASE_SECONDS", 30))
    reminder_interval_hours: int = field(default_factory=lambda: _int("REQUEST_MGMT_REMINDER_INTERVAL_HOURS", 24))

    storage_backend: str = field(default_factory=lambda: os.environ.get("REQUEST_MGMT_STORAGE", "s3"))
    local_storage_dir: str = field(default_factory=lambda: os.environ.get("REQUEST_MGMT_LOCAL_STORAGE_DIR", "/data/request-attachments"))
    s3_bucket: str = field(default_factory=lambda: os.environ.get("S3_BUCKET_NAME", ""))
    s3_region: str = field(default_factory=lambda: os.environ.get("AWS_S3_REGION") or os.environ.get("AWS_REGION", "us-east-1"))
    max_attachment_bytes: int = field(default_factory=lambda: _int("REQUEST_MGMT_MAX_ATTACHMENT_BYTES", 10 * 1024 * 1024))


settings = Settings()
