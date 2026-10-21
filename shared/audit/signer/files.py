"""Durable, never-silently-overwriting file writes, and the layout of the checkpoint store."""
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any, Optional

from shared.audit.signer.errors import SignerError

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_FILE = re.compile(r"^checkpoint-(\d{6,12})\.json$")
_ARCHIVE_FILE = re.compile(r"^archive-(\d{6,12})\.json$")


class AlreadyExists(SignerError):
    def __init__(self, path: Path):
        super().__init__("CHECKPOINT_EXISTS", f"{path.name} already exists and is never overwritten", 409)


def _fsync_dir(directory: Path) -> None:
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return  # directory fsync is not supported on every platform
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def write_new(path: Path, data: bytes, mode: int = 0o444, dir_mode: int = 0o755) -> None:
    """Create `path` with `data`, durably, and fail (AlreadyExists) rather than replace an existing file.

    The bytes go to a temporary file first (flushed to disk), which is then hard-linked into place: the link fails if the
    target exists, so a concurrent or repeated writer can never clobber a signed checkpoint, and a crash leaves either
    nothing or the complete file."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=dir_mode)
    tmp = path.parent / f".{path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        try:
            os.link(tmp, path)
        except FileExistsError:
            raise AlreadyExists(path) from None
        except OSError:  # a filesystem without hard links: fall back to a checked rename
            if path.exists():
                raise AlreadyExists(path) from None
            os.rename(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
    _fsync_dir(path.parent)


def replace_atomic(path: Path, data: bytes, mode: int = 0o644, dir_mode: int = 0o755) -> None:
    """Replace `path` atomically (for files that legitimately change: the trust registry, the signer's own state)."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=dir_mode)
    tmp = path.parent / f".{path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)
    _fsync_dir(path.parent)


def dumps(obj: Any) -> bytes:
    return (json.dumps(obj, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode("ascii")


class CheckpointStore:
    """<root>/<environment_id>/<tenant_id | platform>/checkpoint-000001.json  and  <root>/trust/signing-keys.json

    Every path component is validated (UUIDs only, integer file numbers), so identifiers can't escape the root."""

    def __init__(self, root: Path):
        self.root = Path(root)

    @staticmethod
    def _component(value: Optional[str], what: str) -> str:
        if value is None:
            return "platform"
        value = str(value)
        if not _UUID.match(value):
            raise SignerError("BAD_IDENTIFIER", f"{what} must be a UUID", 400)
        return value

    def directory(self, environment_id: str, tenant_id: Optional[str]) -> Path:
        env, tenant = self._component(environment_id, "environment_id"), self._component(tenant_id, "tenant_id")
        path = (self.root / env / tenant).resolve()
        if self.root.resolve() not in path.parents:
            raise SignerError("BAD_IDENTIFIER", "path escapes the checkpoint store", 400)
        return path

    def path(self, environment_id: str, tenant_id: Optional[str], number: int) -> Path:
        if not isinstance(number, int) or not 1 <= number <= 10**9:
            raise SignerError("BAD_IDENTIFIER", "checkpoint number out of range", 400)
        return self.directory(environment_id, tenant_id) / f"checkpoint-{number:06d}.json"

    @property
    def registry_path(self) -> Path:
        return self.root / "trust" / "signing-keys.json"

    def numbers(self, environment_id: str, tenant_id: Optional[str]) -> list[int]:
        directory = self.directory(environment_id, tenant_id)
        if not directory.is_dir():
            return []
        return sorted(int(m.group(1)) for f in directory.iterdir() if (m := _FILE.match(f.name)))

    def write(self, environment_id: str, tenant_id: Optional[str], number: int, envelope: dict) -> Path:
        path = self.path(environment_id, tenant_id, number)
        write_new(path, dumps(envelope))
        return path

    def read(self, environment_id: str, tenant_id: Optional[str], number: int) -> Optional[dict]:
        path = self.path(environment_id, tenant_id, number)
        try:
            return json.loads(path.read_text("ascii"))
        except FileNotFoundError:
            return None
        except (ValueError, UnicodeDecodeError) as exc:
            raise SignerError("CHECKPOINT_UNREADABLE", f"{path.name} is not valid JSON", 500) from exc

    def read_registry(self) -> Optional[dict]:
        try:
            return json.loads(self.registry_path.read_text("ascii"))
        except FileNotFoundError:
            return None
        except (ValueError, UnicodeDecodeError) as exc:
            raise SignerError("REGISTRY_UNREADABLE", "the trust registry is not valid JSON", 500) from exc

    def write_registry(self, data: dict) -> None:
        replace_atomic(self.registry_path, dumps(data), mode=0o444)


class ArchiveManifestStore(CheckpointStore):
    """<root>/archives/<environment_id>/<tenant_id | platform>/archive-000001.json : signed archive manifests, same rules as checkpoints
    (written once, never overwritten, durable). Lives under the same protected root, outside PostgreSQL."""

    def directory(self, environment_id: str, tenant_id: Optional[str]) -> Path:
        env, tenant = self._component(environment_id, "environment_id"), self._component(tenant_id, "tenant_id")
        path = (self.root / "archives" / env / tenant).resolve()
        if (self.root.resolve() / "archives") not in path.parents:
            raise SignerError("BAD_IDENTIFIER", "path escapes the archive manifest store", 400)
        return path

    def path(self, environment_id: str, tenant_id: Optional[str], number: int) -> Path:
        if not isinstance(number, int) or not 1 <= number <= 10**9:
            raise SignerError("BAD_IDENTIFIER", "archive number out of range", 400)
        return self.directory(environment_id, tenant_id) / f"archive-{number:06d}.json"

    def numbers(self, environment_id: str, tenant_id: Optional[str]) -> list[int]:
        directory = self.directory(environment_id, tenant_id)
        if not directory.is_dir():
            return []
        return sorted(int(m.group(1)) for f in directory.iterdir() if (m := _ARCHIVE_FILE.match(f.name)))
