"""The Evaluation Studio's read model: the ecosystem map, global search, change impact and what the agent was observed doing. Everything is read from what the platform already
records (datasets, the change registry and its declared case dependencies, review items, jobs, runs, results, judge scores, cost lines, budgets); nothing here is invented.

The map's nodes carry a health state computed from real numbers, with the reason in words:
  ok | warn | bad | unknown     (unknown means there is not enough evidence to say, never "fine")
Agents, specialists, skills and tools exist only as far as runs OBSERVED them (the trace summary of each execution): the platform keeps no catalogue of them.
Pass rates in health judgments use real-model runs only; scripted models prove the machinery, not the quality.
"""
from datetime import date, datetime, time, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import Text, cast, func, or_
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from services import eval_budget, eval_reconcile
from shared.evaluation import analytics as an
from shared.evaluation import change_registry as cr
from shared.evaluation.policy import UNCONFIRMED
from shared.models.evaluation import (EvalBenchmark, EvalCaseDependency, EvalCaseResult, EvalCostLine, EvalDataset, EvalDatasetVersion, EvalDriftItem, EvalDriftScan, EvalJob, EvalMetricScore, EvalModel,
                                      EvalRegistryItem, EvalRegistryVersion, EvalRun, EvalStorageObject, EvalVersionCase)

RAN = ("passed", "failed")
ACTIVE_JOBS = ("queued", "running", "cancel_requested")
MIN_EXECUTIONS_FOR_HEALTH = 10
TYPE_LABEL = {"plan": "Plans", "rule": "Business rules", "workflow": "Workflows", "template": "Form templates", "calc": "Calculations", "gate": "Gates", "access": "Access rules", "message": "Messages", "form": "Forms"}


def _health(state: str, reason: str) -> Dict[str, str]:
    return {"state": state, "reason": reason}


def _pass_health(passed: int, ran: int, what: str) -> Dict[str, str]:
    if ran < MIN_EXECUTIONS_FOR_HEALTH:
        return _health("unknown", f"only {ran} real-model execution(s) of {what}: too few to judge")
    rate = passed / ran
    state = "ok" if rate >= 0.9 else "warn" if rate >= 0.7 else "bad"
    return _health(state, f"{rate * 100:.0f}% of {ran} real-model executions of {what} passed")


def _node(id_: str, kind: str, label: str, layer: int, order: int, health: Dict[str, str], stats: Dict[str, Any], *, badge: Optional[str] = None, active: bool = False) -> Dict[str, Any]:
    return {"id": id_, "kind": kind, "label": label, "layer": layer, "order": order, "health": health, "stats": stats, "badge": badge, "active": active}


async def _real_results(session: AsyncSession) -> List[Tuple[EvalCaseResult, EvalRun]]:
    rows = (await session.exec(select(EvalCaseResult, EvalRun).join(EvalRun, EvalRun.id == EvalCaseResult.run_row_id).where(EvalRun.state == "complete", EvalRun.synthetic_model == False))).all()   # noqa: E712
    return list(rows)


# ── what the agent was observed doing ─────────────────────────────────────────────────────────────────────────────────

async def observed(session: AsyncSession) -> Dict[str, Any]:
    """The agent, its specialists, skills and tools as the traces of past executions show them. There is no catalogue: a tool never used by any run does not appear."""
    rows = (await session.exec(select(EvalCaseResult.status, EvalCaseResult.trace_summary, EvalRun.synthetic_model, EvalRun.model_id, EvalRun.run_id)
                               .join(EvalRun, EvalRun.id == EvalCaseResult.run_row_id).where(EvalCaseResult.trace_summary != {}))).all()          # noqa: E711
    tools: Dict[str, Dict[str, Any]] = {}
    specs: Dict[str, Dict[str, Any]] = {}
    skills: Dict[str, Dict[str, Any]] = {}
    agent = {"executions": 0, "ran": 0, "passed": 0, "failed": 0, "blocked": 0, "infrastructure_errors": 0, "scripted_executions": 0}

    def bucket(d: Dict[str, Dict[str, Any]], name: str) -> Dict[str, Any]:
        return d.setdefault(name, {"name": name, "executions": 0, "ran": 0, "passed": 0, "failed": 0, "scripted_executions": 0, "tools": set(), "specialists": set(), "models": set()})
    for status, ts, synthetic, model, run_id in rows:
        ts = ts or {}
        names = ts.get("executed_tools") if isinstance(ts.get("executed_tools"), list) else []
        spec = ts.get("specialist")
        used_skills = [x for x in ts.get("skills") if isinstance(x, str)] if isinstance(ts.get("skills"), list) else []
        agent["executions"] += 1
        if synthetic:
            agent["scripted_executions"] += 1
        else:
            agent["ran"] += 1 if status in RAN else 0
            agent["passed"] += 1 if status == "passed" else 0
            agent["failed"] += 1 if status == "failed" else 0
            agent["blocked"] += 1 if status == "blocked" else 0
            agent["infrastructure_errors"] += 1 if status == "infrastructure_error" else 0
        for kind, name, d in [("tool", t, tools) for t in set(names)] + [("skill", k, skills) for k in set(used_skills)] + ([("specialist", spec, specs)] if spec else []):
            b = bucket(d, name)
            b["executions"] += 1
            if synthetic:
                b["scripted_executions"] += 1
            else:
                b["ran"] += 1 if status in RAN else 0
                b["passed"] += 1 if status == "passed" else 0
                b["failed"] += 1 if status == "failed" else 0
            if kind in ("tool", "skill") and spec:
                b["specialists"].add(spec)
            if kind in ("specialist", "skill"):
                b["tools"].update(names)
            if model and not synthetic:
                b["models"].add(model)

    def fin(b: Dict[str, Any]) -> Dict[str, Any]:
        return {**{k: v for k, v in b.items() if k not in ("tools", "specialists", "models")}, "pass_rate": (b["passed"] / b["ran"]) if b["ran"] else None,
                "tools": sorted(b["tools"]), "specialists": sorted(b["specialists"]), "models": sorted(b["models"])}
    return {"agent": {**agent, "pass_rate": (agent["passed"] / agent["ran"]) if agent["ran"] else None}, "specialists": sorted((fin(b) for b in specs.values()), key=lambda x: -x["executions"]),
            "tools": sorted((fin(b) for b in tools.values()), key=lambda x: -x["executions"]), "skills": sorted((fin(b) for b in skills.values()), key=lambda x: -x["executions"]),
            "note": "Observed from the traces of past executions. The platform keeps no catalogue of agents or tools, so one that no run has used does not appear here."}


