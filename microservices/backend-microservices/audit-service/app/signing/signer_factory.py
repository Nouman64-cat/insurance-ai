"""Chooses the signing provider from AUDIT_SIGNING_PROVIDER. Adding Vault / a KMS means a new class and one line here."""
from typing import Optional

from app.config import Settings
from app.signing.interface import CheckpointSigner
from app.signing.local_signer import LocalSignerClient

RESERVED = {"vault", "kms", "hsm", "aws-kms"}   # planned enterprise providers: not implemented in this stage


class UnsupportedProvider(RuntimeError):
    pass


def get_signer(settings: Settings) -> Optional[CheckpointSigner]:
    if not settings.signing_enabled:
        return None
    provider = settings.signing_provider
    if provider == "local":
        return LocalSignerClient(settings.signer_url, settings.signer_service_key, settings.signer_timeout_seconds)
    if provider in RESERVED:
        raise UnsupportedProvider(f"signing provider {provider!r} is reserved for a later stage; use AUDIT_SIGNING_PROVIDER=local")
    raise UnsupportedProvider(f"unknown signing provider {provider!r}")
