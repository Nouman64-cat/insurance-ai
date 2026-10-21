"""SHA-256 hash chaining for audit events (shared by the Audit Service and the independent checkpoint signer, which must
recompute chains with exactly this code): deterministic, versioned canonical serialization and hash computation.

    event_hash = SHA256( domain_separator || canonical_json({
        "hash_version": 1, "chain_id": ..., "sequence_number": ..., "previous_hash": ..., "event": {...immutable fields...}
    }) )

Canonical form (hash_version 1)
  * JSON, UTF-8/ASCII bytes, object keys sorted, no whitespace, non-ASCII escaped (\\uXXXX), no NaN/Infinity;
  * integers as JSON integers; floats and Decimals are rejected (the sanitizer turns them into decimal strings first);
  * timestamps as UTC "YYYY-MM-DDTHH:MM:SS.ffffffZ" (always 6 fractional digits); naive datetimes are rejected;
  * UUIDs as lowercase hyphenated strings; missing optional fields are JSON null.

The domain separator keeps a hash from this ledger from ever being valid in another context, and the version is
inside both the separator and the payload. A future hash_version adds a new function to HASHERS; events already
written keep verifying under the version stored with them, so existing chains are never rewritten.

The genesis hash is derived from the chain id, so an event can't be spliced from one chain into another: its
previous_hash would not match.
"""
import hashlib
import json
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable, Mapping, Optional
from uuid import UUID

__all__ = ["HASH_VERSION", "EVENT_DOMAIN", "GENESIS_DOMAIN", "HASHED_EVENT_FIELDS", "CanonicalizationError", "format_timestamp",
           "canonical_bytes", "genesis_hash", "chain_id_for", "hashable_event", "HASHERS", "SUPPORTED_VERSIONS", "compute_event_hash"]

HASH_VERSION = 1
EVENT_DOMAIN = b"insurance-ai/audit-event/v1\x00"
GENESIS_DOMAIN = b"insurance-ai/audit-genesis/v1\x00"   # must equal chain_genesis_hash() in migrations/0001_initial.sql

# The immutable event fields, in documentation order. `timestamp` is the time the action occurred (occurred_at).
HASHED_EVENT_FIELDS = (
    "event_id", "tenant_id", "environment_id", "timestamp", "recorded_at", "actor_id", "actor_type", "actor_role",
    "service_name", "module", "action", "entity_type", "entity_id", "case_id", "correlation_id", "source_event_id",
    "previous_value", "new_value", "outcome", "metadata",
)


class CanonicalizationError(ValueError):
    """A value that has no single canonical encoding (float, naive datetime, non-string key, ...)."""


def format_timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        raise CanonicalizationError("naive datetime cannot be canonicalized")
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _canon(value: Any) -> Any:
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, (float, Decimal)):
        raise CanonicalizationError(f"{type(value).__name__} has no canonical form; use a decimal string")
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        return format_timestamp(value)
    if isinstance(value, Mapping):
        out = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise CanonicalizationError("object keys must be strings")
            out[key] = _canon(item)
        return out
    if isinstance(value, (list, tuple)):
        return [_canon(item) for item in value]
    raise CanonicalizationError(f"unsupported type {type(value).__name__}")


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(_canon(value), sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")


def genesis_hash(chain_id: str) -> str:
    return hashlib.sha256(GENESIS_DOMAIN + chain_id.encode("utf-8")).hexdigest()


def chain_id_for(environment_id: UUID, tenant_id: Optional[UUID]) -> str:
    return f"{environment_id}:{tenant_id if tenant_id else 'platform'}"


def hashable_event(record: Mapping[str, Any]) -> dict[str, Any]:
    """The immutable fields of a ledger event, from a record that has `occurred_at` (a DB row or an API object that
    has `timestamp`). Absent optional fields are None."""
    source = dict(record)
    if "timestamp" not in source:
        source["timestamp"] = source.get("occurred_at")
    return {name: source.get(name) for name in HASHED_EVENT_FIELDS}


def _hash_v1(chain_id: str, sequence_number: int, previous_hash: str, event: Mapping[str, Any]) -> str:
    payload = {
        "hash_version": 1,
        "chain_id": chain_id,
        "sequence_number": sequence_number,
        "previous_hash": previous_hash,
        "event": event,
    }
    return hashlib.sha256(EVENT_DOMAIN + canonical_bytes(payload)).hexdigest()


HASHERS: dict[int, Callable[[str, int, str, Mapping[str, Any]], str]] = {1: _hash_v1}
SUPPORTED_VERSIONS = frozenset(HASHERS)


def compute_event_hash(chain_id: str, sequence_number: int, previous_hash: str, record: Mapping[str, Any],
                       hash_version: int = HASH_VERSION) -> str:
    """The hash of `record` as event `sequence_number` of `chain_id` following `previous_hash`."""
    try:
        hasher = HASHERS[hash_version]
    except KeyError:
        raise CanonicalizationError(f"unsupported hash_version {hash_version}") from None
    return hasher(chain_id, int(sequence_number), previous_hash, hashable_event(record))
