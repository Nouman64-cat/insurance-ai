"""The pure half of the evaluation runner: verify a dataset bundle, choose cases, classify them, and summarise and print a run.
No database, no network, no model: everything here is a function of its arguments, so it is tested without the stack
(evals/tools/test_runner.py). The I/O half is evals/tools/eval_runner.py.

Result classes (one per case execution):
  passed               ran, and every assertion held
  failed               ran, and an assertion did not hold (or a critical one could not be judged)
  blocked              selected and supported, but a prerequisite is missing: credentials, budget, a registered operation. `reason` says which
  skipped              deliberately not run: not selected, filtered out by the suite, or not implemented yet (chat). Never a pass
  infrastructure_error the harness or the environment broke (timeout, connection, a case that cannot be performed): says nothing about the system
Only passed and failed count towards the pass rate; everything else is reported beside it, so a gap can never look like a pass.
"""
from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

from shared.evaluation.canonical import content_hash, sha256_hex
from shared.evaluation.pricing import cost_of

STATUSES = ("passed", "failed", "blocked", "skipped", "infrastructure_error")
SUITES = ("technical", "business")
CHAT_REASON = "no_chat_model_selected"          # a chat case needs a model under test (--model); without one it is skipped, never passed
# Operations that call a model when the document is readable: they cost money and need provider credentials.
MODEL_BACKED_OPERATIONS = {"ocr.extract_customer"}
MODEL_FILE_SUFFIXES = {"png", "jpg", "jpeg", "pdf"}


class BundleError(Exception):
    """The dataset bundle is not what was published: a checksum differs or a part is missing."""


@dataclass
class Bundle:
    path: Path
    manifest: Dict[str, Any]
    cases: List[Dict[str, Any]]
    fixtures: Dict[str, bytes]
    verified: bool = True

    @property
    def identity(self) -> Dict[str, Any]:
        m = self.manifest
        files = {f["name"]: f["sha256"] for f in m.get("files", [])}
        return {"dataset": (m.get("dataset") or {}).get("slug"), "version": m.get("version"), "snapshot_sha256": files.get("cases.jsonl"),
                "dataset_sha256": m.get("dataset_sha256"), "verified": self.verified, "cases": len(self.cases), "fixtures": len(self.fixtures)}


def load_bundle(path: Path) -> Bundle:
    """Read an exported Gold version and re-check every checksum against its manifest: the snapshot, each case, each fixture,
    and the dataset fingerprint. A run must never use altered data, whatever happened to the folder after it was exported."""
    path = Path(path)
    try:
        manifest = json.loads((path / "manifest.json").read_text(encoding="utf-8"))
        raw = (path / "cases.jsonl").read_bytes()
    except FileNotFoundError as exc:
        raise BundleError(f"the bundle is incomplete: {exc.filename} is missing") from exc
    snapshot = next((f for f in manifest.get("files", []) if f.get("name") == "cases.jsonl"), None)
    if snapshot is None:
        raise BundleError("the manifest does not list cases.jsonl")
    if sha256_hex(raw) != snapshot["sha256"]:
        raise BundleError("cases.jsonl does not match the checksum the version pinned")
    cases = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
    pinned = {c["case_id"]: c["sha256"] for c in manifest.get("cases", [])}
    if len(cases) != len(pinned):
        raise BundleError(f"the snapshot holds {len(cases)} cases but the manifest lists {len(pinned)}")
    for case in cases:
        if pinned.get(case.get("case_id")) != content_hash(case):
            raise BundleError(f"case {case.get('case_id')!r} does not match its pinned checksum")
    fixtures: Dict[str, bytes] = {}
    for entry in manifest.get("fixtures", []):
        file = path / "fixtures" / entry["fixture_key"]
        if not file.is_file():
            raise BundleError(f"fixture {entry['fixture_key']} is missing from the bundle")
        data = file.read_bytes()
        if sha256_hex(data) != entry["sha256"]:
            raise BundleError(f"fixture {entry['fixture_key']} does not match the checksum its version pinned")
        fixtures[entry["fixture_key"]] = data
    lines = [f"case:{c['case_id']}:{c['sha256']}" for c in manifest["cases"]] + [f"fixture:{f['fixture_key']}:{f['sha256']}" for f in manifest["fixtures"]]
    if manifest.get("dataset_sha256") and sha256_hex("\n".join(sorted(lines)).encode("utf-8")) != manifest["dataset_sha256"]:
        raise BundleError("the dataset fingerprint does not match")
    return Bundle(path=path, manifest=manifest, cases=cases, fixtures=fixtures)