# ── the map ───────────────────────────────────────────────────────────────────────────────────────────────────────────

async def graph(session: AsyncSession, *, today: Optional[date] = None) -> Dict[str, Any]:
    today = today or datetime.utcnow().date()
    month_start = datetime.combine(today.replace(day=1), time.min)
    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []

    # drift: open review items decide the health of what they concern
    open_items = (await session.exec(select(EvalDriftItem).where(EvalDriftItem.state.in_(["open", "in_review"])))).all()
    by_dataset: Dict[str, List[EvalDriftItem]] = {}
    by_item: Dict[str, List[EvalDriftItem]] = {}
    for it in open_items:
        if it.dataset_slug:
            by_dataset.setdefault(it.dataset_slug, []).append(it)
        if it.registry_item_key:
            by_item.setdefault(it.registry_item_key, []).append(it)
    worst = lambda items: "bad" if any(i.severity in ("critical", "high") for i in items) else "warn" if items else "ok"

    # business: registry items grouped by type
    items = (await session.exec(select(EvalRegistryItem).where(EvalRegistryItem.status == "active"))).all()
    latest_v: Dict[Any, int] = dict((await session.exec(select(EvalRegistryVersion.item_id, func.max(EvalRegistryVersion.version)).group_by(EvalRegistryVersion.item_id))).all())
    types: Dict[str, List[EvalRegistryItem]] = {}
    for it in items:
        types.setdefault(it.item_type, []).append(it)
    deps = (await session.exec(select(EvalCaseDependency.dataset_slug, EvalCaseDependency.dataset_version, EvalCaseDependency.case_key, EvalCaseDependency.item_key))).all()
    latest_dep_version: Dict[str, Tuple[int, ...]] = {}
    for slug, ver, _, _ in deps:
        v = tuple(int(x) for x in ver.split(".") if x.isdigit())
        latest_dep_version[slug] = max(latest_dep_version.get(slug, ()), v)
    dep_edges: Dict[Tuple[str, str], set] = {}
    for slug, ver, case, key in deps:
        if tuple(int(x) for x in ver.split(".") if x.isdigit()) != latest_dep_version[slug]:
            continue
        dep_edges.setdefault((key.split(":", 1)[0], slug), set()).add(case)
    for order, (t, its) in enumerate(sorted(types.items(), key=lambda kv: -len(kv[1]))):
        changed = [i for i in its if latest_v.get(i.id, 1) > 1]
        findings = [f for i in its for f in by_item.get(i.item_key, [])]
        health = _health("ok", "no open review item concerns these") if not findings else _health(worst(findings), f"{len(findings)} open review item(s) concern these")
        nodes.append(_node(f"rules:{t}", "rules", f"{TYPE_LABEL.get(t, t.title())} ({len(its)})", 0, order, health,
                           {"type": t, "items": len(its), "changed": len(changed), "open_findings": len(findings), "dependent_cases": len({c for (tt, _), cs in dep_edges.items() if tt == t for c in cs})},
                           badge=f"{len(changed)} changed" if changed else None))

    # golden datasets
    datasets = (await session.exec(select(EvalDataset).where(EvalDataset.status == "active").order_by(EvalDataset.slug))).all()
    run_rows = (await session.exec(select(EvalRun).where(EvalRun.state == "complete").order_by(EvalRun.started_at.desc()))).all()
    for order, d in enumerate(datasets):
        v = (await session.exec(select(EvalDatasetVersion).where(EvalDatasetVersion.dataset_id == d.id, EvalDatasetVersion.state == "published").order_by(EvalDatasetVersion.published_at.desc()).limit(1))).first()
        unconfirmed = 0
        if v is not None:
            unconfirmed = (await session.exec(select(func.count()).select_from(EvalVersionCase).where(EvalVersionCase.version_id == v.id, EvalVersionCase.verification == UNCONFIRMED))).one()
        mine = by_dataset.get(d.slug, [])
        covered = (await session.exec(select(func.count(func.distinct(EvalCaseResult.case_key))).join(EvalRun, EvalRun.id == EvalCaseResult.run_row_id)
                                      .where(EvalRun.dataset_slug == d.slug, EvalRun.state == "complete", EvalRun.synthetic_model == False, EvalCaseResult.status.in_(list(RAN))))).one()           # noqa: E712
        runs = [r for r in run_rows if r.dataset_slug == d.slug]
        real = [r for r in runs if not r.synthetic_model and r.passed + r.failed > 0]
        if mine:
            health = _health(worst(mine), f"{len(mine)} open review item(s) concern this dataset")
        elif unconfirmed:
            health = _health("warn", f"{unconfirmed} case(s) rest on a rule the business has not confirmed")
        elif v is None:
            health = _health("unknown", "no version is published")
        else:
            health = _health("ok", "published, nothing open")
        nodes.append(_node(f"dataset:{d.slug}", "dataset", d.name, 1, order, health,
                           {"slug": d.slug, "turn_mode": d.turn_mode, "latest_version": v.version if v else None, "cases": v.case_count if v else 0, "unconfirmed": int(unconfirmed), "open_findings": len(mine),
                            "runs": len(runs), "real_runs": len(real), "covered_cases": int(covered), "last_pass_rate": (real[0].pass_rate if real else None), "last_run_at": (real[0].started_at if real else None)},
                           badge=f"v{v.version}" if v else None))
    for (t, slug), cases in dep_edges.items():
        if f"rules:{t}" in {n["id"] for n in nodes} and f"dataset:{slug}" in {n["id"] for n in nodes}:
            edges.append({"from": f"rules:{t}", "to": f"dataset:{slug}", "kind": "depends", "weight": len(cases), "label": f"{len(cases)} case(s) depend on it"})

    # the data lake (MinIO): the objects that hold every dataset layer, every published version and every run's artifacts, and whether they still verify
    objs = dict((await session.exec(select(EvalStorageObject.layer, func.count()).group_by(EvalStorageObject.layer))).all())
    obj_states = dict((await session.exec(select(EvalStorageObject.state, func.count()).group_by(EvalStorageObject.state))).all())
    bad_objs = int(obj_states.get("corrupt", 0)) + int(obj_states.get("missing", 0))
    n_versions = (await session.exec(select(func.count()).select_from(EvalDatasetVersion).where(EvalDatasetVersion.state == "published"))).one()
    nodes.append(_node("lake", "lake", "Data lake (MinIO)", 1, len([n for n in nodes if n["layer"] == 1]),
                       _health("unknown", "nothing is stored yet") if not sum(objs.values()) else _health("bad", f"{bad_objs} stored object(s) are corrupt or missing") if bad_objs
                       else _health("ok", f"{sum(objs.values())} objects stored, none corrupt or missing"),
                       {"objects_by_layer": {k: int(v) for k, v in objs.items()}, "objects_by_state": {k: int(v) for k, v in obj_states.items()}, "published_versions": int(n_versions), "corrupt_or_missing": bad_objs},
                       badge=f"{n_versions} versions"))
    for d in datasets:
        edges.append({"from": "lake", "to": f"dataset:{d.slug}", "kind": "stores", "weight": int(objs.get("gold", 0)), "label": "holds its versions"})

    # harness: jobs and runs
    since = datetime.utcnow() - timedelta(days=7)
    jobs = [j for j in (await session.exec(select(EvalJob).where(EvalJob.created_at >= since).order_by(EvalJob.created_at.desc()))).all() if (j.config or {}).get("kind") != "drift_scan"]
    running = [j for j in jobs if j.state in ACTIVE_JOBS]
    failed_recent = [j for j in jobs if j.state in ("failed", "lost") and j.created_at >= datetime.utcnow() - timedelta(days=1)]
    if failed_recent:
        h_health = _health("bad", f"{len(failed_recent)} job(s) failed or were lost in the last day")
    elif running:
        h_health = _health("ok", f"{len(running)} job(s) in progress")
    elif jobs:
        h_health = _health("ok", "recent jobs finished")
    else:
        h_health = _health("unknown", "no job in the last 7 days")
    nodes.append(_node("harness", "harness", "Evaluation harness", 2, 1, h_health,
                       {"running": [{"job_id": str(j.id), "state": j.state, "dataset": (j.config or {}).get("dataset"), "version": (j.config or {}).get("version"), "models": (j.config or {}).get("models") or [(j.config or {}).get("model")],
                                     "executions": (j.progress or {}).get("executions"), "planned": (j.progress or {}).get("planned"), "spent_usd": (j.progress or {}).get("spent_usd")} for j in running],
                        "jobs_7d": len(jobs), "failed_1d": len(failed_recent), "runs_total": len(run_rows), "scripted_runs": sum(1 for r in run_rows if r.synthetic_model)},
                       badge=f"{len(running)} running" if running else None, active=bool(running)))
    for d in datasets:
        edges.append({"from": f"dataset:{d.slug}", "to": "harness", "kind": "feeds", "weight": sum(1 for r in run_rows if r.dataset_slug == d.slug), "label": "runs of this dataset"})

    # drift monitor
    last_scan = (await session.exec(select(EvalDriftScan).order_by(EvalDriftScan.created_at.desc()).limit(1))).first()
    sev: Dict[str, int] = {}
    for it in open_items:
        sev[it.severity] = sev.get(it.severity, 0) + 1
    if not last_scan and not open_items:
        d_health = _health("unknown", "no scan has run yet")
    elif open_items:
        d_health = _health(worst(open_items), f"{len(open_items)} open review item(s)")
    else:
        d_health = _health("ok", "nothing waiting for a decision")
    nodes.append(_node("drift", "drift", "Drift monitor", 2, 0, d_health, {"open": len(open_items), "by_severity": sev, "last_scan_at": last_scan.created_at if last_scan else None}, badge=f"{len(open_items)} open" if open_items else None))
    for n in [n for n in nodes if n["kind"] == "rules"]:
        edges.append({"from": "drift", "to": n["id"], "kind": "monitors", "weight": n["stats"]["open_findings"], "label": "watches for changes"})
    for d in datasets:
        edges.append({"from": "drift", "to": f"dataset:{d.slug}", "kind": "monitors", "weight": len(by_dataset.get(d.slug, [])), "label": "watches the dataset"})

    # the system under test, as observed
    obs = await observed(session)
    a = obs["agent"]
    nodes.append(_node("agent", "agent", "Insurance chat agent", 3, 1, _pass_health(a["passed"], a["ran"], "the agent") if a["ran"] else _health("unknown", "no real-model execution has observed the agent yet"),
                       {**{k: a[k] for k in ("executions", "ran", "passed", "failed", "blocked", "infrastructure_errors", "scripted_executions", "pass_rate")}, "observed_only": True}))
    edges.append({"from": "harness", "to": "agent", "kind": "exercises", "weight": a["executions"], "label": "executions observed"})
    if obs["specialists"]:
        worst_spec = min((s for s in obs["specialists"] if s["ran"] >= 3), key=lambda s: s["pass_rate"] or 0, default=None)
        nodes.append(_node("specialists", "specialists", f"Specialists ({len(obs['specialists'])})", 3, 0,
                           _health("ok" if not worst_spec or (worst_spec["pass_rate"] or 0) >= 0.9 else "warn", "no specialist with 3 or more real executions is failing" if not worst_spec or (worst_spec["pass_rate"] or 0) >= 0.9
                                   else f"{worst_spec['name']} passed {worst_spec['pass_rate'] * 100:.0f}% of {worst_spec['ran']}") if any(s["ran"] >= 3 for s in obs["specialists"]) else _health("unknown", "too few real executions"),
                           {"items": [s["name"] for s in obs["specialists"]], "observed_only": True}))
        edges.append({"from": "agent", "to": "specialists", "kind": "routes", "weight": sum(s["executions"] for s in obs["specialists"]), "label": "routed to"})
    if obs["skills"]:
        weak_sk = [k for k in obs["skills"] if k["ran"] >= 5 and (k["pass_rate"] or 0) < 0.7]
        nodes.append(_node("skills", "skills", f"Skills ({len(obs['skills'])})", 3, 1,
                           _health("warn", f"{len(weak_sk)} skill(s) loaded by real executions that mostly failed: {', '.join(k['name'] for k in weak_sk[:3])}") if weak_sk
                           else _health("ok", "no skill with 5 or more real executions is failing") if any(k["ran"] >= 5 for k in obs["skills"]) else _health("unknown", "too few real executions"),
                           {"items": [k["name"] for k in obs["skills"]], "observed_only": True}))
        edges.append({"from": "agent", "to": "skills", "kind": "loads", "weight": sum(k["executions"] for k in obs["skills"]), "label": "skills loaded"})
    if obs["tools"]:
        weak = [t for t in obs["tools"] if t["ran"] >= 5 and (t["pass_rate"] or 0) < 0.7]
        nodes.append(_node("tools", "tools", f"Tools ({len(obs['tools'])})", 3, 2, _health("warn", f"{len(weak)} tool(s) used by real executions that mostly failed: {', '.join(t['name'] for t in weak[:3])}") if weak
                           else _health("ok", "no tool with 5 or more real executions is failing") if any(t["ran"] >= 5 for t in obs["tools"]) else _health("unknown", "too few real executions"),
                           {"items": [t["name"] for t in obs["tools"]], "observed_only": True}))
        edges.append({"from": "agent", "to": "tools", "kind": "calls", "weight": sum(t["executions"] for t in obs["tools"]), "label": "tool calls observed"})

    # providers and models
    models = (await session.exec(select(EvalModel))).all()
    by_provider: Dict[str, List[EvalModel]] = {}
    for m in models:
        by_provider.setdefault(m.provider, []).append(m)
    prov_runs: Dict[str, List[EvalRun]] = {}
    for r in run_rows:
        prov_runs.setdefault(r.provider or "none", []).append(r)
    prov = eval_reconcile.provider_expr()                                 # one expression object, so the SELECT and the GROUP BY carry the same parameters
    prov_spend = dict((await session.exec(select(prov, func.coalesce(func.sum(EvalCostLine.usd), 0.0)).where(EvalCostLine.incurred_at >= month_start).group_by(prov))).all())
    blocked_rows = (await session.exec(select(EvalRun.provider, func.count()).join(EvalCaseResult, EvalCaseResult.run_row_id == EvalRun.id).where(EvalCaseResult.reason == "blocked_missing_credentials").group_by(EvalRun.provider))).all()
    blocked = {p: n for p, n in blocked_rows}
    for order, (p, ms) in enumerate(sorted(by_provider.items(), key=lambda kv: (kv[0] == "mock", kv[0]))):
        runs = [r for r in prov_runs.get(p, []) if not r.synthetic_model]
        ran = sum(r.passed + r.failed for r in runs)
        passed = sum(r.passed for r in runs)
        if p == "mock":
            health = _health("ok", "scripted stand-ins: they test the machinery and say nothing about quality")
        elif blocked.get(p):
            health = _health("warn", f"{blocked[p]} execution(s) were blocked for a missing API key")
        else:
            health = _pass_health(passed, ran, f"{p} models") if ran else _health("unknown", "no real run yet")
        nodes.append(_node(f"provider:{p}", "provider", {"openai": "OpenAI GPT", "gemini": "Google Gemini", "anthropic": "Anthropic Claude", "mock": "Scripted models"}.get(p, p), 4, order, health,
                           {"provider": p, "models": len(ms), "active_models": sum(1 for m in ms if m.status == "active"), "real_runs": len(runs), "ran": ran, "passed": passed, "pass_rate": (passed / ran) if ran else None,
                            "spend_month_usd": round(float(prov_spend.get(p, 0.0) or 0.0), 6), "blocked_for_key": blocked.get(p, 0)}))
        edges.append({"from": "agent", "to": f"provider:{p}", "kind": "uses", "weight": len(prov_runs.get(p, [])), "label": "runs against these models"})

    # judging, results and money
    scores = (await session.exec(select(EvalMetricScore.metric, EvalMetricScore.status, EvalMetricScore.score, EvalMetricScore.passed, EvalMetricScore.judge_model))).all()
    scored = [s for s in scores if s[1] == "scored" and s[2] is not None]
    errors = sum(1 for s in scores if s[1] not in ("scored", "not_scored") and s[1] != "blocked_missing_credentials")
    metrics: Dict[str, Dict[str, Any]] = {}
    for m, st, sc, ps, jm in scored:
        b = metrics.setdefault(m, {"n": 0, "sum": 0.0, "passed": 0})
        b["n"] += 1; b["sum"] += sc; b["passed"] += 1 if ps else 0
    share = errors / len(scores) if scores else 0.0
    nodes.append(_node("deepeval", "deepeval", "DeepEval judge", 5, 0, _health("unknown", "no judged score yet") if not scores else _health("bad" if share > 0.2 else "warn" if share > 0.05 else "ok", f"{errors} of {len(scores)} judge call(s) failed"),
                       {"metrics": {m: {"n": v["n"], "mean": v["sum"] / v["n"], "met": v["passed"] / v["n"]} for m, v in metrics.items()}, "judges": sorted({s[4] for s in scores if s[4]}), "judge_errors": errors}))
    edges.append({"from": "harness", "to": "deepeval", "kind": "judged_by", "weight": len(scored), "label": "answers scored"})
    real = await _real_results(session)
    counts: Dict[str, int] = {}
    for r, _ in real:
        counts[r.status] = counts.get(r.status, 0) + 1
    ran_n, pass_n = counts.get("passed", 0) + counts.get("failed", 0), counts.get("passed", 0)
    crit = sum(1 for r, _ in real if r.critical_failed)
    nodes.append(_node("results", "results", "Results", 5, 1, _pass_health(pass_n, ran_n, "all runs") if ran_n else _health("unknown", "no real-model execution yet"),
                       {"by_status": counts, "pass_rate": (pass_n / ran_n) if ran_n else None, "critical_failures": crit, "real_executions": len(real)}, badge=f"{counts.get('failed', 0)} failed" if counts.get("failed") else None))
    edges.append({"from": "harness", "to": "results", "kind": "produces", "weight": len(real), "label": "executions recorded"})
    edges.append({"from": "deepeval", "to": "results", "kind": "scores", "weight": len(scored), "label": "scores attached"})
    budget = await eval_budget.status(session)
    month_total = float((await session.exec(select(func.coalesce(func.sum(EvalCostLine.usd), 0.0)).where(EvalCostLine.incurred_at >= month_start, func.coalesce(eval_reconcile.provider_expr(), "") != "mock"))).one())
    unknown_lines = (await session.exec(select(func.count()).select_from(EvalCostLine).where(EvalCostLine.incurred_at >= month_start, EvalCostLine.usd == None))).one()       # noqa: E711
    bs = budget["status"]
    c_health = _health("bad", "a spending limit is reached: " + "; ".join(budget["messages"][:1])) if bs == "exceeded" else _health("warn", "close to a spending limit") if bs == "warning" else \
        _health("warn", f"{unknown_lines} cost line(s) could not be priced") if unknown_lines else _health("ok", "within limits" if bs == "ok" else "no limit is set")
    nodes.append(_node("costs", "costs", "Costs & budgets", 5, 2, c_health, {"month_usd": round(month_total, 6), "budget": {k: {x: v[x] for x in ("limit_usd", "spent_usd", "reserved_usd", "status", "used_pct")} for k, v in budget["periods"].items()}, "unknown_lines": int(unknown_lines)},
                       badge=f"${month_total:.2f}"))
    edges.append({"from": "results", "to": "costs", "kind": "costs", "weight": int(month_total * 1000), "label": "spend recorded"})
    health_counts: Dict[str, int] = {}
    for n in nodes:
        health_counts[n["health"]["state"]] = health_counts.get(n["health"]["state"], 0) + 1
    return {"as_of": datetime.utcnow(), "nodes": sorted(nodes, key=lambda n: (n["layer"], n["order"])), "edges": edges, "health": health_counts,
            "layers": ["Business", "Golden data", "Harness", "System under test", "Models", "Outcomes"], "running": [r for n in nodes if n["id"] == "harness" for r in n["stats"]["running"]],
            "note": "Nodes and links are read from what the platform records. Agents, specialists and tools are those observed in run traces."}


