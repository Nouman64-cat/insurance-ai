"""Evaluation run folders: sealing them in the isolated worker and ingesting them on the platform side.

The isolated evaluation stack never reaches the platform database or MinIO. A run leaves it as a folder:

    results.jsonl     one line per execution (shared/evaluation/run_report.CaseResult)
    summary.json      totals, configuration, dataset identity
    report.txt        the console report
    artifacts/        what each execution observed, every assertion result, chat traces
    manifest.json     the SHA-256 of every file above, written last (`seal_folder`)

`verify_folder` re-checks the manifest, so a folder that was changed after it was sealed, or that has a file nobody listed, is refused.
`ingest_run` (platform side) uploads the files to MinIO under artifacts/<run>/, writes the rows to PostgreSQL, prices the run with the
active versioned rates, and flips the run to 'complete', after which the database refuses any change to it. Ingesting the same sealed
folder again changes nothing; a different folder claiming the same run id is refused.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from shared.evaluation import cost_lines, cost_store
from shared.evaluation.canonical import sha256_hex
from shared.evaluation.pricing import PriceTable, cost_of

MANIFEST = "manifest.json"
MAIN_FILES = ("results.jsonl", "summary.json", "report.txt")
RUN_NAMESPACE = uuid.UUID("0b3f5c1e-6d2a-4f7b-9c18-2a5e8d41f3a7")
COST_BASIS_CALCULATED = "calculated"      # providers report tokens, not dollars: a cost is always tokens x a versioned rate. (The column is VARCHAR(12): keep these short.)
COST_BASIS_NONE = "none"                  # no model was used
COST_BASIS_UNKNOWN = "unknown"


class RunFolderError(Exception):
    """The folder is not a complete, unaltered run."""


def row_id_for(run_id: str) -> uuid.UUID:
    """The database id of a run: derived from the worker's run id, so ingesting twice cannot create two rows."""
    return uuid.uuid5(RUN_NAMESPACE, run_id)


def _files(folder: Path) -> List[Path]:
    return sorted(p for p in folder.rglob("*") if p.is_file() and p.name != MANIFEST)


