"""Signed archive manifests: what an archive claims about itself, and the Ed25519 signature that makes the claim hard to forge.

An archive is a contiguous range of ONE chain (events start..end), ending exactly on a signed checkpoint boundary. Its manifest
commits to the range, to the hashes at both ends (so archives link into the chain without gaps), to the encrypted object's
checksum, and to the checkpoints that cover the range. The isolated signer signs it with the SAME Ed25519 key as checkpoints
(domain-separated, so a manifest signature can never be replayed as a checkpoint signature or the reverse).

    signature = Ed25519( key, "insurance-ai/audit-archive/v1\0" || canonical_json(manifest) )
    manifest_hash = SHA-256( "insurance-ai/audit-archive/v1\0" || canonical_json(manifest) )

Archives of a chain form their own hash chain: each names the previous archive's manifest_hash (the first names a genesis value),
so a deleted or substituted archive is detectable even if every remaining archive is individually valid.
"""
import base64
import hashlib
from typing import Any, Mapping, Optional

from shared.audit import checkpoint as cp
from shared.audit.hashing import canonical_bytes

MANIFEST_VERSION = 1
ARCHIVE_DOMAIN = b"insurance-ai/audit-archive/v1\x00"
ARCHIVE_GENESIS_DOMAIN = b"insurance-ai/audit-archive-genesis/v1\x00"   # must equal archive_genesis_hash() in migration 0004
ENVELOPE_FORMAT = 1

# Everything the audit service proposes (the signer adds the SIGNED_FIELDS and checks the rest against the ledger itself).
PROPOSED_FIELDS = (
    "archive_id", "tenant_id", "environment_id", "chain_id", "archive_number", "manifest_version", "start_sequence", "end_sequence",
    "event_count", "first_previous_hash", "last_event_hash", "previous_archive_hash", "events_digest", "plaintext_sha256", "plaintext_bytes",
    "stored_sha256", "stored_bytes", "compression", "encryption", "covered_checkpoints", "first_occurred_at", "last_occurred_at",
    "first_recorded_at", "last_recorded_at", "created_at",
)
SIGNED_FIELDS = ("signed_at", "signer_id", "signing_key_id", "key_version", "signature_algorithm")
MANIFEST_FIELDS = PROPOSED_FIELDS + SIGNED_FIELDS
_INTEGERS = ("archive_number", "manifest_version", "start_sequence", "end_sequence", "event_count", "plaintext_bytes", "stored_bytes", "key_version")


class ManifestFormatError(ValueError):
    pass


def archive_genesis_hash(chain_id: str) -> str:
    return hashlib.sha256(ARCHIVE_GENESIS_DOMAIN + chain_id.encode("utf-8")).hexdigest()


class EventsDigest:
    """SHA-256 over every event hash of the range in sequence order (one per line). Lets the signer, which re-reads the ledger, and a
    later verifier, which decrypts the archive, agree on the content of the range without exchanging it."""

    def __init__(self) -> None:
        self._h = hashlib.sha256(b"insurance-ai/audit-archive-events/v1\x00")

    def update(self, event_hash: str) -> None:
        self._h.update(event_hash.encode("ascii") + b"\n")

    def hexdigest(self) -> str:
        return self._h.hexdigest()


def events_digest(hashes) -> str:
    digest = EventsDigest()
    for value in hashes:
        digest.update(value)
    return digest.hexdigest()


class CheckpointsDigest:
    """Commits to the exact list of checkpoints (by hash, in order) that cover an archive's range."""

    def __init__(self) -> None:
        self._h = hashlib.sha256(b"insurance-ai/audit-archive-checkpoints/v1\x00")

    def update(self, checkpoint_hash: str) -> None:
        self._h.update(checkpoint_hash.encode("ascii") + b"\n")

    def hexdigest(self) -> str:
        return self._h.hexdigest()


COVERAGE_FIELDS = ("first_number", "last_number", "count", "digest")