# ── global search ─────────────────────────────────────────────────────────────────────────────────────────────────────

async def search(session: AsyncSession, q: str, *, per_group: int = 6) -> Dict[str, Any]:
    """Datasets, cases, runs and benchmarks, models, business rules and templates, and review items whose name or text contains `q`."""
    q = (q or "").strip()
    if len(q) < 2:
        return {"q": q, "groups": [], "total": 0}
    like = f"%{q}%"
    groups: List[Dict[str, Any]] = []

    def add(kind: str, label: str, items: List[Dict[str, Any]]) -> None:
        if items:
            groups.append({"kind": kind, "label": label, "items": items[:per_group]})
    add("dataset", "Datasets", [{"id": d.slug, "title": d.name, "sub": f"{d.slug} · latest {d.latest_version or 'unpublished'}"} for d in (await session.exec(select(EvalDataset).where(or_(EvalDataset.slug.ilike(like), EvalDataset.name.ilike(like))).limit(per_group))).all()])
    cases = (await session.exec(select(EvalVersionCase.case_key, EvalVersionCase.category, EvalVersionCase.severity, EvalDataset.slug, func.max(EvalDatasetVersion.version))
                                .join(EvalDatasetVersion, EvalDatasetVersion.id == EvalVersionCase.version_id).join(EvalDataset, EvalDataset.id == EvalDatasetVersion.dataset_id)
                                .where(EvalVersionCase.case_key.ilike(like)).group_by(EvalVersionCase.case_key, EvalVersionCase.category, EvalVersionCase.severity, EvalDataset.slug)
                                .order_by(func.max(EvalDatasetVersion.published_at).desc().nullslast(), EvalVersionCase.case_key, EvalDataset.slug).limit(per_group))).all()          # newest dataset first, so a capped list is the same every time
    add("case", "Golden cases", [{"id": c, "title": c, "sub": f"{slug} {ver} · {cat or '—'} · {sev or '—'}", "dataset": slug} for c, cat, sev, slug, ver in cases])
    add("benchmark", "Benchmarks", [{"id": b.benchmark_id, "title": " vs ".join(m.get("label", "") for m in (b.models or [])) or b.benchmark_id, "sub": f"{b.dataset_slug} {b.dataset_version} · {b.mode}{' · scripted' if b.synthetic else ''}", "when": b.created_at}
                                    for b in (await session.exec(select(EvalBenchmark).where(or_(EvalBenchmark.benchmark_id.ilike(like), cast(EvalBenchmark.models, Text).ilike(like))).order_by(EvalBenchmark.created_at.desc()).limit(per_group))).all()])
    add("run", "Runs", [{"id": r.run_id, "title": r.run_id, "sub": f"{r.model_id or 'no model'} · {r.dataset_slug} {r.dataset_version} · {r.kind}", "when": r.started_at}
                        for r in (await session.exec(select(EvalRun).where(or_(EvalRun.run_id.ilike(like), EvalRun.model_id.ilike(like))).order_by(EvalRun.started_at.desc()).limit(per_group))).all()])
    add("model", "Models", [{"id": m.id.hex if hasattr(m.id, "hex") else str(m.id), "title": f"{m.provider}/{m.model_id}", "sub": f"{m.display_name or ''} · {m.status}{' · scripted' if m.synthetic else ''}", "provider": m.provider}
                            for m in (await session.exec(select(EvalModel).where(or_(EvalModel.model_id.ilike(like), EvalModel.display_name.ilike(like), EvalModel.provider.ilike(like))).limit(per_group))).all()])
    add("rule", "Business rules, plans and templates", [{"id": i.item_key, "title": i.title, "sub": f"{i.item_key} · {i.item_type}", "type": i.item_type}
                                                        for i in (await session.exec(select(EvalRegistryItem).where(EvalRegistryItem.status == "active", or_(EvalRegistryItem.item_key.ilike(like), EvalRegistryItem.title.ilike(like))).limit(per_group))).all()])
    add("finding", "Review items", [{"id": str(i.id), "title": i.summary[:140], "sub": f"{i.kind} · {i.severity} · {i.state}"} for i in (await session.exec(select(EvalDriftItem).where(EvalDriftItem.summary.ilike(like)).order_by(EvalDriftItem.opened_at.desc()).limit(per_group))).all()])
    return {"q": q, "groups": groups, "total": sum(len(g["items"]) for g in groups)}


