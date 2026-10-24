"""Infrastructure settings and first-install archive defaults.

Archive controls are seeded once, then resolved from archive_configuration_versions.
Environment changes do not override persisted SuperAdmin controls.
"""
import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _roles(name: str, default: str) -> frozenset[str]:
    return frozenset(r.strip() for r in os.environ.get(name, default).split(",") if r.strip())


@dataclass(frozen=True)
class Settings:
    # The service connects as a role that can read the ledger and append events, nothing more.
    database_url: str = field(default_factory=lambda: os.environ.get("AUDIT_DATABASE_URL", ""))
    # Migrations run as the schema owner. Unset: the service does not migrate.
    migration_database_url: str = field(default_factory=lambda: os.environ.get("AUDIT_MIGRATION_DATABASE_URL", ""))
    schema: str = field(default_factory=lambda: os.environ.get("AUDIT_DB_SCHEMA", "audit"))
    run_migrations_on_start: bool = field(default_factory=lambda: _bool("AUDIT_RUN_MIGRATIONS", True))

    tenant_service_url: str = field(default_factory=lambda: os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001").rstrip("/"))
    identity_cache_seconds: int = field(default_factory=lambda: _int("AUDIT_IDENTITY_CACHE_SECONDS", 15))

    # Who may read the ledger and run verification. Default: the platform SuperAdmin only (every chain, including the platform
    # chain). Add "Admin" to let tenant administrators read their own tenant's chain; everyone else is always refused.
    read_roles: frozenset = field(default_factory=lambda: _roles("AUDIT_READ_ROLES", "SuperAdmin"))

    kafka_bootstrap: str = field(default_factory=lambda: os.environ.get("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092"))
    consumer_enabled: bool = field(default_factory=lambda: _bool("AUDIT_CONSUMER_ENABLED", True))
    consumer_group: str = field(default_factory=lambda: os.environ.get("AUDIT_CONSUMER_GROUP", "audit-service"))
    consumer_batch: int = field(default_factory=lambda: _int("AUDIT_CONSUMER_BATCH", 200))

    # Scheduled verification of every chain.
    verify_enabled: bool = field(default_factory=lambda: _bool("AUDIT_VERIFY_ENABLED", True))
    verify_interval_seconds: int = field(default_factory=lambda: _int("AUDIT_VERIFY_INTERVAL_SECONDS", 6 * 3600))
    verify_initial_delay_seconds: float = field(default_factory=lambda: float(os.environ.get("AUDIT_VERIFY_INITIAL_DELAY_SECONDS", 30)))
    verify_batch: int = field(default_factory=lambda: _int("AUDIT_VERIFY_BATCH", 1000))


    # ── Stage 2: signed checkpoints ──────────────────────────────────────────────
    signing_enabled: bool = field(default_factory=lambda: _bool("AUDIT_SIGNING_ENABLED", True))
    # Where the signing happens. Only "local" (the isolated audit-signer service with its own key volume) exists today;
    # the provider interface (app/signing/interface.py) is the seam for Vault / a cloud KMS later.
    signing_provider: str = field(default_factory=lambda: os.environ.get("AUDIT_SIGNING_PROVIDER", "local").strip().lower())
    signer_url: str = field(default_factory=lambda: os.environ.get("AUDIT_SIGNER_URL", "http://audit-signer:8021").rstrip("/"))
    signer_service_key: str = field(default_factory=lambda: os.environ.get("AUDIT_SIGNER_SERVICE_KEY", ""))
    signer_timeout_seconds: float = field(default_factory=lambda: float(os.environ.get("AUDIT_SIGNER_TIMEOUT_SECONDS", 60)))
    # A checkpoint is due after this many new events OR this many seconds since the oldest unsigned event, whichever is first.
    checkpoint_event_threshold: int = field(default_factory=lambda: _int("AUDIT_CHECKPOINT_EVENT_THRESHOLD", 500))
    checkpoint_interval_seconds: int = field(default_factory=lambda: _int("AUDIT_CHECKPOINT_INTERVAL_SECONDS", 900))
    checkpoint_poll_seconds: float = field(default_factory=lambda: float(os.environ.get("AUDIT_CHECKPOINT_POLL_SECONDS", 10)))
    checkpoint_max_events: int = field(default_factory=lambda: _int("AUDIT_CHECKPOINT_MAX_EVENTS", 5000))
    checkpoint_lease_seconds: int = field(default_factory=lambda: _int("AUDIT_CHECKPOINT_LEASE_SECONDS", 120))
    checkpoint_retry_base_seconds: float = field(default_factory=lambda: float(os.environ.get("AUDIT_CHECKPOINT_RETRY_BASE_SECONDS", 15)))
    checkpoint_retry_max_seconds: float = field(default_factory=lambda: float(os.environ.get("AUDIT_CHECKPOINT_RETRY_MAX_SECONDS", 600)))
    # The protected store written by the signer and mounted READ-ONLY here. It, not PostgreSQL, is the trust anchor.
    checkpoint_directory: str = field(default_factory=lambda: os.environ.get("AUDIT_CHECKPOINT_DIRECTORY", "/var/lib/audit-checkpoints"))
    # Optional operator-pinned fingerprint of the trust root key (never committed; see README).
    trust_anchor_fingerprint: str = field(default_factory=lambda: os.environ.get("AUDIT_TRUST_ANCHOR_FINGERPRINT", ""))
    # A human label for this installation, shown in the UI. The cryptographic identity is the database's environment_id.
    environment_label: str = field(default_factory=lambda: os.environ.get("AUDIT_ENVIRONMENT_LABEL", "local-dev"))

    # ── Stage 3: archive, retention and cold storage ─────────────────────────────
    archiving_enabled: bool = field(default_factory=lambda: _bool("AUDIT_ARCHIVING_ENABLED", True))
    # Fallback hot window (months) when no retention policy row applies; the retention_policies table is authoritative.
    hot_retention_months: int = field(default_factory=lambda: _int("AUDIT_HOT_RETENTION_MONTHS", 6))
    # "monthly": the hot window ends on a month boundary (archives line up with partitions); "continuous": a rolling window.
    archive_schedule: str = field(default_factory=lambda: os.environ.get("AUDIT_ARCHIVE_SCHEDULE", "monthly").strip().lower())
    # How often the scheduler looks for archivable history and runs cleanup checks (planning is idempotent and cheap).
    archive_interval_seconds: int = field(default_factory=lambda: _int("AUDIT_ARCHIVE_INTERVAL_SECONDS", 300))
    archive_poll_seconds: float = field(default_factory=lambda: float(os.environ.get("AUDIT_ARCHIVE_POLL_SECONDS", 30)))
    archive_compression: str = field(default_factory=lambda: os.environ.get("AUDIT_ARCHIVE_COMPRESSION", "zstd").strip().lower())
    archive_compression_level: int = field(default_factory=lambda: _int("AUDIT_ARCHIVE_COMPRESSION_LEVEL", 6))
    archive_storage_provider: str = field(default_factory=lambda: os.environ.get("AUDIT_ARCHIVE_STORAGE_PROVIDER", "minio").strip().lower())
    # Archives are cut at the first signed checkpoint boundary at or after this many events, never larger than max (bounded work per job).
    archive_min_events: int = field(default_factory=lambda: _int("AUDIT_ARCHIVE_MIN_EVENTS", 1))
    archive_max_events: int = field(default_factory=lambda: _int("AUDIT_ARCHIVE_MAX_EVENTS", 2_000_000))
    archive_chunk_bytes: int = field(default_factory=lambda: _int("AUDIT_ARCHIVE_CHUNK_BYTES", 1024 * 1024))
    archive_fetch_batch: int = field(default_factory=lambda: _int("AUDIT_ARCHIVE_FETCH_BATCH", 2000))
    archive_lease_seconds: int = field(default_factory=lambda: _int("AUDIT_ARCHIVE_LEASE_SECONDS", 600))
    archive_retry_base_seconds: float = field(default_factory=lambda: float(os.environ.get("AUDIT_ARCHIVE_RETRY_BASE_SECONDS", 30)))
    archive_retry_max_seconds: float = field(default_factory=lambda: float(os.environ.get("AUDIT_ARCHIVE_RETRY_MAX_SECONDS", 1800)))
    archive_signer_timeout_seconds: float = field(default_factory=lambda: float(os.environ.get("AUDIT_ARCHIVE_SIGNER_TIMEOUT_SECONDS", 900)))
    # Hot cleanup is a SEPARATE step from archiving and is OFF by default: archiving never removes anything from PostgreSQL.
    auto_hot_cleanup: bool = field(default_factory=lambda: _bool("AUDIT_AUTO_HOT_CLEANUP", False))
    cleanup_mode: str = field(default_factory=lambda: os.environ.get("AUDIT_CLEANUP_MODE", "detach").strip().lower())   # detach | drop
    cleanup_safety_days: float = field(default_factory=lambda: float(os.environ.get("AUDIT_CLEANUP_SAFETY_DAYS", 7)))
    # The object store (MinIO). Separate identities: the writer can put/get but not delete; the reader can only read.
    s3_endpoint: str = field(default_factory=lambda: os.environ.get("AUDIT_ARCHIVE_S3_ENDPOINT", "http://minio:9000").rstrip("/"))
    s3_region: str = field(default_factory=lambda: os.environ.get("AUDIT_ARCHIVE_S3_REGION", "us-east-1"))
    archive_bucket: str = field(default_factory=lambda: os.environ.get("AUDIT_ARCHIVE_BUCKET", "insurance-audit-archive"))
    writer_key: str = field(default_factory=lambda: os.environ.get("AUDIT_ARCHIVE_WRITER_KEY", ""))
    writer_secret: str = field(default_factory=lambda: os.environ.get("AUDIT_ARCHIVE_WRITER_SECRET", ""))
    reader_key: str = field(default_factory=lambda: os.environ.get("AUDIT_ARCHIVE_READER_KEY", ""))
    reader_secret: str = field(default_factory=lambda: os.environ.get("AUDIT_ARCHIVE_READER_SECRET", ""))
    # Object Lock on each archive (an anti-tamper window, NOT a legal retention period). GOVERNANCE or COMPLIANCE; days = 0 disables.
    lock_mode: str = field(default_factory=lambda: os.environ.get("AUDIT_ARCHIVE_LOCK_MODE", "GOVERNANCE").strip().upper())
    lock_days: int = field(default_factory=lambda: _int("AUDIT_ARCHIVE_LOCK_DAYS", 30))
    require_object_lock: bool = field(default_factory=lambda: _bool("AUDIT_ARCHIVE_REQUIRE_OBJECT_LOCK", True))
    # The archive master key (KEK) lives here, on its own volume, mounted read-only. It is never stored in PostgreSQL or in object storage.
    key_directory: str = field(default_factory=lambda: os.environ.get("AUDIT_ARCHIVE_KEY_DIRECTORY", "/run/audit-archive-keys"))
    work_directory: str = field(default_factory=lambda: os.environ.get("AUDIT_ARCHIVE_WORK_DIRECTORY", "/var/lib/audit-archive-work"))
    retrieval_ttl_hours: float = field(default_factory=lambda: float(os.environ.get("AUDIT_RETRIEVAL_TTL_HOURS", 24)))
    retrieval_max_events: int = field(default_factory=lambda: _int("AUDIT_RETRIEVAL_MAX_EVENTS", 200_000))
    # Development only: archive anything older than N seconds (instead of the month-based window) so the whole cycle can be watched in
    # minutes. Refused unless the installation is labelled local-dev (AUDIT_ENVIRONMENT_LABEL).
    archive_test_mode: bool = field(default_factory=lambda: _bool("AUDIT_ARCHIVE_TEST_MODE", False))
    archive_test_hot_seconds: float = field(default_factory=lambda: float(os.environ.get("AUDIT_ARCHIVE_TEST_HOT_SECONDS", 120)))


settings = Settings()
