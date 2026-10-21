"""The Bronze -> Silver step: tidy, validate and de-duplicate a batch of raw records.

A record reaches Silver only when it
  1. is a valid case document (case_schema),
  2. belongs to the dataset's workflow and turn mode,
  3. carries the id it is filed under,
  4. is small enough and holds only valid JSON values, and
  5. does not send the same input as another case.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from shared.evaluation.canonical import canonical_bytes, content_hash
from shared.evaluation.case_schema import MAX_CASE_BYTES, clean_case, dedupe_key, validate_case


@dataclass
class Item:
    key: str            # the case_id the record is filed under
    raw: Any


@dataclass
class Outcome:
    key: str
    ok: bool
    case: Optional[dict] = None
    content_sha256: Optional[str] = None
    dedupe_key: Optional[str] = None
    errors: List[dict] = field(default_factory=list)


def _fail(key: str, loc: str, msg: str, kind: str = "value_error") -> Outcome:
    return Outcome(key=key, ok=False, errors=[{"loc": loc, "msg": msg, "type": kind}])


def validate_batch(items: Sequence[Item], *, workflow: str, turn_mode: str,
                   known_fingerprints: Optional[Dict[str, str]] = None) -> List[Outcome]:
    """One Outcome per item, in order. `known_fingerprints` maps the input fingerprint of every Silver case already in the
    dataset (outside this batch) to its id; the first case with a given fingerprint wins and later ones are rejected."""
    seen: Dict[str, str] = dict(known_fingerprints or {})
    outcomes: List[Outcome] = []
    for item in items:
        case, errors = validate_case(clean_case(item.raw))
        if case is None:
            outcomes.append(Outcome(key=item.key, ok=False, errors=errors))
            continue
        if case["workflow"] != workflow:
            outcomes.append(_fail(item.key, "workflow", f"this dataset covers {workflow!r}, the case says {case['workflow']!r}"))
            continue
        if case["turn_mode"] != turn_mode:
            outcomes.append(_fail(item.key, "turn_mode", f"this dataset holds {turn_mode} cases, the case says {case['turn_mode']!r}"))
            continue
        if case["case_id"] != item.key:
            outcomes.append(_fail(item.key, "case_id", f"the document says {case['case_id']!r} but it is filed as {item.key!r}"))
            continue
        try:
            size = len(canonical_bytes(case))
            digest = content_hash(case)
        except ValueError as exc:
            outcomes.append(_fail(item.key, "(case)", f"the case holds a value that is not valid JSON: {exc}"))
            continue
        if size > MAX_CASE_BYTES:
            outcomes.append(_fail(item.key, "(case)", f"the case is {size} bytes; the limit is {MAX_CASE_BYTES}"))
            continue
        fingerprint = dedupe_key(case)
        if fingerprint in seen and seen[fingerprint] != item.key:
            outcomes.append(_fail(item.key, "input", f"sends the same input as case {seen[fingerprint]!r}", "duplicate"))
            continue
        seen[fingerprint] = item.key
        outcomes.append(Outcome(key=item.key, ok=True, case=case, content_sha256=digest, dedupe_key=fingerprint))
    return outcomes


def summarize(outcomes: Sequence[Outcome]) -> dict:
    rejected = [o for o in outcomes if not o.ok]
    return {
        "total": len(outcomes),
        "accepted": len(outcomes) - len(rejected),
        "rejected": len(rejected),
        "duplicates": sum(1 for o in rejected if any(e.get("type") == "duplicate" for e in o.errors)),
    }
