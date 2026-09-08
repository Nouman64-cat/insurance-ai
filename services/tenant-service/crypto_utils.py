"""Symmetric encryption for secrets stored in the database.

Currently used for the LLM provider API keys a SuperAdmin enters
(llm_provider_config.api_key_encrypted). Uses Fernet (AES-128-CBC + HMAC)
from the `cryptography` package, which is already a dependency.

The key comes from the CONFIG_ENCRYPTION_KEY env var — a urlsafe-base64
32-byte key, generate one with:

    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

If CONFIG_ENCRYPTION_KEY is unset, encrypt/decrypt raise — callers should
treat "cannot store a key" as a configuration error, not crash a request.
"""

from __future__ import annotations

import os

from cryptography.fernet import Fernet, InvalidToken

CONFIG_ENCRYPTION_KEY = os.environ.get("CONFIG_ENCRYPTION_KEY", "").strip()


class EncryptionUnavailable(RuntimeError):
    """Raised when CONFIG_ENCRYPTION_KEY is missing or malformed."""


def _fernet() -> Fernet:
    if not CONFIG_ENCRYPTION_KEY:
        raise EncryptionUnavailable(
            "CONFIG_ENCRYPTION_KEY is not set — cannot store or read encrypted "
            "secrets. Generate one with: python -c \"from cryptography.fernet "
            "import Fernet; print(Fernet.generate_key().decode())\""
        )
    try:
        return Fernet(CONFIG_ENCRYPTION_KEY.encode())
    except (ValueError, TypeError) as exc:
        raise EncryptionUnavailable(f"CONFIG_ENCRYPTION_KEY is malformed: {exc}") from exc


def is_available() -> bool:
    """True when a usable encryption key is configured."""
    try:
        _fernet()
        return True
    except EncryptionUnavailable:
        return False


def encrypt_secret(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt_secret(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken as exc:
        # Wrong key, or the ciphertext was written under a different key.
        raise EncryptionUnavailable(
            "Stored secret could not be decrypted — CONFIG_ENCRYPTION_KEY may "
            "have changed since it was saved."
        ) from exc
