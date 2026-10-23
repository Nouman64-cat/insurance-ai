"""The six evaluation layers and the verdict of one execution. Pure functions: no I/O, no model, no database.

  L1  schema, input and fixture validation   the bundle was verified, every placeholder resolved, every fixture the case names exists
  L2  LLM output quality                     the case's semantic criteria scored by a judge (correctness, faithfulness, relevance,
                                             hallucination, task completion, safety), plus deterministic checks on the reply text
  L3  agent trajectory                       which specialist, skills and tools, with which arguments (trace.*, routing.*, tool_called)
  L4  workflow and state                     what the sandbox now holds (state.*) and what an API or rule call answered (result.*)
  L5  security and business rules            permissions, refusals and leaks, and the insurance and financial rules (premium, risk, underwriting)
  L6  performance and cost                   latency, tokens and cost, against limits when the run sets them

Every assertion belongs to exactly one layer (`layer_of`). A layer the case did not enable still counts when it holds an assertion:
an assertion is never ignored because of how the case listed its layers.

The verdict (`combine`)
  * a failed or unjudgeable CRITICAL assertion fails the case, whatever any score says (`critical_overrides_score`);
  * every deterministic layer must hold ALL of its assertions (or reach the layer's own threshold when the case sets one);
  * L2 holds when its deterministic checks hold and its judged criteria reach their thresholds. If the judge was not available the
    layer is `not_scored` and the verdict says it is incomplete: it rests on the other layers and is never presented as a full pass;
  * L6 only fails a case when the run set a limit and the execution exceeded it.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

LAYERS = ("L1", "L2", "L3", "L4", "L5", "L6")
LAYER_NAMES = {"L1": "inputs and fixtures", "L2": "output quality", "L3": "agent trajectory", "L4": "workflow and state",
               "L5": "security and business rules", "L6": "performance and cost"}
SECURITY_CATEGORIES = {"security-rbac"}
RULE_CATEGORIES = {"premium-payment", "risk-aml-knockout", "underwriting"}
DEFAULT_PASS_THRESHOLD = 0.7
WEIGHT = {"critical": 3.0, "major": 2.0, "minor": 1.0}


def layer_of(assertion: Dict[str, Any], case: Dict[str, Any]) -> str:
    """Which layer an assertion is evidence for. Fixed rules, so the same assertion always lands in the same place."""
    kind, target = assertion.get("type"), assertion.get("target") or ""
    category = case.get("category")
    if kind in ("refuses", "no_leak") or category in SECURITY_CATEGORIES:
        return "L5"
    if kind in ("tool_called", "tool_not_called") or target.startswith(("trace.", "routing.")):
        return "L3"
    if category in RULE_CATEGORIES and target.startswith(("result.", "state.")):
        return "L5"
    if target.startswith(("state.", "result.")):
        return "L4"
    return "L2"                                  # response.text: the words of the reply


def check_inputs(case: Dict[str, Any], fixture_names: Sequence[str]) -> List[str]:
    """L1: what is wrong with the case or its inputs, before anything runs. The case must still be a valid case document, every fixture it
    refers to must be in the bundle, and a file named in its payload must be one of those fixtures. An empty list means all is well."""
    from shared.evaluation.case_schema import validate_case
    problems: List[str] = []
    _, errors = validate_case(case)
    problems += [f"schema {e['loc']}: {e['msg']}" for e in errors[:5]]
    names = set(fixture_names)
    inp = case.get("input") or {}
    for ref in inp.get("fixture_refs", []):
        if ref not in names:
            problems.append(f"the fixture {ref!r} the case refers to is not in the bundle")
    named = (inp.get("payload") or {}).get("file")
    if named and named not in names:
        problems.append(f"the file {named!r} named in the payload is not in the bundle")
    return problems


def _enabled(case: Dict[str, Any]) -> Dict[str, Optional[float]]:
    spec = ((case.get("evaluation") or {}).get("layers")) or []
    return {l["layer"]: l.get("threshold") for l in spec if l.get("enabled", True)}


def _share(results: Sequence[Dict[str, Any]]) -> Optional[float]:
    total = sum(WEIGHT.get(r.get("severity"), 1.0) for r in results)
    if not total:
        return None
    return sum(WEIGHT.get(r.get("severity"), 1.0) for r in results if r.get("status") == "passed") / total


def score_layers(case: Dict[str, Any], assertion_results: Sequence[Dict[str, Any]], *, inputs_ok: bool = True,
                 metrics: Optional[Sequence[Dict[str, Any]]] = None, judge_expected: bool = False,
                 measured: Optional[Dict[str, Any]] = None, limits: Optional[Dict[str, Any]] = None) -> Dict[str, Dict[str, Any]]:
    """One entry per layer: enabled, applicable, status (passed | failed | not_applicable | not_scored | measured | disabled), score,
    threshold and what it rests on. `metrics` are the judge's scores (dicts with metric, score, threshold, passed, status);
    `judge_expected` says the case has criteria that were meant to be scored; `measured` holds latency_ms/tokens/cost_usd."""
    enabled = _enabled(case)
    pass_threshold = float((case.get("evaluation") or {}).get("pass_threshold") or DEFAULT_PASS_THRESHOLD)
    by_layer: Dict[str, List[Dict[str, Any]]] = {l: [] for l in LAYERS}
    for r in assertion_results:
        by_layer[layer_of(r, case)].append(r)
    out: Dict[str, Dict[str, Any]] = {}

    out["L1"] = {"enabled": "L1" in enabled, "applicable": True, "status": "passed" if inputs_ok else "failed", "score": 1.0 if inputs_ok else 0.0,
                 "threshold": 1.0, "items": 1, "implicit": False, "detail": "bundle verified, placeholders and fixtures resolved" if inputs_ok else "an input could not be prepared"}

    for layer in ("L3", "L4", "L5"):
        rows = by_layer[layer]
        threshold = enabled.get(layer)
        if not rows:
            out[layer] = {"enabled": layer in enabled, "applicable": False, "status": "not_applicable", "score": None, "threshold": threshold, "items": 0,
                          "implicit": False, "detail": "no assertion belongs to this layer"}
            continue
        score = _share(rows)
        need = 1.0 if threshold is None else float(threshold)
        ok = all(r.get("status") == "passed" for r in rows) if threshold is None else (score or 0.0) >= need
        out[layer] = {"enabled": layer in enabled, "applicable": True, "status": "passed" if ok else "failed", "score": score, "threshold": need,
                      "items": len(rows), "implicit": layer not in enabled, "detail": f"{sum(1 for r in rows if r.get('status') == 'passed')} of {len(rows)} assertions held"}

    # L2: the deterministic checks on the reply, and the judged criteria.
    text_rows = by_layer["L2"]
    scored = [m for m in (metrics or []) if m.get("status", "scored") == "scored" and m.get("score") is not None]
    unscored = [m for m in (metrics or []) if m.get("status", "scored") != "scored" or m.get("score") is None]
    wants_judge = judge_expected and "L2" in enabled
    if not text_rows and not scored and not (wants_judge and unscored) and not wants_judge:
        out["L2"] = {"enabled": "L2" in enabled, "applicable": False, "status": "not_applicable", "score": None, "threshold": None, "items": 0,
                     "implicit": False, "detail": "nothing to judge in the words of a reply"}
    else:
        parts: List[float] = []
        ok = True
        detail: List[str] = []
        if text_rows:
            share = _share(text_rows)
            parts.append(share or 0.0)
            held = all(r.get("status") == "passed" for r in text_rows)
            ok = ok and held
            detail.append(f"{sum(1 for r in text_rows if r.get('status') == 'passed')} of {len(text_rows)} text checks held")
        for m in scored:
            parts.append(float(m["score"]))
            ok = ok and bool(m.get("passed"))
        if scored:
            detail.append(f"{sum(1 for m in scored if m.get('passed'))} of {len(scored)} judged criteria met")
        status = "passed" if ok else "failed"
        if wants_judge and (unscored or not scored) and ok:
            status = "not_scored"                 # the deterministic part holds, the judged part could not be scored
            detail.append("judged criteria not scored (no judge available)")
        threshold = enabled.get("L2")
        out["L2"] = {"enabled": "L2" in enabled, "applicable": True, "status": status, "score": (sum(parts) / len(parts)) if parts else None,
                     "threshold": pass_threshold if threshold is None else float(threshold), "items": len(text_rows) + len(scored) + len(unscored),
                     "implicit": "L2" not in enabled and bool(text_rows), "detail": "; ".join(detail)}

    # L6: measured always; a verdict only against limits the run set.
    m = measured or {}
    lim = {k: v for k, v in (limits or {}).items() if v is not None}
    checks = []
    for key, limit_key in (("latency_ms", "max_latency_ms"), ("total_tokens", "max_tokens"), ("cost_usd", "max_cost_usd")):
        if limit_key in lim and m.get(key) is not None:
            checks.append((key, m[key] <= lim[limit_key], m[key], lim[limit_key]))
    if checks:
        ok = all(c[1] for c in checks)
        out["L6"] = {"enabled": "L6" in enabled, "applicable": True, "status": "passed" if ok else "failed", "score": sum(1 for c in checks if c[1]) / len(checks),
                     "threshold": 1.0, "items": len(checks), "implicit": False,
                     "detail": "; ".join(f"{k} {v}{' > ' if not good else ' <= '}{lim_}" for k, good, v, lim_ in checks), "measured": m}
    else:
        out["L6"] = {"enabled": "L6" in enabled, "applicable": bool(m), "status": "measured" if m else "not_applicable", "score": None, "threshold": None,
                     "items": 0, "implicit": False, "detail": "measured; no limit set for this run" if m else "nothing measured", "measured": m}
    return out


def combine(case: Dict[str, Any], layers: Dict[str, Dict[str, Any]], assertion_results: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """The case's verdict from its layers. See the module docstring for the rules."""
    spec = case.get("evaluation") or {}
    critical = [r for r in assertion_results if r.get("severity") == "critical" and r.get("status") != "passed"]
    failing = [l for l, v in layers.items() if v["status"] == "failed" and v["applicable"] and (l != "L6" or v["enabled"])]
    not_scored = [l for l, v in layers.items() if v["status"] == "not_scored"]
    scores = [(v["score"], v["items"] or 1) for v in layers.values() if v["score"] is not None and v["applicable"] and v["status"] in ("passed", "failed")]
    score = (sum(s * w for s, w in scores) / sum(w for _, w in scores)) if scores else None
    passed = not failing
    reason = None
    if critical and spec.get("critical_overrides_score", True):
        passed = False
        reason = "critical_assertion_failed"
    elif failing:
        reason = "layer_failed:" + ",".join(failing)
    return {"passed": passed, "score": None if score is None else round(score, 4), "reason": reason, "critical_failed": bool(critical),
            "failing_layers": failing, "unscored_layers": not_scored, "complete": not not_scored,
            "pass_threshold": float(spec.get("pass_threshold") or DEFAULT_PASS_THRESHOLD)}