def operation_of(case: Dict[str, Any]) -> Optional[str]:
    return ((case.get("input") or {}).get("payload") or {}).get("operation")


def is_chat(case: Dict[str, Any]) -> bool:
    return bool((case.get("input") or {}).get("messages")) or operation_of(case) == "chat.stream" or (case.get("metadata") or {}).get("interface") == "chat"


def verification_of(case: Dict[str, Any]) -> str:
    return (case.get("source") or {}).get("verification") or "unspecified"


def needs_model(case: Dict[str, Any], files: Dict[str, bytes]) -> bool:
    """Would running this case call a model? A refused upload (wrong type, empty file) never reaches one."""
    payload = (case.get("input") or {}).get("payload") or {}
    if operation_of(case) not in MODEL_BACKED_OPERATIONS:
        return False
    name = payload.get("file") or ""
    return name.rsplit(".", 1)[-1].lower() in MODEL_FILE_SUFFIXES and len(files.get(name, b"x")) > 0


def select_cases(cases: Sequence[Dict[str, Any]], *, suite: str = "technical", case_ids: Sequence[str] = (), categories: Sequence[str] = (),
                 operations: Sequence[str] = ()) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """(selected, left out). The suite: `technical` is every case of the version (does the system still do what the dataset pins);
    `business` is only the cases a business owner has approved. `left out` carries the reason, so nothing disappears silently."""
    if suite not in SUITES:
        raise ValueError(f"suite must be one of {', '.join(SUITES)}")
    unknown = sorted(set(case_ids) - {c["case_id"] for c in cases})
    if unknown:
        raise ValueError("no such case in this version: " + ", ".join(unknown))
    selected, left = [], []
    for case in sorted(cases, key=lambda c: c["case_id"]):
        why = None
        if case_ids and case["case_id"] not in case_ids:
            why = "not_selected"
        elif categories and case.get("category") not in categories:
            why = "not_selected"
        elif operations and operation_of(case) not in operations:
            why = "not_selected"
        elif suite == "business" and verification_of(case) != "business_approved":
            why = "not_business_approved"
        (left if why else selected).append({**case, "_left_out": why} if why else case)
    return selected, left


def classify(case: Dict[str, Any], *, registered: Dict[str, str], files: Dict[str, bytes], providers_ready: bool,
             chat: str = "unavailable") -> Optional[Dict[str, str]]:
    """Decide before running whether a selected case can be run at all. None means: run it. Otherwise {status, reason}.
    `chat` says whether a model under test was chosen for chat cases: "ready", "missing_credentials" (a real provider without a key)
    or "unavailable" (none chosen: the case is skipped)."""
    if is_chat(case):
        if chat == "ready":
            return None
        if chat == "missing_credentials":
            return {"status": "blocked", "reason": "blocked_missing_credentials"}
        return {"status": "skipped", "reason": CHAT_REASON}
    op = operation_of(case)
    if op not in registered:
        return {"status": "blocked", "reason": f"operation_not_registered:{op}"}
    if needs_model(case, files) and not providers_ready:
        return {"status": "blocked", "reason": "blocked_missing_credentials"}
    return None


