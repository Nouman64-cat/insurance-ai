"""Verifying one checkpoint envelope against the trusted key registry (pure functions, no I/O).

A checkpoint is only as good as the key behind it: the signer key must be in the registry (a validated chain of signed
statements), must belong to this environment and cover this tenant, must have been active when the checkpoint was created,
and the Ed25519 signature must verify over the complete canonical payload.
"""
from dataclasses import dataclass
from typing import Optional

from shared.audit import checkpoint as cp
from shared.audit.trust import TrustRegistry

VERIFIED = "VERIFIED"
INVALID_HASH_CHAIN = "INVALID_HASH_CHAIN"
INVALID_SIGNATURE = "INVALID_SIGNATURE"
UNTRUSTED_SIGNER = "UNTRUSTED_SIGNER"
MISSING_CHECKPOINT = "MISSING_CHECKPOINT"
CHECKPOINT_MISMATCH = "CHECKPOINT_MISMATCH"
UNSIGNED_EVENTS_PENDING = "UNSIGNED_EVENTS_PENDING"
VERIFICATION_FAILED = "VERIFICATION_FAILED"

# Worst first: the overall state of a verification is the most serious finding.
PRIORITY = [VERIFICATION_FAILED, INVALID_SIGNATURE, UNTRUSTED_SIGNER, MISSING_CHECKPOINT, CHECKPOINT_MISMATCH, INVALID_HASH_CHAIN, UNSIGNED_EVENTS_PENDING, VERIFIED]


@dataclass
class Finding:
    state: str
    code: str
    message: str
    checkpoint_number: Optional[int] = None
    source: Optional[str] = None      # "trusted_storage" | "database"

    def to_api(self) -> dict:
        return {"state": self.state, "code": self.code, "message": self.message, "checkpoint_number": self.checkpoint_number, "source": self.source}


def verify_envelope(envelope: dict, registry: TrustRegistry, *, chain_id: str, environment_id: str, tenant_id: Optional[str],
                    source: str) -> list[Finding]:
    """All problems with this checkpoint's own contents, binding and signature (none = sound)."""
    number = None
    try:
        number = envelope["payload"]["checkpoint_number"]
    except (KeyError, TypeError):
        pass
    problem = cp.check_envelope(envelope)
    if problem:
        return [Finding(CHECKPOINT_MISMATCH, "ENVELOPE_INCONSISTENT", f"checkpoint record is inconsistent: {problem}", number, source)]
    p = envelope["payload"]
    findings: list[Finding] = []
    if (p["chain_id"], p["environment_id"], p["tenant_id"]) != (chain_id, environment_id, tenant_id):
        return [Finding(CHECKPOINT_MISMATCH, "CHECKPOINT_NOT_FOR_THIS_CHAIN",
                        "checkpoint is bound to a different chain, tenant or environment (a checkpoint from elsewhere is never trusted)", number, source)]
    key = registry.get(p["signing_key_id"])
    if key is None:
        return [Finding(UNTRUSTED_SIGNER, "UNKNOWN_SIGNING_KEY", f"signing key {p['signing_key_id']} is not in the trusted registry", number, source)]
    if (key.signer_id, key.key_version) != (p["signer_id"], p["key_version"]):
        findings.append(Finding(UNTRUSTED_SIGNER, "KEY_IDENTITY_MISMATCH", "the checkpoint names a signer or key version that does not match the trusted key", number, source))
    if key.environment_id != environment_id or not key.covers_tenant(tenant_id):
        findings.append(Finding(UNTRUSTED_SIGNER, "KEY_NOT_AUTHORISED", "the signing key is not authorised for this environment or tenant", number, source))
    if not key.valid_at(p["created_at"]):
        findings.append(Finding(UNTRUSTED_SIGNER, "KEY_NOT_ACTIVE_AT_SIGNING", "the key was not active when the checkpoint claims to have been created", number, source))
    if not cp.verify_payload(key.public_key, p, envelope["signature"]):
        findings.append(Finding(INVALID_SIGNATURE, "SIGNATURE_DOES_NOT_VERIFY", "the Ed25519 signature does not verify over the checkpoint payload", number, source))
    return findings