def seal_folder(folder: Path, *, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Write manifest.json: the checksum of every file. Call once, after the last file is written."""
    folder = Path(folder)
    entries = [{"name": str(p.relative_to(folder)), "sha256": sha256_hex(p.read_bytes()), "size": p.stat().st_size} for p in _files(folder)]
    manifest = {"manifest_version": "1.0", "sealed_at": datetime.utcnow().isoformat() + "Z", "files": entries, **(extra or {})}
    (folder / MANIFEST).write_text(json.dumps(manifest, indent=1, sort_keys=True), encoding="utf-8")
    return manifest


def verify_folder(folder: Path) -> Dict[str, Any]:
    """The manifest of a sealed folder, after re-hashing every file. Raises RunFolderError on any difference."""
    folder = Path(folder)
    try:
        manifest = json.loads((folder / MANIFEST).read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RunFolderError("the run folder is not sealed: manifest.json is missing") from exc
    except json.JSONDecodeError as exc:
        raise RunFolderError(f"manifest.json is not valid JSON: {exc}") from exc
    listed = {f["name"]: f for f in manifest.get("files", [])}
    for name in MAIN_FILES:
        if name not in listed:
            raise RunFolderError(f"the manifest does not list {name}")
    for name, entry in listed.items():
        path = folder / name
        if not path.is_file():
            raise RunFolderError(f"{name} is listed in the manifest but missing from the folder")
        if sha256_hex(path.read_bytes()) != entry["sha256"]:
            raise RunFolderError(f"{name} does not match the checksum in the manifest")
    unlisted = sorted(str(p.relative_to(folder)) for p in _files(folder) if str(p.relative_to(folder)) not in listed)
    if unlisted:
        raise RunFolderError("files that the manifest does not list: " + ", ".join(unlisted[:5]))
    return manifest


def read_results(folder: Path) -> List[Dict[str, Any]]:
    return [json.loads(line) for line in (Path(folder) / "results.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]


def _content_type(name: str) -> str:
    return {"jsonl": "application/x-ndjson", "json": "application/json", "txt": "text/plain"}.get(name.rsplit(".", 1)[-1], "application/octet-stream")


def reprice(usage: Optional[Dict[str, Any]], table: PriceTable) -> tuple[Optional[float], str]:
    """(dollars, basis) for one execution's usage under `table`. No usage means no model was used: 0, and that is known. A model with
    no rate, a ledger that was missing or unreadable, make the cost UNKNOWN (None); never zero."""
    if usage is None:
        return 0.0, COST_BASIS_NONE
    if usage.get("status") != "attributed":
        return None, COST_BASIS_UNKNOWN
    by_model = usage.get("by_model") or {}
    if not by_model:
        return 0.0, COST_BASIS_NONE
    total = 0.0
    for model, v in by_model.items():
        c = table.cost_of({"model_name": model, "input_tokens": v.get("input_tokens"), "output_tokens": v.get("output_tokens"),
                           "cached_tokens": v.get("cached_tokens", 0)})
        if c is None:
            return None, COST_BASIS_UNKNOWN
        total += c
    return total, COST_BASIS_CALCULATED


@dataclass
class IngestReport:
    run_id: str
    row_id: uuid.UUID
    created: bool                       # False: this exact run was already there, nothing changed
    results: int = 0
    assertions: int = 0
    metrics: int = 0
    objects: int = 0
    problems: List[str] = field(default_factory=list)


async def active_price_table(session) -> tuple[Optional[uuid.UUID], PriceTable]:
    """The active versioned rates of the Evaluation Costs module, over the built-in table for any model it does not list."""
    from sqlmodel import select
    from shared.models.evaluation import EvalPricingVersion
    row = (await session.exec(select(EvalPricingVersion).where(EvalPricingVersion.is_active == True).order_by(EvalPricingVersion.created_at.desc()))).first()  # noqa: E712
    if row is None:
        return None, PriceTable.builtin()
    return row.id, PriceTable.from_rates(row.label, row.rates, fallback=PriceTable.builtin())


async def _compute_rates(session) -> List[Dict[str, Any]]:
    """The recorded hourly machine rates (for a run of a self-hosted model); none when none is recorded, in which case machine time is unknown, never free."""
    from sqlmodel import select
    from shared.models.evaluation import EvalComputeRate
    return [{"name": r.name, "resource": r.resource, "usd_per_hour": r.usd_per_hour, "effective_from": r.effective_from, "source": r.source, "created_at": r.created_at}
            for r in (await session.exec(select(EvalComputeRate))).all()]


async def ingest_run(lake, folder: Path, *, ingested_by: Optional[uuid.UUID] = None) -> IngestReport:
    """Verify a sealed run folder and write it to MinIO and PostgreSQL. Idempotent; see the module docstring."""
    from sqlalchemy import delete
    from sqlmodel import select

    from shared.models.evaluation import (EvalAssertionResult, EvalCaseResult, EvalCostRecord, EvalDataset, EvalDatasetVersion, EvalMetricScore,
                                          EvalPricingVersion, EvalRun, EvalStorageObject)

    folder = Path(folder)
    manifest = verify_folder(folder)
    manifest_sha = sha256_hex((folder / MANIFEST).read_bytes())
    summary = json.loads((folder / "summary.json").read_text(encoding="utf-8"))
    results = read_results(folder)
    run_id = summary.get("run_id")
    if not run_id:
        raise RunFolderError("summary.json has no run_id")
    row_id = row_id_for(run_id)
    problems: List[str] = []

    async with lake.session_factory() as session:
        existing = (await session.exec(select(EvalRun).where(EvalRun.run_id == run_id))).first()
        if existing is not None and existing.state == "complete":
            if (existing.summary or {}).get("ingest", {}).get("manifest_sha256") != manifest_sha:
                raise RunFolderError(f"run {run_id} is already stored from a different folder; a run id is never reused")
            return IngestReport(run_id, existing.id, created=False, results=existing.executions)
        if existing is not None:                                   # a crashed earlier ingestion: its rows are removed and written again
            old = [r.id for r in (await session.exec(select(EvalCaseResult).where(EvalCaseResult.run_row_id == existing.id))).all()]
            if old:
                await session.execute(delete(EvalMetricScore).where(EvalMetricScore.result_id.in_(old)))
                await session.execute(delete(EvalAssertionResult).where(EvalAssertionResult.result_id.in_(old)))
                await session.execute(delete(EvalCaseResult).where(EvalCaseResult.id.in_(old)))
            await session.delete(existing)
            await session.flush()
        ledger_version, table = await active_price_table(session)
        if ledger_version is None:                                  # a fresh database: record the built-in rates as the first version
            builtin = PriceTable.builtin()
            rates = {m: {"input": p[0], "cached": p[1], "output": p[2]} for m, p in builtin.prices.items()}
            version = EvalPricingVersion(label=builtin.label, rates=rates, default_rate={"input": 0.0, "cached": 0.0, "output": 0.0},
                                         source_notes="built-in table of shared/evaluation/pricing.py", is_active=True,
                                         content_hash=sha256_hex(json.dumps(rates, sort_keys=True).encode()))
            session.add(version)
            await session.flush()
            ledger_version, table = version.id, builtin

        # MinIO first (a stored object is the same bytes or an error), then the rows.
        stored = 0
        keys: Dict[str, str] = {}
        for entry in manifest["files"]:
            data = (folder / entry["name"]).read_bytes()
            key = f"artifacts/{row_id}/{entry['name']}"
            await lake._store(session, key=key, data=data, content_type=_content_type(entry["name"]), layer="artifacts", kind="artifact")
            keys[entry["name"]] = key
            stored += 1

        dataset_slug = (summary.get("dataset") or {}).get("dataset")
        dataset_version = (summary.get("dataset") or {}).get("version")
        dataset = (await session.exec(select(EvalDataset).where(EvalDataset.slug == dataset_slug))).first() if dataset_slug else None
        version_row = None
        if dataset is not None and dataset_version:
            version_row = (await session.exec(select(EvalDatasetVersion).where(
                EvalDatasetVersion.dataset_id == dataset.id, EvalDatasetVersion.version == dataset_version, EvalDatasetVersion.state == "published"))).first()
        cfg = summary.get("config") or {}
        run = EvalRun(
            id=row_id, run_id=run_id, dataset_id=dataset.id if dataset else None, version_id=version_row.id if version_row else None,
            dataset_slug=dataset_slug, dataset_version=dataset_version, snapshot_sha256=(summary.get("dataset") or {}).get("snapshot_sha256"),
            dataset_sha256=(summary.get("dataset") or {}).get("dataset_sha256"), data_verified=bool((summary.get("dataset") or {}).get("verified")),
            suite=summary.get("suite", "technical"), repetitions=int(summary.get("repeat", 1)), state="ingesting", cancelled=bool(summary.get("cancelled")),
            started_at=_dt(summary.get("started_at")), finished_at=_dt(summary.get("finished_at")), selected_cases=int(summary.get("selected_cases", 0)),
            budget_usd=summary.get("budget_usd"), summary=summary, kind=cfg.get("kind", "suite"), group_id=cfg.get("group_id"), config=cfg,
            provider=cfg.get("provider"), model_id=cfg.get("model_id"), skills_enabled=cfg.get("skills_enabled"), prompt_version=cfg.get("prompt_version"),
            judge_model=cfg.get("judge_model"), pricing_version_id=ledger_version, estimated_usd=(summary.get("estimate") or {}).get("total_usd"),
            job_id=_uuid(cfg.get("job_id")), model_label=cfg.get("model_id"), synthetic_model=bool(cfg.get("synthetic_model")),
            summary_key=keys.get("summary.json"), report_key=keys.get("report.txt"), results_key=keys.get("results.jsonl"),
            ingested_by=ingested_by, ingested_at=datetime.utcnow())
        session.add(run)
        await session.flush()

        compute_rates = await _compute_rates(session)
        n_assert = n_metric = 0
        case_costs: Dict[str, Dict[str, Any]] = {}
        all_lines: List[Dict[str, Any]] = []
        mode = cfg.get("mode") or ("direct" if cfg.get("kind") == "benchmark_direct" else "agent")
        counts = {s: 0 for s in ("passed", "failed", "blocked", "skipped", "infrastructure_error")}
        for r in results:
            counts[r["status"]] = counts.get(r["status"], 0) + 1
            usage = r.get("usage")
            cost, basis = reprice(usage, table)
            if r["status"] in ("skipped", "blocked") and usage is None:
                cost, basis = 0.0, COST_BASIS_NONE
            mine = cost_lines.lines_for_result(run_id, r, table=table, candidate=cfg.get("model_id"), mode=mode, synthetic=bool(cfg.get("synthetic_model")), pricing_version_id=ledger_version,
                                               compute_rates=compute_rates, at=run.started_at)
            all_lines += mine
            artifact = r.get("artifact")
            row = EvalCaseResult(
                id=uuid.uuid4(), run_row_id=row_id, case_key=r["case_id"], category=r.get("category"), operation=r.get("operation"),
                verification=r.get("verification"), repetition=int(r.get("repetition", 1)), status=r["status"], reason=r.get("reason"),
                latency_ms=r.get("latency_ms"), score=r.get("score"), cost_usd=cost, cost_known=cost is not None, usage=usage,
                assertion_counts=r.get("assertion_counts") or {}, error=r.get("error"),
                artifact_key=keys.get(artifact) if artifact else None, artifact_sha256=_sha(manifest, artifact),
                model_id=r.get("model_id"), input_tokens=r.get("input_tokens"), output_tokens=r.get("output_tokens"), cached_tokens=r.get("cached_tokens"),
                llm_calls=r.get("llm_calls"), judge_cost_usd=r.get("judge_cost_usd"), retry_usage=r.get("retry_usage") or None, ttft_ms=r.get("ttft_ms"), turns=r.get("turns"),
                critical_failed=bool(r.get("critical_failed")), layer_scores=r.get("layer_scores") or {}, verdict=r.get("verdict") or {},
                trace_summary=r.get("trace_summary") or {}, trace_key=keys.get(r.get("trace_artifact")) if r.get("trace_artifact") else None,
                trace_sha256=_sha(manifest, r.get("trace_artifact")))
            if usage and usage.get("by_model") and row.model_id is None and len(usage["by_model"]) == 1:
                row.model_id = next(iter(usage["by_model"]))
            if usage and usage.get("status") == "attributed":
                row.llm_calls = row.llm_calls if row.llm_calls is not None else usage.get("calls")
                for field_name in ("input_tokens", "output_tokens", "cached_tokens"):
                    if getattr(row, field_name) is None:
                        setattr(row, field_name, usage.get(field_name))
            session.add(row)
            await session.flush()
            assertions = []
            if artifact and (folder / artifact).is_file():
                assertions = ((json.loads((folder / artifact).read_text(encoding="utf-8")).get("assertions") or {}).get("results")) or []
            for a in assertions:
                session.add(EvalAssertionResult(result_id=row.id, assertion_id=str(a.get("id")), kind=a.get("type") or "", target=a.get("target"),
                                                severity=a.get("severity") or "major", status=a.get("status") or "error", method=a.get("method") or "exact",
                                                message=a.get("message"), expected={"value": a.get("expected")}, actual={"value": a.get("actual")}))
                n_assert += 1
            for m in r.get("metric_scores") or []:
                session.add(EvalMetricScore(result_id=row.id, metric=m["metric"], layer=m.get("layer"), criterion_id=m.get("criterion_id"), score=m.get("score"),
                                            threshold=m.get("threshold"), passed=m.get("passed"), status=m.get("status", "scored"), reason=m.get("reason"),
                                            judge_model=m.get("judge_model"), judge_cost_usd=m.get("judge_cost_usd"),
                                            input_tokens=m.get("input_tokens"), output_tokens=m.get("output_tokens")))
                n_metric += 1
            if mine and ((usage and usage.get("calls")) or r.get("judge_cost_usd") or r.get("retry_usage")):      # no usage, no cost record is invented (the cost lines carry the unknown)
                # One cost record per case and pricing version (the table's rule), so a case run several times is summed. Its figures are the sums of the
                # execution's cost lines, so the record, the lines and the run's total can never disagree.
                c = case_costs.setdefault(r["case_id"], {"models": set(), "input": 0, "output": 0, "cached": 0, "calls": 0, "llm": 0.0, "judge": 0.0,
                                                         "judge_in": 0, "judge_out": 0, "repetitions": 0, "basis": set()})
                own = [l for l in mine if l["component"] != "judge"]
                judge = [l for l in mine if l["component"] == "judge"]
                c["models"].update(l["model"] for l in own if l["model"])
                c["input"] += sum(l["input_units"] for l in own)
                c["output"] += sum(l["output_units"] for l in own)
                c["cached"] += sum(l["cached_units"] for l in own)
                c["calls"] += int((usage or {}).get("calls") or 0) + sum(int(u.get("calls") or 0) for u in r.get("retry_usage") or [])
                c["llm"] += cost_lines.known_total(own)
                c["judge"] += cost_lines.known_total(judge)
                c["judge_in"] += sum(l["input_units"] for l in judge)
                c["judge_out"] += sum(l["output_units"] for l in judge)
                c["repetitions"] += 1
                c["basis"].add(COST_BASIS_UNKNOWN if any(l["cost_kind"] == "unknown" for l in own) else COST_BASIS_CALCULATED if own else COST_BASIS_NONE)
        for case_id, c in case_costs.items():
            basis = COST_BASIS_UNKNOWN if COST_BASIS_UNKNOWN in c["basis"] else COST_BASIS_CALCULATED if COST_BASIS_CALCULATED in c["basis"] else COST_BASIS_NONE
            session.add(EvalCostRecord(
                run_id=run_id, case_id=case_id, models=sorted(c["models"]), pricing_version_id=ledger_version, calls=c["calls"],
                tokens={"input": c["input"], "output": c["output"], "cached": c["cached"], "repetitions": c["repetitions"]},
                judge_tokens={"input": c["judge_in"], "output": c["judge_out"]}, llm_cost_usd=c["llm"], judge_cost_usd=c["judge"],
                total_cost_usd=c["llm"] + c["judge"], cost_basis=basis, created_by=ingested_by))
        ran = counts["passed"] + counts["failed"]
        run.executions, run.passed, run.failed, run.blocked, run.skipped = len(results), counts["passed"], counts["failed"], counts["blocked"], counts["skipped"]
        run.infrastructure_errors = counts["infrastructure_error"]
        run.pass_rate = (counts["passed"] / ran) if ran else None
        run.known_cost_usd, run.unknown_cost_executions = round(cost_lines.known_total(all_lines), 6), cost_lines.unknown_executions(all_lines)
        await cost_store.store_lines(session, all_lines, job_id=run.job_id, incurred_at=run.started_at)       # idempotent: a line is recorded once, so a crashed run ingested again adds nothing twice
        if summary.get("by_status") and {k: summary["by_status"].get(k, 0) for k in counts} != counts:
            problems.append("the totals in summary.json differ from the rows of results.jsonl; the rows were used")
        run.summary = {**summary, "ingest": {"manifest_sha256": manifest_sha, "pricing_label": table.label, "ingested_at": datetime.utcnow().isoformat() + "Z",
                                             "problems": problems, "files": len(manifest["files"])}}
        run.state = "complete"
        session.add(run)
        await session.commit()
    return IngestReport(run_id, row_id, created=True, results=len(results), assertions=n_assert, metrics=n_metric, objects=stored, problems=problems)


def _sha(manifest: Dict[str, Any], name: Optional[str]) -> Optional[str]:
    return next((f["sha256"] for f in manifest["files"] if f["name"] == name), None) if name else None


def _dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", ""))
    except ValueError:
        return None


def _uuid(value: Any) -> Optional[uuid.UUID]:
    try:
        return uuid.UUID(str(value)) if value else None
    except ValueError:
        return None
