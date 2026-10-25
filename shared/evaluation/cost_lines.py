"""Cost lines: every dollar of an evaluation run, split by what it paid for. Pure logic, no database and no network.

A run's results carry what the token ledger showed for each execution (`usage`), what the judge reported (`metric_scores`, `judge_cost_usd`) and what the
attempts that failed had already spent (`retry_usage`). This module turns those into lines, each of which says:

  component   candidate_llm | agent_llm | subagent_llm | judge | ocr | embedding | retry | fallback | unattributed | self_hosted
  cost_kind   estimated  computed from recorded token counts and a versioned price (nothing was invoiced yet)
              unknown    something was used but cannot be priced (no price for the model, or the ledger showed nothing); the amount is NULL, never 0
              confirmed  the provider reported or billed the amount; no run produces this today, a reconciled statement does (shared/evaluation/reconcile)
  source      where the number came from, in words a reviewer can follow

What each component means:
  candidate_llm  the model under test, asked directly (direct benchmarks)
  agent_llm      the application's chat agent answering for the model under test
  subagent_llm   one of the agent's specialists or helpers (the ledger names the service)
  judge          the DeepEval judge scoring an answer
  ocr            the OCR engine reading a document
  embedding      an embedding model (the application does not meter these yet, so none appear today)
  retry          calls made by an attempt that failed with an infrastructure error and was run again
  fallback       a call answered by a model other than the one under test (the agent failed over to its fallback provider)
  unattributed   spend the ledger showed during an execution that carries no thread of that execution (a late row, a conversation title)

A line is identified by `usage_ref`, a hash of (run, case, repetition, component, service, model, attempt): the same piece of spending can be recorded once,
so ingesting a run twice, or a run that crashed and was ingested again, can never count anything twice.
"""
from __future__ import annotations

import hashlib
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from shared.evaluation.pricing import PriceTable

COMPONENTS = ("candidate_llm", "agent_llm", "subagent_llm", "judge", "ocr", "embedding", "retry", "fallback", "unattributed", "self_hosted")
EMBEDDING_PREFIXES = ("gemini-embedding", "text-embedding", "embedding-", "voyage-", "embed-")
TOLERANCE_USD = 5e-6                                  # the run's total is rounded to six decimals


PROVIDERS = ("openai", "anthropic", "gemini")
_PROVIDER_ALIASES = {"google": "gemini"}


def provider_of(model: Optional[str]) -> Optional[str]:
    """The provider behind a model name: from a `provider/model` label (the judge's name), or from the model's own name (a ledger row names the model only)."""
    m = (model or "").lower().strip()
    if "/" in m:
        head, _, rest = m.partition("/")
        head = _PROVIDER_ALIASES.get(head, head)
        if head in PROVIDERS or head == "mock":
            return head
        m = rest                                                  # "models/gemini-embedding-001"
    if m.startswith(("gpt", "o1", "o3", "o4", "text-embedding", "chatgpt")):
        return "openai"
    if m.startswith("claude"):
        return "anthropic"
    if m.startswith("gemini"):
        return "gemini"
    if m.startswith("mock"):
        return "mock"
    return None


def is_embedding_model(model: Optional[str]) -> bool:
    return (model or "").lower().startswith(EMBEDDING_PREFIXES)


def is_candidate(model: Optional[str], candidate: Optional[str]) -> bool:
    """Whether the model a ledger row names is the one under test. A provider names the model it served with a date suffix (gpt-4.1-2025-04-14),
    so a ledger name that starts with the requested name is the right one. `candidate` is provider/model."""
    if not candidate:
        return True
    wanted = candidate.split("/", 1)[-1].lower()
    return str(model or "").lower().startswith(wanted)


def component_for(service: Optional[str], model: Optional[str], *, operation: Optional[str], candidate: Optional[str], synthetic: bool, mode: str) -> str:
    """Which component a ledger row (a service calling a model) belongs to. `mode` is agent or direct."""
    if is_embedding_model(model):
        return "embedding"
    name = (service or "").lower()
    if name.startswith("ocr") or (not service and str(operation or "").startswith("ocr")):
        return "ocr"
    if not synthetic and candidate and not is_candidate(model, candidate):
        return "fallback"
    if mode == "direct":
        return "candidate_llm"
    if name.startswith("chat agent") and name != "chat agent":                 # "Chat Agent — Claims Specialist", "Chat Agent — Plan Advisor", "Chat Agent — Title Generator", ...
        return "subagent_llm"
    return "agent_llm"


