"""Integration tests of run storage (shared/evaluation/runs.py) against the isolated evaluation database and an in-memory object
store, so nothing is added to the platform's real, immutable run history. Inside eval-runner:

    python evals/environment/envctl.py test-runs         # wraps  python -m evals.tools.test_runs_integration

Real runs are produced by the real runner (function cases need no stack), sealed, and ingested. They check: rows equal the results
file, every artifact reaches the object store with its checksum, a second ingestion changes nothing, a tampered or reused run is
refused, the database itself refuses to change a finished run, and an unknown cost stays unknown through ingestion and totals.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, List

from sqlalchemy import text
from sqlmodel.ext.asyncio.session import AsyncSession
from sqlmodel import select

sys.path.insert(0, str(Path(__file__).resolve().parent))
from shared.evaluation import environment as env_lib  # noqa: E402
from shared.evaluation.canonical import sha256_hex  # noqa: E402
from shared.evaluation.config import LakeSettings  # noqa: E402
from shared.evaluation.lake import DataLake  # noqa: E402
from shared.evaluation.object_store import InMemoryObjectStore  # noqa: E402
from shared.evaluation.runs import RunFolderError, ingest_run, seal_folder  # noqa: E402
from shared.evaluation import cost_lines, cost_store, run_tools  # noqa: E402
from shared.models.evaluation import EvalAssertionResult, EvalCaseResult, EvalCostLine, EvalCostRecord, EvalPricingVersion, EvalRun  # noqa: E402

ROOT = Path("/work")
CASES = ["IND-PAY-001", "IND-PAY-002", "IND-UW-005"]


class Rig:
    def __init__(self) -> None:
        self.engine = env_lib.evaluation_engine()
        self.store = InMemoryObjectStore()
        self.lake = DataLake(self.store, LakeSettings(backend="memory"), lambda: AsyncSession(self.engine, expire_on_commit=False))

    async def clean(self) -> None:
        async with self.engine.begin() as conn:
            await env_lib.reset(conn)

    async def session(self) -> AsyncSession:
        return AsyncSession(self.engine, expire_on_commit=False)


def real_run() -> Path:
    """A sealed run folder made by the real runner."""
    out = subprocess.run([sys.executable, "-m", "evals.tools.eval_runner", "--from-source", "--case", *CASES], cwd=ROOT, capture_output=True, text=True)
    folder = next(line.split("results: ")[1].strip() for line in out.stdout.splitlines() if line.startswith("results: "))
    return Path(folder)


def copy_of(folder: Path, name: str) -> Path:
    dest = ROOT / "runs" / f"_test-{name}-{int(time.time() * 1000)}"
    shutil.copytree(folder, dest)
    return dest


async def t_a_real_run_is_stored_completely(rig: Rig, folder: Path) -> None:
    await rig.clean()
    report = await ingest_run(rig.lake, folder)
    assert report.created and report.results == len(CASES), report
    async with await rig.session() as s:
        run = (await s.exec(select(EvalRun).where(EvalRun.run_id == report.run_id))).one()
        rows = (await s.exec(select(EvalCaseResult).where(EvalCaseResult.run_row_id == run.id))).all()
        file_lines = [json.loads(x) for x in (folder / "results.jsonl").read_text().splitlines() if x.strip()]
        assert run.state == "complete" and run.executions == len(file_lines) == len(rows)
        assert sorted(r.case_key for r in rows) == sorted(x["case_id"] for x in file_lines)
        assert run.passed == sum(1 for x in file_lines if x["status"] == "passed") and run.known_cost_usd == 0.0 and run.unknown_cost_executions == 0
        n_assert = (await s.execute(text("select count(*) from eval_assertion_results"))).scalar()
        assert n_assert == sum(sum(x["assertion_counts"].values()) for x in file_lines), "every assertion of every execution is stored"
        for key in (run.summary_key, run.report_key, run.results_key):
            assert rig.store.head(key) is not None, key
        for r in rows:
            data = rig.store.get(r.artifact_key)
            assert sha256_hex(data) == r.artifact_sha256, "the stored artifact is the sealed one"


async def t_ingesting_twice_changes_nothing(rig: Rig, folder: Path) -> None:
    await rig.clean()
    first = await ingest_run(rig.lake, folder)
    async with await rig.session() as s:
        before = (await s.execute(text("select (select count(*) from eval_runs), (select count(*) from eval_case_results), (select count(*) from eval_assertion_results)"))).one()
    again = await ingest_run(rig.lake, folder)
    async with await rig.session() as s:
        after = (await s.execute(text("select (select count(*) from eval_runs), (select count(*) from eval_case_results), (select count(*) from eval_assertion_results)"))).one()
    assert first.created and not again.created and tuple(before) == tuple(after) == (1, len(CASES), tuple(before)[2])


async def t_a_tampered_or_reused_run_is_refused(rig: Rig, folder: Path) -> None:
    await rig.clean()
    await ingest_run(rig.lake, folder)
    bad = copy_of(folder, "tamper")
    (bad / "results.jsonl").write_text((bad / "results.jsonl").read_text() + "\n{}\n")
    try:
        await ingest_run(rig.lake, bad)
    except RunFolderError as exc:
        assert "does not match" in str(exc)
    else:
        raise AssertionError("a tampered folder was ingested")
    other = copy_of(folder, "reuse")
    summary = json.loads((other / "summary.json").read_text())
    summary["note"] = "same id, different content"
    (other / "summary.json").write_text(json.dumps(summary))
    (other / "manifest.json").unlink()
    seal_folder(other)
    try:
        await ingest_run(rig.lake, other)
    except RunFolderError as exc:
        assert "never reused" in str(exc)
    else:
        raise AssertionError("a different folder with an already-stored run id was ingested")
    async with await rig.session() as s:
        assert (await s.execute(text("select count(*) from eval_runs"))).scalar() == 1


async def t_the_database_refuses_to_change_a_finished_run(rig: Rig, folder: Path) -> None:
    await rig.clean()
    await ingest_run(rig.lake, folder)
    attempts = ["update eval_runs set passed = 99", "delete from eval_runs", "update eval_case_results set status = 'passed'",
                "delete from eval_case_results", "update eval_assertion_results set status = 'passed'", "delete from eval_assertion_results"]
    for sql in attempts:
        async with await rig.session() as s:
            try:
                await s.execute(text(sql))
                await s.commit()
            except Exception as exc:                                   # noqa: BLE001
                assert "immutable" in str(exc), (sql, str(exc)[:120])
            else:
                raise AssertionError(f"not refused: {sql}")


def synthetic_run(root: Path, run_id: str, usage) -> Path:
    (root / "artifacts").mkdir(parents=True)
    result = {"case_id": "IND-KYC-001", "category": "kyc-documents", "operation": "ocr.extract_customer", "verification": "code_verified", "status": "passed",
              "repetition": 1, "latency_ms": 900, "usage": usage, "assertion_counts": {"passed": 1}, "artifact": None}
    (root / "results.jsonl").write_text(json.dumps(result) + "\n")
    (root / "summary.json").write_text(json.dumps({"run_id": run_id, "suite": "technical", "repeat": 1, "selected_cases": 1, "dataset": {"dataset": None},
                                                    "by_status": {"passed": 1, "failed": 0, "blocked": 0, "skipped": 0, "infrastructure_error": 0}}))
    (root / "report.txt").write_text("r\n")
    seal_folder(root, extra={"run_id": run_id})
    return root


async def t_unknown_cost_stays_unknown_and_known_cost_follows_the_active_price(rig: Rig, folder: Path) -> None:
    await rig.clean()
    async with await rig.session() as s:
        s.add(EvalPricingVersion(label="test-rates", rates={"gpt-4o-mini": {"input": 1.0, "cached": 0.5, "output": 2.0}}, default_rate={"input": 0, "cached": 0, "output": 0},
                                 is_active=True, content_hash="0" * 64))
        await s.commit()
    tmp = ROOT / "runs"
    missing = synthetic_run(tmp / f"_test-missing-{int(time.time() * 1000)}", f"t-missing-{int(time.time() * 1000)}", {"status": "missing", "calls": None})
    await ingest_run(rig.lake, missing)
    known = synthetic_run(tmp / f"_test-known-{int(time.time() * 1000)}", f"t-known-{int(time.time() * 1000)}",
                          {"status": "attributed", "calls": 1, "input_tokens": 1_000_000, "output_tokens": 500_000, "cached_tokens": 0,
                           "by_model": {"gpt-4o-mini-2024-07-18": {"calls": 1, "input_tokens": 1_000_000, "output_tokens": 500_000}}})
    await ingest_run(rig.lake, known)
    async with await rig.session() as s:
        runs = {r.run_id.split("-")[1]: r for r in (await s.exec(select(EvalRun))).all()}
        r_missing = (await s.exec(select(EvalCaseResult).where(EvalCaseResult.run_row_id == runs["missing"].id))).one()
        r_known = (await s.exec(select(EvalCaseResult).where(EvalCaseResult.run_row_id == runs["known"].id))).one()
        assert r_missing.cost_usd is None and r_missing.cost_known is False, "a model run whose usage is missing has an UNKNOWN cost, not 0"
        assert runs["missing"].unknown_cost_executions == 1 and runs["missing"].known_cost_usd == 0.0
        assert abs(r_known.cost_usd - (1_000_000 * 1.0 + 500_000 * 2.0) / 1e6) < 1e-9 and r_known.cost_known, "priced with the ACTIVE version, not the built-in rate"
        assert runs["known"].pricing_version_id is not None and runs["known"].summary["ingest"]["pricing_label"] == "test-rates"
        records = (await s.exec(select(EvalCostRecord).where(EvalCostRecord.run_id == runs["known"].run_id))).all()
        assert len(records) == 1 and abs(records[0].total_cost_usd - 2.0) < 1e-9 and records[0].cost_basis == "calculated"
        assert not (await s.exec(select(EvalCostRecord).where(EvalCostRecord.run_id == runs["missing"].run_id))).all(), "no usage, so no cost record is invented"


def custom_run(root: Path, run_id: str, results: list, config: dict) -> Path:
    (root / "artifacts").mkdir(parents=True)
    (root / "results.jsonl").write_text("".join(json.dumps(r) + "\n" for r in results))
    (root / "summary.json").write_text(json.dumps({"run_id": run_id, "suite": "technical", "repeat": 1, "selected_cases": len(results), "dataset": {"dataset": None}, "config": config,
                                                    "by_status": {"passed": sum(r["status"] == "passed" for r in results), "failed": 0, "blocked": 0, "skipped": 0,
                                                                  "infrastructure_error": sum(r["status"] == "infrastructure_error" for r in results)}}))
    (root / "report.txt").write_text("r\n")
    seal_folder(root, extra={"run_id": run_id})
    return root


async def t_cost_lines_split_the_spending_exactly_and_never_count_anything_twice(rig: Rig, folder: Path) -> None:
    await rig.clean()
    async with await rig.session() as s:
        s.add(EvalPricingVersion(label="test-rates", rates={"gpt-4o-mini": {"input": 1.0, "cached": 0.5, "output": 2.0}}, default_rate={"input": 0, "cached": 0, "output": 0},
                                 is_active=True, content_hash="1" * 64))
        await s.commit()

    def tk(calls, i, o, c=0):
        return {"calls": calls, "input_tokens": i, "output_tokens": o, "cached_tokens": c}
    a_usage = {"status": "attributed", "calls": 3, "input_tokens": 1_500_000, "output_tokens": 250_000, "cached_tokens": 0,
               "by_model": {"gpt-4o-mini-2024-07-18": tk(3, 1_500_000, 250_000)},
               "by_service": {"Chat Agent": {"gpt-4o-mini-2024-07-18": tk(2, 1_000_000, 200_000)}, "Chat Agent \u2014 Claims Specialist": {"gpt-4o-mini-2024-07-18": tk(1, 500_000, 50_000)}},
               "foreign": {"rows": 1, "input_tokens": 100_000, "output_tokens": 10_000, "cached_tokens": 0, "by_model": {"gpt-4o-mini-2024-07-18": tk(1, 100_000, 10_000)},
                           "by_service": {"Chat Agent \u2014 Title Generator": {"gpt-4o-mini-2024-07-18": tk(1, 100_000, 10_000)}}}}
    failed_attempt = {"status": "attributed", "calls": 1, "input_tokens": 400_000, "output_tokens": 0, "cached_tokens": 0, "by_model": {"gpt-4o-mini-2024-07-18": tk(1, 400_000, 0)},
                      "by_service": {"Chat Agent": {"gpt-4o-mini-2024-07-18": tk(1, 400_000, 0)}}}
    base = {"category": "agent-routing", "verification": "code_verified", "assertion_counts": {"passed": 1}, "artifact": None, "latency_ms": 10}
    results = [
        {**base, "case_id": "IND-A", "operation": "chat", "status": "passed", "repetition": 1, "usage": a_usage, "llm_calls": 3, "retry_usage": [failed_attempt], "judge_cost_usd": 0.5,
         "metric_scores": [{"metric": "correctness", "layer": "L2", "score": 1.0, "judge_model": "openai/gpt-4o-mini", "input_tokens": 5000, "output_tokens": 500, "judge_cost_usd": 0.5}]},
        {**base, "case_id": "IND-B", "operation": "chat", "status": "passed", "repetition": 1, "usage": {"status": "missing", "calls": None, "note": "the ledger showed nothing"}, "llm_calls": None},
        {**base, "case_id": "IND-C", "operation": "rules.evaluate", "status": "passed", "repetition": 1, "usage": None}]
    rid = f"t-lines-{int(time.time() * 1000)}"
    root = custom_run(ROOT / "runs" / f"_test-lines-{int(time.time() * 1000)}", rid, results, {"kind": "benchmark_agent", "model_id": "openai/gpt-4o-mini", "mode": "agent", "provider": "openai"})
    report = await ingest_run(rig.lake, root)
    assert report.created
    async with await rig.session() as s:
        run = (await s.exec(select(EvalRun).where(EvalRun.run_id == rid))).one()
        lines = (await s.exec(select(EvalCostLine).where(EvalCostLine.run_id == rid))).all()
        by = {}
        for l in lines:
            by.setdefault(l.component, []).append(l)
        assert sorted(by) == ["agent_llm", "judge", "retry", "subagent_llm", "unattributed"], sorted(by)
        agent, sub, retry, foreign, judge = by["agent_llm"][0], by["subagent_llm"][0], by["retry"][0], by["unattributed"][0], by["judge"][0]
        assert abs(agent.usd - (1_000_000 * 1.0 + 200_000 * 2.0) / 1e6) < 1e-9 and agent.cost_kind == "estimated" and agent.case_id == "IND-A"
        assert abs(sub.usd - (500_000 * 1.0 + 50_000 * 2.0) / 1e6) < 1e-9 and abs(retry.usd - 0.4) < 1e-9 and abs(foreign.usd - (100_000 + 20_000) / 1e6) < 1e-9
        assert judge.usd == 0.5 and judge.input_units == 5000
        unknown = [l for l in lines if l.cost_kind == "unknown"]
        assert len(unknown) == 1 and unknown[0].case_id == "IND-B" and unknown[0].usd is None, "a missing ledger is an unknown line, never 0"
        assert not any(l.case_id == "IND-C" for l in lines), "an execution that used no model has no lines"
        expected = 1.4 + 0.6 + 0.4 + 0.12 + 0.5
        assert abs(run.known_cost_usd - expected) < 1e-6 and run.unknown_cost_executions == 1, (run.known_cost_usd, expected)
        assert abs(sum(l.usd for l in lines if l.usd is not None) - run.known_cost_usd) < 1e-6, "the run's total IS the sum of its lines"
        record = (await s.exec(select(EvalCostRecord).where(EvalCostRecord.run_id == rid, EvalCostRecord.case_id == "IND-A"))).one()
        assert abs(record.total_cost_usd - (expected)) < 1e-6 and abs(record.judge_cost_usd - 0.5) < 1e-9, "the per-case record agrees with the lines"
        assert not (await s.exec(select(EvalCostRecord).where(EvalCostRecord.run_id == rid, EvalCostRecord.case_id == "IND-B"))).all()
        stored_results = await cost_store.stored_results(s, run)
        assert cost_lines.check_run({"known_cost_usd": run.known_cost_usd, "unknown_cost_executions": run.unknown_cost_executions}, stored_results, await cost_store.stored_lines(s, rid)) == []
        again = await cost_store.store_lines(s, cost_lines.lines_for_result(rid, results[0], table=(await cost_store.price_table_of(s, run)), candidate="openai/gpt-4o-mini", mode="agent", synthetic=False), job_id=None, incurred_at=None)
        await s.commit()
        assert again == 0, "recording the same lines again adds nothing"
        assert len((await s.exec(select(EvalCostLine).where(EvalCostLine.run_id == rid))).all()) == len(lines)
        rebuilt = await cost_store.build_lines(s, run)
        assert {l["usage_ref"] for l in rebuilt} == {l.usage_ref for l in lines}, "rebuilding a stored run's lines gives the same lines (so backfill cannot disagree with ingestion)"
    again_report = await ingest_run(rig.lake, root)
    assert not again_report.created
    async with await rig.session() as s:
        assert len((await s.exec(select(EvalCostLine).where(EvalCostLine.run_id == rid))).all()) == len(lines), "ingesting the same folder again changes nothing"


async def t_a_stored_run_verifies_and_a_changed_or_missing_file_is_found(rig: Rig, folder: Path) -> None:
    await rig.clean()
    report = await ingest_run(rig.lake, folder)
    async with await rig.session() as s:
        ok = await run_tools.verify(s, rig.lake, report.run_id)
        assert ok["ok"] and ok["objects_checked"] >= 3 and ok["result_rows"] == ok["executions"] == len(CASES), ok
        run = (await s.exec(select(EvalRun).where(EvalRun.run_id == report.run_id))).one()
        key = run.results_key
    rig.store._objects[key] = (b"changed after the fact\n", rig.store._objects[key][1])        # the stored bytes no longer match what was recorded
    async with await rig.session() as s:
        bad = await run_tools.verify(s, rig.lake, report.run_id)
        assert not bad["ok"] and any("checksum" in p and key in p for p in bad["problems"]), bad
    del rig.store._objects[key]                                                                  # and a file that has gone missing
    async with await rig.session() as s:
        gone = await run_tools.verify(s, rig.lake, report.run_id)
        assert not gone["ok"] and any("cannot be read" in p and key in p for p in gone["problems"]), gone
        try:
            await run_tools.verify(s, rig.lake, "no-such-run")
        except run_tools.RunToolError as exc:
            assert exc.status == 404
        else:
            raise AssertionError("an unknown run was verified")


async def t_two_stored_runs_are_compared_case_by_case(rig: Rig, folder: Path) -> None:
    await rig.clean()
    base = {"category": "agent-routing", "verification": "code_verified", "assertion_counts": {"passed": 1}, "artifact": None, "latency_ms": 100, "usage": None, "operation": "rules.evaluate", "repetition": 1}
    stamp = int(time.time() * 1000)

    def run(tag: str, statuses: dict, model: str):
        rid = f"t-cmp-{tag}-{stamp}"
        rows = [{**base, "case_id": c, "status": st} for c, st in statuses.items()]
        root = custom_run(ROOT / "runs" / f"_test-cmp-{tag}-{stamp}", rid, rows, {"kind": "suite", "model_id": model, "provider": "openai", "mode": "agent"})
        return rid, root
    ra, root_a = run("a", {"C1": "passed", "C2": "passed", "C3": "failed", "C4": "passed"}, "openai/gpt-4o-mini")
    rb, root_b = run("b", {"C1": "passed", "C2": "failed", "C3": "passed", "C4": "blocked"}, "openai/gpt-4.1")
    await ingest_run(rig.lake, root_a)
    await ingest_run(rig.lake, root_b)
    async with await rig.session() as s:
        c = await run_tools.compare(s, ra, rb)
        assert [x["case"] for x in c["newly_failing"]] == ["C2"] and [x["case"] for x in c["newly_passing"]] == ["C3"], c
        assert [x["case"] for x in c["changed"]] == ["C4"] and c["unchanged"] == 1 and c["cases_compared"] == 4
        assert (c["a"]["ran"], c["a"]["passed"]) == (4, 3) and (c["b"]["ran"], c["b"]["passed"]) == (3, 2), (c["a"], c["b"])
        assert abs(c["delta"]["pass_rate"] - (2 / 3 - 3 / 4)) < 1e-9 and any("model" in n for n in c["notes"])
        assert c["a_run"]["model"] == "openai/gpt-4o-mini" and c["b_run"]["model"] == "openai/gpt-4.1"
        for args, status in (((ra, ra), 422), ((ra, "no-such-run"), 404)):
            try:
                await run_tools.compare(s, *args)
            except run_tools.RunToolError as exc:
                assert exc.status == status, (args, exc.status)
            else:
                raise AssertionError(f"{args} was compared")


TESTS: List[Callable] = [t_a_real_run_is_stored_completely, t_ingesting_twice_changes_nothing, t_a_tampered_or_reused_run_is_refused,
                         t_the_database_refuses_to_change_a_finished_run, t_unknown_cost_stays_unknown_and_known_cost_follows_the_active_price,
                         t_cost_lines_split_the_spending_exactly_and_never_count_anything_twice,
                         t_a_stored_run_verifies_and_a_changed_or_missing_file_is_found, t_two_stored_runs_are_compared_case_by_case]


async def main() -> int:
    rig = Rig()
    folder = real_run()
    failed = 0
    try:
        for test in TESTS:
            started = time.monotonic()
            try:
                await test(rig, folder)
                status, detail = "ok", ""
            except AssertionError as exc:
                status, detail, failed = "FAIL", str(exc), failed + 1
            except Exception as exc:                                  # noqa: BLE001
                status, detail, failed = "FAIL", f"{type(exc).__name__}: {exc}", failed + 1
            print(f"{status:5} {test.__name__[2:]:78} {time.monotonic() - started:5.1f}s" + (f"\n        {detail}" if detail else ""))
        await rig.clean()
    finally:
        await rig.engine.dispose()
        for p in (ROOT / "runs").glob("_test-*"):
            shutil.rmtree(p, ignore_errors=True)
    print(f"\n{len(TESTS)} run-storage integration tests: {len(TESTS) - failed} ok, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
