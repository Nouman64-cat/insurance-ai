"""Ed25519 key generation, encrypted storage and loading. Only the signer process uses this.

Keys are generated ONLY by the explicit `init` step (and by an authorised rotation), never on a restart:
  * the private key is stored as PKCS#8 PEM encrypted with a passphrase (cryptography's BestAvailableEncryption);
  * the passphrase lives in a different place (a secret file, not the key volume, never an environment variable);
  * if the key or passphrase is missing or wrong the signer says so and stops signing; it does not make a new key.

Files:  <key_dir>/ed25519-private-v<N>.pem  (0400, directory 0700)   <passphrase_file> (0400)
"""
import logging
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from shared.audit.checkpoint import public_key_b64
from shared.audit.hashing import format_timestamp
from shared.audit.signer.errors import SignerError
from shared.audit.signer.files import CheckpointStore, write_new
from shared.audit.trust import TrustRegistry, TrustedKey, RegistryError, make_statement, new_registry_data, sign_entry

log = logging.getLogger("audit.signer.keys")


def _now() -> str:
    return format_timestamp(datetime.now(timezone.utc))


class KeyManager:
    def __init__(self, key_dir: Path, passphrase_file: Path, store: CheckpointStore, signer_id: str,
                 anchor_fingerprint: Optional[str] = None):
        self.key_dir, self.passphrase_file, self.store, self.signer_id = Path(key_dir), Path(passphrase_file), store, signer_id
        self.anchor_fingerprint = anchor_fingerprint

    # ── paths ─────────────────────────────────────────────────────────────────────
    def key_path(self, version: int) -> Path:
        return self.key_dir / f"ed25519-private-v{version}.pem"

    def key_id(self, version: int) -> str:
        return f"{self.signer_id}-v{version}"

    # ── registry ──────────────────────────────────────────────────────────────────
    def registry(self, environment_id: Optional[str] = None) -> Optional[TrustRegistry]:
        data = self.store.read_registry()
        if data is None:
            return None
        try:
            return TrustRegistry.parse(data, environment_id=environment_id, anchor_fingerprint=self.anchor_fingerprint)
        except RegistryError as exc:
            raise SignerError("REGISTRY_INVALID", f"the trust registry is not valid: {exc}", 500) from exc

    # ── passphrase and private keys ───────────────────────────────────────────────
    def _passphrase(self) -> bytes:
        try:
            value = self.passphrase_file.read_bytes().strip()
        except FileNotFoundError:
            raise SignerError("KEY_UNAVAILABLE", "the key passphrase is not available to the signer", 503) from None
        if not value:
            raise SignerError("KEY_UNAVAILABLE", "the key passphrase file is empty", 503)
        return value

    def load_private(self, version: int) -> Ed25519PrivateKey:
        path = self.key_path(version)
        try:
            pem = path.read_bytes()
        except FileNotFoundError:
            raise SignerError("KEY_UNAVAILABLE", f"private key v{version} is missing; restore it from backup (a new key is never created implicitly)", 503) from None
        try:
            key = serialization.load_pem_private_key(pem, password=self._passphrase())
        except SignerError:
            raise
        except Exception:
            raise SignerError("KEY_INVALID", f"private key v{version} cannot be decrypted (wrong passphrase or corrupted file)", 503) from None
        if not isinstance(key, Ed25519PrivateKey):
            raise SignerError("KEY_INVALID", "the private key is not an Ed25519 key", 503)
        return key

    def active(self, environment_id: str) -> tuple[TrustedKey, Ed25519PrivateKey]:
        """The registry's active key and its private half, verified to be a matching pair."""
        registry = self.registry(environment_id)
        if registry is None or registry.active is None:
            raise SignerError("KEY_UNAVAILABLE", "no signing key has been initialised for this environment (run the init step)", 503)
        trusted = registry.active
        private = self.load_private(trusted.key_version)
        if public_key_b64(private.public_key()) != trusted.public_key:
            raise SignerError("KEY_INVALID", "the private key on disk does not match the trusted public key", 503)
        return trusted, private

    def _write_key(self, version: int, key: Ed25519PrivateKey) -> None:
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.BestAvailableEncryption(self._passphrase()))
        self.key_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.key_dir, 0o700)
        except OSError:
            pass
        write_new(self.key_path(version), pem, mode=0o400, dir_mode=0o700)

    # ── explicit lifecycle ────────────────────────────────────────────────────────
    def initialize(self, environment_id: str) -> TrustedKey:
        """Create this installation's key pair and trust root. Refuses if any key or registry already exists."""
        has_keys = self.key_dir.exists() and any(self.key_dir.glob("ed25519-private-v*.pem"))
        if has_keys or self.store.read_registry() is not None:
            raise SignerError("ALREADY_INITIALISED", "keys or a trust registry already exist for this installation; refusing to create new ones", 409)
        if not self.passphrase_file.exists():
            self.passphrase_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            write_new(self.passphrase_file, secrets.token_urlsafe(48).encode("ascii"), mode=0o400, dir_mode=0o700)
        key = Ed25519PrivateKey.generate()
        self._write_key(1, key)
        statement = make_statement(action="bootstrap", signer_id=self.signer_id, key_id=self.key_id(1), key_version=1, environment_id=environment_id,
                                   public_key=public_key_b64(key.public_key()), created_at=_now(), previous_key_id=None)
        self.store.write_registry(new_registry_data(environment_id, [sign_entry(statement, key)]))
        log.info("initialised signing key %s (fingerprint %s)", self.key_id(1), statement["fingerprint"])
        return self.registry(environment_id).active  # type: ignore[union-attr]

    def rotate(self, environment_id: str) -> TrustedKey:
        """Add a new key, authorised by the current one. The old public key stays trusted for its historical checkpoints."""
        current, current_private = self.active(environment_id)
        data = self.store.read_registry()
        version = current.key_version + 1
        key = Ed25519PrivateKey.generate()
        self._write_key(version, key)
        statement = make_statement(action="rotate", signer_id=self.signer_id, key_id=self.key_id(version), key_version=version,
                                   environment_id=environment_id, public_key=public_key_b64(key.public_key()), created_at=_now(),
                                   previous_key_id=current.key_id)
        data["keys"].append(sign_entry(statement, key, current_private, current.key_id))
        TrustRegistry.parse(data, environment_id=environment_id, anchor_fingerprint=self.anchor_fingerprint)  # never publish an invalid registry
        self.store.write_registry(data)
        log.info("rotated signing key %s -> %s", current.key_id, self.key_id(version))
        return self.registry(environment_id).active  # type: ignore[union-attr]
