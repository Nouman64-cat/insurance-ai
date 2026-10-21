"""Signed audit checkpoints: the canonical payload, its hash, and Ed25519 signing / verification.

A checkpoint commits to a range of one chain: "events start..end of this chain, ending in this event hash, following that
previous checkpoint". It is signed by a key that lives only in the isolated signer, so the committed history can no longer
be rewritten by anyone who controls the audit database alone: they cannot produce a signature the trust registry accepts.

    signature = Ed25519( key, "insurance-ai/audit-checkpoint/v1\0" || canonical_json(payload) )

The *entire* payload is signed (not just the last event hash). Canonical encoding is the same deterministic, versioned
encoding the event hashes use (shared/audit/hashing.py). Ed25519 comes from the `cryptography` library.
"""
import base64
import hashlib
from typing import Any, Mapping, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from shared.audit.hashing import canonical_bytes

PAYLOAD_VERSION = 1
ALGORITHM = "Ed25519"
ENVELOPE_FORMAT = 1
CHECKPOINT_DOMAIN = b"insurance-ai/audit-checkpoint/v1\x00"
CHECKPOINT_GENESIS_DOMAIN = b"insurance-ai/audit-checkpoint-genesis/v1\x00"   # must equal checkpoint_genesis_hash() in migration 0002

PAYLOAD_FIELDS = (
    "checkpoint_id", "tenant_id", "environment_id", "chain_id", "checkpoint_number", "start_sequence", "end_sequence",
    "event_count", "last_event_hash", "previous_checkpoint_hash", "created_at", "signer_id", "signing_key_id", "key_version",
    "signature_algorithm", "payload_version",
)


class CheckpointFormatError(ValueError):
    pass


def checkpoint_genesis_hash(chain_id: str) -> str:
    """What the first checkpoint of a chain names as its 'previous checkpoint'."""
    return hashlib.sha256(CHECKPOINT_GENESIS_DOMAIN + chain_id.encode("utf-8")).hexdigest()


def build_payload(**fields: Any) -> dict:
    missing = [f for f in PAYLOAD_FIELDS if f not in fields]
    extra = [f for f in fields if f not in PAYLOAD_FIELDS]
    if missing or extra:
        raise CheckpointFormatError(f"checkpoint payload fields differ from the spec (missing {missing}, unexpected {extra})")
    payload = {name: fields[name] for name in PAYLOAD_FIELDS}
    payload["tenant_id"] = None if payload["tenant_id"] is None else str(payload["tenant_id"])
    payload["environment_id"] = str(payload["environment_id"])
    payload["checkpoint_id"] = str(payload["checkpoint_id"])
    for name in ("checkpoint_number", "start_sequence", "end_sequence", "event_count", "key_version", "payload_version"):
        if not isinstance(payload[name], int) or isinstance(payload[name], bool):
            raise CheckpointFormatError(f"{name} must be an integer")
    if payload["signature_algorithm"] != ALGORITHM:
        raise CheckpointFormatError(f"unsupported signature algorithm {payload['signature_algorithm']!r}")
    if payload["payload_version"] != PAYLOAD_VERSION:
        raise CheckpointFormatError(f"unsupported payload version {payload['payload_version']!r}")
    if payload["event_count"] != payload["end_sequence"] - payload["start_sequence"] + 1 or payload["start_sequence"] < 1:
        raise CheckpointFormatError("event_count does not match start_sequence..end_sequence")
    return payload


def canonical_payload(payload: Mapping[str, Any]) -> bytes:
    if set(payload) != set(PAYLOAD_FIELDS):
        raise CheckpointFormatError("checkpoint payload has missing or unexpected fields")
    return canonical_bytes({name: payload[name] for name in PAYLOAD_FIELDS})


def signing_message(payload: Mapping[str, Any]) -> bytes:
    return CHECKPOINT_DOMAIN + canonical_payload(payload)


def checkpoint_hash(payload: Mapping[str, Any]) -> str:
    """The identity the NEXT checkpoint links to (previous_checkpoint_hash)."""
    return hashlib.sha256(signing_message(payload)).hexdigest()


def sign_payload(private_key: Ed25519PrivateKey, payload: Mapping[str, Any]) -> str:
    return base64.b64encode(private_key.sign(signing_message(payload))).decode("ascii")


def public_key_b64(public_key: Ed25519PublicKey) -> str:
    raw = public_key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode("ascii")


def load_public_key(public_key: str) -> Ed25519PublicKey:
    try:
        return Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key, validate=True))
    except Exception as exc:
        raise CheckpointFormatError("not a valid Ed25519 public key") from exc


def fingerprint(public_key: str) -> str:
    """SHA-256 of the raw public key bytes: the short identity shown to humans and pinned by operators."""
    return hashlib.sha256(base64.b64decode(public_key, validate=True)).hexdigest()


def verify_message(public_key: str, message: bytes, signature: str) -> bool:
    try:
        load_public_key(public_key).verify(base64.b64decode(signature, validate=True), message)
        return True
    except (InvalidSignature, CheckpointFormatError, ValueError):
        return False


def verify_payload(public_key: str, payload: Mapping[str, Any], signature: str) -> bool:
    try:
        return verify_message(public_key, signing_message(payload), signature)
    except CheckpointFormatError:
        return False


def make_envelope(payload: Mapping[str, Any], signature: str) -> dict:
    """The self-describing record kept in PostgreSQL and in the protected files: payload, its canonical text, the
    signature (stored separately from the signed bytes) and the key it names."""
    return {
        "format": ENVELOPE_FORMAT,
        "payload": dict(payload),
        "canonical_payload": canonical_payload(payload).decode("ascii"),
        "checkpoint_hash": checkpoint_hash(payload),
        "signature": signature,
        "signing_key_id": payload["signing_key_id"],
        "key_version": payload["key_version"],
        "signature_algorithm": payload["signature_algorithm"],
    }


def check_envelope(envelope: Mapping[str, Any]) -> Optional[str]:
    """None if the envelope is internally consistent, else why not. Says nothing about whether the signature is trusted."""
    try:
        payload = envelope["payload"]
        if envelope.get("format") != ENVELOPE_FORMAT:
            return "unsupported envelope format"
        if canonical_payload(payload).decode("ascii") != envelope["canonical_payload"]:
            return "canonical payload does not match the payload"
        if checkpoint_hash(payload) != envelope["checkpoint_hash"]:
            return "checkpoint hash does not match the payload"
        if (payload["signing_key_id"], payload["key_version"]) != (envelope["signing_key_id"], envelope["key_version"]):
            return "envelope names a different key than the payload"
        return None
    except (KeyError, TypeError, CheckpointFormatError) as exc:
        return f"malformed envelope ({exc})"