def check_proposed(fields: Mapping[str, Any]) -> dict:
    """Validate the shape of what the audit service proposes. Returns a normalised copy."""
    missing = [f for f in PROPOSED_FIELDS if f not in fields]
    extra = [f for f in fields if f not in PROPOSED_FIELDS]
    if missing or extra:
        raise ManifestFormatError(f"archive manifest fields differ from the spec (missing {missing}, unexpected {extra})")
    out = {name: fields[name] for name in PROPOSED_FIELDS}
    out["tenant_id"] = None if out["tenant_id"] is None else str(out["tenant_id"])
    out["environment_id"], out["archive_id"] = str(out["environment_id"]), str(out["archive_id"])
    for name in _INTEGERS:
        if name in out and (not isinstance(out[name], int) or isinstance(out[name], bool)):
            raise ManifestFormatError(f"{name} must be an integer")
    if out["manifest_version"] != MANIFEST_VERSION:
        raise ManifestFormatError(f"unsupported manifest version {out['manifest_version']!r}")
    if out["start_sequence"] < 1 or out["event_count"] != out["end_sequence"] - out["start_sequence"] + 1:
        raise ManifestFormatError("event_count does not match start_sequence..end_sequence")
    for name in ("first_previous_hash", "last_event_hash", "previous_archive_hash", "events_digest", "plaintext_sha256", "stored_sha256"):
        value = out[name]
        if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise ManifestFormatError(f"{name} must be a lowercase SHA-256 hex digest")
    coverage = out["covered_checkpoints"]
    if not isinstance(coverage, dict) or set(coverage) != set(COVERAGE_FIELDS) or coverage["count"] != coverage["last_number"] - coverage["first_number"] + 1 \
            or coverage["count"] < 1:
        raise ManifestFormatError("an archive must name the contiguous checkpoints that cover it (first_number, last_number, count, digest)")
    return out


def build_manifest(proposed: Mapping[str, Any], *, signed_at: str, signer_id: str, signing_key_id: str, key_version: int) -> dict:
    manifest = check_proposed(proposed)
    manifest.update(signed_at=signed_at, signer_id=signer_id, signing_key_id=signing_key_id, key_version=key_version, signature_algorithm=cp.ALGORITHM)
    return manifest


def canonical_manifest(manifest: Mapping[str, Any]) -> bytes:
    if set(manifest) != set(MANIFEST_FIELDS):
        raise ManifestFormatError("manifest has missing or unexpected fields")
    return canonical_bytes({name: manifest[name] for name in MANIFEST_FIELDS})


def signing_message(manifest: Mapping[str, Any]) -> bytes:
    return ARCHIVE_DOMAIN + canonical_manifest(manifest)


def manifest_hash(manifest: Mapping[str, Any]) -> str:
    return hashlib.sha256(signing_message(manifest)).hexdigest()


def sign_manifest(private_key, manifest: Mapping[str, Any]) -> str:
    return base64.b64encode(private_key.sign(signing_message(manifest))).decode("ascii")


def verify_manifest(public_key: str, manifest: Mapping[str, Any], signature: str) -> bool:
    try:
        return cp.verify_message(public_key, signing_message(manifest), signature)
    except ManifestFormatError:
        return False


def make_envelope(manifest: Mapping[str, Any], signature: str) -> dict:
    return {
        "format": ENVELOPE_FORMAT, "manifest": dict(manifest), "canonical_manifest": canonical_manifest(manifest).decode("ascii"),
        "manifest_hash": manifest_hash(manifest), "signature": signature, "signing_key_id": manifest["signing_key_id"],
        "key_version": manifest["key_version"], "signature_algorithm": manifest["signature_algorithm"],
    }


def check_envelope(envelope: Mapping[str, Any]) -> Optional[str]:
    """None if the envelope is internally consistent, else why not. Says nothing about whether the signature is trusted."""
    try:
        manifest = envelope["manifest"]
        if envelope.get("format") != ENVELOPE_FORMAT:
            return "unsupported envelope format"
        if canonical_manifest(manifest).decode("ascii") != envelope["canonical_manifest"]:
            return "canonical manifest does not match the manifest"
        if manifest_hash(manifest) != envelope["manifest_hash"]:
            return "manifest hash does not match the manifest"
        if (manifest["signing_key_id"], manifest["key_version"]) != (envelope["signing_key_id"], envelope["key_version"]):
            return "envelope names a different key than the manifest"
        return None
    except (KeyError, TypeError, ManifestFormatError) as exc:
        return f"malformed envelope ({exc})"
