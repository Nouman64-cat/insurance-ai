"""Canonical JSON, JSONL and SHA-256 helpers.

Everything the lake hashes goes through canonical_json, so the same case always has the same checksum, whatever order its
keys were written in or which tool produced it.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Iterable, List, Optional, Tuple


def canonical_json(value: Any) -> str:
    """Sorted keys, no extra whitespace, UTF-8 characters kept. NaN and Infinity are refused (they are not valid JSON)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def canonical_bytes(value: Any) -> bytes:
    return canonical_json(value).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def content_hash(value: Any) -> str:
    """SHA-256 of a JSON value in canonical form."""
    return sha256_hex(canonical_bytes(value))


def to_jsonl(records: Iterable[Any]) -> bytes:
    """One canonical JSON document per line, newline-terminated. An empty list gives empty bytes."""
    return "".join(canonical_json(r) + "\n" for r in records).encode("utf-8")


def parse_jsonl(data: bytes) -> List[Tuple[int, Optional[Any], Optional[str]]]:
    """[(line_number, value, error)] for every non-blank line; exactly one of value and error is set. Line numbers start at 1."""
    out: List[Tuple[int, Optional[Any], Optional[str]]] = []
    text = data.decode("utf-8-sig")
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            out.append((number, json.loads(line), None))
        except ValueError as exc:
            out.append((number, None, f"invalid JSON: {exc}"))
    return out
