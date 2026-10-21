"""Verifying archives: independent of the catalog, which is only an index.

Layers, each able to fail on its own (a finding names exactly which):
  1. the signed manifest: parses, is internally consistent, is signed by a key the trusted registry accepts for this environment,
     tenant and moment, and matches the copy in the signer's protected store (outside PostgreSQL and outside object storage);
  2. the catalog row agrees with the manifest (a row edited to point elsewhere is caught);
  3. the stored object: exists, has the size and SHA-256 the manifest commits to (replaced / corrupted / deleted objects are caught);
  4. (deep) the content: decrypts (authenticated chunks), decompresses, and every event is re-hashed, linked, contiguous, and digests
     to what the manifest and the signer saw; the checkpoint coverage is re-derived from the protected checkpoint store;
  5. the archive chain of a chain: archives are contiguous, linked by hash, none missing from catalog or from protected storage.
"""
import hashlib
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from app.archive import crypto, format as fmt
from app.archive.store import ObjectStore, StoreError
from app.checkpoints.storage import TrustedStorage
from app.trust import key_registry
from shared.audit import archive_manifest as am
from shared.audit import checkpoint as cp
from shared.audit import hashing
from shared.audit.trust import RegistryError

VERIFIED, FAILED = "VERIFIED", "FAILED"


@dataclass
class Finding:
    code: str
    message: str
    archive_number: Optional[int] = None

    def to_api(self) -> dict:
        return {"code": self.code, "message": self.message, "archive_number": self.archive_number}


@dataclass
class ArchiveVerification:
    archive_id: str
    deep: bool
    findings: list[Finding] = field(default_factory=list)
    details: dict = field(default_factory=dict)
    duration_ms: int = 0

    @property
    def state(self) -> str:
        return FAILED if self.findings else VERIFIED

    @property
    def code(self) -> Optional[str]:
        return self.findings[0].code if self.findings else None

    def to_api(self) -> dict:
        return {"archive_id": self.archive_id, "state": self.state, "deep": self.deep, "findings": [f.to_api() for f in self.findings],
                "details": self.details, "duration_ms": self.duration_ms}