# ── change impact ─────────────────────────────────────────────────────────────────────────────────────────────────────

def _vtuple(v: str) -> Tuple[int, ...]:
    return tuple(int(x) for x in v.split(".") if x.isdigit())


async def _latest_dependencies(session: AsyncSession) -> List[Tuple[str, str, str, str]]:
    rows = (await session.exec(select(EvalCaseDependency.dataset_slug, EvalCaseDependency.dataset_version, EvalCaseDependency.case_key, EvalCaseDependency.item_key))).all()
    latest: Dict[str, Tuple[int, ...]] = {}
    for slug, ver, _, _ in rows:
        latest[slug] = max(latest.get(slug, ()), _vtuple(ver))
    return [r for r in rows if _vtuple(r[1]) == latest[r[0]]]


async def impact_candidates(session: AsyncSession) -> Dict[str, Any]:
    """The things worth looking at: registry items that changed, that have open review items, or that cases depend on."""
    deps = await _latest_dependencies(session)
    open_items = (await session.exec(select(EvalDriftItem).where(EvalDriftItem.state.in_(["open", "in_review"])))).all()
    findings: Dict[str, int] = {}
    for it in open_items:
        if it.registry_item_key:
            findings[it.registry_item_key] = findings.get(it.registry_item_key, 0) + 1
    out = []
    for item in (await session.exec(select(EvalRegistryItem).where(EvalRegistryItem.status == "active"))).all():
        vs = (await session.exec(select(EvalRegistryVersion.version, EvalRegistryVersion.captured_at).where(EvalRegistryVersion.item_id == item.id).order_by(EvalRegistryVersion.version.desc()).limit(1))).first()
        n_dep = len({c for _, _, c, k in deps if cr.dependents(item.item_key, [(c, k)], {})})
        changed = bool(vs and vs[0] > 1)
        if changed or n_dep or findings.get(item.item_key):
            out.append({"key": item.item_key, "title": item.title, "type": item.item_type, "version": vs[0] if vs else None, "changed_at": vs[1] if changed else None, "dependent_cases": n_dep, "open_findings": findings.get(item.item_key, 0)})
    out.sort(key=lambda x: (-x["open_findings"], x["changed_at"] is None, -(x["changed_at"].timestamp() if x["changed_at"] else 0), -x["dependent_cases"]))
    return {"items": out}


