"""The trusted public-key registry.

Which keys may sign checkpoints is NOT decided by a database row (the database is the thing being protected). It is
decided by a registry file kept in the protected storage, outside PostgreSQL, written only by the signer and readable
(read-only) by the verifier. The registry is a chain of signed statements:

  * entry 1 (`bootstrap`): created by the explicit initialisation step; self-signed by the new key (proof of possession).
    Operators can pin its fingerprint (AUDIT_TRUST_ANCHOR_FINGERPRINT) so even a replaced registry file is rejected.
  * entry n+1 (`rotate`): signed by the NEW key (possession) and by the PREVIOUS key (authorisation). A key that no
    one holds the previous key for cannot be added, and a rotation cannot be forged from the database.

The status of every key is derived from this chain (a key is retired the moment its successor is activated), never from a
mutable field. Old public keys stay in the registry forever so historical checkpoints keep verifying.

Checkpoints from another installation are not trusted: a key is bound to one environment_id, and a registry for a
different environment is rejected.
"""
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping, Optional

from shared.audit.checkpoint import ALGORITHM, fingerprint, load_public_key, verify_message
from shared.audit.hashing import canonical_bytes

REGISTRY_FORMAT = 1
STATEMENT_VERSION = 1
STATEMENT_DOMAIN = b"insurance-ai/audit-key-statement/v1\x00"
TENANT_SCOPE_ALL = "*"


class RegistryError(ValueError):
    """The registry is malformed or does not form a valid chain of trust."""


def statement_message(statement: Mapping[str, Any]) -> bytes:
    return STATEMENT_DOMAIN + canonical_bytes(dict(statement))


def make_statement(*, action: str, signer_id: str, key_id: str, key_version: int, environment_id: str, public_key: str,
                   created_at: str, previous_key_id: Optional[str], tenant_scope: str = TENANT_SCOPE_ALL) -> dict:
    return {
        "statement_version": STATEMENT_VERSION, "action": action, "signer_id": signer_id, "key_id": key_id,
        "key_version": key_version, "environment_id": str(environment_id), "tenant_scope": tenant_scope,
        "public_key": public_key, "fingerprint": fingerprint(public_key), "algorithm": ALGORITHM,
        "created_at": created_at, "activated_at": created_at, "previous_key_id": previous_key_id,
    }


def sign_entry(statement: dict, new_private_key, previous_private_key=None, previous_key_id: Optional[str] = None) -> dict:
    """A registry entry: the statement, signed by the new key and (for a rotation) by the previous key."""
    import base64
    message = statement_message(statement)
    entry = {"statement": statement, "key_signature": base64.b64encode(new_private_key.sign(message)).decode("ascii")}
    if previous_private_key is not None:
        entry["authorizing_key_id"] = previous_key_id
        entry["authorizing_signature"] = base64.b64encode(previous_private_key.sign(message)).decode("ascii")
    return entry


@dataclass(frozen=True)
class TrustedKey:
    signer_id: str
    key_id: str
    key_version: int
    environment_id: str
    tenant_scope: str
    public_key: str
    fingerprint: str
    algorithm: str
    activated_at: str
    retired_at: Optional[str]            # when the next key was activated

    @property
    def status(self) -> str:
        return "RETIRED" if self.retired_at else "ACTIVE"

    def valid_at(self, moment: str) -> bool:
        """Was this key allowed to sign at `moment` (an ISO-8601 UTC timestamp, which sorts lexically)?"""
        return self.activated_at <= moment and (self.retired_at is None or moment < self.retired_at)

    def covers_tenant(self, tenant_id: Optional[str]) -> bool:
        return self.tenant_scope == TENANT_SCOPE_ALL or self.tenant_scope == (tenant_id or "platform")

    def public(self) -> dict:
        return {"signer_id": self.signer_id, "key_id": self.key_id, "key_version": self.key_version, "environment_id": self.environment_id,
                "tenant_scope": self.tenant_scope, "public_key": self.public_key, "fingerprint": self.fingerprint, "algorithm": self.algorithm,
                "status": self.status, "created_at": self.activated_at, "activated_at": self.activated_at, "retired_at": self.retired_at}


