"""Evidence packages: everything an auditor needs to check an archive WITHOUT trusting this service.

A zip with the signed manifest, the covering signed checkpoints, the trusted public keys, the catalog entry, a fresh verification report
and `verify_evidence.py`, a standalone script (needs only Python and `cryptography`) that re-checks the manifest signature, the checkpoint
signatures and their linkage. The encrypted archive itself is included only on request; the master key never is.
"""
import io
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from app.archive import repository as repo
from app.archive.store import ObjectStore
from app.archive.verify import ArchiveVerification
from shared.audit.hashing import format_timestamp

README = """Audit archive evidence package
==============================
archive:       {archive_id}  (chain {chain_id}, archive #{archive_number}, events {start}..{end})
generated at:  {generated}
verification:  {state} (see verification.json)

Files
  manifest.json      the signed manifest (what the archive claims)
  signature.json     the manifest, its canonical text, hash and Ed25519 signature
  checkpoints.json   the signed checkpoints that cover the archive's range
  trusted-keys.json  the public keys of the signer registry (a chain of signed key statements)
  catalog.json       the catalog entry (an index; NOT a trust anchor)
  verification.json  a verification run performed when this package was built
  verify_evidence.py standalone checker:  python3 verify_evidence.py     (pip install cryptography)
{data_line}
What this proves: the manifest was signed by a key in the registry, the checkpoints are signed and contiguous, and the manifest names exactly
those checkpoints and boundary hashes. To verify the archive CONTENT you need the archive object and the master key held by the operator.
What it does not prove: anything about events after the archive's last checkpoint, or that the signer's host was not itself compromised.
"""

VERIFY_SCRIPT = r'''"""Standalone check of an audit archive evidence package. Needs: Python 3.9+ and `pip install cryptography`."""
import base64, hashlib, json, sys
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

ARCHIVE_DOMAIN = b"insurance-ai/audit-archive/v1\x00"
CHECKPOINT_DOMAIN = b"insurance-ai/audit-checkpoint/v1\x00"
CHECKPOINTS_DIGEST = b"insurance-ai/audit-archive-checkpoints/v1\x00"


def canon(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")


def verify(public_key_b64, message, signature_b64):
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64)).verify(base64.b64decode(signature_b64), message)
        return True
    except (InvalidSignature, ValueError):
        return False


def main():
    envelope = json.load(open("signature.json")); checkpoints = json.load(open("checkpoints.json"))["checkpoints"]
    keys = {k["key_id"]: k for k in json.load(open("trusted-keys.json")).get("keys", [])}
    problems = []
    m = envelope["manifest"]
    if canon(m).decode() != envelope["canonical_manifest"]:
        problems.append("canonical manifest does not match the manifest")
    if hashlib.sha256(ARCHIVE_DOMAIN + canon(m)).hexdigest() != envelope["manifest_hash"]:
        problems.append("manifest hash is wrong")
    key = keys.get(m["signing_key_id"])
    if key is None:
        problems.append("signing key %s is not in trusted-keys.json" % m["signing_key_id"])
    elif not verify(key["public_key"], ARCHIVE_DOMAIN + canon(m), envelope["signature"]):
        problems.append("MANIFEST SIGNATURE DOES NOT VERIFY")
    cursor, digest, last = m["start_sequence"] - 1, hashlib.sha256(CHECKPOINTS_DIGEST), None
    for e in checkpoints:
        p = e["payload"]
        k = keys.get(p["signing_key_id"])
        if k is None or not verify(k["public_key"], CHECKPOINT_DOMAIN + canon(p), e["signature"]):
            problems.append("checkpoint %s signature does not verify" % p["checkpoint_number"])
        if p["start_sequence"] != cursor + 1:
            problems.append("checkpoint %s does not continue the range" % p["checkpoint_number"])
        cursor, last = p["end_sequence"], e
        digest.update(e["checkpoint_hash"].encode() + b"\n")
    cov = m["covered_checkpoints"]
    if cursor != m["end_sequence"] or last is None or last["payload"]["last_event_hash"] != m["last_event_hash"]:
        problems.append("the checkpoints do not end exactly at the archive boundary")
    if digest.hexdigest() != cov["digest"] or len(checkpoints) != cov["count"]:
        problems.append("the checkpoints are not the ones the manifest names")
    print("archive %s events %s..%s" % (m["archive_id"], m["start_sequence"], m["end_sequence"]))
    if problems:
        print("FAILED:"); [print(" -", p) for p in problems]; sys.exit(1)
    print("OK: manifest signature, %d checkpoint signatures and linkage verified" % len(checkpoints))


main()
'''


def build(entry: dict, verification: ArchiveVerification, *, manifest_envelope: dict, checkpoints: list[dict], registry: Optional[dict],
          data_path: Optional[Path] = None) -> bytes:
    buffer = io.BytesIO()
    now = format_timestamp(datetime.now(timezone.utc))
    dump = lambda obj: json.dumps(obj, sort_keys=True, indent=2, default=str)
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("README.txt", README.format(archive_id=entry["archive_id"], chain_id=entry["chain_id"], archive_number=entry["archive_number"], start=entry["start_sequence"],
                                               end=entry["end_sequence"], generated=now, state=verification.state,
                                               data_line="  data.iaar          the encrypted, compressed archive (needs the master key)\n" if data_path else ""))
        z.writestr("manifest.json", dump(manifest_envelope["manifest"]))
        z.writestr("signature.json", dump(manifest_envelope))
        z.writestr("checkpoints.json", dump({"checkpoints": checkpoints}))
        z.writestr("trusted-keys.json", dump(registry or {"keys": []}))
        z.writestr("catalog.json", dump(repo.catalog_to_api(entry)))
        z.writestr("verification.json", dump(verification.to_api()))
        z.writestr("verify_evidence.py", VERIFY_SCRIPT)
        if data_path:
            z.write(data_path, "data.iaar")
    return buffer.getvalue()
