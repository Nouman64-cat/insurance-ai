"""Dataset drift and continuous improvement (Phase 6): pure detectors and the review rules. No database, no network, no LLM.

What it finds (each finding says what is wrong, which golden cases it touches, and what a person should look at):

  rule_changed        a case's executable pin (`metadata.truth`) no longer matches the code: the expectation may be stale
  oracle_error        a pin could not be evaluated at all (the check itself is broken or the code moved)
  unpinned            an approved case that is not tied to the code by any check, so a rule change cannot be noticed
  unconfirmed         the business has not confirmed the expected value (`pending_domain_approval`)
  review_due          the case was approved long ago and has not been looked at since
  coverage_gap        a workflow stage or scenario type with too few cases
  behaviour_changed   the same case gave a different verdict or used different tools between two runs
  performance_changed pass rate, latency or cost moved between two runs
  input_shift         the inputs people send now no longer look like the inputs the dataset was written for (PSI)

What it must never do: change an approved golden answer. A finding only OPENS a review item. A suggestion is a proposal with no expected
value of its own; accepting one needs a named reviewer and a reviewer-written expected value, and the result is a new draft in the working
copy, which is published as a new immutable version by the normal publish step. `guard_no_overwrite` and `advance` enforce that here, and
the database layer repeats it.
"""
from __future__ import annotations

import hashlib
import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from shared.evaluation import stats

SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
FINDING_KINDS = ("rule_changed", "oracle_error", "unpinned", "unconfirmed", "review_due", "coverage_gap", "behaviour_changed", "performance_changed", "input_shift", "config_changed")

# Defaults a reviewer can override per scan.
MIN_CASES_PER_STAGE = 6
MIN_PER_SCENARIO = {"negative": 1, "boundary": 1}      # the two whose absence matters most; a reviewer can ask for more per scan
REVIEW_AFTER_DAYS = 180
PSI_WATCH, PSI_ACT = 0.10, 0.25


class DriftError(ValueError):
    """An illegal use of the review rules (for example, accepting a proposal without a reviewer)."""


def finding_key(kind: str, *parts: Any) -> str:
    """A stable identity, so the same problem found by two scans is one open item, not two."""
    return kind + ":" + hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()[:16]


def _finding(kind: str, case: Optional[Dict[str, Any]], *, key_parts: Sequence[Any], summary: str, detail: Optional[Dict[str, Any]] = None,
             severity: Optional[str] = None, affects: Sequence[str] = ()) -> Dict[str, Any]:
    sev = severity or (case or {}).get("severity") or "medium"
    ids = list(affects) or ([case["case_id"]] if case else [])
    return {"key": finding_key(kind, *key_parts), "kind": kind, "severity": sev, "summary": summary, "affected_cases": ids, "detail": detail or {}, "needs_human": True}


