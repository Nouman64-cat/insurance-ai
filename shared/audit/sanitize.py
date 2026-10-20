"""Turns arbitrary values into audit-safe JSON.

Audit payloads are structured records, not request logs. Before anything is queued, this module:

  * redacts credentials and secrets by key name (passwords, tokens, API/private keys, OTPs, card numbers, ...);
  * masks or redacts personal identifiers (CNIC, phone, e-mail, date of birth, address, bank details);
  * omits raw medical and document content (OCR text, lab results, diagnoses, file bytes, base64 payloads);
  * shortens long free text, bounds depth and size;
  * converts everything to canonical-friendly JSON: no floats (they become decimal strings), no NaN, no NUL bytes,
    UUIDs/datetimes/enums as strings.

It is deliberately conservative and idempotent: sanitizing already-sanitized data changes nothing. Key matching works
on the words of a key (snake_case, camelCase, kebab-case all split alike), so `total_tokens` (a usage metric) is kept
while `access_token` and `hashedPassword` are redacted.
"""
import base64
import json
import re
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from enum import Enum
from typing import Any
from uuid import UUID

REDACTED = "[REDACTED]"
OMITTED = "[OMITTED]"

MAX_DEPTH = 6
MAX_ITEMS = 100
MAX_STRING = 500
MAX_KEY = 64
MAX_JSON_BYTES = 16_384

# A key containing any of these words is a credential: its value is never stored.
_SECRET_WORDS = frozenset({
    "password", "passwd", "pwd", "passcode", "secret", "authorization", "credential", "credentials", "otp", "cvv",
    "cvc", "jwt", "cookie", "bearer", "signature", "apikey", "passphrase", "mnemonic",
})
# ... or these adjacent word pairs.
_SECRET_PAIRS = frozenset({
    ("api", "key"), ("private", "key"), ("secret", "key"), ("access", "key"), ("signing", "key"),
    ("encryption", "key"), ("access", "token"), ("refresh", "token"), ("auth", "token"), ("id", "token"),
    ("session", "token"), ("bearer", "token"), ("invite", "token"), ("reset", "token"), ("login", "token"),
    ("verification", "token"), ("hashed", "password"), ("password", "hash"), ("token", "hash"), ("card", "number"),
    ("pin", "code"), ("security", "code"), ("session", "id"), ("key", "encrypted"), ("encrypted", "key"),
})
_SECRET_EXACT = frozenset({"token", "tokens", "pin", "hash", "hashed", "salt", "key"})

# Raw clinical / document content: not stored, even when the owning table keeps it.
_CONTENT_WORDS = frozenset({
    "ocr", "diagnosis", "prescription", "base64", "blob",
})
_CONTENT_EXACT = frozenset({
    "content", "file_content", "raw_text", "extracted_text", "document_text", "results_json", "abnormal_findings",
    "extracted_metadata", "bytes", "data_url", "body_html", "html", "full_text", "transcript", "lab_results",
    "medical_history",
})

# Personal identifiers: masked where a partial value is still useful, otherwise redacted.
_PII_WORDS = frozenset({
    "cnic", "nic", "passport", "ssn", "iban", "dob", "birthdate", "address", "phone", "mobile", "email",
})
_PII_PAIRS = frozenset({
    ("date", "of", "birth"), ("national", "id"), ("account", "number"), ("bank", "account"), ("postal", "code"),
})

_WORD = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+")


def _words(key: str) -> list[str]:
    return [w.lower() for w in _WORD.findall(key)]


def _has_pair(words: list[str], pairs: frozenset, size: int = 2) -> bool:
    return any(tuple(words[i:i + size]) in pairs for i in range(len(words) - size + 1))


def classify_key(key: str) -> str:
    """'secret' | 'content' | 'pii' | 'ok' for a field name."""
    words = _words(key)
    flat = "_".join(words)
    if flat in _SECRET_EXACT or any(w in _SECRET_WORDS for w in words) or _has_pair(words, _SECRET_PAIRS):
        return "secret"
    if flat in _CONTENT_EXACT or any(w in _CONTENT_WORDS for w in words):
        return "content"
    if any(w in _PII_WORDS for w in words) or _has_pair(words, _PII_PAIRS) or _has_pair(words, _PII_PAIRS, 3):
        return "pii"
    return "ok"


def mask_pii(key: str, value: Any) -> str:
    """A partial, non-reversible form of a personal identifier."""
    text = str(value)
    words = _words(key)
    digits = re.sub(r"\D", "", text)
    if "cnic" in words or "nic" in words:
        return f"*****-*******-{digits[-1:]}" if digits else REDACTED
    if any(w in words for w in ("phone", "mobile")) and len(digits) >= 4:
        return f"***{digits[-3:]}"
    if "email" in words and "@" in text:
        local, _, domain = text.partition("@")
        return f"{local[:1]}***@{domain}"
    return REDACTED


