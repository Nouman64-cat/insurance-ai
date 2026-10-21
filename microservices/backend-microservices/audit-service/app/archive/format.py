"""The archive file: events as newline-delimited JSON, compressed with zstd, encrypted in authenticated chunks (crypto.py).

The builder and reader are synchronous and bounded in memory (one batch / one chunk at a time); the worker runs them in threads.
Events are written with every column, using the same value encodings the hash uses (UUIDs and timestamps as text), so a reader can
recompute every event's SHA-256 from the archive alone.
"""
import hashlib
import json
import math
import os
import struct
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import BinaryIO, Iterable, Iterator, Mapping, Optional
from uuid import UUID

import zstandard

from app.archive import crypto
from app.models import EVENT_COLUMNS
from shared.audit import archive_manifest as am
from shared.audit import hashing

_TIME_COLUMNS = ("occurred_at", "recorded_at")


class ArchiveBuildError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def event_record(row: Mapping) -> dict:
    """A ledger row as a JSON-safe dict (the same text forms the hash canonicalisation produces)."""
    out = {}
    for name in EVENT_COLUMNS:
        value = row[name]
        if isinstance(value, UUID):
            value = str(value)
        elif isinstance(value, datetime):
            value = hashing.format_timestamp(value)
        out[name] = value
    return out


def event_line(record: Mapping) -> bytes:
    return json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii") + b"\n"


# ── bloom filter (catalog-side lookup of "which archives might mention this entity / actor / case") ───────────────────
BLOOM_MIN_BITS, BLOOM_MAX_BITS, BLOOM_HASHES = 8192, 8 * 1024 * 1024, 7
LOOKUP_KINDS = ("entity", "actor", "case")


def bloom_bits_for(event_count: int) -> int:
    wanted = max(event_count, 1) * 3 * 10          # ~3 lookup values per event, ~10 bits each => ~1% false positives
    bits = 1 << max(math.ceil(math.log2(wanted)), 1)
    return max(BLOOM_MIN_BITS, min(bits, BLOOM_MAX_BITS))


def _positions(chain_id: str, kind: str, value: str, bits: int, hashes: int) -> list[int]:
    digest = hashlib.sha256(f"{chain_id}\x00{kind}\x00{value}".encode("utf-8")).digest()
    a, b = struct.unpack(">QQ", digest[:16])
    return [(a + i * (b | 1)) % bits for i in range(hashes)]