def sort_findings(findings: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(findings, key=lambda f: (SEVERITY_ORDER.get(f["severity"], 9), f["kind"], f["key"]))


# ── rules: do the expectations still match the code? ───────────────────────────────────────────────────────────────────

def rule_findings(cases: Sequence[Dict[str, Any]], truth_results: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """`truth_results[case_id]` is what a scan got by re-running each pin: [{"oracle", "inputs", "expect", "got", "error"}]. A mismatch means the
    code now says something other than the case expects. The suggestion is only a proposal: it never replaces the approved expected value."""
    out: List[Dict[str, Any]] = []
    for case in cases:
        results = truth_results.get(case["case_id"])
        if results is None:
            continue
        for i, r in enumerate(results):
            if r.get("error"):
                out.append(_finding("oracle_error", case, key_parts=(case["case_id"], r.get("oracle"), i, r["error"][:80]),
                                    summary=f"{case['case_id']}: the check '{r.get('oracle')}' could not run ({r['error'][:120]})",
                                    detail={"oracle": r.get("oracle"), "inputs": r.get("inputs"), "error": r["error"]}))
            elif r.get("got") != r.get("expect"):
                out.append(_finding("rule_changed", case, key_parts=(case["case_id"], r.get("oracle"), i, str(r.get("got"))),
                                    summary=f"{case['case_id']}: the code now gives {r.get('got')!r} where the case expects {r.get('expect')!r} ({r.get('oracle')})",
                                    detail={"oracle": r.get("oracle"), "inputs": r.get("inputs"), "expected_by_case": r.get("expect"), "found_in_code": r.get("got"),
                                            "suggestion": {"kind": "review_expectation", "note": "Decide whether the code or the case is right. Nothing was changed."}}))
    return out


def stale_findings(cases: Sequence[Dict[str, Any]], *, now: Optional[datetime] = None, review_after_days: int = REVIEW_AFTER_DAYS) -> List[Dict[str, Any]]:
    now = now or datetime.now(timezone.utc)
    out: List[Dict[str, Any]] = []
    for c in cases:
        source = c.get("source") or {}
        verification = source.get("verification")
        truth = (c.get("metadata") or {}).get("truth") or []
        if verification == "pending_domain_approval":
            out.append(_finding("unconfirmed", c, key_parts=(c["case_id"],), severity="medium" if c.get("severity") in ("low", "medium") else c.get("severity"),
                                summary=f"{c['case_id']}: the business has not confirmed the expected value"))
        elif verification == "code_verified" and not truth and source.get("kind") == "code":
            out.append(_finding("unpinned", c, key_parts=(c["case_id"],), summary=f"{c['case_id']}: marked code-verified but no check ties it to the code, so a rule change would go unnoticed"))
        approved_at = (c.get("approval") or {}).get("approved_at")
        if approved_at:
            try:
                when = datetime.fromisoformat(approved_at.replace("Z", "+00:00"))
                when = when if when.tzinfo else when.replace(tzinfo=timezone.utc)
                age = (now - when).days
                if age >= review_after_days:
                    out.append(_finding("review_due", c, key_parts=(c["case_id"],), severity="low", summary=f"{c['case_id']}: approved {age} days ago and not reviewed since",
                                        detail={"approved_at": approved_at, "age_days": age}))
            except ValueError:
                pass
    return out


# ── coverage: what is missing? ─────────────────────────────────────────────────────────────────────────────────────────

def coverage_matrix(cases: Sequence[Dict[str, Any]]) -> Dict[str, Dict[str, int]]:
    grid: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for c in cases:
        grid[c.get("category") or "unclassified"][c.get("scenario_type") or "unclassified"] += 1
    return {k: dict(v) for k, v in grid.items()}


def coverage_findings(cases: Sequence[Dict[str, Any]], *, min_per_stage: int = MIN_CASES_PER_STAGE, min_per_scenario: Optional[Dict[str, int]] = None,
                      stages: Optional[Sequence[str]] = None) -> List[Dict[str, Any]]:
    """Stages with too few cases, and stages missing a kind of scenario the dataset is meant to cover. `stages` lists the workflow stages that
    should exist even if no case mentions them yet."""
    need = MIN_PER_SCENARIO if min_per_scenario is None else min_per_scenario
    grid = coverage_matrix(cases)
    out: List[Dict[str, Any]] = []
    for stage in sorted(set(grid) | set(stages or ())):
        row = grid.get(stage, {})
        total = sum(row.values())
        if total < min_per_stage:
            out.append(_finding("coverage_gap", None, key_parts=("stage", stage), severity="medium",
                                summary=f"{stage}: {total} case(s), fewer than the {min_per_stage} wanted",
                                detail={"stage": stage, "have": total, "want": min_per_stage, "scenario_counts": row}, affects=[]))
        for scenario, minimum in sorted(need.items()):
            if row.get(scenario, 0) < minimum:
                out.append(_finding("coverage_gap", None, key_parts=("scenario", stage, scenario), severity="low",
                                    summary=f"{stage}: no '{scenario.replace('_', ' ')}' case",
                                    detail={"stage": stage, "scenario_type": scenario, "have": row.get(scenario, 0), "want": minimum}, affects=[]))
    critical_stages = {c.get("category") for c in cases if c.get("severity") == "critical"}
    for stage in sorted(set(grid) - critical_stages):
        out.append(_finding("coverage_gap", None, key_parts=("critical", stage), severity="low",
                            summary=f"{stage}: no critical-severity case, so a regression there could not fail a quality gate",
                            detail={"stage": stage, "kind": "no_critical_case"}, affects=[]))
    return out


# ── behaviour and performance between two runs ─────────────────────────────────────────────────────────────────────────

def _tool_signature(row: Dict[str, Any]) -> Tuple[str, ...]:
    return tuple(((row.get("trace_summary") or {}).get("executed_tools")) or ())


def behaviour_findings(baseline: Sequence[Dict[str, Any]], current: Sequence[Dict[str, Any]], *, context: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Cases whose verdict or tool use changed between two runs (rows are result rows: case_id, status, severity, trace_summary).
    `context` says what differed between the runs (model, prompt, dataset version, code), so a reader knows what to blame."""
    out: List[Dict[str, Any]] = []
    for reg in stats.detect_regressions(list(baseline), list(current)):
        out.append(_finding("behaviour_changed", {"case_id": reg["case"], "severity": "high"}, key_parts=(reg["case"], "regression"),
                            summary=f"{reg['case']}: pass rate fell from {reg['from'] * 100:.0f}% to {reg['to'] * 100:.0f}% ({reg['evidence']})", detail={"regression": reg, "context": context or {}},
                            severity="critical" if reg.get("critical") else "high"))
    by_b, by_c = stats.group_by_case(list(baseline)), stats.group_by_case(list(current))
    for case in sorted(set(by_b) & set(by_c)):
        a, b = by_b[case], by_c[case]
        verdict_a = Counter(r["status"] for r in a).most_common(1)[0][0]
        verdict_b = Counter(r["status"] for r in b).most_common(1)[0][0]
        severity = next((r.get("severity") for r in b if r.get("severity")), "medium")
        if verdict_a == "failed" and verdict_b == "passed":
            out.append(_finding("behaviour_changed", {"case_id": case, "severity": "low"}, key_parts=(case, "fixed"), severity="low",
                                summary=f"{case}: now passes where it failed before. If the code was fixed, the case is doing its job; if not, the expectation may be too loose.",
                                detail={"before": verdict_a, "after": verdict_b, "context": context or {}}))
        sig_a, sig_b = Counter(_tool_signature(r) for r in a).most_common(1)[0][0], Counter(_tool_signature(r) for r in b).most_common(1)[0][0]
        if sig_a != sig_b and verdict_a == verdict_b == "passed":
            out.append(_finding("behaviour_changed", {"case_id": case, "severity": severity}, key_parts=(case, "tools", sig_b), severity="low",
                                summary=f"{case}: still passes but now uses different tools ({', '.join(sig_b) or 'none'} instead of {', '.join(sig_a) or 'none'})",
                                detail={"tools_before": list(sig_a), "tools_after": list(sig_b), "context": context or {}}))
    return out


def _rate(rows: Sequence[Dict[str, Any]]) -> Optional[float]:
    ran = [r for r in rows if r["status"] in ("passed", "failed")]
    return sum(1 for r in ran if r["status"] == "passed") / len(ran) if ran else None


def performance_findings(baseline: Sequence[Dict[str, Any]], current: Sequence[Dict[str, Any]], *, max_pass_drop: float = 0.05, max_latency_growth: float = 0.3,
                         max_cost_growth: float = 0.3, context: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Run-level movement. Unknown stays unknown: a figure missing on either side is not compared."""
    out: List[Dict[str, Any]] = []
    a, b = _rate(baseline), _rate(current)
    if a is not None and b is not None and a - b >= max_pass_drop:
        out.append(_finding("performance_changed", None, key_parts=("pass_rate", round(b, 3)), severity="high", summary=f"pass rate fell from {a * 100:.0f}% to {b * 100:.0f}%",
                            detail={"metric": "pass_rate", "before": a, "after": b, "context": context or {}}))
    for metric, field, limit in (("p95 latency", "latency_ms", max_latency_growth), ("cost per executed case", "cost_usd", max_cost_growth)):
        x = [r[field] for r in baseline if r.get(field) is not None and r.get("cost_known", True)]
        y = [r[field] for r in current if r.get(field) is not None and r.get("cost_known", True)]
        if len(x) < 3 or len(y) < 3:
            continue
        before = stats.percentile(x, 95) if field == "latency_ms" else sum(x) / len(x)
        after = stats.percentile(y, 95) if field == "latency_ms" else sum(y) / len(y)
        if before and after is not None and (after - before) / before >= limit:
            out.append(_finding("performance_changed", None, key_parts=(field, round(after, 4)), severity="medium", summary=f"{metric} grew from {before:.4g} to {after:.4g} ({(after - before) / before * 100:.0f}% more)",
                                detail={"metric": field, "before": before, "after": after, "context": context or {}}))
    return out


# ── inputs: do real inputs still look like the dataset's? ─────────────────────────────────────────────────────────────

def length_bucket(text: str) -> str:
    n = len(text or "")
    return "empty" if n == 0 else "short" if n <= 40 else "medium" if n <= 160 else "long"


def features_of(item: Dict[str, Any]) -> Dict[str, str]:
    """The few input features compared for drift. Works for a golden case and for a (de-identified) trace shaped {message(s), locale, stage}."""
    messages = [m.get("content", "") for m in (item.get("input") or {}).get("messages", []) if m.get("role") == "user"] or ([item["message"]] if item.get("message") else item.get("messages") or [])
    first = messages[0] if messages else ""
    return {"stage": item.get("category") or item.get("stage") or "unclassified", "length": length_bucket(first), "turns": "1" if len(messages) <= 1 else "2" if len(messages) == 2 else "3+",
            "locale": str(((item.get("input") or {}).get("locale")) or item.get("locale") or "en"), "has_number": "yes" if re.search(r"\d", first) else "no"}


def psi(reference: Sequence[str], current: Sequence[str]) -> Optional[float]:
    """Population Stability Index between two samples of a category. < 0.10 steady, 0.10-0.25 worth watching, > 0.25 a real shift. None when either sample is empty."""
    if not reference or not current:
        return None
    ref, cur = Counter(reference), Counter(current)
    total = 0.0
    for k in set(ref) | set(cur):
        p, q = max(ref[k] / len(reference), 1e-4), max(cur[k] / len(current), 1e-4)
        total += (q - p) * math.log(q / p)
    return total


def input_shift_findings(reference_items: Sequence[Dict[str, Any]], current_items: Sequence[Dict[str, Any]], *, min_items: int = 20) -> List[Dict[str, Any]]:
    if len(reference_items) < 1 or len(current_items) < min_items:
        return []
    ref, cur = [features_of(i) for i in reference_items], [features_of(i) for i in current_items]
    out: List[Dict[str, Any]] = []
    for feature in ("stage", "length", "turns", "locale", "has_number"):
        value = psi([f[feature] for f in ref], [f[feature] for f in cur])
        if value is not None and value >= PSI_WATCH:
            gone = sorted(set(f[feature] for f in cur) - set(f[feature] for f in ref))
            out.append(_finding("input_shift", None, key_parts=(feature, round(value, 2)), severity="medium" if value >= PSI_ACT else "low", affects=[],
                                summary=f"inputs have shifted in '{feature}' (PSI {value:.2f}{', new: ' + ', '.join(gone) if gone else ''})",
                                detail={"feature": feature, "psi": value, "level": "act" if value >= PSI_ACT else "watch", "new_values": gone, "reference_n": len(ref), "current_n": len(cur)}))
    return out


# ── de-identification: a trace may become a candidate only after this, and only if it is clean afterwards ──────────────

_PATTERNS: List[Tuple[str, "re.Pattern[str]", str]] = [
    ("cnic", re.compile(r"\b\d{5}-?\d{7}-?\d\b"), "<CNIC>"),
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<EMAIL>"),
    ("phone", re.compile(r"(?:\+92|0092|0)[\s-]?3\d{2}[\s-]?\d{7}\b|\b03\d{9}\b"), "<PHONE>"),
    ("iban", re.compile(r"\bPK\d{2}[A-Z]{4}\d{16}\b", re.I), "<IBAN>"),
    ("account", re.compile(r"\b\d{10,16}\b"), "<NUMBER>"),
    ("date_of_birth", re.compile(r"\b(?:19|20)\d{2}-\d{2}-\d{2}\b|\b\d{2}[/-]\d{2}[/-](?:19|20)\d{2}\b"), "<DATE>"),
    ("policy_number", re.compile(r"\b[A-Z]{2,5}-\d{4,}\b"), "<ID>"),
]
_NAME = re.compile(r"\b(?:Mr|Mrs|Ms|Miss|Dr|Sir|Madam)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?|\b(?:my name is|name:|customer|client|insured)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?", re.I)


def scrub(text: str) -> Tuple[str, List[str]]:
    """The text with identifiers replaced by placeholders, and the kinds of identifier found."""
    found: List[str] = []
    for kind, pattern, placeholder in _PATTERNS:
        text, n = pattern.subn(placeholder, text)
        if n:
            found.append(kind)
    text, n = _NAME.subn(lambda m: m.group(0).split()[0] + " <NAME>" if m.group(0).split()[0].lower() in ("mr", "mr.", "mrs", "mrs.", "ms", "ms.", "miss", "dr", "dr.", "sir", "madam") else "<NAME>", text)
    if n:
        found.append("name")
    return text, found


def residual_pii(text: str) -> List[str]:
    """Identifier-shaped text that is still there after scrubbing. A trace with any is refused outright, not partially used."""
    return [kind for kind, pattern, _ in _PATTERNS if pattern.search(text)] + (["name"] if _NAME.search(text) else [])


def deidentify_trace(trace: Dict[str, Any]) -> Dict[str, Any]:
    """{message(s)} -> a safe copy, or raises DriftError. Only the user's wording is kept: no ids, no tool results, no model output."""
    messages = trace.get("messages") or ([trace["message"]] if trace.get("message") else [])
    clean: List[str] = []
    for m in messages:
        text, _ = scrub(str(m))
        left = residual_pii(text.replace("<NAME>", "").replace("<CNIC>", "").replace("<EMAIL>", "").replace("<PHONE>", "").replace("<NUMBER>", "").replace("<DATE>", "").replace("<IBAN>", "").replace("<ID>", ""))
        if left:
            raise DriftError(f"the trace still contains identifier-like text after scrubbing ({', '.join(left)}); it is not used")
        clean.append(text)
    if not clean:
        raise DriftError("the trace has no user message")
    return {"messages": clean, "locale": trace.get("locale") or "en", "stage": trace.get("stage"), "provenance": {"kind": "trace", "scrubbed": True}}


# ── suggestions: proposals, never cases ────────────────────────────────────────────────────────────────────────────────

def candidate_proposals(cases: Sequence[Dict[str, Any]], gaps: Sequence[Dict[str, Any]], *, per_gap: int = 1) -> List[Dict[str, Any]]:
    """For each coverage gap, a proposal naming the stage and scenario to write and a seed case to model it on. A proposal has NO expected
    value: a reviewer writes it. It is not a golden case and cannot be run or published until a person turns it into a draft."""
    by_stage: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for c in cases:
        by_stage[c.get("category") or "unclassified"].append(c)
    out: List[Dict[str, Any]] = []
    for gap in gaps:
        d = gap.get("detail") or {}
        stage = d.get("stage")
        if gap["kind"] != "coverage_gap" or not stage:
            continue
        scenario = d.get("scenario_type") or ("positive" if d.get("kind") == "no_critical_case" else "negative")
        seeds = sorted(by_stage.get(stage, []), key=lambda c: (c.get("scenario_type") != scenario, SEVERITY_ORDER.get(c.get("severity"), 9), c["case_id"]))[:per_gap]
        for seed in seeds or [None]:
            out.append({"key": finding_key("proposal", stage, scenario, seed["case_id"] if seed else "none"), "from_finding": gap["key"], "stage": stage, "scenario_type": scenario,
                        "severity": "critical" if d.get("kind") == "no_critical_case" else "medium", "seed_case": seed["case_id"] if seed else None,
                        "rationale": gap["summary"], "provenance": {"kind": "synthetic", "method": "coverage_gap"},
                        "proposed_input": None, "expected": None, "state": "proposed"})
    return out


def template_proposals(template_key: str, title: str, version: int, changes: Sequence[Dict[str, Any]], content: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Suggested test cases for what a published template change added: a new field or section means a case should fill it in, and a reworded
    field means a case that quotes it should be checked. A suggestion names the template and the field, and has NO input and NO expected value:
    a reviewer writes both. `changes` is shared.doc_templates.diff(old, new)."""
    out: List[Dict[str, Any]] = []
    fields = {f["id"]: (s.get("id"), f) for s in (content or {}).get("sections", []) for f in s.get("fields", [])}
    for c in changes:
        kind, _, ident = c["what"].partition(":")
        if kind not in ("field", "section") or c["change"] not in ("added", "edited"):
            continue
        if c["change"] == "edited" and not (kind == "field" and "label" in (c.get("fields") or [])):
            continue
        section_id, f = fields.get(ident, (ident if kind == "section" else None, {}))
        label = (f or {}).get("label") or (c.get("after") or {}).get("title") or ident
        what = {"added": "was added to", "edited": "was reworded in"}[c["change"]]
        out.append({"key": finding_key("proposal", "template", template_key, kind, ident, version), "from_finding": None, "stage": None, "scenario_type": "positive",
                    "severity": "medium", "seed_case": None,
                    "rationale": f"{kind.capitalize()} '{label}' {what} {title} (version {version}): a test case should fill it in, or be checked against the new wording.",
                    "provenance": {"kind": "template_change", "template": template_key, "version": version, "target": f"{kind}:{ident}", "section": section_id},
                    "proposed_input": None, "expected": None, "state": "proposed"})
    return out


# ── the review rules ───────────────────────────────────────────────────────────────────────────────────────────────────

# Accepting these produces a new draft case, so a person must supply what the case expects. The others are acknowledgements: nothing is written.
NEEDS_EXPECTED = ("proposal", "rule_changed", "unconfirmed", "coverage_gap")
STATES = ("open", "in_review", "accepted", "rejected", "dismissed", "cleared")
TRANSITIONS = {"open": ("in_review", "dismissed"), "in_review": ("accepted", "rejected", "open"), "accepted": (), "rejected": ("open",), "dismissed": ("open",), "cleared": ()}
# A scan, not a person, may close an item whose problem has gone and reopen one that has come back. It can never touch a decision.
SYSTEM_TRANSITIONS = {"open": ("cleared",), "in_review": ("cleared",), "cleared": ("open",)}


def advance(item: Dict[str, Any], to: str, *, actor: Optional[str], note: Optional[str] = None, expected: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The only way a review item changes state. Accepting needs a named person and, for a proposal, an expected value written by that person.
    The result never contains a golden-case document: acceptance means "create a draft", and a draft is published by the normal publish step."""
    cur = item.get("state", "open")
    if to not in STATES or to not in TRANSITIONS.get(cur, ()):
        raise DriftError(f"a review item cannot go from {cur!r} to {to!r}")
    if not actor or not str(actor).strip():
        raise DriftError("every change of a review item names the person who made it")
    if to in ("accepted", "rejected", "dismissed") and not (note or "").strip():
        raise DriftError(f"{to} needs a written reason")
    if to == "accepted" and item.get("kind", "proposal") in NEEDS_EXPECTED:
        if not expected:
            raise DriftError("accepting this needs the expected value, written by the reviewer: the system never invents one")
        if item.get("expected_source") == "model" and item.get("expected") == expected:
            raise DriftError("an expected value suggested by a model cannot be accepted as it is; the reviewer writes or confirms their own")
    return {**item, "state": to, "decided_by": actor if to in ("accepted", "rejected", "dismissed") else item.get("decided_by"), "decision_note": note or item.get("decision_note"),
            **({"expected": expected, "expected_source": "reviewer"} if expected else {}), "history": [*item.get("history", []), {"from": cur, "to": to, "by": actor, "note": note}]}


def system_advance(item: Dict[str, Any], to: str, *, scan_id: str) -> Dict[str, Any]:
    """What a scan may do to an item: clear it when it no longer finds the problem, reopen it when the problem is back. An accepted, rejected or
    dismissed item is a person's decision and a scan leaves it exactly as it is."""
    cur = item.get("state", "open")
    if to not in SYSTEM_TRANSITIONS.get(cur, ()):
        raise DriftError(f"a scan cannot move an item from {cur!r} to {to!r}")
    return {**item, "state": to, "history": [*item.get("history", []), {"from": cur, "to": to, "by": "system", "note": f"scan {scan_id}"}]}


def guard_no_overwrite(change: Dict[str, Any], approved_case_ids: Iterable[str]) -> None:
    """Called before any write that comes from a finding or a proposal. A change aimed at an approved golden case's expectation is refused."""
    approved = set(approved_case_ids)
    touched = change.get("replaces_case") or change.get("overwrites")
    if touched and touched in approved:
        raise DriftError(f"{touched} is an approved golden case: a finding cannot change its expectation. Open a review item and publish a new version.")
    if change.get("write_to") in ("gold", "published"):
        raise DriftError("drift detection and generated suggestions never write to the Gold layer")


def summarise(findings: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    by_kind = Counter(f["kind"] for f in findings)
    by_sev = Counter(f["severity"] for f in findings)
    return {"total": len(findings), "by_kind": dict(by_kind), "by_severity": dict(by_sev), "blocking": by_sev.get("critical", 0) + sum(1 for f in findings if f["kind"] == "rule_changed" and f["severity"] in ("critical", "high"))}
