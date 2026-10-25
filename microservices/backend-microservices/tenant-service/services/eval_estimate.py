"""What a run or a benchmark is expected to consume, before it starts: executions, tokens and USD per model, the judge, and the total.

An estimate, never a promise. Each figure says where it comes from:
  measured  the average of this model's own past executions of the same kind (at least MIN_SAMPLES), priced at today's registry price
  borrowed  the average of other real models' executions of that kind (the same agent prompt and tools, so the input size carries over)
  assumed   a fixed figure, because nothing has been measured yet

Cost is an UPPER bound: cached input tokens are priced as ordinary input. A scripted (mock) model costs nothing.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.evaluation import direct as direct_lib
from shared.evaluation import registry
from shared.evaluation.run_report import is_chat, select_cases
from shared.models.evaluation import EvalCaseResult, EvalMetricScore, EvalModel, EvalModelPrice, EvalRun

MIN_SAMPLES = 5
DEFAULT_PER_EXECUTION = {"agent": (25000, 600), "direct": (3000, 300)}      # input, output tokens
DEFAULT_PER_CRITERION = (3000, 500)                                          # the judge's input, output tokens
DEFAULT_REPEAT_FOR_AUTO = 3


async def _current_price(session: AsyncSession, label: str) -> Tuple[Optional[Dict[str, Any]], Optional[EvalModel]]:
    provider, model_id = registry.split_label(label)
    model = (await session.exec(select(EvalModel).where(EvalModel.provider == provider, EvalModel.model_id == model_id))).first()
    if model is None:
        return None, None
    rows = (await session.exec(select(EvalModelPrice).where(EvalModelPrice.model_row_id == model.id))).all()
    price = registry.price_on([{"effective_from": p.effective_from, "input_per_m": p.input_per_m, "output_per_m": p.output_per_m, "cached_per_m": p.cached_per_m} for p in rows],
                             datetime.utcnow())
    return price, model


async def _average_tokens(session: AsyncSession, label: Optional[str], mode: str) -> Tuple[int, int, str, int]:
    """(input, output, basis, samples) per model-backed execution."""
    kinds = ("benchmark_direct",) if mode == "direct" else ("suite", "benchmark_agent")

    async def avg(model_label: Optional[str]) -> Tuple[Optional[float], Optional[float], int]:
        stmt = (select(func.avg(EvalCaseResult.input_tokens), func.avg(EvalCaseResult.output_tokens), func.count())
                .join(EvalRun, EvalRun.id == EvalCaseResult.run_row_id)
                .where(EvalCaseResult.input_tokens.is_not(None), EvalCaseResult.input_tokens > 0, EvalRun.synthetic_model.is_(False), EvalRun.kind.in_(kinds)))
        if model_label:
            stmt = stmt.where(EvalRun.model_label == model_label)
        a, b, n = (await session.exec(stmt)).one()
        return (float(a) if a is not None else None, float(b) if b is not None else None, int(n or 0))

    own = await avg(label) if label else (None, None, 0)
    if own[2] >= MIN_SAMPLES:
        return round(own[0]), round(own[1] or 0), f"measured from {own[2]} past executions of this model", own[2]
    other = await avg(None)
    if other[2] >= MIN_SAMPLES:
        return round(other[0]), round(other[1] or 0), f"borrowed from {other[2]} past executions of other models", other[2]
    d_in, d_out = DEFAULT_PER_EXECUTION[mode]
    return d_in, d_out, "assumed (nothing measured yet)", 0


async def _judge_per_criterion(session: AsyncSession, judge: str) -> Tuple[int, int, str]:
    stmt = (select(func.avg(EvalMetricScore.input_tokens), func.avg(EvalMetricScore.output_tokens), func.count())
            .where(EvalMetricScore.judge_model == judge, EvalMetricScore.input_tokens.is_not(None)))
    a, b, n = (await session.exec(stmt)).one()
    if n and n >= MIN_SAMPLES:
        return round(float(a)), round(float(b or 0)), f"measured from {n} past judgements by this judge"
    return DEFAULT_PER_CRITERION[0], DEFAULT_PER_CRITERION[1], "assumed (this judge has not been used yet)"


def _usd(tokens_in: float, tokens_out: float, price: Optional[Dict[str, Any]]) -> Optional[float]:
    if price is None:
        return None
    return tokens_in / 1e6 * price["input_per_m"] + tokens_out / 1e6 * price["output_per_m"]


async def estimate_cost(session: AsyncSession, req: Any, cases: List[Dict[str, Any]]) -> Dict[str, Any]:
    """`req` is the JobRequest; `cases` are the cases of the (verified) published version."""
    mode = "direct" if req.kind == "benchmark_direct" else "agent"
    selected, _ = select_cases(cases, suite=req.suite, case_ids=req.case_ids, categories=req.categories, operations=req.operations)
    chat = [c for c in selected if is_chat(c)]
    if mode == "direct":
        chat = [c for c in chat if direct_lib.applicable(c) is None]
    reps = int(req.repeat) if req.repeat != "auto" else DEFAULT_REPEAT_FOR_AUTO
    labels = list(req.models) if req.models else ([req.model] if req.model else [])
    criteria = 0
    for c in chat:
        l2 = any(l.get("layer") == "L2" and l.get("enabled", True) for l in (c.get("evaluation") or {}).get("layers", [])) or not (c.get("evaluation") or {}).get("layers")
        crit = c.get("semantic_criteria", []) if l2 else []
        criteria += len([x for x in crit if not req.metrics or x.get("metric", "correctness") in req.metrics])
    executions = len(chat) * reps

    per_model: List[Dict[str, Any]] = []
    for label in labels:
        price, entry = await _current_price(session, label)
        synthetic = bool(entry.synthetic) if entry else label.startswith("mock/")
        t_in, t_out, basis, samples = await _average_tokens(session, label, mode)
        tokens_in, tokens_out = executions * t_in, executions * t_out
        cost = 0.0 if synthetic else _usd(tokens_in, tokens_out, price)
        per_model.append({"model": label, "synthetic": synthetic, "executions": executions, "input_tokens": 0 if synthetic else tokens_in, "output_tokens": 0 if synthetic else tokens_out,
                          "usd": cost, "usd_known": synthetic or price is not None, "basis": "scripted model: no cost" if synthetic else basis, "samples": samples,
                          "price": price and {"input_per_m": price["input_per_m"], "output_per_m": price["output_per_m"]}})

    judge: Dict[str, Any] = {"model": req.judge, "calls": 0, "input_tokens": 0, "output_tokens": 0, "usd": 0.0, "usd_known": True, "basis": "no judge selected"}
    if req.judge and criteria:
        calls = criteria * reps * max(len(labels), 1)
        j_in, j_out, j_basis = await _judge_per_criterion(session, req.judge)
        j_price, j_entry = await _current_price(session, req.judge)
        j_syn = bool(j_entry.synthetic) if j_entry else req.judge.startswith("mock/")
        judge = {"model": req.judge, "calls": calls, "input_tokens": 0 if j_syn else calls * j_in, "output_tokens": 0 if j_syn else calls * j_out,
                 "usd": 0.0 if j_syn else _usd(calls * j_in, calls * j_out, j_price), "usd_known": j_syn or j_price is not None,
                 "basis": "scripted judge: no cost" if j_syn else j_basis}
    unknown = [m["model"] for m in per_model if not m["usd_known"]] + ([judge["model"]] if not judge["usd_known"] else [])
    total = sum(m["usd"] or 0.0 for m in per_model) + (judge["usd"] or 0.0)
    out = {"mode": mode, "model_backed_cases": len(chat), "repetitions": reps, "repetitions_assumed": req.repeat == "auto", "judged_criteria_per_pass": criteria,
           "models": per_model, "judge": judge,
           "tokens": {"input": sum(m["input_tokens"] for m in per_model), "output": sum(m["output_tokens"] for m in per_model),
                      "judge_input": judge["input_tokens"], "judge_output": judge["output_tokens"]},
           "usd": {"models": sum(m["usd"] or 0.0 for m in per_model), "judge": judge["usd"] or 0.0, "total": total, "complete": not unknown, "unpriced": unknown},
           "upper_bound": True, "note": "an estimate: cached input is priced as ordinary input, so the real cost is usually lower; a case that is skipped or blocked costs nothing"}
    warnings: List[str] = []
    if req.budget_usd is not None and total > req.budget_usd:
        warnings.append(f"the estimate (${total:.4f}) is above the budget (${req.budget_usd:.2f}): the run will stop when the budget is reached and report the rest as blocked")
    if unknown:
        warnings.append("no price is registered for " + ", ".join(unknown) + ": its cost cannot be estimated")
    if executions == 0 and labels:
        warnings.append("no chat case is selected, so no model would be called")
    out["warnings"] = warnings
    return out
