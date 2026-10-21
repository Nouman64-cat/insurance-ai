"""Loading, expanding and validating Golden cases written in the compact authoring format.

Authoring files (datasets/individual-insurance/cases/*.json) hold one JSON array of cases each. A case there may use
four shorthands; `expand` turns them into the full GoldenCase document that shared/evaluation/case_schema.py defines
and the data lake stores:

  user      a user ref from fixtures/tenant-sandbox-v1.json. Becomes input.actor, with that user's role and tenant, and adds
            the tenant fixture to input.fixture_refs, so a case cannot disagree with the fixture about who is acting.
  messages  a list of strings. Each becomes a user message; turn_mode follows from how many there are (none or one:
            single_turn, two or more: multi_turn).
  layers    the evaluation layers that apply, e.g. ["L1", "L3", "L5"]. The others are written as disabled.
  pass      pass threshold (default 0.7).

Everything else is the case schema as it is. Nothing in here decides a case's expected values.
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

TOOLS = Path(__file__).resolve().parent
EVALS = TOOLS.parent
REPO = EVALS.parent
DATASET = EVALS / "datasets" / "individual-insurance"
CASES_DIR = DATASET / "cases"
FIXTURES = DATASET / "fixtures"

if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from shared.evaluation.case_schema import clean_case, dedupe_key, validate_case  # noqa: E402
from shared.evaluation.workflows import get_workflow  # noqa: E402

WORKFLOW = "individual-insurance"
TENANT_FIXTURE = "tenant-sandbox-v1.json"
PLANS_FIXTURE = "plans-individual-v1.json"
ALL_LAYERS = ("L1", "L2", "L3", "L4", "L5", "L6")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def manifest() -> Dict[str, dict]:
    return {e["key"]: e for e in read_json(FIXTURES / "manifest.json")["fixtures"]}


def users() -> Dict[str, dict]:
    world = read_json(FIXTURES / TENANT_FIXTURE)
    return {u["ref"]: u for u in world["users"]}


def plans() -> List[dict]:
    return read_json(FIXTURES / PLANS_FIXTURE)["plans"]


def sources() -> List[Tuple[str, dict]]:
    """(file name, raw authoring case) for every case, in file then position order."""
    out: List[Tuple[str, dict]] = []
    for path in sorted(CASES_DIR.glob("*.json")):
        items = read_json(path)
        if not isinstance(items, list):
            raise ValueError(f"{path.name}: expected a JSON array of cases")
        out += [(path.name, item) for item in items]
    return out


def expand(raw: dict) -> dict:
    """The full case document for an authoring case. Raises ValueError for an unknown user ref."""
    case = copy.deepcopy(raw)
    user = case.pop("user", None)
    messages = case.pop("messages", None)
    layers = case.pop("layers", None)
    pass_threshold = case.pop("pass", None)

    inp = case.setdefault("input", {})
    if messages is not None:
        inp["messages"] = [{"role": "user", "content": m} for m in messages]
    inp.setdefault("messages", [])
    inp.setdefault("payload", {})
    inp.setdefault("fixture_refs", [])
    if user is not None:
        known = users()
        if user not in known:
            raise ValueError(f"unknown user ref {user!r}; known: {', '.join(sorted(known))}")
        u = known[user]
        inp["actor"] = {"role": u["role"], "tenant_ref": u["tenant"], "user_ref": user}
        if TENANT_FIXTURE not in inp["fixture_refs"]:
            inp["fixture_refs"].insert(0, TENANT_FIXTURE)

    case["workflow"] = WORKFLOW
    case["turn_mode"] = "multi_turn" if sum(1 for m in inp["messages"] if m["role"] == "user") > 1 else "single_turn"

    if layers is not None:
        unknown = [l for l in layers if l not in ALL_LAYERS]
        if unknown:
            raise ValueError(f"unknown layer(s) {unknown}")
        spec = case.setdefault("evaluation", {})
        spec["layers"] = [{"layer": l, "enabled": l in layers} for l in ALL_LAYERS]
        if pass_threshold is not None:
            spec["pass_threshold"] = pass_threshold
    return case


def normalise(raw: dict) -> Tuple[Optional[dict], List[dict]]:
    """(validated, normalised case, []) or (None, errors), using the same validation the lake applies on ingest."""
    try:
        full = expand(raw)
    except ValueError as exc:
        return None, [{"loc": "(authoring)", "msg": str(exc), "type": "value_error"}]
    return validate_case(clean_case(full))


def categories() -> Dict[str, str]:
    return dict(get_workflow(WORKFLOW).categories)


__all__ = ["CASES_DIR", "DATASET", "FIXTURES", "dedupe_key", "expand", "manifest", "normalise", "plans", "read_json",
           "sources", "users", "categories", "WORKFLOW"]
