"""Operator commands for the signer (run inside the signer container):

  python -m shared.audit.signer.cli init      create this installation's key pair + trust root (explicit; refuses to repeat)
  python -m shared.audit.signer.cli status    key / registry / environment status (no secrets)
  python -m shared.audit.signer.cli rotate    add a new key, authorised by the current one
  python -m shared.audit.signer.cli backup --out FILE --passphrase-file FILE
  python -m shared.audit.signer.cli restore --in FILE --passphrase-file FILE

`backup` writes an encrypted archive of the protected checkpoints, trust registry, signer state and the (already
encrypted) private keys. It never includes the key passphrase, which is backed up separately by the operator.
"""
import argparse
import asyncio
import base64
import io
import json
import os
import sys
import tarfile
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from shared.audit.signer.config import SignerSettings
from shared.audit.signer.errors import SignerError
from shared.audit.signer.service import SignerService
from shared.audit.signer.source import DbEventSource

MAGIC = b"IAI-AUDIT-BACKUP1"


def _fernet(passphrase: bytes, salt: bytes) -> Fernet:
    key = Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(passphrase)
    return Fernet(base64.urlsafe_b64encode(key))


def make_backup(settings: SignerSettings, passphrase: bytes) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, directory in (("checkpoints", settings.checkpoint_dir), ("state", settings.state_dir), ("keys", settings.key_dir)):
            if Path(directory).exists():
                tar.add(directory, arcname=name, filter=lambda info: None if info.name.endswith((".lock", ".tmp")) else info)
    salt = os.urandom(16)
    return MAGIC + salt + _fernet(passphrase, salt).encrypt(buffer.getvalue())


def restore_backup(settings: SignerSettings, blob: bytes, passphrase: bytes) -> list[str]:
    """Extract into the configured directories. Never overwrites a differing file; refuses unsafe archive members."""
    if not blob.startswith(MAGIC):
        raise SignerError("BACKUP_INVALID", "not an audit backup file", 400)
    salt, token = blob[len(MAGIC):len(MAGIC) + 16], blob[len(MAGIC) + 16:]
    try:
        data = _fernet(passphrase, salt).decrypt(token)
    except InvalidToken:
        raise SignerError("BACKUP_INVALID", "wrong passphrase or corrupted backup", 400) from None
    targets = {"checkpoints": Path(settings.checkpoint_dir), "state": Path(settings.state_dir), "keys": Path(settings.key_dir)}
    restored: list[str] = []
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for member in tar.getmembers():
            top, _, rest = member.name.partition("/")
            if top not in targets or not (member.isfile() or member.isdir()) or ".." in Path(member.name).parts or member.name.startswith("/"):
                raise SignerError("BACKUP_INVALID", f"unsafe or unexpected archive member {member.name!r}", 400)
            if not member.isfile():
                continue
            destination = targets[top] / rest
            content = tar.extractfile(member).read()  # type: ignore[union-attr]
            if destination.exists():
                if destination.read_bytes() != content:
                    raise SignerError("RESTORE_CONFLICT", f"{destination} already exists with different content; it is never overwritten", 409)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
            os.chmod(destination, 0o400 if top == "keys" else 0o444 if top == "checkpoints" else 0o600)
            restored.append(str(destination))
    return restored


async def _run(args) -> int:
    settings = SignerSettings()
    service = SignerService(settings, DbEventSource(settings.database_url, settings.schema))
    try:
        if args.command == "init":
            env = await service.source.environment_id()
            key = service.keys.initialize(env)
            print(f"Initialised signing key {key.key_id} for environment {env}")
            print(f"Public key fingerprint (SHA-256): {key.fingerprint}")
            print("Record this fingerprint somewhere outside this machine; set AUDIT_TRUST_ANCHOR_FINGERPRINT to pin it.")
            print("Back up the key volume AND the passphrase volume (separately). See audit-service/README.md.")
        elif args.command == "status":
            print(json.dumps(await service.status(), indent=2))
        elif args.command == "rotate":
            key = await service.rotate()
            print(f"Rotated: new active key {key['key_id']} (fingerprint {key['fingerprint']})")
        elif args.command == "backup":
            blob = make_backup(settings, Path(args.passphrase_file).read_bytes().strip())
            Path(args.out).write_bytes(blob)
            print(f"Encrypted backup written to {args.out} ({len(blob)} bytes). The key passphrase is NOT included.")
        elif args.command == "restore":
            done = restore_backup(settings, Path(args.infile).read_bytes(), Path(args.passphrase_file).read_bytes().strip())
            print(f"Restored {len(done)} files (existing identical files were left alone).")
        return 0
    except SignerError as exc:
        print(f"{exc.code}: {exc.message}", file=sys.stderr)
        return 1
    finally:
        await service.source.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(prog="signer")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "status", "rotate"):
        sub.add_parser(name)
    backup = sub.add_parser("backup")
    backup.add_argument("--out", required=True)
    backup.add_argument("--passphrase-file", required=True)
    restore = sub.add_parser("restore")
    restore.add_argument("--in", dest="infile", required=True)
    restore.add_argument("--passphrase-file", required=True)
    sys.exit(asyncio.run(_run(parser.parse_args())))


if __name__ == "__main__":
    main()
