"""Builds the exchange files from the authoring sources: one canonical JSONL file per turn mode.

    python evals/tools/build_dataset.py            # verify, then write single_turn.jsonl and multi_turn.jsonl
    python evals/tools/build_dataset.py --check    # fail if the committed JSONL differs from what the sources produce

The JSONL is what the data lake ingests (`eval_lake_cli.py ingest <slug> single_turn.jsonl`). It is canonical: sorted
keys, one case per line, so the same cases always give the same SHA-256. Approval is left at draft: approval is decided
by the review record, never by a file.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import casekit  # noqa: E402
import verify_dataset  # noqa: E402
from shared.evaluation.canonical import sha256_hex  # noqa: E402
from shared.evaluation.formats import parse_cases, serialize_cases  # noqa: E402
from shared.evaluation.validation import Item, validate_batch  # noqa: E402

OUTPUTS = {"single_turn": casekit.DATASET / "single_turn.jsonl", "multi_turn": casekit.DATASET / "multi_turn.jsonl"}


def build() -> dict:
    cases = []
    for _, raw in casekit.sources():
        case, problems = casekit.normalise(raw)
        if case is None:
            raise SystemExit(f"{raw.get('case_id')}: {problems[0]['loc']}: {problems[0]['msg']}")
        cases.append(case)
    cases.sort(key=lambda c: c["case_id"])
    return {mode: serialize_cases([c for c in cases if c["turn_mode"] == mode], "jsonl") for mode in OUTPUTS}


def lake_dry_run(data: dict) -> list:
    """Read each file back the way the lake does on ingest and run its Bronze to Silver validation. Returns problems."""
    problems = []
    for mode, payload in data.items():
        parsed = parse_cases(payload, "jsonl")
        problems += [f"{mode}: line {r.position}: {r.error}" for r in parsed.rejects]
        items = [Item(key=rec.get("case_id", f"line-{i}"), raw=rec) for i, rec in enumerate(parsed.records, 1)]
        for outcome in validate_batch(items, workflow=casekit.WORKFLOW, turn_mode=mode):
            if not outcome.ok:
                problems.append(f"{mode}: {outcome.key}: {outcome.errors[0]['loc']}: {outcome.errors[0]['msg']}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if verify_dataset.main(["--quiet"]) != 0:
        print("not building: the dataset does not verify")
        return 1
    data = build()
    problems = lake_dry_run(data)
    if problems:
        print("the lake would reject some cases:")
        print("\n".join("  " + p for p in problems))
        return 1
    total = sum(d.count(b"\n") for d in data.values())
    print(f"lake dry run: all {total} cases pass its Bronze to Silver validation")
    if args.check:
        stale = [m for m, path in OUTPUTS.items() if not path.exists() or path.read_bytes() != data[m]]
        print("JSONL is stale for: " + ", ".join(stale) if stale else "JSONL matches the sources")
        return 1 if stale else 0
    for mode, path in OUTPUTS.items():
        path.write_bytes(data[mode])
        count = data[mode].count(b"\n")
        print(f"wrote {path.relative_to(casekit.REPO)}: {count} cases, sha256 {sha256_hex(data[mode])[:16]}...")
    return 0


if __name__ == "__main__":
    sys.exit(main())
