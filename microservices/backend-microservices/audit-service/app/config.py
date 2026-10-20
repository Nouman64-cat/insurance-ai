"""Settings, all from the environment. See README.md, "Configuration"."""
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

    # Who may read the ledger and run verification: tenant administrators (their own tenant's chain) and the platform
    # SuperAdmin (every chain, including the platform chain). Everyone else is refused.
    read_roles: frozenset = field(default_factory=lambda: _roles("AUDIT_READ_ROLES", "Admin,SuperAdmin"))

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


settings = Settings()