def usage_key(*parts: Any) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()


def _line(*, run_id: str, case_id: Optional[str], repetition: int, component: str, model: Optional[str], service: Optional[str], attempt: int, unit_kind: str = "tokens",
          input_units: float = 0, output_units: float = 0, cached_units: float = 0, usd: Optional[float], source: str, pricing_version_id: Any = None) -> Dict[str, Any]:
    return {"run_id": run_id, "case_id": case_id, "repetition": repetition, "component": component, "provider": provider_of(model), "model": (model or None),
            "unit_kind": unit_kind, "input_units": input_units, "output_units": output_units, "cached_units": cached_units, "usd": usd,
            "cost_kind": "unknown" if usd is None else "estimated", "source": source, "pricing_version_id": pricing_version_id,
            "usage_ref": usage_key(run_id, case_id, repetition, component, service or "-", model or "-", attempt)}


def _priced(table: PriceTable, model: str, v: Dict[str, Any]) -> Optional[float]:
    return table.cost_of({"model_name": model, "input_tokens": v.get("input_tokens"), "output_tokens": v.get("output_tokens"), "cached_tokens": v.get("cached_tokens", 0)})


def _items(block: Dict[str, Any]) -> Tuple[List[Tuple[Optional[str], str, Dict[str, Any]]], bool]:
    """(service, model, tokens) for each group of calls in a usage block, and whether the service names were recorded."""
    by_service = block.get("by_service") or {}
    if by_service:
        return [(svc, model, v) for svc, models in sorted(by_service.items()) for model, v in sorted(models.items())], True
    return [(None, model, v) for model, v in sorted((block.get("by_model") or {}).items())], False


def _from_usage(usage: Dict[str, Any], *, run_id: str, result: Dict[str, Any], candidate: Optional[str], synthetic: bool, mode: str, table: PriceTable,
                pricing_version_id: Any, attempt: int, retry: bool) -> List[Dict[str, Any]]:
    case_id, rep, operation = result["case_id"], int(result.get("repetition", 1)), result.get("operation")
    base = "candidate_llm" if mode == "direct" else "agent_llm"
    if operation and str(operation).startswith("ocr"):
        base = "ocr"
    where = f"attempt {attempt} (failed, run again)" if retry else None
    status = usage.get("status")
    out: List[Dict[str, Any]] = []
    if status != "attributed":
        comp = "retry" if retry else base
        why = usage.get("note") or f"the ledger result was '{status}'"
        out.append(_line(run_id=run_id, case_id=case_id, repetition=rep, component=comp, model=None, service=None, attempt=attempt, usd=None, pricing_version_id=pricing_version_id,
                         source=f"a model was used but its usage is not known: {why}" + (f"; {where}" if where else "")))
        return out
    items, named = _items(usage)
    for service, model, v in items:
        comp = "retry" if retry else component_for(service, model, operation=operation, candidate=candidate, synthetic=synthetic, mode=mode)
        usd = _priced(table, model, v)
        how = f"token ledger x prices '{table.label}'" if usd is not None else f"no price is recorded for {model} in '{table.label}'"
        if not named:
            how += "; the ledger's service name was not recorded for this run, so the component is inferred from the run's mode and the case's operation"
        if retry:
            was = component_for(service, model, operation=operation, candidate=candidate, synthetic=synthetic, mode=mode)
            how += f"; {where}; it would have been {was}"
        out.append(_line(run_id=run_id, case_id=case_id, repetition=rep, component=comp, model=model, service=service, attempt=attempt, input_units=int(v.get("input_tokens") or 0),
                         output_units=int(v.get("output_tokens") or 0), cached_units=int(v.get("cached_tokens") or 0), usd=usd, source=how, pricing_version_id=pricing_version_id))
    foreign = usage.get("foreign") or {}
    if foreign:
        f_items, _ = _items(foreign)
        for service, model, v in f_items:
            usd = _priced(table, model, v)
            out.append(_line(run_id=run_id, case_id=case_id, repetition=rep, component="unattributed", model=model, service=service, attempt=attempt, input_units=int(v.get("input_tokens") or 0),
                             output_units=int(v.get("output_tokens") or 0), cached_units=int(v.get("cached_tokens") or 0), usd=usd, pricing_version_id=pricing_version_id,
                             source=f"{v.get('calls', 0)} ledger row(s) seen during this execution that carry another thread id (a late row of an earlier execution, or a call with no thread such as a title); "
                                    f"token ledger x prices '{table.label}'" if usd is not None else f"ledger rows with another thread id; no price for {model}"))
    return out