async def impact(session: AsyncSession, item_key: str) -> Optional[Dict[str, Any]]:
    """What a change to one watched item touches: the cases that declare a dependency on it (with how the latest real run did on each), the review items it caused, the dataset versions
    published since, and how real runs before and after the change compare. Only declared dependencies and recorded runs are used."""
    item = (await session.exec(select(EvalRegistryItem).where(EvalRegistryItem.item_key == item_key))).first()
    if item is None:
        return None
    vs = (await session.exec(select(EvalRegistryVersion).where(EvalRegistryVersion.item_id == item.id).order_by(EvalRegistryVersion.version.desc()).limit(8))).all()
    by_v = {v.version: v for v in vs}
    versions = [{"version": v.version, "captured_at": v.captured_at, "captured_from": v.captured_from, "diff": cr.diff_summaries(by_v[v.version - 1].summary, v.summary) if v.version - 1 in by_v else []} for v in vs]
    changed_at = vs[0].captured_at if vs and vs[0].version > 1 else None

    deps = await _latest_dependencies(session)
    pairs_by_ds: Dict[str, List[Tuple[str, str]]] = {}
    ver_by_ds: Dict[str, str] = {}
    for slug, ver, case, key in deps:
        pairs_by_ds.setdefault(slug, []).append((case, key))
        ver_by_ds[slug] = ver
    dependents: List[Dict[str, Any]] = []
    for slug, pairs in pairs_by_ds.items():
        cases = [d["case_id"] for d in cr.dependents(item_key, pairs, {})]
        if not cases:
            continue
        meta = {k: (cat, sev) for k, cat, sev in (await session.exec(select(EvalVersionCase.case_key, EvalVersionCase.category, EvalVersionCase.severity).join(EvalDatasetVersion, EvalDatasetVersion.id == EvalVersionCase.version_id)
                                                                      .join(EvalDataset, EvalDataset.id == EvalDatasetVersion.dataset_id).where(EvalDataset.slug == slug, EvalDatasetVersion.version == ver_by_ds[slug], EvalVersionCase.case_key.in_(cases)))).all()}
        latest: Dict[str, Dict[str, Any]] = {}
        for r, run in (await session.exec(select(EvalCaseResult, EvalRun).join(EvalRun, EvalRun.id == EvalCaseResult.run_row_id).where(EvalRun.dataset_slug == slug, EvalRun.synthetic_model == False,           # noqa: E712
                                                                                                                                       EvalCaseResult.case_key.in_(cases), EvalRun.state == "complete").order_by(EvalRun.started_at.desc()))).all():
            latest.setdefault(r.case_key, {"status": r.status, "model": run.model_id, "run_id": run.run_id, "result_id": str(r.id), "at": run.started_at, "critical_failed": r.critical_failed})
        for c in sorted(cases):
            dependents.append({"dataset": slug, "version": ver_by_ds[slug], "case_id": c, "category": meta.get(c, (None, None))[0], "severity": meta.get(c, (None, None))[1], "latest_real_result": latest.get(c)})
    case_ids = {d["case_id"] for d in dependents}

    template_key = item_key.split(":", 1)[1] if item_key.startswith("template:") else None
    drift = [i for i in (await session.exec(select(EvalDriftItem).order_by(EvalDriftItem.opened_at.desc()))).all()
             if i.registry_item_key == item_key or (template_key and ((i.detail or {}).get("provenance") or {}).get("template") == template_key)           # a suggested case for a field the template gained
             or (i.kind in ("rule_changed", "unconfirmed", "proposal", "coverage_gap") and case_ids & set(i.affected_cases or []))]
    suggested = [{"id": str(i.id), "kind": i.kind, "severity": i.severity, "state": i.state, "summary": i.summary, "needs_expected": i.kind in ("proposal", "rule_changed", "unconfirmed", "coverage_gap"),
                  "decision_note": i.decision_note, "decided_at": i.decided_at, "affected_cases": [c for c in (i.affected_cases or []) if c in case_ids][:12], "dataset": i.dataset_slug} for i in drift[:25]]

    datasets = sorted({d["dataset"] for d in dependents})
    versions_by_ds: Dict[str, List[Dict[str, Any]]] = {}
    regression: Dict[str, Any] = {}
    for slug in datasets:
        dvs = (await session.exec(select(EvalDatasetVersion).join(EvalDataset, EvalDataset.id == EvalDatasetVersion.dataset_id).where(EvalDataset.slug == slug, EvalDatasetVersion.state == "published")
                                  .order_by(EvalDatasetVersion.published_at.desc()))).all()
        versions_by_ds[slug] = [{"version": v.version, "published_at": v.published_at, "case_count": v.case_count, "after_change": bool(changed_at and v.published_at and v.published_at > changed_at)} for v in dvs][:8]
        runs = [r for r in (await session.exec(select(EvalRun).where(EvalRun.dataset_slug == slug, EvalRun.state == "complete", EvalRun.synthetic_model == False).order_by(EvalRun.started_at.desc()))).all() if r.passed + r.failed > 0]   # noqa: E712
        cost = dict((await session.exec(select(EvalCostLine.run_id, func.coalesce(func.sum(EvalCostLine.usd), 0.0)).where(EvalCostLine.run_id.in_([r.run_id for r in runs])).group_by(EvalCostLine.run_id))).all()) if runs else {}
        rows = [{"run_id": r.run_id, "model": r.model_id, "version": r.dataset_version, "started_at": r.started_at, "pass_rate": r.pass_rate, "ran": r.passed + r.failed, "cost_usd": round(float(cost.get(r.run_id, 0.0)), 6),
                 "phase": None if not changed_at else ("after" if r.started_at and r.started_at >= changed_at else "before")} for r in runs[:12]]
        compare = []
        if changed_at:
            for model in sorted({r["model"] for r in rows if r["model"]}):
                b = next((r for r in rows if r["model"] == model and r["phase"] == "before"), None)
                a = next((r for r in rows if r["model"] == model and r["phase"] == "after"), None)
                if a and b:
                    compare.append({"model": model, "before": b, "after": a, "pass_rate_delta": (a["pass_rate"] - b["pass_rate"]) if a["pass_rate"] is not None and b["pass_rate"] is not None else None,
                                    "cost_per_execution_delta": (a["cost_usd"] / a["ran"] - b["cost_usd"] / b["ran"]) if a["ran"] and b["ran"] else None})
        regression[slug] = {"runs": rows, "compare": compare}
    return {"item": {"key": item.item_key, "title": item.title, "type": item.item_type, "source": item.source}, "changed_at": changed_at, "versions": versions, "dependents": dependents,
            "suggested_updates": suggested, "dataset_versions": versions_by_ds, "regression": regression,
            "stages": {"change": bool(changed_at), "affected_cases": len(dependents), "suggestions": len(suggested), "open_suggestions": sum(1 for s in suggested if s["state"] in ("open", "in_review")),
                       "new_versions": sum(1 for v in sum(versions_by_ds.values(), []) if v["after_change"]), "regression_pairs": sum(len(r["compare"]) for r in regression.values())},
            "principle": "Only declared dependencies and recorded runs are shown. Nothing here changes a case: accepting a suggestion produces a draft, and a person publishes a new dataset version."}