@dataclass
class CaseResult:
    case_id: str
    category: Optional[str]
    operation: Optional[str]
    verification: str
    status: str
    reason: Optional[str] = None
    repetition: int = 1
    latency_ms: Optional[int] = None
    failed_assertions: List[Dict[str, Any]] = field(default_factory=list)
    assertion_counts: Dict[str, int] = field(default_factory=dict)
    score: Optional[float] = None
    usage: Optional[Dict[str, Any]] = None            # what the ledger showed: status, calls, tokens
    cost_usd: Optional[float] = None                  # None = unknown (never 0 for "not measured")
    cost_known: bool = True                           # False when a model was used but its cost could not be established
    artifact: Optional[str] = None
    error: Optional[str] = None
    # Chat, repetition and judge fields (steps 7 to 9). None means "not measured", never zero.
    model_id: Optional[str] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cached_tokens: Optional[int] = None
    llm_calls: Optional[int] = None
    ttft_ms: Optional[int] = None
    turns: Optional[int] = None
    critical_failed: bool = False
    layer_scores: Dict[str, Any] = field(default_factory=dict)
    verdict: Dict[str, Any] = field(default_factory=dict)
    trace_summary: Dict[str, Any] = field(default_factory=dict)
    trace_artifact: Optional[str] = None
    metric_scores: List[Dict[str, Any]] = field(default_factory=list)
    judge_cost_usd: Optional[float] = None
    severity: Optional[str] = None                    # the case's own severity (the quality gate holds critical cases to a stricter standard)
    attempts: int = 1                                 # executions it took (an infrastructure error is retried, a verdict never is)
    retry_usage: List[Dict[str, Any]] = field(default_factory=list)   # the ledger usage of the earlier attempts that failed: those calls were paid for too
    synthetic_model: bool = False                     # the model was a scripted stand-in: a mechanics result, not a quality result

    def as_dict(self) -> Dict[str, Any]:
        return self.__dict__.copy()


def cost_from_usage(usage: Optional[Dict[str, Any]], uses_model: bool) -> tuple[Optional[float], bool]:
    """(dollars, known). A case that used no model costs 0 and that is known; one that used a model but whose ledger rows are
    missing, unreadable or unpriced has an UNKNOWN cost."""
    if usage is None:
        return (None, False) if uses_model else (0.0, True)
    if usage.get("status") != "attributed":
        return None, False
    by_model = usage.get("by_model") or {}
    if not by_model:
        return 0.0, True
    total = 0.0
    for model, v in by_model.items():
        c = cost_of({"model_name": model, "input_tokens": v.get("input_tokens"), "output_tokens": v.get("output_tokens"), "cached_tokens": v.get("cached_tokens")})
        if c is None:
            return None, False
        total += c
    return total, True


def percentile(values: Sequence[float], p: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, math.ceil(p / 100 * len(ordered)) - 1))]


def summarise(results: Sequence[CaseResult], *, selected: int, left_out: Sequence[Dict[str, Any]] = ()) -> Dict[str, Any]:
    """Counts, pass rate, per-category and per-reason breakdowns, latency and cost, for one run."""
    by = Counter(r.status for r in results)
    ran = by["passed"] + by["failed"]
    latencies = [r.latency_ms for r in results if r.latency_ms is not None and r.status in ("passed", "failed")]
    known_cost = sum(r.cost_usd or 0.0 for r in results if r.cost_known and r.cost_usd)
    unknown_cost = sum(1 for r in results if not r.cost_known)
    categories: Dict[str, Counter] = defaultdict(Counter)
    for r in results:
        categories[r.category or "-"][r.status] += 1
    per_case: Dict[str, List[str]] = defaultdict(list)
    for r in results:
        if r.status in ("passed", "failed"):
            per_case[r.case_id].append(r.status)
    return {
        "executions": len(results), "selected_cases": selected, "left_out": dict(Counter(x["_left_out"] for x in left_out)),
        "by_status": {s: by.get(s, 0) for s in STATUSES}, "ran": ran,
        "pass_rate": (by["passed"] / ran) if ran else None,
        "reasons": dict(Counter(f"{r.status}:{r.reason}" for r in results if r.reason)),
        "by_category": {c: {s: n for s, n in v.items()} for c, v in sorted(categories.items())},
        "latency_ms": {"p50": percentile(latencies, 50), "p95": percentile(latencies, 95), "max": max(latencies) if latencies else None},
        "cost": {"known_usd": round(known_cost, 6), "executions_with_unknown_cost": unknown_cost},
        "flaky_cases": sorted(c for c, s in per_case.items() if len(set(s)) > 1),
    }


