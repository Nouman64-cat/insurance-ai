"""Work out which watched items each golden case depends on, from evidence the case already carries: the oracle checks that pin it to the code
(`metadata.truth`) and the code files it refers to (`source.code_refs`). The result is written BESIDE the dataset
(evals/datasets/<dataset>/dependencies.json), not into the cases: a published version is immutable and an approved case is never edited
to add metadata. A case with no evidence is listed as undeclared, so the gap is visible; nothing is guessed.

    python -m evals.tools.derive_dependencies [--write]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

ORACLE_ITEMS = {
    "premium": ["calc:premium", "plan:*"], "premium_plan": ["calc:premium", "plan:*"], "payment_split": ["calc:premium"], "hlv_limit": ["calc:premium", "plan:*"],
    "plan_choices": ["plan:*"], "plan_selection": ["plan:*"], "fixture_truth": [],
    "transition_legal": ["workflow:policy-status"],
    "requirements": ["rule:*"], "medical_requirement": ["rule:*"], "cession": ["rule:*"], "decide": ["rule:*"], "verification": ["rule:*"],
    "knockout": ["rule:*"], "aml": ["rule:*"], "secp": ["rule:*"], "sanctions_internal": ["rule:*"],
}
PATH_ITEMS = {"routers/claims.py": ["access:claims"], "routers/cases.py": ["gate:initial-premium"], "pricing/calculator.py": ["calc:premium"],
              "services/pricing_engine.py": ["calc:premium"], "policy_state_machine.py": ["workflow:policy-status"]}


def derive(case: dict) -> List[str]:
    found: set = set()
    for item in (case.get("metadata") or {}).get("truth") or []:
        found.update(ORACLE_ITEMS.get(item.get("oracle"), []))
        path = str((item.get("inputs") or {}).get("path", ""))
        for frag, keys in PATH_ITEMS.items():
            if frag in path:
                found.update(keys)
    for ref in (case.get("source") or {}).get("code_refs") or []:
        for frag, keys in PATH_ITEMS.items():
            if frag in ref:
                found.update(keys)
    return sorted(found)


def main(argv: List[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--write", action="store_true")
    args = p.parse_args(argv)
    import casekit
    cases = [casekit.normalise(raw)[0] for _, raw in casekit.sources()]
    deps: Dict[str, List[str]] = {}
    undeclared: List[str] = []
    for c in cases:
        keys = derive(c)
        (deps.__setitem__(c["case_id"], keys) if keys else undeclared.append(c["case_id"]))
    doc = {"schema": 1, "derived_from": "metadata.truth oracles and source.code_refs of each case; nothing is guessed",
           "dependencies": dict(sorted(deps.items())), "undeclared": sorted(undeclared)}
    by_item: Dict[str, int] = {}
    for keys in deps.values():
        for k in keys:
            by_item[k] = by_item.get(k, 0) + 1
    print(f"cases {len(cases)}: {len(deps)} with a dependency, {len(undeclared)} without")
    print("cases per item:", dict(sorted(by_item.items())))
    if args.write:
        out = casekit.FIXTURES.parent / "dependencies.json"
        out.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print("written:", out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
