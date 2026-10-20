"""Signer settings, all from the environment (no secrets in code or in committed files)."""
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


def _path(name: str, default: str) -> Path:
    return Path(os.environ.get(name, default))


@dataclass(frozen=True)
class SignerSettings:
    # Read-only database role: the signer re-reads the chain itself rather than trusting what it is told.
    database_url: str = field(default_factory=lambda: os.environ.get("AUDIT_SIGNER_DATABASE_URL", ""))
    schema: str = field(default_factory=lambda: os.environ.get("AUDIT_DB_SCHEMA", "audit"))
    signer_id: str = field(default_factory=lambda: os.environ.get("AUDIT_SIGNER_ID", "audit-signer-local"))
    key_dir: Path = field(default_factory=lambda: _path("AUDIT_KEY_DIRECTORY", "/run/audit-keys"))
    passphrase_file: Path = field(default_factory=lambda: _path("AUDIT_KEY_PASSPHRASE_FILE", "/run/audit-secrets/key-passphrase"))
    checkpoint_dir: Path = field(default_factory=lambda: _path("AUDIT_CHECKPOINT_DIRECTORY", "/var/lib/audit-checkpoints"))
    replica_dir: Optional[Path] = field(default_factory=lambda: Path(os.environ["AUDIT_CHECKPOINT_REPLICA_DIRECTORY"]) if os.environ.get("AUDIT_CHECKPOINT_REPLICA_DIRECTORY") else None)
    replica_required: bool = field(default_factory=lambda: os.environ.get("AUDIT_CHECKPOINT_REPLICA_REQUIRED", "false").lower() == "true")
    state_dir: Path = field(default_factory=lambda: _path("AUDIT_SIGNER_STATE_DIRECTORY", "/var/lib/audit-signer"))
    service_key: str = field(default_factory=lambda: os.environ.get("AUDIT_SIGNER_SERVICE_KEY", ""))
    max_events: int = field(default_factory=lambda: int(os.environ.get("AUDIT_CHECKPOINT_MAX_EVENTS", "5000")))
    trust_anchor_fingerprint: Optional[str] = field(default_factory=lambda: os.environ.get("AUDIT_TRUST_ANCHOR_FINGERPRINT") or None)
