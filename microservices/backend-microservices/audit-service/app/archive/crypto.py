"""Archive encryption: AES-256-GCM in authenticated chunks, a fresh data key per archive, wrapped by a master key (KEK).

  * Memory is bounded: data is processed in chunks (default 1 MiB), never as a whole archive.
  * Every chunk is authenticated with its position and a "final" flag in the AAD, together with a hash of the header, so reordering,
    dropping, truncating or splicing chunks, or editing the header, fails decryption instead of yielding altered plaintext.
  * The data key is random per archive and stored (wrapped, RFC 3394 AES key wrap) only inside the archive's own header. The master key
    lives in its own directory/volume (AUDIT_ARCHIVE_KEY_DIRECTORY), never in PostgreSQL, object storage or the repository; losing it
    means losing access to the archives, so it must be backed up separately (see the README).
  * Several master keys can coexist (rotation): an archive names the key id that wrapped its data key.
"""
import base64
import hashlib
import json
import os
import secrets
import struct
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Iterator, Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.keywrap import InvalidUnwrap, aes_key_unwrap, aes_key_wrap

MAGIC = b"IAAR\x01"
FORMAT_VERSION = 1
ALGORITHM = "AES-256-GCM-CHUNKED"
TAG_BYTES = 16
MAX_HEADER = 16 * 1024
DEFAULT_CHUNK = 1024 * 1024


class ArchiveCryptoError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


# ── master keys ──────────────────────────────────────────────────────────────────────────────────────────
class KeyRing:
    """<dir>/kek-<id>.key (32 random bytes, base64) and <dir>/current (the id used for NEW archives)."""

    def __init__(self, directory: str):
        self.directory = Path(directory)

    def _load(self, kek_id: str) -> bytes:
        if not kek_id.replace("-", "").replace("_", "").isalnum():
            raise ArchiveCryptoError("KEK_INVALID", "bad key id")
        path = self.directory / f"{kek_id}.key"
        try:
            key = base64.b64decode(path.read_text("ascii").strip(), validate=True)
        except FileNotFoundError:
            raise ArchiveCryptoError("KEK_UNAVAILABLE", f"the archive master key {kek_id!r} is not available (run the archive key init step, "
                                                         "or restore the key from its backup)") from None
        except (ValueError, UnicodeDecodeError):
            raise ArchiveCryptoError("KEK_INVALID", f"the archive master key {kek_id!r} is unreadable") from None
        if len(key) != 32:
            raise ArchiveCryptoError("KEK_INVALID", f"the archive master key {kek_id!r} is not 256 bits")
        return key

    def current_id(self) -> str:
        try:
            return (self.directory / "current").read_text("ascii").strip()
        except FileNotFoundError:
            raise ArchiveCryptoError("KEK_UNAVAILABLE", "no archive master key has been initialised (run the archive key init step)") from None

    def current(self) -> tuple[str, bytes]:
        kek_id = self.current_id()
        return kek_id, self._load(kek_id)

    def get(self, kek_id: str) -> bytes:
        return self._load(kek_id)

    def available(self) -> bool:
        try:
            self.current()
            return True
        except ArchiveCryptoError:
            return False


def init_keys(directory: str) -> str:
    """Create the first master key. Refuses if any key exists: regenerating would orphan every existing archive."""
    path = Path(directory)
    path.mkdir(parents=True, exist_ok=True)
    if any(path.glob("kek-*.key")):
        raise ArchiveCryptoError("KEK_EXISTS", "an archive master key already exists; it is never regenerated")
    kek_id = "kek-" + datetime.now(timezone.utc).strftime("%Y%m%d") + "-" + secrets.token_hex(4)
    key_path = path / f"{kek_id}.key"
    fd = os.open(key_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o400)
    with os.fdopen(fd, "w") as handle:
        handle.write(base64.b64encode(secrets.token_bytes(32)).decode("ascii") + "\n")
    (path / "current").write_text(kek_id + "\n")
    os.chmod(path / "current", 0o444)
    return kek_id


# ── writing ──────────────────────────────────────────────────────────────────────────────────────────────
def _nonce(prefix: bytes, index: int) -> bytes:
    return prefix + struct.pack(">Q", index)


def _aad(header_digest: bytes, index: int, final: bool) -> bytes:
    return header_digest + struct.pack(">QB", index, 1 if final else 0)


