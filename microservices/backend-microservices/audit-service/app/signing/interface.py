"""The signing provider interface. The Audit Service never holds a private key; it asks a provider to checkpoint a chain.

A provider returns a checkpoint that is already signed AND stored in protected storage, or raises SigningError. Providers:
  * "local"  an isolated audit-signer service with its own key volume (app/signing/local_signer.py);
  * (future) Vault transit, cloud KMS/HSM: implement CheckpointSigner and register it in signer_factory.py.
Nothing else in the service depends on how signing is done.
"""
from dataclasses import dataclass
from typing import Optional, Protocol


class SigningError(Exception):
    """A signing failure with a stable code. `retryable` failures are retried with backoff; every failure raises an alert."""

    def __init__(self, code: str, message: str, *, retryable: bool = True):
        super().__init__(message)
        self.code, self.message, self.retryable = code, message, retryable


@dataclass
class SignedCheckpoint:
    envelope: dict          # payload, canonical payload, hash, signature, key id (shared/audit/checkpoint.py)
    path: str               # relative path of the protected copy
    replica: str            # "ok" | "not_configured" | "failed: ..." | "conflict"
    idempotent: bool        # True when this was already signed (crash recovery / repeated request)


@dataclass
class SignedArchive:
    envelope: dict          # manifest, canonical manifest, hash, signature, key id (shared/audit/archive_manifest.py)
    path: str               # relative path of the protected copy
    replica: str
    idempotent: bool


class CheckpointSigner(Protocol):
    async def sign_checkpoint(self, chain_id: str, *, end_sequence: Optional[int] = None, proposal: Optional[dict] = None) -> SignedCheckpoint: ...
    async def sign_archive(self, manifest: dict) -> SignedArchive: ...
    async def status(self) -> dict: ...
    async def public_keys(self) -> dict: ...
    async def rotate(self) -> dict: ...
