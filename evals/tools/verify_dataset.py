"""Verifies the Individual Insurance Golden dataset. Exit status 0 means every check passed.

    python evals/tools/verify_dataset.py            # full report
    python evals/tools/verify_dataset.py --quiet    # failures and the summary only

What it checks
  1. Fixtures: the files match the manifest; personas have well-formed, non-placeholder CNICs; the plan catalog is
     internally consistent.
  2. Every case is a valid GoldenCase (the same validation the lake applies on ingest), ids are unique, no two cases
     send the same input, every fixture a case names exists, and every code reference points at a file that mentions
     the symbol.
  3. Ground truth: each case's `metadata.truth` entries are re-run against the real service code (oracles.py) and must
     reproduce the values the case expects. When the code changes, this is where the case goes stale.
  4. Honesty about sources: a case that depends on a number the code itself calls a placeholder, demo or starting value
     must be marked pending_domain_approval, and a case marked code_verified or independently_verified must have an
     oracle to back it.
  5. Coverage: cases per category, scenario types, difficulty, severity and turn modes.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent))

import casekit  # noqa: E402
import make_fixtures  # noqa: E402
import oracles  # noqa: E402

PER_CATEGORY = 6
MIN_MULTI_TURN = 8   # the multi-turn dataset is a deliverable of its own; it must not shrink away
SCENARIO_TYPES = ("positive", "negative", "boundary", "edge", "adversarial", "missing_information", "conflicting_data",
                  "complex_workflow")
TOL = 0.011


def matches(actual: Any, expect: Any) -> bool:
    if isinstance(expect, dict):
        return isinstance(actual, dict) and all(k in actual and matches(actual[k], v) for k, v in expect.items())
    if isinstance(expect, list):
        return isinstance(actual, list) and len(actual) == len(expect) and all(matches(a, e) for a, e in zip(actual, expect))
    if isinstance(expect, bool) or isinstance(actual, bool) or expect is None or actual is None:
        return actual == expect
    if isinstance(expect, (int, float)) and isinstance(actual, (int, float)):
        return abs(actual - expect) <= (TOL if isinstance(expect, float) or isinstance(actual, float) else 0)
    return actual == expect


_TEMPLATE = re.compile(r"\{\{date:today([+-]\d+)d\}\}")


def resolve(value: Any) -> Any:
    """Replace {{date:today-4d}} style tokens with the date they stand for, as the harness does when it runs a case."""
    if isinstance(value, str):
        return _TEMPLATE.sub(lambda m: (date.today() + timedelta(days=int(m.group(1)))).isoformat(), value)
    if isinstance(value, dict):
        return {k: resolve(v) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v) for v in value]
    return value


def run_truth(item: dict) -> Any:
    name, inputs = item["oracle"], dict(resolve(item.get("inputs", {})))
    catalog = {p["code"]: p for p in casekit.plans()}
    if name == "fixture_truth":
        entry = casekit.manifest()[inputs["fixture"]]
        return (entry.get("ground_truth") or {}).get(inputs["field"], "<no ground truth>")
    if name == "premium_plan":
        plan = catalog[inputs.pop("plan_code")]
        return oracles.premium(coverage=inputs.pop("coverage"), rate=plan["base_premium_rate"],
                               smoker_factor=plan["smoker_factor"], **inputs)
    if name == "plan_choices":
        return oracles.plan_choices(age=inputs["age"], plans=casekit.plans())
    if name == "plan_selection":
        return oracles.plan_selection(plan=catalog[inputs.pop("plan_code")], **inputs)
    if name not in oracles.ORACLES:
        raise KeyError(f"unknown oracle {name!r}")
    return oracles.ORACLES[name](**inputs)


def check_fixtures(errors: List[str]) -> None:
    errors += [f"fixtures: {p}" for p in make_fixtures.check()]
    personas = casekit.read_json(casekit.FIXTURES / "personas-individual-v1.json")["customers"]
    seen = set()
    for c in personas:
        if oracles.cnic_normalised(c["cnic"]) != c["cnic"]:
            errors.append(f"fixtures: persona {c['ref']} CNIC {c['cnic']} is not well formed")
        if oracles.is_placeholder_cnic(c["cnic"]):
            errors.append(f"fixtures: persona {c['ref']} CNIC looks like a placeholder")
        if c["cnic"] in seen:
            errors.append(f"fixtures: two personas share CNIC {c['cnic']}")
        seen.add(c["cnic"])
        if not oracles.lead_phone_ok(c["phone"]):
            errors.append(f"fixtures: persona {c['ref']} phone {c['phone']} would fail the lead phone check")
    for p in casekit.plans():
        if p["entry_age_min"] > p["entry_age_max"] or p["term_min_years"] > p["term_max_years"]:
            errors.append(f"fixtures: plan {p['code']} has an inverted age or term band")


def check_refs(case: dict, errors: List[str]) -> None:
    cid = case["case_id"]
    for ref in case["source"]["code_refs"]:
        path, _, symbol = ref.partition("::")
        file = oracles.REPO / path
        if not file.is_file():
            errors.append(f"{cid}: code ref {ref!r}: no such file")
        elif symbol and symbol.split(".")[-1] not in file.read_text(encoding="utf-8", errors="replace"):
            errors.append(f"{cid}: code ref {ref!r}: the file no longer mentions {symbol.split('.')[-1]!r}")


def verify(sources=None, *, check_fixture_files: bool = True) -> dict:
    """Run every check over `sources` (default: the authoring files). Returns {"errors", "cases", "oracle_ok", "oracle_runs"}."""
    errors: List[str] = []
    if check_fixture_files:
        check_fixtures(errors)
    known_fixtures = set(casekit.manifest())
    cases: List[dict] = []
    fingerprints: Dict[str, str] = {}
    truth_runs = truth_ok = 0

    for file, raw in (sources if sources is not None else casekit.sources()):
        label = f"{file}:{raw.get('case_id', '?')}"
        case, problems = casekit.normalise(raw)
        if case is None:
            errors += [f"{label}: {p['loc']}: {p['msg']}" for p in problems]
            continue
        cid = case["case_id"]
        if any(c["case_id"] == cid for c in cases):
            errors.append(f"{label}: duplicate case_id")
            continue
        cases.append(case)
        fp = casekit.dedupe_key(case)
        if fp in fingerprints:
            errors.append(f"{cid}: sends the same input as {fingerprints[fp]}")
        fingerprints[fp] = cid
        for ref in case["input"]["fixture_refs"]:
            if ref not in known_fixtures:
                errors.append(f"{cid}: fixture {ref!r} is not in the manifest")
        check_refs(case, errors)

        meta = case["metadata"]
        truth = meta.get("truth", [])
        basis = case["source"]["verification"]
        if meta.get("placeholder_rule") and basis != "pending_domain_approval":
            errors.append(f"{cid}: depends on a placeholder rule but is marked {basis}; mark it pending_domain_approval")
        if basis in ("code_verified", "independently_verified") and not truth and not meta.get("verified_by"):
            errors.append(f"{cid}: marked {basis} but has no truth oracle (metadata.truth) or verified_by")
        if case["severity"] == "critical" and not any(a["severity"] == "critical" for a in case["assertions"]):
            errors.append(f"{cid}: critical case without a critical assertion")
        if not meta.get("interface") or not meta.get("env_mode"):
            errors.append(f"{cid}: metadata.interface and metadata.env_mode are required")
        # The oracles read the same ENV_VAR switch the services do: a case declares which mode it assumes.
        os.environ["ENV_VAR"] = "demo" if meta.get("env_mode") == "demo" else "strict"
        for item in truth:
            truth_runs += 1
            try:
                actual = run_truth(item)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{cid}: oracle {item.get('oracle')} failed to run: {type(exc).__name__}: {exc}")
                continue
            if matches(actual, item["expect"]):
                truth_ok += 1
            else:
                errors.append(f"{cid}: oracle {item['oracle']} says {actual!r}, the case expects {item['expect']!r}")

    by_cat = Counter(c["category"] for c in cases)
    for cat in casekit.categories():
        if by_cat.get(cat, 0) != PER_CATEGORY:
            errors.append(f"coverage: category {cat} has {by_cat.get(cat, 0)} cases, expected {PER_CATEGORY}")
    types = Counter(c["scenario_type"] for c in cases)
    for t in SCENARIO_TYPES:
        if types.get(t, 0) == 0:
            errors.append(f"coverage: no {t} case")
    multi = sum(1 for c in cases if c["turn_mode"] == "multi_turn")
    if multi < MIN_MULTI_TURN:
        errors.append(f"coverage: only {multi} multi-turn cases, expected at least {MIN_MULTI_TURN}")
    return {"errors": errors, "cases": cases, "oracle_ok": truth_ok, "oracle_runs": truth_runs}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    result = verify()
    cases, errors = result["cases"], result["errors"]
    if not args.quiet:
        print(f"cases: {len(cases)}   fixtures: {len(casekit.manifest())}   oracle checks: {result['oracle_ok']}/{result['oracle_runs']} reproduced")
        for label, key in (("by category:      ", lambda c: c["category"]), ("by scenario type: ", lambda c: c["scenario_type"]),
                           ("by difficulty:    ", lambda c: c["difficulty"]), ("by severity:      ", lambda c: c["severity"]),
                           ("turn mode:        ", lambda c: c["turn_mode"]), ("ground truth:     ", lambda c: c["source"]["verification"]),
                           ("interfaces:       ", lambda c: c["metadata"].get("interface"))):
            print(label, dict(sorted(Counter(key(c) for c in cases).items())))
    for e in errors:
        print("FAIL", e)
    print(f"{'PASS' if not errors else 'FAILED'}: {len(cases)} cases, {len(errors)} problem(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
