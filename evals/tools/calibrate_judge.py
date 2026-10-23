"""Check that a judge can tell good answers from bad ones before its scores are trusted. Run inside eval-runner:

    python -m evals.tools.calibrate_judge --judge mock/mock-judge
    python evals/environment/envctl.py run ... --judge openai/gpt-4o --calibrate       # calibrate first, and record it with the run

Every item in evals/calibration/judge-calibration-v1.json is an answer whose quality is not in doubt, with the direction a sound judge
must score it (high: 0.7 or more, low: 0.4 or less). The judge is called exactly as a real run calls it. The report gives agreement per
metric and overall; below the threshold the judge is marked NOT TRUSTED, and a run says so beside every judged score. A judge that
could not be reached or has no key is `not_calibrated`, never trusted by default.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from shared.evaluation.pricing import PriceTable

ITEMS = Path(os.environ.get("EVAL_CALIBRATION", "/work/evals/calibration/judge-calibration-v1.json"))
HIGH, LOW = 0.7, 0.4
TRUST_AT = 0.8


def load_items(path: Path = ITEMS) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def verdict_of(score: Optional[float], expect: str) -> Optional[bool]:
    """Whether the score points the way the item says it should; None when there is no score."""
    if score is None:
        return None
    return score >= HIGH if expect == "high" else score <= LOW


def summarise(rows: List[Dict[str, Any]], *, version: str, judge_model: str, cost_usd: Optional[float]) -> Dict[str, Any]:
    scored = [r for r in rows if r["score"] is not None]
    agreed = sum(1 for r in scored if r["agreed"])
    by_metric: Dict[str, Dict[str, int]] = {}
    for r in scored:
        m = by_metric.setdefault(r["metric"], {"items": 0, "agreed": 0})
        m["items"] += 1
        m["agreed"] += 1 if r["agreed"] else 0
    agreement = (agreed / len(scored)) if scored else None
    if not scored:
        status = "not_calibrated"
    else:
        status = "trusted" if agreement >= TRUST_AT and len(scored) == len(rows) else "not_trusted" if agreement < TRUST_AT else "partial"
    return {"version": version, "judge_model": judge_model, "status": status, "items": len(rows), "scored": len(scored), "agreed": agreed, "agreement": agreement,
            "trust_threshold": TRUST_AT, "by_metric": by_metric, "disagreements": [r["id"] for r in scored if not r["agreed"]],
            "unscored": [{"id": r["id"], "status": r["status"], "reason": r["reason"]} for r in rows if r["score"] is None], "cost_usd": cost_usd}


async def calibrate(client: Any, *, url: str, judge_model: str, data: Optional[Dict[str, Any]] = None, timeout: float = 120.0) -> Dict[str, Any]:
    data = data or load_items()
    table = PriceTable.builtin()
    rows: List[Dict[str, Any]] = []
    cost, priced = 0.0, True
    for item in data["items"]:
        req = {"criterion_id": item["id"], "metric": item["metric"], "criterion": item["criterion"], "threshold": 0.7, "input": item.get("input", ""),
               "actual_output": item["actual_output"], "expected_output": item.get("expected_output"), "context": item.get("context", []),
               "tools_called": item.get("tools_called", []), "judge_model": judge_model}
        try:
            r = await client.post(f"{url}/score", json=req, timeout=timeout)
            body = r.json()
        except Exception as exc:                                   # noqa: BLE001 — an unreachable judge is a result
            rows.append({"id": item["id"], "metric": item["metric"], "expect": item["expect"], "score": None, "agreed": None, "status": "judge_error", "reason": type(exc).__name__})
            continue
        score = body.get("score") if body.get("status") == "scored" else None
        if score is not None:
            c = table.cost_of({"model_name": judge_model.split("/", 1)[1], "input_tokens": body.get("input_tokens"), "output_tokens": body.get("output_tokens"), "cached_tokens": 0})
            if c is None:
                priced = False
            else:
                cost += c
        rows.append({"id": item["id"], "metric": item["metric"], "expect": item["expect"], "score": score, "agreed": verdict_of(score, item["expect"]),
                     "status": body.get("status", "judge_error"), "reason": body.get("reason")})
    report = summarise(rows, version=data["version"], judge_model=judge_model, cost_usd=cost if priced else None)
    report["rows"] = rows
    return report


def render(report: Dict[str, Any]) -> str:
    out = [f"Judge calibration {report['version']}  judge {report['judge_model']}  ->  {report['status'].upper().replace('_', ' ')}"]
    if report["agreement"] is not None:
        out.append(f"  agreement {report['agreement'] * 100:.0f}% ({report['agreed']} of {report['scored']} scored; trusted from {report['trust_threshold'] * 100:.0f}%)")
    for metric, m in sorted(report["by_metric"].items()):
        out.append(f"    {metric:16} {m['agreed']} of {m['items']}")
    if report["disagreements"]:
        out.append("  the judge scored these the wrong way round: " + ", ".join(report["disagreements"]))
    for u in report["unscored"]:
        out.append(f"  not scored: {u['id']} ({u['status']}: {u['reason']})")
    return "\n".join(out)


async def main(argv: List[str]) -> int:
    p = argparse.ArgumentParser(prog="calibrate_judge")
    p.add_argument("--judge", required=True)
    p.add_argument("--url", default=os.environ.get("EVAL_JUDGE_URL"))
    args = p.parse_args(argv)
    async with httpx.AsyncClient() as client:
        report = await calibrate(client, url=args.url, judge_model=args.judge)
    print(render(report))
    return 0 if report["status"] == "trusted" else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