def render_report(summary: Dict[str, Any], results: Sequence[CaseResult], *, identity: Dict[str, Any], suite: str, run_id: str,
                  budget_usd: Optional[float] = None, cancelled: bool = False, repeat: int = 1) -> str:
    s, out = summary, []
    w = out.append
    w("=" * 78)
    w(f"Evaluation run {run_id}" + ("   *** CANCELLED: partial results ***" if cancelled else ""))
    w(f"  dataset  {identity.get('dataset')} {identity.get('version')}   suite: {suite}   repetitions: {repeat}")
    w(f"  data     {identity.get('cases')} cases, {identity.get('fixtures')} fixtures, checksums "
      + ("VERIFIED against the published manifest" if identity.get("verified") else "NOT verified (repository files, not a published version)"))
    w("-" * 78)
    b = s["by_status"]
    w(f"  executions {s['executions']}  of {s['selected_cases']} selected case(s)")
    w(f"  passed {b['passed']}   failed {b['failed']}   blocked {b['blocked']}   skipped {b['skipped']}   infrastructure_error {b['infrastructure_error']}")
    rate = "n/a (nothing ran)" if s["pass_rate"] is None else f"{s['pass_rate'] * 100:.1f}% ({b['passed']} of {s['ran']} that ran)"
    w(f"  pass rate  {rate}")
    if s["left_out"]:
        w("  left out   " + ", ".join(f"{n} {why}" for why, n in s["left_out"].items()))
    w("-" * 78)
    if s["by_category"]:
        w(f"  {'category':26}" + "".join(f"{x[:6]:>8}" for x in ("passed", "failed", "blocked", "skipped", "infra")))
        for cat, v in s["by_category"].items():
            w(f"  {cat:26}" + "".join(f"{v.get(x, 0):>8}" for x in STATUSES))
        w("-" * 78)
    failed = [r for r in results if r.status == "failed"]
    if failed:
        w("  FAILED")
        for r in failed:
            w(f"    {r.case_id}  {r.operation}" + (f"   (repetition {r.repetition})" if repeat > 1 else "") + f"   [{r.verification}]")
            for a in r.failed_assertions[:6]:
                w(f"        {a.get('status')}: {a.get('target')}  expected {json.dumps(a.get('expected'), default=str)[:60]}  got {json.dumps(a.get('actual'), default=str)[:70]}")
        w("-" * 78)
    for status, title in (("blocked", "BLOCKED (selected, but a prerequisite is missing)"), ("infrastructure_error", "INFRASTRUCTURE ERRORS (not a verdict on the system)")):
        rows = [r for r in results if r.status == status]
        if rows:
            w(f"  {title}")
            for reason, group in _group(rows).items():
                w(f"    {reason}: " + ", ".join(sorted({r.case_id for r in group})))
            w("-" * 78)
    skipped = [r for r in results if r.status == "skipped"]
    if skipped:
        w("  SKIPPED (never counted as passed)")
        for reason, group in _group(skipped).items():
            w(f"    {reason}: {len({r.case_id for r in group})} case(s)")
        w("-" * 78)
    if s["flaky_cases"]:
        w("  FLAKY (different outcomes across repetitions): " + ", ".join(s["flaky_cases"]))
        w("-" * 78)
    lat = s["latency_ms"]
    w("  latency    " + ("n/a" if lat["p50"] is None else f"p50 {lat['p50']} ms   p95 {lat['p95']} ms   max {lat['max']} ms"))
    c = s["cost"]
    unknown = c["executions_with_unknown_cost"]
    w(f"  cost       ${c['known_usd']:.4f} known" + (f"   +  UNKNOWN for {unknown} execution(s) (a model was used but its usage could not be established)" if unknown else "   (no unknown costs)")
      + (f"   budget ${budget_usd:.2f}" if budget_usd is not None else ""))
    w("=" * 78)
    return "\n".join(out)


def _group(rows: Iterable[CaseResult]) -> Dict[str, List[CaseResult]]:
    groups: Dict[str, List[CaseResult]] = defaultdict(list)
    for r in rows:
        groups[r.reason or r.error or "unspecified"].append(r)
    return groups


def exit_code(summary: Dict[str, Any], *, strict: bool = False) -> int:
    """0 clean; 1 a case failed; 2 the harness or environment broke; 3 (strict only) something selected was blocked or nothing ran."""
    b = summary["by_status"]
    if b["failed"]:
        return 1
    if b["infrastructure_error"]:
        return 2
    if strict and (b["blocked"] or not summary["ran"]):
        return 3
    return 0
