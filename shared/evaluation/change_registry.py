"""The change registry's pure logic: fingerprints, readable differences, and the finding a change produces. No database, no network.

A watched item (a plan, a calculation, a rule set, a workflow, a template) is read into an **observation**:

    {"key": "calc:premium", "type": "calc", "title": "...", "source": "...", "summary": {...}}

`summary` is a plain, readable rendering of the item's content. Its fingerprint is a hash of that rendering, so two readings of an unchanged
item give the same fingerprint and any change in what the summary says gives a different one. Code is summarised by what it DOES (its syntax
tree), never by how it is written, so a comment, a blank line or a reformatting is not a change.

A new registry version is recorded only when the fingerprint differs from the last one. A change plus the cases that depend on the item gives
one `config_changed` finding for a person to review (shared/evaluation/drift.py has the review rules). Nothing here edits a case.
"""
from __future__ import annotations

import ast
import hashlib
import json
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from shared.evaluation import drift

MAX_DIFFS = 60


# ── fingerprints ───────────────────────────────────────────────────────────────────────────────────────────────────────

def canonical(value: Any) -> str:
    """A text form of a JSON-like value that does not depend on key order, so equal content always gives equal text."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str, ensure_ascii=False)


def fingerprint(summary: Any) -> str:
    return hashlib.sha256(canonical(summary).encode("utf-8")).hexdigest()


def _strip_docstrings(tree: ast.AST) -> ast.AST:
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Module)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(getattr(first, "value", None), ast.Constant) and isinstance(first.value.value, str):
                node.body = node.body[1:] or [ast.Pass()]
    return tree


def code_hash(node: ast.AST) -> str:
    """A hash of what a piece of code does: its syntax tree without line numbers, comments or docstrings."""
    return hashlib.sha256(ast.dump(_strip_docstrings(node), annotate_fields=True, include_attributes=False).encode()).hexdigest()


def module_summary(source: str) -> Dict[str, Any]:
    """{"functions": {name: short hash}, "classes": {...}, "assignments": {...}} for a Python file. A change to any function shows up as that
    function's hash changing, which is what lets the difference view say WHICH function changed."""
    tree = ast.parse(source)
    funcs: Dict[str, str] = {}
    classes: Dict[str, str] = {}
    assigns: Dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            funcs[node.name] = code_hash(node)[:12]
        elif isinstance(node, ast.ClassDef):
            classes[node.name] = code_hash(node)[:12]
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    funcs[f"{node.name}.{sub.name}"] = code_hash(sub)[:12]
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in targets:
                if isinstance(t, ast.Name):
                    assigns[t.id] = code_hash(node)[:12]
    return {"functions": funcs, "classes": classes, "assignments": assigns}


def function_summary(source: str, names: Sequence[str]) -> Dict[str, Any]:
    """The same for chosen functions or assignments only. A name that is not there is recorded as missing, which is itself a change."""
    full = module_summary(source)
    found = {n: full["functions"].get(n) or full["assignments"].get(n) or full["classes"].get(n) for n in names}
    return {"items": {n: (h or "MISSING") for n, h in found.items()}}


# ── differences a person can read ──────────────────────────────────────────────────────────────────────────────────────

def diff_summaries(old: Any, new: Any, path: str = "") -> List[Dict[str, Any]]:
    """Every place two summaries differ: [{"path": "functions.premium", "before": ..., "after": ...}]. Added and removed keys are included."""
    out: List[Dict[str, Any]] = []
    if isinstance(old, dict) and isinstance(new, dict):
        for key in sorted(set(old) | set(new), key=str):
            here = f"{path}.{key}" if path else str(key)
            if key not in old:
                out.append({"path": here, "before": None, "after": new[key], "change": "added"})
            elif key not in new:
                out.append({"path": here, "before": old[key], "after": None, "change": "removed"})
            else:
                out.extend(diff_summaries(old[key], new[key], here))
    elif isinstance(old, list) and isinstance(new, list) and old != new:
        if all(isinstance(x, (str, int, float, bool)) or x is None for x in old + new):
            for gone in [x for x in old if x not in new]:
                out.append({"path": path, "before": gone, "after": None, "change": "removed"})
            for came in [x for x in new if x not in old]:
                out.append({"path": path, "before": None, "after": came, "change": "added"})
        else:
            out.append({"path": path, "before": old, "after": new, "change": "changed"})
    elif old != new:
        out.append({"path": path, "before": old, "after": new, "change": "changed"})
    return out[:MAX_DIFFS]


# ── what a reading means ───────────────────────────────────────────────────────────────────────────────────────────────

def classify_reading(observation: Dict[str, Any], last: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Compare a fresh reading with the last recorded version of the same item.

    `last` is {"version": n, "fingerprint": ..., "summary": ...} or None.
    Returns {"status": new | unchanged | changed, "fingerprint", "version" (the version to record, or the existing one), "diff"}.
    The first sighting of an item is `new`: it records version 1 and is NOT a change, so adding an item to the watch list cannot flood the queue."""
    fp = fingerprint(observation["summary"])
    if last is None:
        return {"status": "new", "fingerprint": fp, "version": 1, "diff": []}
    if last["fingerprint"] == fp:
        return {"status": "unchanged", "fingerprint": fp, "version": last["version"], "diff": []}
    return {"status": "changed", "fingerprint": fp, "version": last["version"] + 1, "diff": diff_summaries(last.get("summary") or {}, observation["summary"])}


def change_finding(observation: Dict[str, Any], reading: Dict[str, Any], cases: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The review item a change produces, or None when nothing changed. `cases` are the cases that declare a dependency on the item:
    [{"case_id", "severity"}]. The severity is that of the most serious affected case, and a change nobody depends on is reported as low,
    because it means the dataset does not cover it."""
    if reading["status"] != "changed":
        return None
    order = drift.SEVERITY_ORDER
    severity = min((c.get("severity") or "medium" for c in cases), key=lambda s: order.get(s, 9)) if cases else "low"
    ids = sorted({c["case_id"] for c in cases})
    what = ", ".join(f"{d['path'] or 'content'}" for d in reading["diff"][:3]) or "its content"
    finding = drift._finding("config_changed", None, key_parts=(observation["key"], reading["version"]), severity=severity, affects=ids,
                             summary=(f"{observation['title']} changed (version {reading['version'] - 1} to {reading['version']}: {what}); "
                                      + (f"{len(ids)} case(s) depend on it" if ids else "no case depends on it, so the dataset does not cover this change")),
                             detail={"registry_item": observation["key"], "type": observation["type"], "source": observation.get("source"),
                                     "from_version": reading["version"] - 1, "to_version": reading["version"], "diff": reading["diff"],
                                     "suggestion": {"kind": "review_cases", "note": "Check each dependent case against the change. Nothing was changed."}})
    finding["registry_item_key"] = observation["key"]
    return finding


def dependents(item_key: str, dependencies: Iterable[Tuple[str, str]], severities: Dict[str, str]) -> List[Dict[str, Any]]:
    """The cases that depend on an item. `dependencies` are (case_id, item_key) pairs; `*` at the end of a declared key matches a family
    (`plan:*` covers every plan)."""
    out = []
    for case_id, declared in dependencies:
        if declared == item_key or (declared.endswith("*") and item_key.startswith(declared[:-1])):
            out.append({"case_id": case_id, "severity": severities.get(case_id)})
    return out
