"""Signing a checkpoint, with every check the signer performs on its own.

The signer never signs a hash it is handed. Given only "checkpoint chain X", it:
  1. reads the chain from the (read-only) ledger and re-derives the chain identity, tenant and environment itself;
  2. takes the previous checkpoint from ITS OWN trusted state (rebuilt from signed files if lost), not from the database;
  3. checks that the ledger still contains the event that previous checkpoint committed to (else history was rewritten);
  4. recomputes every SHA-256 event hash from that trusted anchor to the new end and checks continuity;
  5. only then builds the payload, signs it, stores it durably and advances its state.
Anything the caller proposes (number, range, hashes) is compared with what the signer computed and refused on any difference.
"""
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional
from uuid import uuid4

from shared.audit import archive_manifest as am
from shared.audit import checkpoint as cp
from shared.audit import hashing
from shared.audit.signer.config import SignerSettings
from shared.audit.signer.errors import SignerError
from shared.audit.signer.files import AlreadyExists, ArchiveManifestStore, CheckpointStore
from shared.audit.signer.key_manager import KeyManager
from shared.audit.signer.source import DbEventSource
from shared.audit.signer.state import SignerState
from shared.audit.trust import RegistryError, TrustRegistry

log = logging.getLogger("audit.signer")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class SignerService:
    def __init__(self, settings: SignerSettings, source: DbEventSource, clock: Callable[[], datetime] = utcnow):
        self.settings, self.source, self.clock = settings, source, clock
        self.store = CheckpointStore(settings.checkpoint_dir)
        self.replica = CheckpointStore(settings.replica_dir) if settings.replica_dir else None
        self.archives = ArchiveManifestStore(settings.checkpoint_dir)
        self.archive_replica = ArchiveManifestStore(settings.replica_dir) if settings.replica_dir else None
        self.state = SignerState(settings.state_dir)
        self.keys = KeyManager(settings.key_dir, settings.passphrase_file, self.store, settings.signer_id, settings.trust_anchor_fingerprint)

    # ── status / registry ─────────────────────────────────────────────────────────
    async def status(self) -> dict:
        out: dict[str, Any] = {"signer_id": self.settings.signer_id, "key_available": False, "environment_matches": None, "active_key": None,
                               "replica_configured": self.replica is not None, "problem": None}
        try:
            env = await self.source.environment_id()
            data = self.store.read_registry()
            if data is None:
                out["problem"] = "KEY_UNAVAILABLE: no signing key has been initialised (run the init step)"
                return out
            out["environment_matches"] = str(data.get("environment_id")) == env
            trusted, _ = self.keys.active(env) if out["environment_matches"] else (None, None)
            if trusted is None:
                out["problem"] = "ENVIRONMENT_MISMATCH: the keys belong to a different environment than this database"
            else:
                out["key_available"] = True
                out["active_key"] = trusted.public()
        except SignerError as exc:
            out["problem"] = f"{exc.code}: {exc.message}"
        except Exception as exc:  # database unreachable etc.
            out["problem"] = f"{type(exc).__name__}: {exc}"[:300]
        return out

    async def registry_public(self) -> dict:
        env = await self.source.environment_id()
        registry = self.keys.registry(env)
        return {"environment_id": env, "keys": registry.public_list() if registry else []}

    async def rotate(self) -> dict:
        env = await self.source.environment_id()
        self._require_matching_registry(env)
        trusted = self.keys.rotate(env)
        return trusted.public()

    def _require_matching_registry(self, env: str) -> None:
        data = self.store.read_registry()
        if data is not None and str(data.get("environment_id")) != env:
            raise SignerError("ENVIRONMENT_MISMATCH", "the trust registry and keys belong to a different environment than this database; "
                                                       "refusing to sign (another installation's data, or the database was recreated)", 409)

    # ── trusted previous state ────────────────────────────────────────────────────
    def _rebuild_state(self, chain_id: str, env: str, tenant: Optional[str], registry: TrustRegistry) -> Optional[dict]:
        numbers = self.store.numbers(env, tenant)
        if not numbers:
            return None
        previous: Optional[dict] = None
        for expected, number in enumerate(numbers, start=1):
            if number != expected:
                raise SignerError("STATE_REBUILD_FAILED", f"protected storage is missing checkpoint {expected}; cannot rebuild trusted state", 500)
            envelope = self.store.read(env, tenant, number)
            self._check_stored(envelope, previous, chain_id, env, tenant, registry)
            previous = self._state_record(envelope)
        self.state.save(chain_id, previous)  # type: ignore[arg-type]
        log.warning("rebuilt signer state for %s from %d protected checkpoints", chain_id, len(numbers))
        return previous

    @staticmethod
    def _state_record(envelope: dict) -> dict:
        p = envelope["payload"]
        return {"chain_id": p["chain_id"], "environment_id": p["environment_id"], "tenant_id": p["tenant_id"], "checkpoint_number": p["checkpoint_number"],
                "end_sequence": p["end_sequence"], "last_event_hash": p["last_event_hash"], "checkpoint_hash": envelope["checkpoint_hash"],
                "signing_key_id": p["signing_key_id"], "signed_at": p["created_at"], "envelope": envelope}

    def _check_stored(self, envelope: Optional[dict], previous: Optional[dict], chain_id: str, env: str, tenant: Optional[str], registry: TrustRegistry) -> None:
        """A checkpoint read back from storage must be consistent, correctly linked and signed by a key trusted at the time."""
        problem = cp.check_envelope(envelope) if envelope else "missing"
        if problem:
            raise SignerError("STATE_REBUILD_FAILED", f"stored checkpoint is unusable: {problem}", 500)
        p = envelope["payload"]
        key = registry.get(p["signing_key_id"])
        if key is None or not key.valid_at(p["created_at"]) or not cp.verify_payload(key.public_key, p, envelope["signature"]):
            raise SignerError("STATE_REBUILD_FAILED", f"stored checkpoint {p['checkpoint_number']} has no valid trusted signature", 500)
        want_prev = previous["checkpoint_hash"] if previous else cp.checkpoint_genesis_hash(chain_id)
        want_start = previous["end_sequence"] + 1 if previous else 1
        if (p["chain_id"], p["environment_id"], p["tenant_id"]) != (chain_id, env, tenant) or p["previous_checkpoint_hash"] != want_prev \
                or p["start_sequence"] != want_start or p["checkpoint_number"] != (previous["checkpoint_number"] + 1 if previous else 1):
            raise SignerError("STATE_REBUILD_FAILED", f"stored checkpoint {p['checkpoint_number']} is not linked to its predecessor", 500)

    def _trusted_previous(self, chain_id: str, env: str, tenant: Optional[str], registry: TrustRegistry) -> Optional[dict]:
        state = self.state.load(chain_id)
        if state is None:
            return self._rebuild_state(chain_id, env, tenant, registry)
        numbers = self.store.numbers(env, tenant)
        if state["checkpoint_number"] not in numbers:
            raise SignerError("STATE_STORE_MISMATCH", f"the signer recorded checkpoint {state['checkpoint_number']} but protected storage no longer has it", 500)
        if numbers and numbers[-1] > state["checkpoint_number"] + 1:
            raise SignerError("STATE_STORE_MISMATCH", "protected storage holds checkpoints the signer's state does not know about", 500)
        return state

    # ── signing ───────────────────────────────────────────────────────────────────
    async def sign_checkpoint(self, chain_id: str, *, end_sequence: Optional[int] = None, proposal: Optional[dict] = None) -> dict:
        env = await self.source.environment_id()
        self._require_matching_registry(env)
        trusted_key, private = self.keys.active(env)
        registry = self.keys.registry(env)
        async with self.state.lock(chain_id):
            async with self.source.snapshot() as snap:
                chain = await snap.chain(chain_id)
                if chain is None:
                    raise SignerError("CHAIN_NOT_FOUND", "no such chain", 404)
                if str(chain["environment_id"]) != env or hashing.chain_id_for(chain["environment_id"], chain["tenant_id"]) != chain_id \
                        or chain["genesis_hash"] != hashing.genesis_hash(chain_id):
                    raise SignerError("CHAIN_IDENTITY_MISMATCH", "the chain's identity is not consistent with its environment and tenant", 409)
                tenant = str(chain["tenant_id"]) if chain["tenant_id"] else None
                if not trusted_key.covers_tenant(tenant):
                    raise SignerError("KEY_NOT_AUTHORISED", "the active key is not authorised for this tenant", 403)

                previous = self._trusted_previous(chain_id, env, tenant, registry)
                prev_end = previous["end_sequence"] if previous else 0
                prev_number = previous["checkpoint_number"] if previous else 0
                prev_checkpoint_hash = previous["checkpoint_hash"] if previous else cp.checkpoint_genesis_hash(chain_id)
                anchor_hash = previous["last_event_hash"] if previous else hashing.genesis_hash(chain_id)
                number = prev_number + 1

                if prev_end:  # history before this checkpoint must still be the history the last checkpoint committed to
                    anchor_event = await snap.event(chain_id, prev_end)
                    if anchor_event is None:
                        # Events may legitimately have left hot storage, but only after being archived: a manifest THIS signer signed must
                        # name exactly this event (as the end of the archive) with exactly the hash the checkpoint committed to.
                        if not self._archived_boundary(env, tenant, registry, prev_end, previous["last_event_hash"]):
                            raise SignerError("CHAIN_TRUNCATED", f"event {prev_end}, committed by checkpoint {prev_number}, is no longer in the ledger", 409)
                    elif anchor_event["current_hash"] != previous["last_event_hash"]:
                        raise SignerError("ANCHOR_MISMATCH", f"event {prev_end} no longer matches what checkpoint {prev_number} signed: history was rewritten", 409)

                existing = self.store.read(env, tenant, number)
                if existing is not None:  # signed and stored before a crash (or by a concurrent request): adopt, never re-sign
                    return await self._adopt(existing, previous, snap, chain_id, env, tenant, registry)

                head = chain["head_sequence"]
                if end_sequence is not None and end_sequence > head:
                    raise SignerError("EVENTS_NOT_RECORDED", f"the ledger has only {head} events", 409)
                end = min(end_sequence or head, head, prev_end + self.settings.max_events)
                if end <= prev_end:
                    raise SignerError("NOTHING_TO_SIGN", "there are no new events since the last checkpoint", 409)

                last_hash = await self._recompute(snap, chain_id, chain, prev_end, end, anchor_hash)
                computed = {"checkpoint_number": number, "start_sequence": prev_end + 1, "end_sequence": end, "event_count": end - prev_end,
                            "last_event_hash": last_hash, "previous_checkpoint_hash": prev_checkpoint_hash}
                for name, value in (proposal or {}).items():
                    if name in computed and computed[name] != value:
                        raise SignerError("PROPOSAL_MISMATCH", f"the proposed {name} differs from what the signer computed from the ledger", 409)

                # Never earlier than the previous checkpoint (a clock that stepped backwards must not make time regress; verification
                # treats a regression as evidence of backdating).
                created_at = max(hashing.format_timestamp(self.clock()), previous["envelope"]["payload"]["created_at"] if previous else "")
                payload = cp.build_payload(
                    checkpoint_id=uuid4(), tenant_id=tenant, environment_id=env, chain_id=chain_id, **computed,
                    created_at=created_at, signer_id=trusted_key.signer_id, signing_key_id=trusted_key.key_id,
                    key_version=trusted_key.key_version, signature_algorithm=cp.ALGORITHM, payload_version=cp.PAYLOAD_VERSION)
                envelope = cp.make_envelope(payload, cp.sign_payload(private, payload))
                return self._store(envelope, env, tenant, chain_id)

    async def _recompute(self, snap, chain_id: str, chain, prev_end: int, end: int, anchor_hash: str, digest: Optional[am.EventsDigest] = None) -> str:
        running, expected = anchor_hash, prev_end + 1
        async for row in snap.events(chain_id, prev_end, end):
            if row["sequence_number"] != expected:
                raise SignerError("SEQUENCE_GAP", f"event {expected} is missing from the ledger", 409)
            if row["environment_id"] != chain["environment_id"] or row["tenant_id"] != chain["tenant_id"]:
                raise SignerError("TENANT_MISMATCH", f"event {expected} does not belong to this chain", 409)
            if row["hash_version"] not in hashing.SUPPORTED_VERSIONS:
                raise SignerError("UNSUPPORTED_HASH_VERSION", f"event {expected} uses an unknown hash version", 409)
            if row["previous_hash"] != running:
                raise SignerError("HASH_CHAIN_BROKEN", f"event {expected} does not link to the trusted history before it", 409)
            try:
                calculated = hashing.compute_event_hash(chain_id, expected, running, row, row["hash_version"])
            except hashing.CanonicalizationError as exc:
                raise SignerError("HASH_CHAIN_BROKEN", f"event {expected} cannot be hashed: {exc}", 409) from exc
            if calculated != row["current_hash"]:
                raise SignerError("HASH_CHAIN_BROKEN", f"event {expected} does not match its recorded hash", 409)
            running, expected = row["current_hash"], expected + 1
            if digest is not None:
                digest.update(running)
        if expected - 1 != end:
            raise SignerError("SEQUENCE_GAP", f"events {expected}..{end} are missing from the ledger", 409)
        return running

    async def _adopt(self, envelope: dict, previous: Optional[dict], snap, chain_id: str, env: str, tenant: Optional[str], registry: TrustRegistry) -> dict:
        self._check_stored(envelope, previous, chain_id, env, tenant, registry)
        p = envelope["payload"]
        end_event = await snap.event(chain_id, p["end_sequence"])
        if end_event is None or end_event["current_hash"] != p["last_event_hash"]:
            raise SignerError("ANCHOR_MISMATCH", "a stored checkpoint for the next number does not match the ledger", 409)
        self.state.save(chain_id, self._state_record(envelope))
        log.warning("adopted already-stored checkpoint %s #%d (recovery)", chain_id, p["checkpoint_number"])
        return {"envelope": envelope, "path": self._relative(self.store.path(env, tenant, p["checkpoint_number"])), "replica": self._replica_status(envelope, env, tenant),
                "idempotent": True}

    def _replica_status(self, envelope: dict, env: str, tenant: Optional[str]) -> str:
        if self.replica is None:
            return "not_configured"
        p = envelope["payload"]
        try:
            self.replica.write(env, tenant, p["checkpoint_number"], envelope)
            return "ok"
        except AlreadyExists:
            return "ok" if self.replica.read(env, tenant, p["checkpoint_number"]) == envelope else "conflict"
        except Exception as exc:
            if self.settings.replica_required:
                raise SignerError("REPLICA_FAILED", f"the required replica could not be written: {exc}", 503) from exc
            log.error("replica write failed: %s", exc)
            return f"failed: {type(exc).__name__}"

    def _store(self, envelope: dict, env: str, tenant: Optional[str], chain_id: str) -> dict:
        """Durable storage first, then the signer's own state; only then is the checkpoint reported as signed."""
        p = envelope["payload"]
        try:
            path = self.store.write(env, tenant, p["checkpoint_number"], envelope)
        except AlreadyExists as exc:
            raise SignerError("CHECKPOINT_EXISTS", "a different checkpoint with this number already exists; it is never overwritten", 409) from exc
        except OSError as exc:
            raise SignerError("STORAGE_FAILED", f"the protected checkpoint store is not writable: {exc}", 503) from exc
        replica = self._replica_status(envelope, env, tenant)
        self.state.save(chain_id, self._state_record(envelope))
        return {"envelope": envelope, "path": self._relative(path), "replica": replica, "idempotent": False}

    def _relative(self, path: Path) -> str:
        return str(Path(path).relative_to(self.store.root))

    # ── archives ─────────────────────────────────────────────────────────────────
    def _archived_boundary(self, env: str, tenant: Optional[str], registry: TrustRegistry, sequence: int, event_hash: str) -> bool:
        """True if a signed archive manifest in protected storage ends exactly at `sequence` with `event_hash` (trusted without the ledger)."""
        for number in reversed(self.archives.numbers(env, tenant)):
            envelope = self.archives.read(env, tenant, number)
            try:
                self._check_stored_archive(envelope, registry)
            except SignerError:
                continue
            m = envelope["manifest"]
            if m["start_sequence"] <= sequence <= m["end_sequence"]:
                # Within a signed archive the event is accounted for. If it is the archive's last event its hash is checked outright; otherwise
                # the checkpoint's own signed hash (our trusted state) stands, and the archive was signed after this signer re-read the range.
                return m["last_event_hash"] == event_hash if m["end_sequence"] == sequence else True
            if m["end_sequence"] < sequence:
                return False
        return False

    @staticmethod
    def _check_stored_archive(envelope: Optional[dict], registry: TrustRegistry) -> dict:
        problem = am.check_envelope(envelope) if envelope else "missing"
        if problem:
            raise SignerError("ARCHIVE_STATE_UNUSABLE", f"a stored archive manifest is unusable: {problem}", 500)
        m = envelope["manifest"]
        key = registry.get(m["signing_key_id"])
        if key is None or not key.valid_at(m["signed_at"]) or not am.verify_manifest(key.public_key, m, envelope["signature"]):
            raise SignerError("ARCHIVE_STATE_UNUSABLE", f"stored archive {m['archive_number']} has no valid trusted signature", 500)
        return envelope

    def _previous_archive(self, chain_id: str, env: str, tenant: Optional[str], registry: TrustRegistry) -> Optional[dict]:
        numbers = self.archives.numbers(env, tenant)
        previous: Optional[dict] = None
        for expected, number in enumerate(numbers, start=1):
            if number != expected:
                raise SignerError("ARCHIVE_STATE_UNUSABLE", f"protected storage is missing archive manifest {expected}", 500)
            envelope = self._check_stored_archive(self.archives.read(env, tenant, number), registry)
            m = envelope["manifest"]
            want_prev = previous["manifest_hash"] if previous else am.archive_genesis_hash(chain_id)
            want_start = previous["manifest"]["end_sequence"] + 1 if previous else 1
            if m["chain_id"] != chain_id or m["previous_archive_hash"] != want_prev or m["start_sequence"] != want_start or m["archive_number"] != number:
                raise SignerError("ARCHIVE_STATE_UNUSABLE", f"stored archive manifest {number} is not linked to its predecessor", 500)
            previous = envelope
        return previous

    def _coverage(self, env: str, tenant: Optional[str], m: dict) -> None:
        """The archive must end on a signed checkpoint boundary and name exactly the checkpoints that cover it: re-derived from OUR store."""
        cov = m["covered_checkpoints"]
        digest, previous_end = am.CheckpointsDigest(), m["start_sequence"] - 1
        for number in range(cov["first_number"], cov["last_number"] + 1):
            envelope = self.store.read(env, tenant, number)
            problem = cp.check_envelope(envelope) if envelope else "missing"
            if problem:
                raise SignerError("COVERAGE_MISMATCH", f"checkpoint {number} needed to cover the archive is unusable: {problem}", 409)
            p = envelope["payload"]
            if p["chain_id"] != m["chain_id"] or p["start_sequence"] != previous_end + 1:
                raise SignerError("COVERAGE_MISMATCH", f"checkpoint {number} does not continue the archive range", 409)
            previous_end = p["end_sequence"]
            digest.update(envelope["checkpoint_hash"])
            last = envelope
        if previous_end != m["end_sequence"] or last["payload"]["last_event_hash"] != m["last_event_hash"]:
            raise SignerError("COVERAGE_MISMATCH", "the archive does not end exactly on a signed checkpoint boundary", 409)
        if digest.hexdigest() != cov["digest"]:
            raise SignerError("COVERAGE_MISMATCH", "the named checkpoints are not the ones in protected storage", 409)

    async def sign_archive(self, proposed: dict) -> dict:
        """Sign an archive manifest. The signer verifies, from its own trusted state and the ledger, that: the chain/tenant/environment are
        real and consistent; the archive follows the previous signed archive exactly; its range is covered by signed checkpoints and ends on a
        boundary; and the events in the ledger for the range hash to the claimed last hash and digest. It signs nothing else."""
        try:
            claim = am.check_proposed(proposed)
        except am.ManifestFormatError as exc:
            raise SignerError("MANIFEST_INVALID", str(exc), 400) from exc
        env = await self.source.environment_id()
        self._require_matching_registry(env)
        if claim["environment_id"] != env:
            raise SignerError("ENVIRONMENT_MISMATCH", "the manifest names a different environment than this database", 409)
        trusted_key, private = self.keys.active(env)
        registry = self.keys.registry(env)
        chain_id = claim["chain_id"]
        async with self.state.lock("archive:" + chain_id):
            async with self.source.snapshot() as snap:
                chain = await snap.chain(chain_id)
                if chain is None:
                    raise SignerError("CHAIN_NOT_FOUND", "no such chain", 404)
                if str(chain["environment_id"]) != env or hashing.chain_id_for(chain["environment_id"], chain["tenant_id"]) != chain_id \
                        or chain["genesis_hash"] != hashing.genesis_hash(chain_id):
                    raise SignerError("CHAIN_IDENTITY_MISMATCH", "the chain's identity is not consistent with its environment and tenant", 409)
                tenant = str(chain["tenant_id"]) if chain["tenant_id"] else None
                if tenant != claim["tenant_id"]:
                    raise SignerError("TENANT_MISMATCH", "the manifest names a different tenant than the chain", 409)
                if not trusted_key.covers_tenant(tenant):
                    raise SignerError("KEY_NOT_AUTHORISED", "the active key is not authorised for this tenant", 403)

                previous = self._previous_archive(chain_id, env, tenant, registry)
                number = (previous["manifest"]["archive_number"] if previous else 0) + 1
                existing = self.archives.read(env, tenant, claim["archive_number"]) if claim["archive_number"] <= number else None
                if existing is not None:   # signed and stored before a crash, or asked twice: adopt only if it is the SAME archive
                    self._check_stored_archive(existing, registry)
                    old = {k: v for k, v in existing["manifest"].items() if k in am.PROPOSED_FIELDS}
                    if old != claim:
                        raise SignerError("ARCHIVE_EXISTS", f"archive manifest {claim['archive_number']} was already signed with different content; it is never replaced", 409)
                    return {"envelope": existing, "path": self._archive_relative(env, tenant, claim["archive_number"]),
                            "replica": self._archive_replica(existing, env, tenant), "idempotent": True}
                want_prev = previous["manifest_hash"] if previous else am.archive_genesis_hash(chain_id)
                want_first = previous["manifest"]["last_event_hash"] if previous else hashing.genesis_hash(chain_id)
                want_start = previous["manifest"]["end_sequence"] + 1 if previous else 1
                for name, want, got in (("archive_number", number, claim["archive_number"]), ("start_sequence", want_start, claim["start_sequence"]),
                                        ("previous_archive_hash", want_prev, claim["previous_archive_hash"]),
                                        ("first_previous_hash", want_first, claim["first_previous_hash"])):
                    if want != got:
                        raise SignerError("PROPOSAL_MISMATCH", f"the proposed {name} does not follow the last signed archive", 409)
                if claim["end_sequence"] > chain["head_sequence"]:
                    raise SignerError("EVENTS_NOT_RECORDED", f"the ledger has only {chain['head_sequence']} events", 409)
                self._coverage(env, tenant, claim)

                digest = am.EventsDigest()
                last_hash = await self._recompute(snap, chain_id, chain, claim["start_sequence"] - 1, claim["end_sequence"], want_first, digest)
                if last_hash != claim["last_event_hash"] or digest.hexdigest() != claim["events_digest"]:
                    raise SignerError("PROPOSAL_MISMATCH", "the events in the ledger do not match the manifest's last hash or events digest", 409)

                signed_at = max(hashing.format_timestamp(self.clock()), previous["manifest"]["signed_at"] if previous else "")
                manifest = am.build_manifest(claim, signed_at=signed_at, signer_id=trusted_key.signer_id, signing_key_id=trusted_key.key_id,
                                             key_version=trusted_key.key_version)
                envelope = am.make_envelope(manifest, am.sign_manifest(private, manifest))
                try:
                    path = self.archives.write(env, tenant, number, envelope)
                except AlreadyExists as exc:
                    raise SignerError("ARCHIVE_EXISTS", "an archive manifest with this number already exists; it is never overwritten", 409) from exc
                except OSError as exc:
                    raise SignerError("STORAGE_FAILED", f"the protected store is not writable: {exc}", 503) from exc
                log.info("signed archive %s #%d events %d..%d", chain_id, number, claim["start_sequence"], claim["end_sequence"])
                return {"envelope": envelope, "path": self._relative(path), "replica": self._archive_replica(envelope, env, tenant), "idempotent": False}

    def _archive_relative(self, env: str, tenant: Optional[str], number: int) -> str:
        return str(self.archives.path(env, tenant, number).relative_to(self.store.root.resolve()))

    def _archive_replica(self, envelope: dict, env: str, tenant: Optional[str]) -> str:
        if self.archive_replica is None:
            return "not_configured"
        number = envelope["manifest"]["archive_number"]
        try:
            self.archive_replica.write(env, tenant, number, envelope)
            return "ok"
        except AlreadyExists:
            return "ok" if self.archive_replica.read(env, tenant, number) == envelope else "conflict"
        except Exception as exc:
            if self.settings.replica_required:
                raise SignerError("REPLICA_FAILED", f"the required replica could not be written: {exc}", 503) from exc
            return f"failed: {type(exc).__name__}"