class EncryptingWriter:
    """Write plaintext in; encrypted chunks go to `sink`. Tracks the SHA-256 and size of everything written (the stored object)."""

    def __init__(self, sink: BinaryIO, keyring: KeyRing, archive_id: str, *, chunk_bytes: int = DEFAULT_CHUNK, compression: str = "zstd"):
        kek_id, kek = keyring.current()
        dek = AESGCM.generate_key(bit_length=256)
        prefix = secrets.token_bytes(4)
        header = json.dumps({"v": FORMAT_VERSION, "alg": ALGORITHM, "archive_id": archive_id, "kek_id": kek_id, "compression": compression,
                             "chunk_bytes": chunk_bytes, "nonce_prefix": base64.b64encode(prefix).decode("ascii"),
                             "wrapped_dek": base64.b64encode(aes_key_wrap(kek, dek)).decode("ascii")}, sort_keys=True, separators=(",", ":")).encode("ascii")
        self.kek_id, self._aead, self._prefix, self._chunk = kek_id, AESGCM(dek), prefix, chunk_bytes
        self._digest = hashlib.sha256(header).digest()
        self._sink, self._buffer, self._index, self._closed = sink, bytearray(), 0, False
        self.sha256, self.bytes_written = hashlib.sha256(), 0
        self._emit(MAGIC + struct.pack(">I", len(header)) + header)

    def _emit(self, data: bytes) -> None:
        self._sink.write(data)
        self.sha256.update(data)
        self.bytes_written += len(data)

    def _seal(self, plaintext: bytes, final: bool) -> None:
        ciphertext = self._aead.encrypt(_nonce(self._prefix, self._index), plaintext, _aad(self._digest, self._index, final))
        self._emit(struct.pack(">I", len(ciphertext)) + ciphertext)
        self._index += 1

    def write(self, data: bytes) -> None:
        if self._closed:
            raise ValueError("writer is closed")
        self._buffer += data
        while len(self._buffer) > self._chunk:      # strictly greater: the last chunk is held back so it can be sealed as final
            self._seal(bytes(self._buffer[:self._chunk]), False)
            del self._buffer[:self._chunk]

    def close(self) -> None:
        if not self._closed:
            self._seal(bytes(self._buffer), True)
            self._buffer.clear()
            self._closed = True


# ── reading ──────────────────────────────────────────────────────────────────────────────────────────────
def read_header(stream: BinaryIO) -> tuple[dict, bytes]:
    if stream.read(len(MAGIC)) != MAGIC:
        raise ArchiveCryptoError("ARCHIVE_FORMAT", "not an audit archive (bad magic)")
    raw = stream.read(4)
    if len(raw) != 4:
        raise ArchiveCryptoError("ARCHIVE_FORMAT", "truncated archive header")
    (length,) = struct.unpack(">I", raw)
    if length > MAX_HEADER:
        raise ArchiveCryptoError("ARCHIVE_FORMAT", "implausible header size")
    blob = stream.read(length)
    if len(blob) != length:
        raise ArchiveCryptoError("ARCHIVE_FORMAT", "truncated archive header")
    try:
        header = json.loads(blob)
    except ValueError:
        raise ArchiveCryptoError("ARCHIVE_FORMAT", "archive header is not valid JSON") from None
    if header.get("v") != FORMAT_VERSION or header.get("alg") != ALGORITHM:
        raise ArchiveCryptoError("ARCHIVE_FORMAT", "unsupported archive format")
    return header, hashlib.sha256(blob).digest()


def decrypt_chunks(stream: BinaryIO, keyring: KeyRing, expected_archive_id: Optional[str] = None) -> Iterator[bytes]:
    """Yield the plaintext chunks (the stream must be seekable: a local file). Raises ArchiveCryptoError('ARCHIVE_TAMPERED') on any authentication failure, reordering or truncation."""
    header, digest = read_header(stream)
    if expected_archive_id is not None and header.get("archive_id") != expected_archive_id:
        raise ArchiveCryptoError("ARCHIVE_TAMPERED", "the archive belongs to a different archive id than its catalog entry")
    try:
        dek = aes_key_unwrap(keyring.get(header["kek_id"]), base64.b64decode(header["wrapped_dek"], validate=True))
        prefix = base64.b64decode(header["nonce_prefix"], validate=True)
    except InvalidUnwrap:
        raise ArchiveCryptoError("ARCHIVE_TAMPERED", "the data key cannot be unwrapped with the master key (wrong key or altered header)") from None
    except (KeyError, ValueError):
        raise ArchiveCryptoError("ARCHIVE_FORMAT", "archive header is incomplete") from None
    aead, index, limit = AESGCM(dek), 0, int(header["chunk_bytes"]) + TAG_BYTES
    while True:
        raw = stream.read(4)
        if not raw:
            raise ArchiveCryptoError("ARCHIVE_TAMPERED", "the archive ends without a final chunk (truncated)")
        if len(raw) != 4:
            raise ArchiveCryptoError("ARCHIVE_TAMPERED", "truncated chunk header")
        (length,) = struct.unpack(">I", raw)
        if length < TAG_BYTES or length > limit:
            raise ArchiveCryptoError("ARCHIVE_TAMPERED", "implausible chunk size")
        body = stream.read(length)
        if len(body) != length:
            raise ArchiveCryptoError("ARCHIVE_TAMPERED", "truncated chunk")
        position = stream.tell()
        final = not stream.read(1)     # the last chunk is the one with nothing after it; anything after a "final" chunk fails authentication
        stream.seek(position)
        try:
            yield aead.decrypt(_nonce(prefix, index), body, _aad(digest, index, final))
        except InvalidTag:
            raise ArchiveCryptoError("ARCHIVE_TAMPERED", f"chunk {index} failed authentication (altered, reordered or truncated)") from None
        index += 1
        if final:
            return
