"""A small, self-consistent world for testing the Evaluation Studio against the ISOLATED evaluation stack (everything written here is permanent there): a dataset with two published versions,
a rule set that changed and that cases depend on, review items about it, a running job, and real-model runs on both sides of the change. Used by test_eval_studio_api.py and by
evals/frontend/run_studio_integration.py. Never run it against the working database."""
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict

from sqlmodel import select

from shared.models.evaluation import (EvalCaseDependency, EvalCaseResult, EvalCostLine, EvalDataset, EvalDatasetVersion, EvalDriftItem, EvalJob, EvalRegistryItem, EvalRegistryVersion, EvalRun, EvalVersionCase)


async def _run(s, *, slug, model, at, results, version="1.0.0", cost=0.0) -> str:
    rid = f"t-sw-{uuid.uuid4().hex[:8]}"
    passed, failed = sum(r[1] == "passed" for r in results), sum(r[1] == "failed" for r in results)
    run = EvalRun(run_id=rid, state="ingesting", kind="suite", model_id=model, model_label=model, provider=model.split("/")[0], synthetic_model=False, dataset_slug=slug, dataset_version=version, executions=len(results), passed=passed,
                  failed=failed, started_at=at, finished_at=at, config={"mode": "agent"}, pass_rate=passed / (passed + failed) if passed + failed else None, known_cost_usd=cost)
    s.add(run)
    await s.flush()
    for case, status, ts in results:
        s.add(EvalCaseResult(run_row_id=run.id, case_key=case, category="kyc", repetition=1, status=status, operation="chat", usage={"status": "attributed", "calls": 1}, cost_known=True, latency_ms=1500, trace_summary=ts, critical_failed=False))
    await s.flush()
    run.state = "complete"
    s.add(run)
    await s.flush()
    if cost:
        s.add(EvalCostLine(run_id=rid, component="agent_llm", provider=model.split("/")[0], model=model.split("/")[1], unit_kind="tokens", input_units=1, output_units=1, cached_units=0, usd=cost, cost_kind="estimated",
                           source="studio seed", usage_ref=uuid.uuid4().hex[:40], incurred_at=at))
    return rid


async def seed(s, tag: str = "") -> Dict[str, Any]:
    tag = tag or uuid.uuid4().hex[:6]
    slug, key, now = f"t-sw-{tag}", f"rule:SW-{tag}", datetime.utcnow()
    changed_at = now - timedelta(days=2)
    ds = EvalDataset(slug=slug, name=f"Studio world {tag}", workflow="individual-insurance", turn_mode="single_turn", latest_version="1.0.1")
    s.add(ds)
    await s.flush()
    versions = []
    for ver, when in (("1.0.0", changed_at - timedelta(days=3)), ("1.0.1", changed_at + timedelta(hours=5))):
        v = EvalDatasetVersion(dataset_id=ds.id, version=ver, state="publishing", schema_version="1.0", case_count=3, snapshot_key=f"k{ver}", snapshot_sha256="a" * 64, manifest_key=f"m{ver}", manifest_sha256="b" * 64, dataset_sha256="c" * 64, published_at=when)
        s.add(v)
        await s.flush()
        s.add_all([EvalVersionCase(version_id=v.id, case_key="SW-A", category="kyc", severity="high", verification="code_verified", content_sha256="0" * 64),
                   EvalVersionCase(version_id=v.id, case_key="SW-B", category="kyc", severity="medium", verification="code_verified", content_sha256="0" * 64),
                   EvalVersionCase(version_id=v.id, case_key="SW-C", category="pay", severity="low", verification="pending_domain_approval", content_sha256="0" * 64)])
        await s.flush()
        v.state = "published"
        s.add(v)
        versions.append(v)
    item = EvalRegistryItem(item_key=key, item_type="rule", title=f"Rule set SW-{tag}", source="studio seed")
    s.add(item)
    await s.flush()
    s.add_all([EvalRegistryVersion(item_id=item.id, version=1, fingerprint="1" * 64, summary={"limit": 10, "gone": True}, captured_from="scan", captured_at=changed_at - timedelta(days=5)),
               EvalRegistryVersion(item_id=item.id, version=2, fingerprint="2" * 64, summary={"limit": 15, "added": "x"}, captured_from="publish", captured_at=changed_at, previous_fingerprint="1" * 64)])
    s.add_all([EvalCaseDependency(dataset_slug=slug, dataset_version="1.0.1", case_key=c, item_key=key) for c in ("SW-A", "SW-B")])
    drift = [EvalDriftItem(finding_key=f"t-sw-{tag}-1", kind="config_changed", severity="medium", state="open", summary=f"Rule set SW-{tag} changed", affected_cases=["SW-A", "SW-B"], registry_item_key=key, from_version=1, to_version=2),
             EvalDriftItem(finding_key=f"t-sw-{tag}-2", kind="rule_changed", severity="high", state="open", summary=f"SW-A's pinned limit no longer holds ({tag})", dataset_slug=slug, affected_cases=["SW-A"])]
    s.add_all(drift)
    before = await _run(s, slug=slug, model="openai/gpt-4o-mini", at=changed_at - timedelta(hours=6), cost=0.10,
                        results=[("SW-A", "passed", {"executed_tools": ["record_lead"], "specialist": "underwriting"}), ("SW-B", "passed", {"executed_tools": ["list_leads"]}), ("SW-C", "failed", {"executed_tools": []})])
    after = await _run(s, slug=slug, model="openai/gpt-4o-mini", at=changed_at + timedelta(hours=8), version="1.0.1", cost=0.30,
                       results=[("SW-A", "failed", {"executed_tools": ["record_lead"], "specialist": "underwriting"}), ("SW-B", "passed", {"executed_tools": ["list_leads"]}), ("SW-C", "passed", {"executed_tools": []})])
    s.add(EvalJob(config={"kind": "benchmark_agent", "dataset": slug, "version": "1.0.1", "models": ["openai/gpt-4o-mini", "openai/gpt-4.1"]}, estimate={}, state="running", progress={"executions": 5, "planned": 20, "spent_usd": 0.02}))
    await s.flush()
    return {"tag": tag, "slug": slug, "key": key, "before": before, "after": after, "drift_ids": [str(d.id) for d in drift], "changed_at": changed_at.isoformat()}