class TrustRegistry:
    def __init__(self, environment_id: str, keys: list[TrustedKey]):
        self.environment_id = environment_id
        self.keys = keys
        self._by_id = {k.key_id: k for k in keys}

    @property
    def active(self) -> Optional[TrustedKey]:
        return self.keys[-1] if self.keys else None

    def get(self, key_id: str) -> Optional[TrustedKey]:
        return self._by_id.get(key_id)

    def public_list(self) -> list[dict]:
        return [k.public() for k in self.keys]

    @classmethod
    def parse(cls, data: Mapping[str, Any], *, environment_id: Optional[str] = None, anchor_fingerprint: Optional[str] = None) -> "TrustRegistry":
        """Validate the whole chain of trust. Raises RegistryError unless every entry is properly signed."""
        if not isinstance(data, Mapping) or data.get("format") != REGISTRY_FORMAT or not isinstance(data.get("keys"), list):
            raise RegistryError("unsupported registry format")
        registry_env = str(data.get("environment_id") or "")
        if environment_id is not None and registry_env != str(environment_id):
            raise RegistryError("this registry belongs to a different environment")
        keys: list[TrustedKey] = []
        previous: Optional[TrustedKey] = None
        for index, entry in enumerate(data["keys"], start=1):
            try:
                st = entry["statement"]
                message = statement_message(st)
                public_key, key_id = st["public_key"], st["key_id"]
            except (KeyError, TypeError) as exc:
                raise RegistryError(f"entry {index} is malformed") from exc
            if st.get("statement_version") != STATEMENT_VERSION or st.get("algorithm") != ALGORITHM:
                raise RegistryError(f"entry {index} uses an unsupported statement or algorithm")
            if st.get("environment_id") != registry_env:
                raise RegistryError(f"entry {index} belongs to a different environment")
            try:
                if fingerprint(public_key) != st.get("fingerprint"):
                    raise RegistryError(f"entry {index} fingerprint does not match its public key")
                load_public_key(public_key)
            except ValueError as exc:
                raise RegistryError(f"entry {index} has an invalid public key") from exc
            if st.get("key_version") != index or key_id in {k.key_id for k in keys}:
                raise RegistryError(f"entry {index} has an unexpected key version or a repeated key id")
            if not verify_message(public_key, message, entry.get("key_signature", "")):
                raise RegistryError(f"entry {index} is not signed by the key it introduces")
            if previous is None:
                if st.get("action") != "bootstrap" or st.get("previous_key_id") is not None:
                    raise RegistryError("the first entry must be the bootstrap of the trust root")
                if anchor_fingerprint and anchor_fingerprint.lower() != st["fingerprint"]:
                    raise RegistryError("the trust root does not match the pinned anchor fingerprint")
            else:
                if st.get("action") != "rotate" or st.get("previous_key_id") != previous.key_id or entry.get("authorizing_key_id") != previous.key_id:
                    raise RegistryError(f"entry {index} is not a rotation from the previous key")
                if not verify_message(previous.public_key, message, entry.get("authorizing_signature", "")):
                    raise RegistryError(f"entry {index} rotation is not authorised by the previous key")
                if st["activated_at"] < previous.activated_at:
                    raise RegistryError(f"entry {index} activates before its predecessor")
                keys[-1] = _retire(previous, st["activated_at"])
            trusted = TrustedKey(st["signer_id"], key_id, index, registry_env, st.get("tenant_scope", TENANT_SCOPE_ALL), public_key,
                                 st["fingerprint"], ALGORITHM, st["activated_at"], None)
            keys.append(trusted)
            previous = trusted
        return cls(registry_env, keys)


def _retire(key: TrustedKey, at: str) -> TrustedKey:
    return TrustedKey(key.signer_id, key.key_id, key.key_version, key.environment_id, key.tenant_scope, key.public_key,
                      key.fingerprint, key.algorithm, key.activated_at, at)


def new_registry_data(environment_id: str, entries: list[dict]) -> dict:
    return {"format": REGISTRY_FORMAT, "environment_id": str(environment_id), "keys": entries}


def parse_time(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
