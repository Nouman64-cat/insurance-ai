"""The trusted key registry as the verifier sees it.

Trust comes from the registry FILE in the protected store (written only by the signer, mounted read-only here), validated
as a chain of signed statements (shared/audit/trust.py). The `signing_keys` table is only a mirror for display and reporting;
nothing is ever trusted because of what it contains.
"""
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy import text

from app.config import settings
from shared.audit.signer.files import CheckpointStore
from shared.audit.trust import RegistryError, TrustRegistry


class RegistryUnavailable(Exception):
    """The trusted registry cannot be read (so nothing can be verified against it)."""


def store(directory: Optional[str] = None) -> CheckpointStore:
    return CheckpointStore(Path(directory or settings.checkpoint_directory))


def load_registry(environment_id: str, directory: Optional[str] = None) -> TrustRegistry:
    """Raises RegistryUnavailable if the file is missing/unreadable, RegistryError if it is not a valid chain of trust."""
    try:
        data = store(directory).read_registry()
    except Exception as exc:
        raise RegistryUnavailable(f"the trusted key registry cannot be read ({exc})") from exc
    if data is None:
        raise RegistryUnavailable("no trusted key registry exists yet (the signer has not been initialised)")
    return TrustRegistry.parse(data, environment_id=environment_id, anchor_fingerprint=settings.trust_anchor_fingerprint or None)


def _ts(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)


async def sync_to_db(conn, registry: TrustRegistry) -> int:
    """Mirror the (already validated) registry into audit.signing_keys. Returns the number of rows added or retired."""
    changed = 0
    existing = {r.key_id: r.status for r in (await conn.execute(text("SELECT key_id, status FROM signing_keys"))).all()}
    for key in registry.keys:
        if key.key_id not in existing:
            statement = {"derived_from_registry": True, "fingerprint": key.fingerprint}
            await conn.execute(text("""
                INSERT INTO signing_keys (key_id, signer_id, key_version, environment_id, tenant_scope, public_key, fingerprint, algorithm,
                                          status, created_at, activated_at, retired_at, statement)
                VALUES (:id, :signer, :ver, CAST(:env AS uuid), :scope, :pk, :fp, :alg, 'ACTIVE', :created, :activated, NULL, CAST(:st AS jsonb))
                ON CONFLICT (key_id) DO NOTHING"""),
                {"id": key.key_id, "signer": key.signer_id, "ver": key.key_version, "env": key.environment_id, "scope": key.tenant_scope,
                 "pk": key.public_key, "fp": key.fingerprint, "alg": key.algorithm, "created": _ts(key.activated_at), "activated": _ts(key.activated_at),
                 "st": json.dumps(statement)})
            changed += 1
            existing[key.key_id] = "ACTIVE"
        if key.retired_at and existing[key.key_id] == "ACTIVE":
            await conn.execute(text("UPDATE signing_keys SET status = 'RETIRED', retired_at = :t WHERE key_id = :id AND status = 'ACTIVE'"),
                               {"t": _ts(key.retired_at), "id": key.key_id})
            changed += 1
    return changed