class Bloom:
    def __init__(self, chain_id: str, bits: int, hashes: int = BLOOM_HASHES, data: Optional[bytes] = None):
        self.chain_id, self.bits, self.hashes = chain_id, bits, hashes
        self.data = bytearray(data) if data is not None else bytearray(bits // 8)

    def add(self, kind: str, value: Optional[str]) -> None:
        if value:
            for pos in _positions(self.chain_id, kind, str(value), self.bits, self.hashes):
                self.data[pos >> 3] |= 1 << (pos & 7)

    def might_contain(self, kind: str, value: str) -> bool:
        return all(self.data[pos >> 3] & (1 << (pos & 7)) for pos in _positions(self.chain_id, kind, str(value), self.bits, self.hashes))


# ── building ────────────────────────────────────────────────────────────────────────────────────────────────────────
@dataclass
class BuildResult:
    path: Path
    stored_sha256: str
    stored_bytes: int
    plaintext_sha256: str
    plaintext_bytes: int
    events_digest: str
    event_count: int
    first_sequence: int
    last_sequence: int
    last_event_hash: str
    kek_id: str
    first_occurred_at: str
    last_occurred_at: str
    first_recorded_at: str
    last_recorded_at: str
    modules: list = field(default_factory=list)
    actions: list = field(default_factory=list)
    entity_types: list = field(default_factory=list)
    bloom: bytes = b""
    bloom_bits: int = 0


class ArchiveBuilder:
    """add_batch(rows)* then finish(). Every event is re-checked as it is written: contiguous sequence, linkage to the previous hash and
    its own recomputed SHA-256. An archive can therefore never be built from a broken range, even if an earlier check was skipped."""

    def __init__(self, path: Path, keyring: crypto.KeyRing, *, archive_id: str, chain_id: str, start_sequence: int, end_sequence: int,
                 first_previous_hash: str, chunk_bytes: int, compression: str, level: int):
        self.path, self.chain_id, self.start, self.end = Path(path), chain_id, start_sequence, end_sequence
        self._file: BinaryIO = open(self.path, "xb")
        self._writer = crypto.EncryptingWriter(self._file, keyring, archive_id, chunk_bytes=chunk_bytes, compression=compression)
        self._compressor = zstandard.ZstdCompressor(level=level).compressobj() if compression == "zstd" else None
        if compression not in ("zstd", "none"):
            raise ArchiveBuildError("UNSUPPORTED_COMPRESSION", f"unknown compression {compression!r}")
        self._plain, self._plain_bytes = hashlib.sha256(), 0
        self._digest = am.EventsDigest()
        self._expected, self._previous = start_sequence, first_previous_hash
        self._bloom = Bloom(chain_id, bloom_bits_for(end_sequence - start_sequence + 1))
        self._modules: set[str] = set()
        self._actions: set[str] = set()
        self._entities: set[str] = set()
        self._first: Optional[dict] = None
        self._lo_occurred = self._hi_occurred = self._lo_recorded = self._hi_recorded = ""

    def add_batch(self, rows: Iterable[Mapping]) -> None:
        out = bytearray()
        for row in rows:
            record = event_record(row)
            seq = record["sequence_number"]
            if record["chain_id"] != self.chain_id or seq != self._expected or seq > self.end:
                raise ArchiveBuildError("EXPORT_SEQUENCE", f"expected event {self._expected} of {self.chain_id}, read {record['chain_id']}#{seq}")
            if record["previous_hash"] != self._previous:
                raise ArchiveBuildError("EXPORT_CHAIN_BROKEN", f"event {seq} does not link to the one before it")
            try:
                calculated = hashing.compute_event_hash(self.chain_id, seq, self._previous, record, record["hash_version"])
            except hashing.CanonicalizationError as exc:
                raise ArchiveBuildError("EXPORT_CHAIN_BROKEN", f"event {seq} cannot be hashed: {exc}") from exc
            if calculated != record["current_hash"]:
                raise ArchiveBuildError("EXPORT_CHAIN_BROKEN", f"event {seq} does not match its recorded hash")
            self._previous, self._expected = record["current_hash"], seq + 1
            self._digest.update(record["current_hash"])
            out += event_line(record)
            self._index(record)
        if out:
            self._plain.update(out)
            self._plain_bytes += len(out)
            self._writer.write(self._compressor.compress(bytes(out)) if self._compressor else bytes(out))

    def _index(self, record: dict) -> None:
        self._modules.add(record["module"])
        self._actions.add(record["action"])
        self._entities.add(record["entity_type"])
        self._bloom.add("entity", record["entity_id"])
        self._bloom.add("actor", record["actor_id"])
        self._bloom.add("case", record["case_id"])
        occurred, recorded = record["occurred_at"], record["recorded_at"]
        if self._first is None:
            self._first = record
            self._lo_occurred = self._hi_occurred = occurred
            self._lo_recorded = self._hi_recorded = recorded
        self._lo_occurred, self._hi_occurred = min(self._lo_occurred, occurred), max(self._hi_occurred, occurred)
        self._lo_recorded, self._hi_recorded = min(self._lo_recorded, recorded), max(self._hi_recorded, recorded)

    def finish(self) -> BuildResult:
        if self._expected - 1 != self.end or self._first is None:
            self.abort()
            raise ArchiveBuildError("EXPORT_INCOMPLETE", f"the ledger returned events up to {self._expected - 1}, expected {self.end}")
        if self._compressor is not None:
            self._writer.write(self._compressor.flush())
        self._writer.close()
        self._file.flush()
        os.fsync(self._file.fileno())
        self._file.close()
        return BuildResult(
            path=self.path, stored_sha256=self._writer.sha256.hexdigest(), stored_bytes=self._writer.bytes_written,
            plaintext_sha256=self._plain.hexdigest(), plaintext_bytes=self._plain_bytes, events_digest=self._digest.hexdigest(),
            event_count=self.end - self.start + 1, first_sequence=self.start, last_sequence=self.end, last_event_hash=self._previous,
            kek_id=self._writer.kek_id, first_occurred_at=self._lo_occurred, last_occurred_at=self._hi_occurred,
            first_recorded_at=self._lo_recorded, last_recorded_at=self._hi_recorded, modules=sorted(self._modules), actions=sorted(self._actions),
            entity_types=sorted(self._entities), bloom=bytes(self._bloom.data), bloom_bits=self._bloom.bits)

    def abort(self) -> None:
        try:
            self._file.close()
        except Exception:
            pass


# ── reading ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def iter_event_lines(path: Path, keyring: crypto.KeyRing, archive_id: Optional[str] = None) -> Iterator[bytes]:
    """Decrypt, decompress and split into event lines. Memory use is one chunk plus one line."""
    with open(path, "rb") as stream:
        header, _ = crypto.read_header(stream)
        stream.seek(0)
        decompressor = zstandard.ZstdDecompressor().decompressobj() if header.get("compression") == "zstd" else None
        pending = b""
        try:
            for chunk in crypto.decrypt_chunks(stream, keyring, archive_id):
                data = decompressor.decompress(chunk) if decompressor else chunk
                pending += data
                *lines, pending = pending.split(b"\n")
                yield from lines
        except zstandard.ZstdError as exc:
            raise crypto.ArchiveCryptoError("ARCHIVE_TAMPERED", f"the compressed stream is corrupt: {exc}") from exc
        if pending:
            raise crypto.ArchiveCryptoError("ARCHIVE_TAMPERED", "the archive ends in the middle of an event")


def iter_events(path: Path, keyring: crypto.KeyRing, archive_id: Optional[str] = None) -> Iterator[dict]:
    for line in iter_event_lines(path, keyring, archive_id):
        try:
            yield json.loads(line)
        except ValueError:
            raise crypto.ArchiveCryptoError("ARCHIVE_TAMPERED", "an event line in the archive is not valid JSON") from None
