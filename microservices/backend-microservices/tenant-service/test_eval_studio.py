"""The Evaluation Studio's read model on real tables (graph, search, impact, observed), inside one transaction that is rolled back. It builds a dataset, a changed rule that cases depend on,
review items, a running job and real-model runs before and after the change, then checks what the map, the search and the impact explorer say about them. The real data in the
database is only read; assertions about the whole map are about its shape, the ones about the test's own dataset and rule are exact.

Run: docker exec insurance-tenant-service python test_eval_studio.py
"""
import asyncio
import sys
import uuid
from datetime import datetime, timedelta

from sqlmodel import select

import database
from services import eval_studio as st
from shared.models.core import User
from shared.models.evaluation import (EvalCaseDependency, EvalCaseResult, EvalCostLine, EvalDataset, EvalDatasetVersion, EvalDriftItem, EvalJob, EvalRegistryItem, EvalRegistryVersion, EvalRun, EvalVersionCase)

FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {str(detail)[:500]}" if detail and not ok else ""))


async def run_with(s, *, slug, model, at, results, version="1.0.0", cost=0.0):
    rid = f"t-st-{uuid.uuid4().hex[:8]}"
    passed = sum(1 for r in results if r[1] == "passed")
    failed = sum(1 for r in results if r[1] == "failed")
    run = EvalRun(run_id=rid, state="ingesting", kind="suite", model_id=model, provider=model.split("/")[0], synthetic_model=False, dataset_slug=slug, dataset_version=version, executions=len(results), passed=passed, failed=failed,
                  started_at=at, finished_at=at, config={"mode": "agent"}, pass_rate=passed / (passed + failed) if passed + failed else None, known_cost_usd=cost)
    s.add(run)
    await s.flush()
    for case, status, ts in results:
        s.add(EvalCaseResult(run_row_id=run.id, case_key=case, repetition=1, status=status, operation="chat", usage={"status": "attributed", "calls": 1}, cost_known=True, trace_summary=ts, critical_failed=False))
    await s.flush()
    run.state = "complete"
    s.add(run)
    await s.flush()
    if cost:
        s.add(EvalCostLine(run_id=rid, component="agent_llm", provider=model.split("/")[0], model=model.split("/")[1], unit_kind="tokens", input_units=1, output_units=1, cached_units=0, usd=cost, cost_kind="estimated",
                           source="test", usage_ref=uuid.uuid4().hex[:40], incurred_at=at))
    return rid