# ── executions across runs ────────────────────────────────────────────────────────────────────────────────────────────

async def results(session: AsyncSession, *, status: Optional[str] = None, model: Optional[str] = None, dataset: Optional[str] = None, case: Optional[str] = None, run_id: Optional[str] = None,
                  include_synthetic: bool = False, failed_layer: Optional[str] = None, specialist: Optional[str] = None, tool: Optional[str] = None, days: Optional[int] = None,
                  limit: int = 50, offset: int = 0) -> Dict[str, Any]:
    """Executions of every completed run, newest first, filtered; with how many there are of each status (under the other filters) and which models and datasets to filter by.
    `failed_layer` (L1 to L6) keeps the executions that failed that evaluation layer, `specialist` and `tool` those that routed to it or called it, `days` those from the last N days."""
    base = select(EvalCaseResult, EvalRun).join(EvalRun, EvalRun.id == EvalCaseResult.run_row_id).where(EvalRun.state == "complete")
    if not include_synthetic:
        base = base.where(EvalRun.synthetic_model == False)                       # noqa: E712
    if model:
        base = base.where(EvalRun.model_label == None) if model == "no model" else base.where(EvalRun.model_label == model)          # noqa: E711  ("no model": the checks that call no model)
    if dataset:
        base = base.where(EvalRun.dataset_slug == dataset)
    if case:
        base = base.where(EvalCaseResult.case_key.ilike(f"%{case}%"))
    if run_id:
        base = base.where(EvalRun.run_id == run_id)
    if failed_layer:
        base = base.where(EvalCaseResult.layer_scores[failed_layer]["status"].astext == "failed")
    if specialist:
        base = base.where(EvalCaseResult.trace_summary["specialist"].astext == specialist)
    if tool:
        base = base.where(EvalCaseResult.trace_summary["executed_tools"].contains([tool]))
    if days:
        base = base.where(EvalRun.started_at >= datetime.utcnow() - timedelta(days=days))
    facets: Dict[str, int] = {}
    sub = base.subquery()
    for st, n in (await session.exec(select(sub.c.status, func.count()).group_by(sub.c.status))).all():
        facets[st] = n
    filtered = base.where(EvalCaseResult.status == status) if status else base
    total = (await session.exec(select(func.count()).select_from(filtered.subquery()))).one()
    rows = (await session.exec(filtered.order_by(EvalRun.started_at.desc(), EvalCaseResult.case_key, EvalCaseResult.repetition).offset(offset).limit(limit))).all()
    models = sorted({m for m in (await session.exec(select(EvalRun.model_label).where(EvalRun.state == "complete", EvalRun.model_label != None).distinct())).all() if m})        # noqa: E711
    datasets = sorted({d for d in (await session.exec(select(EvalRun.dataset_slug).where(EvalRun.state == "complete", EvalRun.dataset_slug != None).distinct())).all() if d})   # noqa: E711
    return {"total": total, "by_status": facets, "models": models, "datasets": datasets,
            "results": [{"result_id": str(r.id), "run_id": run.run_id, "model": run.model_label, "synthetic": run.synthetic_model, "dataset": run.dataset_slug, "version": run.dataset_version, "case": r.case_key, "stage": r.category,
                         "repetition": r.repetition, "status": r.status, "reason": r.reason, "critical_failed": r.critical_failed, "latency_ms": r.latency_ms, "input_tokens": r.input_tokens, "output_tokens": r.output_tokens,
                         "cost_usd": r.cost_usd, "cost_known": r.cost_known, "judge_cost_usd": r.judge_cost_usd, "has_trace": bool(r.trace_key), "at": run.started_at,
                         "specialist": (r.trace_summary or {}).get("specialist"), "tools": (r.trace_summary or {}).get("executed_tools") if isinstance((r.trace_summary or {}).get("executed_tools"), list) else []} for r, run in rows]}


