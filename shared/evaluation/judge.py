"""The runner's side of the LLM judge (L2). The scoring itself runs in the separate `eval-judge` service, where DeepEval is installed;
this module decides what to ask, enforces who may judge whom, and turns the answers into metric rows.

What is judged: each `semantic_criteria` entry of a chat case, against the final reply (and, for task completion, the tools the agent
used). A criterion the judge cannot score (no credentials, the judge service down, a metric that needs context the case does not
have) is recorded with its reason and NO score: never a made-up zero, never a pass.

Governance (see `check_governance`): the judge is pinned per run, recorded with every score, and must be a different model from the one
under test unless the run explicitly allows it, because a model grading its own answers is not independent evidence. Judge calls cost
money and count against the run's budget, separately from the model under test.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from shared.evaluation.pricing import PriceTable

METRICS = ("correctness", "faithfulness", "relevance", "hallucination", "task_completion", "safety", "custom")
NEEDS_CONTEXT = {"faithfulness", "hallucination"}      # judged against the case's reference context; without any there is nothing to judge against


class JudgeGovernanceError(Exception):
    """The judge configuration breaks a rule (for example, the judge is the model under test)."""


def check_governance(judge_model: Optional[str], model_under_test: Optional[str], *, allow_same: bool = False) -> None:
    if not judge_model:
        return
    if judge_model.count("/") != 1 or not all(judge_model.split("/")):
        raise JudgeGovernanceError(f"the judge must be given as provider/model, got {judge_model!r}")
    if model_under_test and judge_model.lower() == model_under_test.lower() and not allow_same:
        raise JudgeGovernanceError(f"the judge ({judge_model}) is the model under test: a model grading its own answers is not independent "
                                   "evidence. Choose another judge, or pass --allow-same-judge to accept that on purpose.")


def final_reply(observation: Dict[str, Any]) -> str:
    return ((observation.get("response") or {}).get("text")) or ""


def build_requests(case: Dict[str, Any], observation: Dict[str, Any]) -> List[Dict[str, Any]]:
    """One scoring request per semantic criterion of the case."""
    messages = [m["content"] for m in (case.get("input") or {}).get("messages", []) if m.get("role") == "user"]
    if not messages and ((case.get("input") or {}).get("payload") or {}).get("message"):
        messages = [case["input"]["payload"]["message"]]
    context = [c["text"] for c in case.get("reference_context", []) if c.get("text")]
    expected = (case.get("expected") or {}).get("summary")
    tools = (observation.get("trace") or {}).get("executed_tools") or []
    out = []
    for crit in case.get("semantic_criteria", []):
        out.append({"criterion_id": crit["id"], "metric": crit.get("metric", "correctness"), "criterion": crit["criterion"],
                    "threshold": crit.get("threshold", 0.7), "weight": crit.get("weight", 1.0), "input": "\n".join(messages),
                    "actual_output": final_reply(observation), "expected_output": expected, "context": context, "tools_called": tools})
    return out


def _unscored(req: Dict[str, Any], status: str, reason: str, judge_model: Optional[str]) -> Dict[str, Any]:
    return {"metric": req["metric"], "layer": "L2", "criterion_id": req["criterion_id"], "score": None, "threshold": req["threshold"], "passed": None,
            "status": status, "reason": reason, "judge_model": judge_model, "judge_cost_usd": None, "input_tokens": None, "output_tokens": None}


async def score_case(client: Any, *, url: Optional[str], judge_model: Optional[str], case: Dict[str, Any], observation: Dict[str, Any],
                     table: Optional[PriceTable] = None, timeout: float = 120.0) -> Dict[str, Any]:
    """Score every criterion. Returns {"metrics": [...], "cost_usd": float|None, "scored": n, "unscored": n}. `cost_usd` is None when any
    scored call's cost could not be priced."""
    requests = build_requests(case, observation)
    table = table or PriceTable.builtin()
    metrics: List[Dict[str, Any]] = []
    if not requests:
        return {"metrics": [], "cost_usd": 0.0, "scored": 0, "unscored": 0}
    if not url or not judge_model:
        return {"metrics": [_unscored(r, "judge_not_configured", "no judge was selected for this run", judge_model) for r in requests],
                "cost_usd": 0.0, "scored": 0, "unscored": len(requests)}
    total, priced = 0.0, True
    for req in requests:
        if req["metric"] in NEEDS_CONTEXT and not req["context"]:
            metrics.append(_unscored(req, "not_applicable", f"{req['metric']} is judged against reference context and this case has none", judge_model))
            continue
        try:
            response = await client.post(f"{url}/score", json={**req, "judge_model": judge_model}, timeout=timeout)
            body = response.json()
        except Exception as exc:                                # noqa: BLE001 — an unreachable judge is a result, not a crash
            metrics.append(_unscored(req, "judge_error", f"the judge service could not be reached: {type(exc).__name__}", judge_model))
            continue
        if response.status_code != 200 or body.get("status") not in ("scored",):
            status = body.get("status") if isinstance(body, dict) and body.get("status") in ("blocked_missing_credentials", "judge_error", "not_applicable") else "judge_error"
            metrics.append(_unscored(req, status, (body.get("reason") or body.get("detail") or f"HTTP {response.status_code}") if isinstance(body, dict) else f"HTTP {response.status_code}", judge_model))
            continue
        cost = table.cost_of({"model_name": judge_model.split("/", 1)[1], "input_tokens": body.get("input_tokens"), "output_tokens": body.get("output_tokens"), "cached_tokens": 0})
        if cost is None:
            priced = False
        else:
            total += cost
        metrics.append({"metric": req["metric"], "layer": "L2", "criterion_id": req["criterion_id"], "score": body["score"], "threshold": req["threshold"],
                        "passed": body["score"] >= req["threshold"], "status": "scored", "reason": body.get("reason"), "judge_model": judge_model,
                        "judge_cost_usd": cost, "input_tokens": body.get("input_tokens"), "output_tokens": body.get("output_tokens")})
    scored = sum(1 for m in metrics if m["status"] == "scored")
    return {"metrics": metrics, "cost_usd": total if priced else None, "scored": scored, "unscored": len(metrics) - scored}