class ArchiveVerifier:
    def __init__(self, reader: ObjectStore, keyring: crypto.KeyRing, storage: TrustedStorage, work_dir: Path):
        self.reader, self.keyring, self.storage, self.work_dir = reader, keyring, storage, Path(work_dir)

    # ── layer 1+2: the signed manifest ──
    def check_manifest_envelope(self, envelope: Any, row: Optional[dict], env: str, tenant: Optional[str], findings: list[Finding],
                                number: Optional[int]) -> Optional[dict]:
        return check_manifest_envelope(self.storage, envelope, row, env, tenant, findings, number)

    # ── the whole check of one cataloged archive ──
    async def verify(self, row: dict, *, deep: bool, env: str) -> ArchiveVerification:
        import asyncio
        return await asyncio.to_thread(self._verify_sync, row, deep, env)

    def _verify_sync(self, row: dict, deep: bool, env: str) -> ArchiveVerification:
        started = time.monotonic()
        result = ArchiveVerification(str(row["archive_id"]), deep)
        findings, number = result.findings, row["archive_number"]
        tenant = str(row["tenant_id"]) if row["tenant_id"] else None
        # the manifest: protected copy (the root of trust) first, then the object-store copy must be identical to it
        protected = self.storage.read_archive(env, tenant, number) if self.storage.available() else None
        if not self.storage.available():
            findings.append(Finding("TRUSTED_STORAGE_UNAVAILABLE", "the independent protected store cannot be read, so manifests cannot be checked against it", number))
        elif protected is None:
            findings.append(Finding("MANIFEST_PROTECTED_COPY_MISSING", "the signed manifest is missing from protected storage", number))
        elif protected.get("unreadable"):
            findings.append(Finding("MANIFEST_INVALID", "the protected manifest copy is unreadable", number))
            protected = None
        try:
            stored = json.loads(self.reader.get_bytes(row["signature_key"]))
        except StoreError as exc:
            findings.append(Finding("MANIFEST_MISSING" if exc.code == "STORE_NOT_FOUND" else "STORE_UNAVAILABLE", exc.message, number))
            stored = None
        except ValueError:
            findings.append(Finding("MANIFEST_INVALID", "the manifest object in object storage is not valid JSON", number))
            stored = None
        if protected and stored is not None and protected != stored:
            findings.append(Finding("MANIFEST_COPIES_DIFFER", "the manifest in object storage differs from the signed copy in protected storage", number))
        envelope = protected or stored
        manifest = self.check_manifest_envelope(envelope, row, env, tenant, findings, number) if envelope else None
        if manifest is None:
            result.duration_ms = int((time.monotonic() - started) * 1000)
            return result
        result.details["manifest_hash"] = envelope["manifest_hash"]
        # the stored object
        try:
            info = self.reader.head(row["data_key"], row.get("data_version_id"))
        except StoreError as exc:
            findings.append(Finding("STORE_UNAVAILABLE", exc.message, number))
            info = None
        else:
            if info is None:
                findings.append(Finding("ARCHIVE_OBJECT_MISSING", "the archive object is missing from object storage", number))
            elif info.size != manifest["stored_bytes"]:
                findings.append(Finding("ARCHIVE_CHECKSUM_MISMATCH", f"the archive object has {info.size} bytes, the signed manifest says {manifest['stored_bytes']}", number))
        if info is not None and not findings:
            if deep:
                self._deep(row, manifest, number, result)
            else:
                result.details["checked"] = "manifest, signature, catalog agreement, object size"
        coverage = self._check_coverage(manifest, env, tenant, number)
        findings.extend(coverage)
        result.duration_ms = int((time.monotonic() - started) * 1000)
        return result

    def _check_coverage(self, m: dict, env: str, tenant: Optional[str], number: int) -> list[Finding]:
        """Re-derive from the protected checkpoint store that the archive ends on a signed checkpoint boundary."""
        out: list[Finding] = []
        if not self.storage.available():
            return out
        cov, digest, previous_end, last = m["covered_checkpoints"], am.CheckpointsDigest(), m["start_sequence"] - 1, None
        for n in range(cov["first_number"], cov["last_number"] + 1):
            envelope = self.storage.read(env, tenant, n)
            problem = None if envelope and not envelope.get("unreadable") else "missing or unreadable"
            problem = problem or cp.check_envelope(envelope)
            if problem or envelope["payload"]["start_sequence"] != previous_end + 1:
                out.append(Finding("COVERAGE_MISMATCH", f"checkpoint {n} that covers the archive is {problem or 'not contiguous'}", number))
                return out
            previous_end, last = envelope["payload"]["end_sequence"], envelope
            digest.update(envelope["checkpoint_hash"])
        if previous_end != m["end_sequence"] or last["payload"]["last_event_hash"] != m["last_event_hash"] or digest.hexdigest() != cov["digest"]:
            out.append(Finding("COVERAGE_MISMATCH", "the archive does not end on the signed checkpoints it names", number))
        return out

    # ── layer 4: content ──
    def _deep(self, row: dict, m: dict, number: int, result: ArchiveVerification) -> None:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        local = self.work_dir / f"verify-{row['archive_id']}.iaar"
        findings = result.findings
        try:
            try:
                self.reader.get_file(row["data_key"], local, row.get("data_version_id"))
            except StoreError as exc:
                findings.append(Finding("STORE_UNAVAILABLE" if exc.retryable else "ARCHIVE_OBJECT_MISSING", exc.message, number))
                return
            digest = hashlib.sha256()
            with open(local, "rb") as f:
                for block in iter(lambda: f.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != m["stored_sha256"]:
                findings.append(Finding("ARCHIVE_CHECKSUM_MISMATCH", "the archive object's SHA-256 differs from the signed manifest (replaced or corrupted)", number))
                return
            try:
                derived = verify_content(local, m, self.keyring)
            except crypto.ArchiveCryptoError as exc:
                findings.append(Finding("KEK_UNAVAILABLE" if exc.code.startswith("KEK_") else "ARCHIVE_TAMPERED", exc.message, number))
                return
            except ContentError as exc:
                findings.append(Finding(exc.code, exc.message, number))
                return
            result.details.update({"events_verified": derived["events"], "plaintext_sha256": derived["plaintext_sha256"], "hash_chain": "verified from archive contents"})
        finally:
            local.unlink(missing_ok=True)


def check_manifest_envelope(storage: TrustedStorage, envelope: Any, row: Optional[dict], env: str, tenant: Optional[str], findings: list[Finding],
                            number: Optional[int]) -> Optional[dict]:
    """Returns the manifest if it is acceptable (signature trusted), else records findings and returns None."""
    problem = am.check_envelope(envelope) if isinstance(envelope, dict) else "not a JSON object"
    if problem:
        findings.append(Finding("MANIFEST_INVALID", f"the archive manifest is inconsistent: {problem}", number))
        return None
    m = envelope["manifest"]
    try:
        registry = key_registry.load_registry(env, str(storage.root))
    except key_registry.RegistryUnavailable as exc:
        findings.append(Finding("TRUSTED_REGISTRY_UNAVAILABLE", str(exc), number))
        return None
    except RegistryError as exc:
        findings.append(Finding("UNTRUSTED_SIGNER", f"the trusted key registry is not a valid chain of trust: {exc}", number))
        return None
    key = registry.get(m["signing_key_id"])
    if key is None or (key.signer_id, key.key_version) != (m["signer_id"], m["key_version"]) or key.environment_id != env \
            or not key.covers_tenant(tenant) or not key.valid_at(m["signed_at"]):
        findings.append(Finding("UNTRUSTED_SIGNER", "the manifest is signed by a key the trusted registry does not accept for this environment, tenant and time", number))
        return None
    if not am.verify_manifest(key.public_key, m, envelope["signature"]):
        findings.append(Finding("MANIFEST_SIGNATURE_INVALID", "the Ed25519 signature does not verify over the manifest", number))
        return None
    if (m["environment_id"], m["tenant_id"]) != (env, tenant):
        findings.append(Finding("MANIFEST_WRONG_SCOPE", "the manifest is bound to a different tenant or environment", number))
        return None
    if row is not None:
        _compare_catalog(m, envelope, row, findings)
    return m


def _compare_catalog(m: dict, envelope: dict, row: dict, findings: list[Finding]) -> None:
    pairs = {"archive_id": (m["archive_id"], str(row["archive_id"])), "chain_id": (m["chain_id"], row["chain_id"]),
             "archive_number": (m["archive_number"], row["archive_number"]), "start_sequence": (m["start_sequence"], row["start_sequence"]),
         "end_sequence": (m["end_sequence"], row["end_sequence"]), "event_count": (m["event_count"], row["event_count"]),
         "first_previous_hash": (m["first_previous_hash"], row["first_previous_hash"]), "last_event_hash": (m["last_event_hash"], row["last_event_hash"]),
         "previous_archive_hash": (m["previous_archive_hash"], row["previous_archive_hash"]), "manifest_hash": (envelope["manifest_hash"], row["manifest_hash"]),
         "archive_checksum": (m["stored_sha256"], row["archive_checksum"]), "size_bytes": (m["stored_bytes"], row["size_bytes"])}
    bad = [name for name, (a, b) in pairs.items() if a != b]
    if bad:
        findings.append(Finding("CATALOG_MANIFEST_MISMATCH", f"the catalog entry disagrees with the signed manifest on: {', '.join(bad)}", m["archive_number"]))


class ContentError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def verify_content(path: Path, m: dict, keyring: crypto.KeyRing, *, collect_metadata: bool = False, sink=None) -> dict:
    """Decrypt and re-verify every event of an archive against its manifest. Returns derived facts (and, optionally, hands each event to
    `sink` as it passes, for retrieval). Raises ContentError / ArchiveCryptoError on the first problem."""
    chain_id, expected, previous = m["chain_id"], m["start_sequence"], m["first_previous_hash"]
    plain, plain_bytes, digest = hashlib.sha256(), 0, am.EventsDigest()
    meta = {"modules": set(), "actions": set(), "entity_types": set(), "bloom": None, "lo_o": None, "hi_o": None, "lo_r": None, "hi_r": None}
    bloom = fmt.Bloom(chain_id, fmt.bloom_bits_for(m["event_count"])) if collect_metadata else None
    for line in fmt.iter_event_lines(path, keyring, m["archive_id"]):
        plain.update(line + b"\n")
        plain_bytes += len(line) + 1
        try:
            record = json.loads(line)
        except ValueError:
            raise ContentError("ARCHIVE_TAMPERED", "an event line is not valid JSON") from None
        seq = record.get("sequence_number")
        if record.get("chain_id") != chain_id or seq != expected:
            raise ContentError("ARCHIVE_SEQUENCE_BROKEN", f"expected event {expected} of {chain_id}, found {record.get('chain_id')}#{seq}")
        if (record.get("environment_id"), record.get("tenant_id")) != (m["environment_id"], m["tenant_id"]):
            raise ContentError("ARCHIVE_WRONG_SCOPE", f"event {seq} belongs to a different tenant or environment")
        if record.get("previous_hash") != previous:
            raise ContentError("ARCHIVE_CHAIN_BROKEN", f"event {seq} does not link to the one before it")
        try:
            calculated = hashing.compute_event_hash(chain_id, seq, previous, record, record["hash_version"])
        except (hashing.CanonicalizationError, KeyError) as exc:
            raise ContentError("ARCHIVE_CHAIN_BROKEN", f"event {seq} cannot be hashed: {exc}") from exc
        if calculated != record["current_hash"]:
            raise ContentError("ARCHIVE_CHAIN_BROKEN", f"event {seq} does not match its recorded hash")
        previous, expected = record["current_hash"], seq + 1
        digest.update(previous)
        if collect_metadata:
            meta["modules"].add(record["module"]); meta["actions"].add(record["action"]); meta["entity_types"].add(record["entity_type"])
            bloom.add("entity", record["entity_id"]); bloom.add("actor", record["actor_id"]); bloom.add("case", record["case_id"])
            o, r = record["occurred_at"], record["recorded_at"]
            meta["lo_o"], meta["hi_o"] = min(meta["lo_o"] or o, o), max(meta["hi_o"] or o, o)
            meta["lo_r"], meta["hi_r"] = min(meta["lo_r"] or r, r), max(meta["hi_r"] or r, r)
        if sink is not None:
            sink(record)
    if expected - 1 != m["end_sequence"]:
        raise ContentError("ARCHIVE_INCOMPLETE", f"the archive holds events up to {expected - 1}, the manifest says {m['end_sequence']}")
    if previous != m["last_event_hash"]:
        raise ContentError("ARCHIVE_CHAIN_BROKEN", "the last event hash differs from the signed manifest")
    if digest.hexdigest() != m["events_digest"]:
        raise ContentError("ARCHIVE_DIGEST_MISMATCH", "the events do not digest to the value the signer saw")
    if plain.hexdigest() != m["plaintext_sha256"] or plain_bytes != m["plaintext_bytes"]:
        raise ContentError("ARCHIVE_DIGEST_MISMATCH", "the decompressed content differs from the manifest")
    out = {"events": m["event_count"], "plaintext_sha256": plain.hexdigest(), "plaintext_bytes": plain_bytes}
    if collect_metadata:
        out.update(modules=sorted(meta["modules"]), actions=sorted(meta["actions"]), entity_types=sorted(meta["entity_types"]), bloom=bytes(bloom.data),
                   bloom_bits=bloom.bits, first_occurred_at=meta["lo_o"], last_occurred_at=meta["hi_o"], first_recorded_at=meta["lo_r"], last_recorded_at=meta["hi_r"])
    return out