def _judge_lines(result: Dict[str, Any], *, run_id: str) -> List[Dict[str, Any]]:
    scores = result.get("metric_scores") or []
    total = result.get("judge_cost_usd")
    by_model: Dict[str, Dict[str, Any]] = {}
    for m in scores:
        b = by_model.setdefault(m.get("judge_model") or "unknown", {"in": 0, "out": 0, "usd": 0.0, "any_usd": False})
        b["in"] += int(m.get("input_tokens") or 0)
        b["out"] += int(m.get("output_tokens") or 0)
        if m.get("judge_cost_usd") is not None:
            b["usd"] += float(m["judge_cost_usd"])
            b["any_usd"] = True
    if not by_model and not total:
        return []
    if not by_model:                                                  # a cost with no scores to say which judge: keep it, say so
        by_model = {"unknown": {"in": 0, "out": 0, "usd": float(total), "any_usd": True}}
    elif not any(b["any_usd"] for b in by_model.values()) and total is not None and len(by_model) == 1:
        next(iter(by_model.values())).update(usd=float(total), any_usd=True)
    out = []
    for model, b in sorted(by_model.items()):
        out.append(_line(run_id=run_id, case_id=result["case_id"], repetition=int(result.get("repetition", 1)), component="judge", model=None if model == "unknown" else model,
                         service="judge", attempt=0, input_units=b["in"], output_units=b["out"], usd=b["usd"] if b["any_usd"] else None,
                         source="computed by the judge service from the judge model's token counts and its price table" if b["any_usd"] else "the judge ran but reported no cost"))
    return out


def lines_for_result(run_id: str, result: Dict[str, Any], *, table: PriceTable, candidate: Optional[str], mode: str, synthetic: bool, pricing_version_id: Any = None) -> List[Dict[str, Any]]:
    """Every line one execution produced: its own calls, the calls of earlier failed attempts, anything unattributed, and the judge. No usage and no
    model call means no lines (nothing was spent, and that is known)."""
    out: List[Dict[str, Any]] = []
    usage = result.get("usage")
    uses_model = bool(result.get("llm_calls")) and result.get("status") not in ("skipped", "blocked")
    if usage is not None:
        out += _from_usage(usage, run_id=run_id, result=result, candidate=candidate, synthetic=synthetic, mode=mode, table=table, pricing_version_id=pricing_version_id, attempt=0, retry=False)
    elif uses_model:
        out.append(_line(run_id=run_id, case_id=result["case_id"], repetition=int(result.get("repetition", 1)), component="candidate_llm" if mode == "direct" else "agent_llm", model=None,
                         service=None, attempt=0, usd=None, pricing_version_id=pricing_version_id,
                         source=f"the execution reports {result.get('llm_calls')} model call(s) but no usage was recorded"))
    for i, prior in enumerate(result.get("retry_usage") or [], start=1):
        out += _from_usage(prior, run_id=run_id, result=result, candidate=candidate, synthetic=synthetic, mode=mode, table=table, pricing_version_id=pricing_version_id, attempt=i, retry=True)
    out += _judge_lines(result, run_id=run_id)
    return out


# ── totals and checks ──────────────────────────────────────────────────────────────────────────────────────────────────

def known_total(lines: Iterable[Dict[str, Any]]) -> float:
    return sum(l["usd"] for l in lines if l.get("usd") is not None)