async def analytics(session: AsyncSession, *, dataset: Optional[str] = None, model: Optional[str] = None, days: int = 90, include_synthetic: bool = False, now: Optional[datetime] = None) -> Dict[str, Any]:
    """What the executions in a window say: outcomes and coverage, the six evaluation layers per model, routing and tool accuracy, latency (average, P50, P95), repeat reliability, and the
    new review items per week. Real-model runs only unless scripted ones are asked for; every figure comes from the stored executions and carries the count it rests on."""
    now = now or datetime.utcnow()
    stmt = select(EvalCaseResult, EvalRun).join(EvalRun, EvalRun.id == EvalCaseResult.run_row_id).where(EvalRun.state == "complete", EvalRun.started_at >= now - timedelta(days=days))
    if not include_synthetic:
        stmt = stmt.where(EvalRun.synthetic_model == False)                                          # noqa: E712
    if dataset:
        stmt = stmt.where(EvalRun.dataset_slug == dataset)
    if model:
        stmt = stmt.where(EvalRun.model_label == None) if model == "no model" else stmt.where(EvalRun.model_label == model)          # noqa: E711
    rows = []
    for r, run in (await session.exec(stmt.order_by(EvalRun.started_at.desc()).limit(20000))).all():
        ts = r.trace_summary or {}
        rows.append({"model": run.model_label, "dataset": run.dataset_slug, "case_id": r.case_key, "repetition": r.repetition, "status": r.status, "critical_failed": r.critical_failed, "latency_ms": r.latency_ms,
                     "layer_scores": r.layer_scores or {}, "specialist": ts.get("specialist"), "tools": ts.get("executed_tools") if isinstance(ts.get("executed_tools"), list) else [], "at": run.started_at})
    latest: Dict[str, int] = {}
    for slug, case_count, version in (await session.exec(select(EvalDataset.slug, EvalDatasetVersion.case_count, EvalDatasetVersion.version).join(EvalDatasetVersion, EvalDatasetVersion.dataset_id == EvalDataset.id)
                                                         .where(EvalDatasetVersion.state == "published").order_by(EvalDatasetVersion.published_at.desc()))).all():
        latest.setdefault(slug, case_count)                                                           # the newest published version of each dataset
    if dataset:
        latest = {k: v for k, v in latest.items() if k == dataset}
    drift = [{"opened_at": o, "kind": k, "state": st} for o, k, st in (await session.exec(select(EvalDriftItem.opened_at, EvalDriftItem.kind, EvalDriftItem.state).where(EvalDriftItem.opened_at >= now - timedelta(weeks=12)))).all()]
    out = an.summarise(rows, version_cases=latest, drift_items=drift, now=now)
    models = sorted({m for m in (await session.exec(select(EvalRun.model_label).where(EvalRun.state == "complete", EvalRun.model_label != None).distinct())).all() if m})        # noqa: E711
    datasets = sorted({d for d in (await session.exec(select(EvalRun.dataset_slug).where(EvalRun.state == "complete", EvalRun.dataset_slug != None).distinct())).all() if d})   # noqa: E711
    return {**out, "window_days": days, "include_synthetic": include_synthetic, "dataset": dataset, "model": model, "models": models, "datasets": datasets,
            "note": "Real-model runs only unless scripted ones are included. A layer that did not apply to an execution is not counted for it."}