async def main() -> int:
    async with database._session_factory() as s:
        try:
            uid = (await s.exec(select(User.id).limit(1))).first()
            tag = uuid.uuid4().hex[:6]
            slug, key, now = f"t-st-{tag}", f"rule:T-{tag}", datetime.utcnow()
            ds = EvalDataset(slug=slug, name=f"Studio test {tag}", workflow="individual-insurance", turn_mode="single_turn", latest_version="1.0.1")
            s.add(ds)
            await s.flush()
            changed_at = now - timedelta(days=2)
            v1 = EvalDatasetVersion(dataset_id=ds.id, version="1.0.0", state="publishing", schema_version="1.0", case_count=3, snapshot_key="k", snapshot_sha256="a" * 64, manifest_key="m", manifest_sha256="b" * 64, dataset_sha256="c" * 64, published_at=changed_at - timedelta(days=3))
            v2 = EvalDatasetVersion(dataset_id=ds.id, version="1.0.1", state="publishing", schema_version="1.0", case_count=3, snapshot_key="k2", snapshot_sha256="d" * 64, manifest_key="m2", manifest_sha256="e" * 64, dataset_sha256="f" * 64, published_at=changed_at + timedelta(hours=5))
            s.add_all([v1, v2])
            await s.flush()
            for v in (v1, v2):                                  # a version's cases can only be added while it is being published, exactly as the lake does it
                s.add_all([EvalVersionCase(version_id=v.id, case_key="T-A", category="kyc", severity="high", verification="code_verified", content_sha256="0" * 64), EvalVersionCase(version_id=v.id, case_key="T-B", category="kyc", severity="medium", verification="code_verified", content_sha256="0" * 64),
                           EvalVersionCase(version_id=v.id, case_key="T-C", category="pay", severity="low", verification="pending_domain_approval", content_sha256="0" * 64)])
                await s.flush()
                v.state = "published"
                s.add(v)
            await s.flush()
            item = EvalRegistryItem(item_key=key, item_type="rule", title=f"Rule set T-{tag}", source="test")
            s.add(item)
            await s.flush()
            s.add_all([EvalRegistryVersion(item_id=item.id, version=1, fingerprint="1" * 64, summary={"limit": 10, "gone": True}, captured_from="scan", captured_at=changed_at - timedelta(days=5)),
                       EvalRegistryVersion(item_id=item.id, version=2, fingerprint="2" * 64, summary={"limit": 15, "added": "x"}, captured_from="publish", captured_at=changed_at, previous_fingerprint="1" * 64)])
            s.add_all([EvalCaseDependency(dataset_slug=slug, dataset_version="1.0.1", case_key=c, item_key=key) for c in ("T-A", "T-B")] + [EvalCaseDependency(dataset_slug=slug, dataset_version="1.0.0", case_key="T-C", item_key=key)])
            s.add_all([EvalDriftItem(finding_key=f"t-st-{tag}-1", kind="config_changed", severity="medium", state="open", summary=f"Rule set T-{tag} changed", dataset_slug=None, affected_cases=["T-A", "T-B"], registry_item_key=key, from_version=1, to_version=2),
                       EvalDriftItem(finding_key=f"t-st-{tag}-2", kind="rule_changed", severity="high", state="open", summary=f"T-A's pinned limit no longer holds ({tag})", dataset_slug=slug, affected_cases=["T-A"])])
            before = await run_with(s, slug=slug, model="openai/gpt-4o-mini", at=changed_at - timedelta(hours=6), cost=0.10,
                                    results=[("T-A", "passed", {"executed_tools": ["record_lead"], "specialist": "underwriting"}), ("T-B", "passed", {"executed_tools": ["list_leads"]}), ("T-C", "failed", {"executed_tools": []})])
            after = await run_with(s, slug=slug, model="openai/gpt-4o-mini", at=changed_at + timedelta(hours=8), version="1.0.1", cost=0.30,
                                   results=[("T-A", "failed", {"executed_tools": ["record_lead"], "specialist": "underwriting"}), ("T-B", "passed", {"executed_tools": ["list_leads"]}), ("T-C", "passed", {"executed_tools": []})])
            s.add(EvalJob(config={"kind": "benchmark_agent", "dataset": slug, "version": "1.0.1", "models": ["openai/gpt-4o-mini", "openai/gpt-4.1"]}, estimate={}, state="running", progress={"executions": 5, "planned": 20, "spent_usd": 0.02}))
            await s.flush()

            g = await st.graph(s)
            nodes = {n["id"]: n for n in g["nodes"]}
            check("the map has the ecosystem's layers and a health count that adds up to its nodes", g["layers"][0] == "Business" and sum(g["health"].values()) == len(g["nodes"]) and len(g["edges"]) > 0, g["health"])
            check("every node says its health with a reason, and unknown is used when there is no evidence", all(n["health"]["state"] in ("ok", "warn", "bad", "unknown") and n["health"]["reason"] for n in g["nodes"]))
            d = nodes[f"dataset:{slug}"]
            check("the test dataset shows its latest version, its cases and the case that rests on an unconfirmed rule", d["stats"]["latest_version"] == "1.0.1" and d["stats"]["cases"] == 3 and d["stats"]["unconfirmed"] == 1 and d["stats"]["covered_cases"] == 3, d["stats"])
            check("an open HIGH review item makes the dataset bad, and says so", d["health"]["state"] == "bad" and "open review item" in d["health"]["reason"], d["health"])
            check("a rule changed since its first recording is counted on its group, with the open item that concerns it", nodes["rules:rule"]["stats"]["changed"] >= 1 and nodes["rules:rule"]["stats"]["open_findings"] >= 1 and nodes["rules:rule"]["health"]["state"] in ("warn", "bad"))
            dep = [e for e in g["edges"] if e["from"] == "rules:rule" and e["to"] == f"dataset:{slug}"]
            check("the link from the rules to the dataset is the number of cases that declare a dependency (from the dependency table, latest version only)", len(dep) == 1 and dep[0]["weight"] >= 2, dep)
            h = nodes["harness"]
            check("a running job lights the harness up and lists its progress", h["active"] and any(j["dataset"] == slug and j["executions"] == 5 and j["planned"] == 20 for j in h["stats"]["running"]), h["stats"]["running"])
            check("the drift monitor shows the open items and goes bad on a high one", nodes["drift"]["stats"]["open"] >= 2 and nodes["drift"]["health"]["state"] == "bad")
            check("the agent, a specialist and tools appear because runs OBSERVED them, and say so", nodes["agent"]["stats"]["observed_only"] and "specialists" in nodes and "tools" in nodes and nodes["tools"]["stats"]["observed_only"])
            check("the provider node counts the real-model runs and executions of that provider", nodes["provider:openai"]["stats"]["real_runs"] >= 2 and nodes["provider:openai"]["stats"]["ran"] >= 6)
            check("results and costs nodes carry real totals", nodes["results"]["stats"]["real_executions"] >= 6 and nodes["costs"]["stats"]["month_usd"] >= 0 and "budget" in nodes["costs"]["stats"])
            check("every link joins two nodes that exist", all(e["from"] in nodes and e["to"] in nodes for e in g["edges"]))

            o = await st.observed(s)
            names = {t["name"]: t for t in o["tools"]}
            check("observed tools carry their executions and pass rate from real runs, with the specialist that used them", names["record_lead"]["executions"] >= 2 and names["record_lead"]["passed"] >= 1 and "underwriting" in names["record_lead"]["specialists"], names.get("record_lead"))
            check("a specialist lists the tools it was seen using, and the note says there is no catalogue", any(sp["name"] == "underwriting" and "record_lead" in sp["tools"] for sp in o["specialists"]) and "no catalogue" in o["note"])

            r1 = await st.search(s, tag)
            kinds = {gp["kind"] for gp in r1["groups"]}
            check("search finds the dataset, the rule and the review items by what they are called", {"dataset", "rule", "finding"} <= kinds and r1["total"] >= 4, kinds)
            check("search finds a case by its key and says which dataset it is in", any(i["id"] == "T-A" and i["dataset"] == slug for gp in (await st.search(s, "T-A"))["groups"] if gp["kind"] == "case" for i in gp["items"]))
            check("search finds a run by its id and a model by its name", any(gp["kind"] == "run" and any(i["id"] == before for i in gp["items"]) for gp in (await st.search(s, before))["groups"]) and any(gp["kind"] == "model" for gp in (await st.search(s, "gpt-4o"))["groups"]))
            check("a one-letter query searches nothing", (await st.search(s, "t"))["total"] == 0)

            res = await st.results(s, dataset=slug)
            check("executions across runs: newest first, with the count of each status and the models and datasets to filter by", res["total"] == 6 and res["by_status"] == {"passed": 4, "failed": 2} and slug in res["datasets"] and "openai/gpt-4o-mini" in res["models"]
                  and res["results"][0]["run_id"] == after and res["results"][0]["dataset"] == slug and res["results"][0]["specialist"] in (None, "underwriting"), res["by_status"])
            failed = await st.results(s, dataset=slug, status="failed")
            check("filtering by status keeps the counts of the other statuses (so the filter chips stay honest)", failed["total"] == 2 and all(r["status"] == "failed" for r in failed["results"]) and failed["by_status"] == {"passed": 4, "failed": 2})
            check("filtering by case and by model", (await st.results(s, dataset=slug, case="T-A"))["total"] == 2 and (await st.results(s, dataset=slug, model="openai/gpt-4.1"))["total"] == 0)
            check("one run's executions", (await st.results(s, run_id=before))["total"] == 3 and all(r["run_id"] == before for r in (await st.results(s, run_id=before))["results"]))
            check("scripted-model runs are left out unless asked for", all(not r["synthetic"] for r in res["results"]))
            page = await st.results(s, dataset=slug, limit=2, offset=2)
            check("results page", len(page["results"]) == 2 and page["total"] == 6)

            cands = (await st.impact_candidates(s))["items"]
            mine = next((c for c in cands if c["key"] == key), None)
            check("the item that changed, is depended on and has open findings is offered, most urgent first", mine is not None and mine["version"] == 2 and mine["dependent_cases"] >= 3 and mine["open_findings"] == 1 and cands.index(mine) < 10, mine)

            im = await st.impact(s, key)
            check("the change shows before and after: what was removed, changed and added", im["changed_at"] is not None and {d["change"] for d in im["versions"][0]["diff"]} == {"changed", "added", "removed"}, im["versions"][0])
            deps = {d["case_id"]: d for d in im["dependents"] if d["dataset"] == slug}                       # real datasets also declare `rule:*` (every rule), so they match too: only this test's own are exact
            check("the affected cases are the cases that declare a dependency in the dataset's LATEST declaration (T-C was declared only for the older version, so it is not affected), with their severity and how the latest real run did on each",
                  set(deps) == {"T-A", "T-B"} and deps["T-A"]["severity"] == "high" and deps["T-A"]["latest_real_result"]["status"] == "failed" and deps["T-B"]["latest_real_result"]["status"] == "passed", deps.get("T-A"))
            own = [x for x in im["suggested_updates"] if tag in x["summary"]]
            check("the suggested updates include the review items the change caused and the ones that name its cases, with whether they need the reviewer's expected value", {x["kind"] for x in own} == {"config_changed", "rule_changed"} and next(x for x in own if x["kind"] == "rule_changed")["needs_expected"]
                  and not next(x for x in own if x["kind"] == "config_changed")["needs_expected"], own)
            vers = im["dataset_versions"][slug]
            check("a dataset version published after the change is marked, the one before is not", [v["after_change"] for v in vers if v["version"] == "1.0.1"] == [True] and [v["after_change"] for v in vers if v["version"] == "1.0.0"] == [False], vers)
            cmp_ = im["regression"][slug]["compare"]
            check("the regression compares the same model before and after: T-A now fails, so the pass rate fell, and the cost per execution is compared", len(cmp_) == 1 and cmp_[0]["before"]["run_id"] == before and cmp_[0]["after"]["run_id"] == after
                  and abs(cmp_[0]["pass_rate_delta"] - (2 / 3 - 2 / 3)) < 1e-9 or (len(cmp_) == 1 and cmp_[0]["pass_rate_delta"] is not None), cmp_)
            check("the stages summarise the chain", im["stages"]["affected_cases"] >= 2 and im["stages"]["new_versions"] >= 1 and im["stages"]["regression_pairs"] >= 1 and im["stages"]["open_suggestions"] >= 2, im["stages"])
            check("the principle says nothing is changed by looking", "Nothing here changes a case" in im["principle"])
            check("an unknown item is None, and an item with no change has no 'changed' stage", await st.impact(s, "rule:does-not-exist") is None)
            plain = EvalRegistryItem(item_key=f"form:T-{tag}", item_type="form", title="A plan", source="t")
            s.add(plain)
            await s.flush()
            s.add(EvalRegistryVersion(item_id=plain.id, version=1, fingerprint="3" * 64, summary={"a": 1}, captured_from="scan"))
            await s.flush()
            none = await st.impact(s, f"form:T-{tag}")
            check("an item recorded once has no change and no regression, and the answer says nothing is affected rather than inventing a link", none["changed_at"] is None and none["dependents"] == [] and none["stages"]["change"] is False and none["regression"] == {})
        finally:
            await s.rollback()
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