def clean_text(value: str, limit: int = MAX_STRING) -> str:
    value = value.replace("\x00", "")
    if len(value) > limit:
        return f"{value[:limit]}…[truncated {len(value) - limit} chars]"
    return value


def _decimal_text(value: Any) -> str:
    try:
        number = Decimal(repr(value)) if isinstance(value, float) else Decimal(value)
    except (InvalidOperation, ValueError):
        return "NaN"
    if number.is_nan():
        return "NaN"
    if number.is_infinite():
        return "Infinity" if number > 0 else "-Infinity"
    text = format(number.normalize(), "f")
    return "0" if text in ("-0", "") else text


_B64 = re.compile(r"^[A-Za-z0-9+/_-]+={0,2}$")


def _looks_like_blob(text: str) -> bool:
    """An embedded file: a data: URI, or a long unbroken base64-looking run that mixes letter case, digits or symbols
    (plain prose has spaces; a long run of one repeated letter is not a file)."""
    if len(text) < 256:
        return False
    if text.startswith("data:") and ";base64," in text[:64]:
        return True
    head = text[:512]
    if not _B64.match(head):
        return False
    classes = sum(bool(re.search(p, head)) for p in (r"[A-Z]", r"[a-z]", r"[0-9]", r"[+/_-]"))
    if classes < 3:
        return False
    try:
        base64.b64decode(head[: len(head) - len(head) % 4].replace("-", "+").replace("_", "/"), validate=True)
        return True
    except ValueError:
        return False


def _by_key(value: Any, key: str) -> tuple[bool, Any]:
    """(handled, result) when the field name alone decides what is stored."""
    kind = classify_key(key)
    if kind == "secret":
        return True, REDACTED
    if kind == "content":
        return True, OMITTED
    if kind != "pii" or value in (None, "", [], {}):
        return False, None
    if isinstance(value, (dict, list, tuple, set)):
        return True, REDACTED
    if isinstance(value, str) and (value == REDACTED or "*" in value):
        return True, value  # already masked: sanitizing twice changes nothing
    return True, mask_pii(key, value)


def _scalar(value: Any) -> tuple[bool, Any]:
    """(handled, result) for values that are not containers."""
    if value is None or isinstance(value, (bool, int)):
        return True, value
    if isinstance(value, (float, Decimal)):
        return True, _decimal_text(value)
    if isinstance(value, str):
        return True, OMITTED if _looks_like_blob(value) else clean_text(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return True, f"[binary {len(value)} bytes]"
    if isinstance(value, UUID):
        return True, str(value)
    if isinstance(value, datetime):
        stamp = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return True, stamp.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    if isinstance(value, date):
        return True, value.isoformat()
    return False, None


def _mapping(value: dict, depth: int) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for index, (k, v) in enumerate(value.items()):
        if index >= MAX_ITEMS:
            out["_truncated"] = f"{len(value) - MAX_ITEMS} more keys"
            break
        name = clean_text(str(k), MAX_KEY)
        out[name] = sanitize(v, name, depth + 1)
    return out


def _sequence(value: Any, depth: int) -> list:
    items = list(value)
    if isinstance(value, (set, frozenset)):
        items.sort(key=str)
    shown = [sanitize(v, "", depth + 1) for v in items[:MAX_ITEMS]]
    if len(items) > MAX_ITEMS:
        shown.append(f"[{len(items) - MAX_ITEMS} more items]")
    return shown


def sanitize(value: Any, key: str = "", depth: int = 0) -> Any:
    """One value, made audit-safe. `key` is the field name it was found under (drives redaction)."""
    if key:
        handled, result = _by_key(value, key)
        if handled:
            return result
    if isinstance(value, Enum):
        return sanitize(value.value, "", depth)
    handled, result = _scalar(value)
    if handled:
        return result
    if depth >= MAX_DEPTH:
        return "[max depth]"
    if isinstance(value, dict):
        return _mapping(value, depth)
    if isinstance(value, (list, tuple, set, frozenset)):
        return _sequence(value, depth)
    return clean_text(str(value))


def sanitize_mapping(value: Any) -> dict[str, Any]:
    """A mapping, sanitized, and bounded to MAX_JSON_BYTES when serialized."""
    if not isinstance(value, dict):
        value = {"value": value}
    cleaned = sanitize(value)
    encoded = json.dumps(cleaned, sort_keys=True, separators=(",", ":"))
    if len(encoded.encode()) <= MAX_JSON_BYTES:
        return cleaned
    # Too large: keep the small scalar fields, summarise the rest.
    kept: dict[str, Any] = {}
    budget = MAX_JSON_BYTES // 2
    for k, v in cleaned.items():
        piece = json.dumps(v, separators=(",", ":"))
        if len(piece) <= 256 and budget - len(piece) > 0:
            kept[k] = v
            budget -= len(piece) + len(k)
        else:
            kept[k] = f"[omitted: {len(piece)} bytes]"
    kept["_truncated"] = True
    return kept
