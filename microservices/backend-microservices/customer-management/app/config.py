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


@dataclass(frozen=True)
class Settings:
    # The application connects as a role that can only use the customer_management schema.
    database_url: str = field(default_factory=lambda: os.environ.get("CM_DATABASE_URL", ""))
    # Migrations run as the schema owner. Unset: migrations are not run by the service.
    migration_database_url: str = field(default_factory=lambda: os.environ.get("CM_MIGRATION_DATABASE_URL", ""))
    schema: str = field(default_factory=lambda: os.environ.get("CM_DB_SCHEMA", "customer_management"))
    run_migrations_on_start: bool = field(default_factory=lambda: _bool("CM_RUN_MIGRATIONS", True))

    # Audit trail: every security event is mirrored by an audit intent (same transaction) relayed to the Audit Service.
    audit_enabled: bool = field(default_factory=lambda: _bool("AUDIT_ENABLED", True))
    kafka_bootstrap: str = field(default_factory=lambda: os.environ.get("KAFKA_BOOTSTRAP_SERVERS", "kafka:9092"))

    tenant_service_url: str = field(default_factory=lambda: os.environ.get("TENANT_SERVICE_URL", "http://tenant-service:8001").rstrip("/"))
    # Customer Management -> tenant-service (signs). tenant-service -> Customer Management (verifies). Two keys, one per direction.
    to_tenant_key: str = field(default_factory=lambda: os.environ.get("CM_TO_TENANT_KEY", ""))
    from_tenant_key: str = field(default_factory=lambda: os.environ.get("TENANT_TO_CM_KEY", ""))

    # Customer tokens are signed with their own secret and carry their own issuer/audience, so a staff token can never
    # be accepted here (and the reverse).
    jwt_secret: str = field(default_factory=lambda: os.environ.get("CM_JWT_SECRET", ""))
    jwt_issuer: str = "insurance-ai/customer-management"
    jwt_audience: str = "customer-portal"
    access_ttl_minutes: int = field(default_factory=lambda: _int("CM_ACCESS_TTL_MINUTES", 15))
    session_idle_minutes: int = field(default_factory=lambda: _int("CM_SESSION_IDLE_MINUTES", 30))
    session_absolute_hours: int = field(default_factory=lambda: _int("CM_SESSION_ABSOLUTE_HOURS", 12))
    refresh_grace_seconds: int = field(default_factory=lambda: _int("CM_REFRESH_GRACE_SECONDS", 10))
    first_login_window_minutes: int = field(default_factory=lambda: _int("CM_FIRST_LOGIN_WINDOW_MINUTES", 30))

    # Sign-in throttling.
    max_failed_per_user: int = field(default_factory=lambda: _int("CM_MAX_FAILED_PER_USER", 5))
    user_window_minutes: int = field(default_factory=lambda: _int("CM_USER_WINDOW_MINUTES", 15))
    max_failed_per_ip: int = field(default_factory=lambda: _int("CM_MAX_FAILED_PER_IP", 30))
    ip_window_minutes: int = field(default_factory=lambda: _int("CM_IP_WINDOW_MINUTES", 10))
    lockout_minutes: int = field(default_factory=lambda: _int("CM_LOCKOUT_MINUTES", 15))

    # Premium payments go through the platform's mock gateway; they are labelled simulated everywhere.
    payments_enabled: bool = field(default_factory=lambda: _bool("CM_PAYMENTS_ENABLED", True))
    max_upload_bytes: int = field(default_factory=lambda: _int("CM_MAX_UPLOAD_BYTES", 15 * 1024 * 1024))

    env: str = field(default_factory=lambda: os.environ.get("CM_ENV", "development"))

    # Live updates (Server-Sent Events): how often the customer's own claims and tickets are checked, and how long one connection lives
    # before the browser reconnects (so an expired session is noticed).
    stream_poll_seconds: float = field(default_factory=lambda: float(os.environ.get("CM_STREAM_POLL_SECONDS", "5")))
    stream_max_seconds: float = field(default_factory=lambda: float(os.environ.get("CM_STREAM_MAX_SECONDS", "600")))

    # Support tickets are kept by the Customer Service service; this key signs our calls to it.
    support_url: str = field(default_factory=lambda: os.environ.get("CUSTOMER_SERVICE_URL", "http://customer-service:8008").rstrip("/"))
    support_key: str = field(default_factory=lambda: os.environ.get("CS_PORTAL_KEY", ""))

    # Walk-in (email one-time-code) access. The tenant is fixed by configuration, never taken from the browser.
    walkin_tenant_code: str = field(default_factory=lambda: os.environ.get("CM_WALKIN_TENANT_CODE", ""))
    walkin_otp_minutes: int = field(default_factory=lambda: _int("CM_WALKIN_OTP_MINUTES", 10))
    walkin_otp_attempts: int = field(default_factory=lambda: _int("CM_WALKIN_OTP_ATTEMPTS", 5))
    walkin_otp_per_email: int = field(default_factory=lambda: _int("CM_WALKIN_OTP_PER_EMAIL", 5))     # codes per email per 15 minutes
    walkin_otp_per_ip: int = field(default_factory=lambda: _int("CM_WALKIN_OTP_PER_IP", 20))
    walkin_session_minutes: int = field(default_factory=lambda: _int("CM_WALKIN_SESSION_MINUTES", 120))
    # Development only: when the mail provider cannot deliver, accept this fixed code instead. Ignored when CM_ENV=production.
    # Demo mode (ENV_VAR=demo, never in production): a walk-in only enters an email; no one-time code is asked for.
    demo: bool = field(default_factory=lambda: os.environ.get("ENV_VAR", "").strip().lower() == "demo" and os.environ.get("CM_ENV", "development") != "production")
    walkin_dev_otp: str = field(default_factory=lambda: os.environ.get("CM_WALKIN_DEV_OTP", ""))


settings = Settings()