def unknown_executions(lines: Iterable[Dict[str, Any]]) -> int:
    """Executions with at least one line whose cost is unknown (the judge's own unknowns are not counted here, as before)."""
    return len({(l["case_id"], l["repetition"]) for l in lines if l.get("cost_kind") == "unknown" and l["component"] != "judge"})


def by_component(lines: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for l in lines:
        c = out.setdefault(l["component"], {"usd": 0.0, "unknown_lines": 0, "input_units": 0, "output_units": 0, "lines": 0})
        c["lines"] += 1
        c["usd"] += l["usd"] or 0.0
        c["unknown_lines"] += 1 if l.get("usd") is None else 0
        c["input_units"] += l["input_units"]
        c["output_units"] += l["output_units"]
    return out


def _usage_tokens(block: Optional[Dict[str, Any]]) -> Tuple[int, int, int]:
    if not block or block.get("status") != "attributed":
        return 0, 0, 0
    base = (int(block.get("input_tokens") or 0), int(block.get("output_tokens") or 0), int(block.get("cached_tokens") or 0))
    f = block.get("foreign") or {}
    return base[0] + int(f.get("input_tokens") or 0), base[1] + int(f.get("output_tokens") or 0), base[2] + int(f.get("cached_tokens") or 0)


def check_run(run: Dict[str, Any], results: Sequence[Dict[str, Any]], lines: Sequence[Dict[str, Any]]) -> List[str]:
    """What is wrong with how a run's spending was attributed. An empty list means the lines account for the run exactly:
      the lines add up to the run's known cost, the run's unknown executions are the lines' unknown ones, the tokens of every execution are in its lines, every
      execution that used a model has a line, no line is recorded twice, and no line belongs to an execution that does not exist."""
    problems: List[str] = []
    known = known_total(lines)
    if abs(known - float(run.get("known_cost_usd") or 0.0)) > TOLERANCE_USD:
        problems.append(f"the lines add up to ${known:.6f} but the run records ${float(run.get('known_cost_usd') or 0.0):.6f}")
    if unknown_executions(lines) != int(run.get("unknown_cost_executions") or 0):
        problems.append(f"{unknown_executions(lines)} execution(s) have an unknown cost in the lines, the run records {int(run.get('unknown_cost_executions') or 0)}")
    refs = [l["usage_ref"] for l in lines]
    dupes = len(refs) - len(set((l["usage_ref"], l["component"]) for l in lines))
    if dupes:
        problems.append(f"{dupes} line(s) are recorded more than once")
    by_exec: Dict[Tuple[str, int], List[Dict[str, Any]]] = {}
    for l in lines:
        by_exec.setdefault((l["case_id"], l["repetition"]), []).append(l)
    seen = set()
    for r in results:
        key = (r["case_id"], int(r.get("repetition", 1)))
        seen.add(key)
        mine = [l for l in by_exec.get(key, []) if l["component"] != "judge"]
        want = [sum(x) for x in zip(_usage_tokens(r.get("usage")), *[_usage_tokens(u) for u in (r.get("retry_usage") or [])])] or [0, 0, 0]
        got = (sum(l["input_units"] for l in mine if l["unit_kind"] == "tokens"), sum(l["output_units"] for l in mine if l["unit_kind"] == "tokens"),
               sum(l["cached_units"] for l in mine if l["unit_kind"] == "tokens"))
        if tuple(want) != tuple(got):
            problems.append(f"{key[0]} r{key[1]}: the ledger shows tokens {tuple(want)} but the lines hold {got}")
        used_model = bool((r.get("usage") or {}).get("calls")) or (bool(r.get("llm_calls")) and r.get("status") not in ("skipped", "blocked")) or bool(r.get("retry_usage"))
        if used_model and not mine:
            problems.append(f"{key[0]} r{key[1]}: a model was used but no cost line was recorded")
    orphans = sorted({f"{c} r{n}" for (c, n) in by_exec if (c, n) not in seen})
    if orphans:
        problems.append(f"lines belong to execution(s) the run does not have: {', '.join(orphans[:5])}")
    return problems
