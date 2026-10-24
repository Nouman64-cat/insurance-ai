"""Command line for the evaluation data lake (shared/evaluation). Run it inside the tenant-service container:

    docker compose exec tenant-service python eval_lake_cli.py init            # reach MinIO, create/check the bucket
    docker compose exec tenant-service python eval_lake_cli.py smoke           # write, read, lock and delete a test object
    docker compose exec tenant-service python eval_lake_cli.py schema          # print the Golden case JSON Schema
    docker compose exec tenant-service python eval_lake_cli.py datasets        # list datasets and their versions
    docker compose exec tenant-service python eval_lake_cli.py create-dataset individual-single-turn \
        --name "Individual Insurance, single turn" --workflow individual-insurance --turn-mode single_turn
    docker compose exec tenant-service python eval_lake_cli.py ingest individual-single-turn /app/cases.jsonl
    docker compose exec tenant-service python eval_lake_cli.py promote individual-single-turn
    docker compose exec tenant-service python eval_lake_cli.py fixtures individual-single-turn /app/fixtures
    docker compose exec tenant-service python eval_lake_cli.py approve individual-single-turn --as-user admin@example.com
        (cases whose rule the business has not confirmed, source.verification = pending_domain_approval, are skipped;
         `revoke-unconfirmed <slug> --as-user ...` returns any of them that were approved to draft; `publish` leaves them out)
    docker compose exec tenant-service python eval_lake_cli.py publish individual-single-turn 1.0.0 --as-user admin@example.com
    docker compose exec tenant-service python eval_lake_cli.py verify [slug] [--deep]
    docker compose exec tenant-service python eval_lake_cli.py export individual-single-turn 1.0.0 --format csv --out /app/out.csv
    docker compose exec tenant-service python eval_lake_cli.py bundle individual-single-turn 1.0.5 --out /tmp/bundle
        (a published Gold version as a folder for the evaluation worker: cases.jsonl, manifest.json and fixtures/, every checksum re-verified)
    docker compose exec tenant-service python eval_lake_cli.py run-ingest /tmp/run-folder     # keep a finished evaluation run (database + MinIO)
    docker compose exec tenant-service python eval_lake_cli.py runs [--dataset SLUG] [--limit N]
    docker compose exec tenant-service python eval_lake_cli.py run <run id> [--report]
    docker compose exec tenant-service python eval_lake_cli.py reconcile
    docker compose exec -T tenant-service python eval_lake_cli.py job-submit --as-user admin@example.com --config - < job.json    # queue an evaluation run
    docker compose exec tenant-service python eval_lake_cli.py jobs | job <id> | job-events <id> [--follow] | job-cancel <id>
    docker compose exec tenant-service python eval_lake_cli.py models-seed | models | benchmark-ingest <benchmark.json> | benchmarks
    python evals/environment/envctl.py worker [--once]                                                        # on the host: runs the queued jobs

The browser-based Dataset Manager (a later stage) uses the same DataLake; this is for setup, checks and recovery.
"""
import argparse
import asyncio
import json
import mimetypes
from pathlib import Path
import os
import sys
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

os.environ.setdefault("DISABLE_PGVECTOR", "true")

from sqlmodel import select

import database
from services.eval_lake import get_lake
from shared.evaluation import case_schema
from shared.evaluation.canonical import sha256_hex
from shared.evaluation.formats import FORMATS, serialize_cases
from shared.evaluation.lake import LakeValidationError
from shared.evaluation.object_store import LakeError
from shared.evaluation.policy import is_unconfirmed
from shared.models.core import User
from shared.models.evaluation import EvalBenchmark, EvalCase, EvalCaseResult, EvalDataset, EvalDatasetVersion, EvalModel, EvalModelPrice, EvalRun
from shared.evaluation.runs import RunFolderError


async def _user_id(session, email: str):
    user = (await session.exec(select(User).where(User.email == email))).first()
    if user is None:
        raise LakeValidationError(f"no user with the email {email!r}")
    return user.id


async def _jobs(args, session) -> int:
    """Evaluation jobs: request, list, inspect, follow and cancel (the worker, `envctl.py worker`, runs them)."""
    from fastapi import HTTPException
    from routers.eval_jobs import JobRequest, _check_request, _append, _out, TERMINAL
    from shared.models.evaluation import EvalJob, EvalJobEvent
    if args.command == "job-submit":
        raw = json.load(sys.stdin if args.config == "-" else open(args.config, encoding="utf-8"))
        try:
            req = JobRequest(**raw)
            estimate = await _check_request(session, req)
        except HTTPException as exc:
            print(f"error: {json.dumps(exc.detail)}", file=sys.stderr)
            return 1
        job = EvalJob(config=req.model_dump(exclude_none=True), estimate=estimate, created_by=await _user_id(session, args.as_user))
        session.add(job)
        session.add(EvalJobEvent(job_id=job.id, seq=1, kind="state", message="queued", data={"state": "queued"}))
        await session.commit()
        print(f"queued job {job.id}  estimate: {json.dumps(estimate)}")
        return 0
    if args.command == "jobs":
        stmt = select(EvalJob).order_by(EvalJob.created_at.desc()).limit(args.limit)
        if args.state:
            stmt = stmt.where(EvalJob.state == args.state)
        for j in (await session.exec(stmt)).all():
            c = j.config
            print(f"{j.id}  {j.state:10} {c.get('dataset')} {c.get('version')}  model={c.get('model', '-')} skills={c.get('skills', 'default')} repeat={c.get('repeat')}"
                  f"  {json.dumps(j.progress)[:90]}{'  CANCEL REQUESTED' if j.cancel_requested and j.state not in TERMINAL else ''}")
        return 0
    job = await session.get(EvalJob, UUID(args.job_id))
    if job is None:
        raise LakeValidationError(f"no job {args.job_id}")
    if args.command == "job":
        print(json.dumps(_out(job), indent=1, default=str))
        return 0
    if args.command == "job-events":
        cursor = args.after
        while True:
            rows = (await session.exec(select(EvalJobEvent).where(EvalJobEvent.job_id == job.id, EvalJobEvent.seq > cursor).order_by(EvalJobEvent.seq))).all()
            for e in rows:
                cursor = e.seq
                print(f"{e.seq:5} {e.at:%H:%M:%S} {e.kind:8} {e.message or ''}")
            await session.refresh(job)
            if not args.follow or (job.state in TERMINAL and not rows):
                return 0
            await asyncio.sleep(1.0)
    if args.command == "job-cancel":
        if job.state in TERMINAL:
            raise LakeValidationError(f"the job is already {job.state}")
        if job.state == "queued":
            job.state, job.finished_at = "cancelled", datetime.utcnow()
        job.cancel_requested = True
        await _append(session, job, "log", "cancel requested", {"cancel_requested": True})
        session.add(job)
        await session.commit()
        print(f"job {job.id}: {job.state}")
        return 0
    return 2


async def run(args) -> int:
    lake = get_lake()
    if args.command == "schema":
        print(json.dumps(case_schema.json_schema(), indent=2))
        return 0
    if args.command == "init":
        await lake.ensure_ready()
        s = lake.settings
        print(f"ready: bucket {s.bucket!r} at {s.endpoint_url} (retention {s.retention_mode}, {s.retention_days} days)")
        return 0
    if args.command == "smoke":
        await lake.ensure_ready()
        store, key, data = lake.store, f"_smoke/{uuid4()}.txt", b"evaluation lake smoke test"
        put = await asyncio.to_thread(store.put_if_absent, key, data, content_type="text/plain")
        again = await asyncio.to_thread(store.put_if_absent, key, data, content_type="text/plain")
        assert put.created and not again.created, "second identical write should be adopted, not created"
        assert await asyncio.to_thread(store.get, key) == data
        try:
            await asyncio.to_thread(store.put_if_absent, key, b"different", content_type="text/plain")
            raise AssertionError("an existing object was overwritten")
        except LakeError:
            pass
        if lake.settings.locks_objects:
            await asyncio.to_thread(store.retain, key, datetime.now(timezone.utc) + timedelta(minutes=5))
            try:
                await asyncio.to_thread(store.delete, key)
                raise AssertionError("a retained object could be deleted")
            except LakeError:
                pass
            if lake.settings.retention_mode == "GOVERNANCE":
                await asyncio.to_thread(store.delete, key, bypass_governance=True)
            else:
                print(f"note: {key} stays until its 5 minute COMPLIANCE retention ends")
        else:
            await asyncio.to_thread(store.delete, key)
        print(f"smoke test passed: write, adopt identical, refuse overwrite, read back, "
              f"{'retention + delete refused, governance bypass' if lake.settings.locks_objects else 'delete'} (sha256 {sha256_hex(data)[:12]}...)")
        return 0

    async with database._session_factory() as session:
        if args.command == "run-ingest":
            from shared.evaluation.runs import ingest_run            # the platform-side ingestion (shared/evaluation/runs.py)
            report = await ingest_run(lake, Path(args.folder))
            print(f"{'stored' if report.created else 'already stored (unchanged)'}: run {report.run_id}  {report.results} results, "
                  f"{report.assertions} assertions, {report.objects} objects" + ("".join(f"\n  problem: {p}" for p in report.problems)))
            return 0
        if args.command == "runs":
            stmt = select(EvalRun).order_by(EvalRun.started_at.desc().nullslast(), EvalRun.created_at.desc()).limit(args.limit)
            if args.dataset:
                stmt = stmt.where(EvalRun.dataset_slug == args.dataset)
            for r in (await session.exec(stmt)).all():
                rate = "n/a" if r.pass_rate is None else f"{r.pass_rate * 100:.0f}%"
                print(f"{r.run_id}  {r.dataset_slug or '-'} {r.dataset_version or '-'}  {r.suite}  x{r.repetitions}  {r.executions} exec  "
                      f"pass {rate} ({r.passed}/{r.passed + r.failed})  blocked {r.blocked}  skipped {r.skipped}  infra {r.infrastructure_errors}  "
                      f"${r.known_cost_usd:.4f}{'+?' if r.unknown_cost_executions else ''}  {r.state}{'  CANCELLED' if r.cancelled else ''}{'  (unverified data)' if not r.data_verified else ''}")
            return 0
        if args.command == "run":
            r = (await session.exec(select(EvalRun).where(EvalRun.run_id == args.run_id))).first()
            if r is None:
                raise LakeValidationError(f"no run {args.run_id!r}")
            if args.report:
                sys.stdout.buffer.write(await lake._io(lake.store.get, r.report_key))
                return 0
            print(json.dumps({k: v for k, v in r.summary.items() if k not in ("by_category",)}, indent=1, default=str))
            for row in (await session.exec(select(EvalCaseResult).where(EvalCaseResult.run_row_id == r.id, EvalCaseResult.status.in_(["failed", "infrastructure_error"])).order_by(EvalCaseResult.case_key))).all():
                print(f"  {row.status:20} {row.case_key} r{row.repetition} {row.reason or ''}")
            return 0
        if args.command == "models-seed":
            from shared.evaluation import registry
            added = 0
            for entry in registry.seed_entries():
                price = entry.pop("price")
                display = entry.pop("display_name")
                notes = entry.pop("notes")
                if (await session.exec(select(EvalModel).where(EvalModel.provider == entry["provider"], EvalModel.model_id == entry["model_id"]))).first():
                    continue
                m = EvalModel(**entry, display_name=display, notes=notes)
                session.add(m)
                await session.flush()
                session.add(EvalModelPrice(model_row_id=m.id, **price))
                added += 1
            await session.commit()
            print(f"registered {added} model(s); the rest were already there")
            return 0
        if args.command == "models":
            for m in (await session.exec(select(EvalModel).order_by(EvalModel.provider, EvalModel.model_id))).all():
                p = (await session.exec(select(EvalModelPrice).where(EvalModelPrice.model_row_id == m.id).order_by(EvalModelPrice.effective_from.desc()))).first()
                print(f"{m.provider}/{m.model_id:28} {m.status:10} {'SYNTHETIC ' if m.synthetic else ''}{','.join(m.roles):16} "
                      + (f"${p.input_per_m}/{p.cached_per_m}/{p.output_per_m} per M tokens" if p else "no price"))
            return 0
        if args.command == "drift-ingest":
            from services import eval_drift
            report = json.loads(Path(args.file).read_text(encoding="utf-8"))
            out = await eval_drift.ingest_scan(session, report)
            await session.commit()
            print(json.dumps(out))
            return 0
        if args.command == "drift-registry":
            from services import eval_drift
            out = await eval_drift.scan_registry(session, captured_from="cli")
            await session.commit()
            print(json.dumps(out, default=str))
            return 0
        if args.command == "drift-deps-load":
            from services import eval_registry
            data = json.loads(Path(args.file).read_text(encoding="utf-8"))
            known = [o["key"] for o in await eval_registry.read_all(session)]
            n = await eval_registry.load_dependencies(session, args.slug, args.version, data["dependencies"], known)
            await session.commit()
            print(f"stored {n} dependencies for {args.slug} {args.version}")
            return 0
        if args.command == "benchmark-ingest":
            data = json.loads(Path(args.file).read_text(encoding="utf-8"))
            bid = data["benchmark_id"]
            if not data.get("valid", False):
                raise LakeValidationError(f"benchmark {bid} is not valid and is not stored: " + "; ".join(data.get("problems") or ["it carries no validity check"]))
            if (await session.exec(select(EvalBenchmark).where(EvalBenchmark.benchmark_id == bid))).first():
                print(f"benchmark {bid} is already stored; nothing changed")
                return 0
            missing = [v["run_id"] for v in data["runs"].values() if v.get("run_id") and not (await session.exec(select(EvalRun).where(EvalRun.run_id == v["run_id"]))).first()]
            if missing:
                raise LakeValidationError("ingest the runs of this benchmark first (" + ", ".join(missing) + ")")
            ds = data.get("dataset") or {}
            summary = {k: data[k] for k in ("models", "order", "comparisons", "leader", "fairness", "notes", "evidence_rules", "fallback", "runs", "report")}
            session.add(EvalBenchmark(
                benchmark_id=bid, mode=data["mode"], dataset_slug=ds.get("dataset"), dataset_version=ds.get("version"),
                models=[{"label": l, "status": m["status"], "provider": (m.get("config") or {}).get("provider"), "model_id": (m.get("config") or {}).get("model_id"),
                         "settings": (m.get("config") or {}).get("model_settings")} for l, m in data["models"].items()],
                repetitions=int(data.get("repetitions") or 1), judge_model=(data.get("judge") or {}).get("model"),
                judge_version=(data.get("judge") or {}).get("deepeval_version"), synthetic=bool(data["synthetic"]), complete=bool(data["complete"]),
                config={"judge": data.get("judge"), "dataset": ds}, summary=summary))
            await session.commit()
            print(f"stored benchmark {bid}: {len(data['models'])} model(s), {'SYNTHETIC, ' if data['synthetic'] else ''}{'complete' if data['complete'] else 'INCOMPLETE'}")
            return 0
        if args.command == "benchmarks":
            for b in (await session.exec(select(EvalBenchmark).order_by(EvalBenchmark.created_at.desc()).limit(20))).all():
                print(f"{b.benchmark_id:34} {b.mode:7} {b.dataset_slug} {b.dataset_version}  x{b.repetitions}  {len(b.models)} model(s)  "
                      f"{'SYNTHETIC ' if b.synthetic else ''}{'complete' if b.complete else 'INCOMPLETE'}")
            return 0
        if args.command == "run-reliability":
            r = (await session.exec(select(EvalRun).where(EvalRun.run_id == args.run_id))).first()
            if r is None:
                raise LakeValidationError(f"no run {args.run_id!r}")
            s_ = r.summary or {}
            rel = s_.get("reliability")
            if not rel:
                print(f"{r.run_id}: no reliability was recorded (the run predates it, or nothing ran)")
                return 0
            pct = lambda x: "-" if x is None else f"{x * 100:.1f}%"  # noqa: E731
            print(f"{r.run_id}  {r.dataset_slug} {r.dataset_version}  x{s_.get('repeat', 1)}")
            print(f"  pass rate {pct(rel.get('pass_rate'))}  (95% interval {pct(rel.get('ci_low'))} - {pct(rel.get('ci_high'))})")
            print(f"  flaky:              {', '.join(rel.get('flaky_cases') or []) or 'none'}")
            print(f"  consistently wrong: {', '.join(rel.get('consistently_wrong_cases') or []) or 'none'}")
            for case, v in sorted((s_.get("per_case") or {}).items()):
                if v.get("class") not in (None, "stable_pass"):
                    print(f"    {case:14} {v.get('class'):13} passed {v.get('passes')} of {v.get('n')}   tool consistency {pct(v.get('tool_consistency'))}")
            gate = s_.get("gate")
            if gate:
                print(f"  quality gate {'PASSED' if gate['passed'] else 'FAILED'}")
                for c in gate["checks"]:
                    print(f"    {'ok  ' if c['ok'] else 'FAIL'} {c['name']}: {c['value']} (required {c['threshold']}) {c['detail']}")
            cal = s_.get("judge_calibration")
            if cal:
                print(f"  judge calibration {cal['status']} ({cal.get('agreed')}/{cal.get('scored')})")
            return 0
        if args.command in ("job-submit", "jobs", "job", "job-events", "job-cancel"):
            return await _jobs(args, session)
        if args.command == "datasets":
            for d in (await session.exec(select(EvalDataset).order_by(EvalDataset.slug))).all():
                versions = (await session.exec(select(EvalDatasetVersion).where(EvalDatasetVersion.dataset_id == d.id).order_by(EvalDatasetVersion.started_at))).all()
                print(f"{d.slug}  [{d.workflow}, {d.turn_mode}, {d.status}]  latest={d.latest_version or '-'}")
                for v in versions:
                    print(f"    {v.version:<10} {v.state:<10} {v.case_count} cases  sha256 {v.snapshot_sha256[:12]}")
            return 0
        if args.command == "create-dataset":
            d = await lake.create_dataset(session, slug=args.slug, name=args.name, workflow=args.workflow, turn_mode=args.turn_mode)
            print(f"created dataset {d.slug} ({d.id})")
            return 0
        if args.command == "reconcile":
            r = await lake.reconcile()
            print(f"finalized={r.finalized} failed={r.failed} skipped={r.skipped}")
            return 0
        if args.command == "verify":
            stmt = select(EvalDatasetVersion).where(EvalDatasetVersion.state == "published")
            if args.slug:
                stmt = stmt.where(EvalDatasetVersion.dataset_id == (await lake.get_dataset(session, args.slug)).id)
            bad = 0
            for v in (await session.exec(stmt)).all():
                report = await lake.verify_version(v, deep=args.deep)
                print(f"{'OK  ' if report.ok else 'FAIL'} {v.dataset_id} {report.version}  ({report.objects_checked} objects)")
                for p in report.problems:
                    print(f"       - {p}")
                bad += 0 if report.ok else 1
            return 1 if bad else 0

        dataset = await lake.get_dataset(session, args.slug)
        if args.command == "ingest":
            with open(args.file, "rb") as f:
                result = await lake.ingest_bronze(session, dataset, data=f.read(), filename=os.path.basename(args.file),
                                                  source_type=args.source_type, source_ref=args.source_ref)
            print(f"ingestion {result.ingestion_id}: {result.created} new, {result.updated} updated, {result.rejected} rejected -> {result.raw_key}")
            for r in result.rejects[:20]:
                print(f"    position {r['position']}: {r['error']}")
            return 0
        if args.command == "fixtures":
            # Upload the files in a folder that the dataset's Silver cases reference (publish refuses a case whose fixture is missing).
            rows = (await session.exec(select(EvalCase).where(EvalCase.dataset_id == dataset.id, EvalCase.tier == "silver"))).all()
            refs = sorted({ref for r in rows for ref in (r.content.get("input") or {}).get("fixture_refs") or []})
            absent = [ref for ref in refs if not os.path.isfile(os.path.join(args.directory, ref))]
            if absent:
                raise LakeValidationError(f"not found in {args.directory}: " + ", ".join(absent))
            # A zero-byte file is accepted only when the folder's manifest.json declares it empty on purpose.
            manifest_path = os.path.join(args.directory, "manifest.json")
            declared = {}
            if os.path.isfile(manifest_path):
                with open(manifest_path) as f:
                    declared = {e["key"]: e.get("size_bytes") for e in json.load(f).get("fixtures", [])}
            for ref in refs:
                with open(os.path.join(args.directory, ref), "rb") as f:
                    data = f.read()
                content_type = mimetypes.guess_type(ref)[0] or "application/octet-stream"
                row = await lake.put_fixture(session, dataset, fixture_key=ref, data=data, filename=ref, content_type=content_type,
                                             kind="payload" if content_type == "application/json" else "document",
                                             allow_empty=declared.get(ref) == 0)
                print(f"    {ref}  {len(data)} bytes  sha256 {row.sha256[:12]}")
            print(f"stored {len(refs)} fixture(s) for {dataset.slug}")
            return 0
        if args.command == "promote":
            report = await lake.promote_to_silver(session, dataset, ingestion_id=UUID(args.ingestion) if args.ingestion else None)
            print(f"batch {report.batch_id}: {report.accepted} to Silver, {report.rejected} rejected ({report.duplicates} duplicates)")
            for r in report.rejects[:20]:
                print(f"    {r['case_id']}: {r['errors'][0]['loc']}: {r['errors'][0]['msg']}")
            return 0
        if args.command == "approve":
            actor = await _user_id(session, args.as_user)
            rows = (await session.exec(select(EvalCase).where(EvalCase.dataset_id == dataset.id, EvalCase.tier == "silver",
                                                              EvalCase.status.in_(["draft", "in_review"])))).all()
            if args.case_keys:
                wanted = set(args.case_keys.split(","))
                rows = [r for r in rows if r.case_key in wanted]
                missing = wanted - {r.case_key for r in rows}
                if missing:
                    raise LakeValidationError("not a draft or in-review Silver case: " + ", ".join(sorted(missing)))
            else:
                held = [r for r in rows if is_unconfirmed(r.content)]
                rows = [r for r in rows if not is_unconfirmed(r.content)]
                print(f"left alone, waiting for the business to confirm the rule: {len(held)} case(s)")
            for row in rows:
                if row.status == "draft":
                    await lake.transition_case(session, row, "in_review", actor=actor)
                await lake.transition_case(session, row, "approved", actor=actor, note=args.note)
            print(f"approved {len(rows)} case(s)")
            return 0
        if args.command == "revoke-unconfirmed":
            # Move cases that rest on an unconfirmed rule back to draft. Nothing published changes; the cases stay editable.
            actor = await _user_id(session, args.as_user)
            rows = (await session.exec(select(EvalCase).where(EvalCase.dataset_id == dataset.id, EvalCase.tier == "silver",
                                                              EvalCase.status.in_(["approved", "in_review"])))).all()
            rows = [r for r in rows if is_unconfirmed(r.content)]
            for row in rows:
                await lake.transition_case(session, row, "draft", actor=actor, note="rule not yet confirmed by the business")
            print(f"returned {len(rows)} unconfirmed case(s) to draft")
            return 0
        if args.command == "publish":
            actor = await _user_id(session, args.as_user)
            approved = (await session.exec(select(EvalCase).where(EvalCase.dataset_id == dataset.id, EvalCase.tier == "silver",
                                                                  EvalCase.status == "approved"))).all()
            eligible = [r.case_key for r in approved if not is_unconfirmed(r.content)]
            if not eligible:
                # An empty list would mean "every approved case" to the lake, which would publish the unconfirmed ones.
                raise LakeValidationError("no approved case with a confirmed rule to publish")
            print(f"publishing {len(eligible)} case(s); {len(approved) - len(eligible)} approved but unconfirmed case(s) are left out")
            v = await lake.publish(dataset.id, args.version, approval={"approved_by": args.as_user, "note": args.note},
                                   published_by=actor, change_summary=args.summary, case_keys=eligible)
            print(f"published {dataset.slug} {v.version}: {v.case_count} cases, snapshot sha256 {v.snapshot_sha256}")
            return 0
        if args.command == "bundle":
            # What the evaluation worker reads: the Gold snapshot, never the database. load_version re-checks the manifest, the
            # snapshot and every case against the checksums the version pinned, and read_fixture does the same for each fixture,
            # so a bundle can only hold exactly what was published.
            v = await lake.get_version(session, args.slug, args.version)
            loaded = await lake.load_version(v)
            out = os.path.abspath(args.out)
            os.makedirs(os.path.join(out, "fixtures"), exist_ok=True)
            with open(os.path.join(out, "cases.jsonl"), "wb") as f:
                f.write(serialize_cases(loaded.cases, "jsonl"))
            with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
                json.dump(loaded.manifest, f, indent=1, sort_keys=True)
            for entry in loaded.manifest["fixtures"]:
                with open(os.path.join(out, "fixtures", entry["fixture_key"]), "wb") as f:
                    f.write(await lake.read_fixture(entry))
            print(f"bundle {args.slug} {args.version}: {len(loaded.cases)} cases, {len(loaded.manifest['fixtures'])} fixtures -> {out}")
            return 0
        if args.command == "export":
            v = await lake.get_version(session, args.slug, args.version)
            data = await lake.export_version(v, args.format)
            if args.out:
                with open(args.out, "wb") as f:
                    f.write(data)
                print(f"wrote {len(data)} bytes to {args.out}")
            else:
                sys.stdout.buffer.write(data)
            return 0
    return 2


def main() -> int:
    p = argparse.ArgumentParser(description="Evaluation data lake tools")
    sub = p.add_subparsers(dest="command", required=True)
    for name in ("init", "smoke", "schema", "datasets", "reconcile"):
        sub.add_parser(name)
    ri = sub.add_parser("run-ingest"); ri.add_argument("folder")
    ru = sub.add_parser("runs"); ru.add_argument("--dataset"); ru.add_argument("--limit", type=int, default=20)
    r1 = sub.add_parser("run"); r1.add_argument("run_id"); r1.add_argument("--report", action="store_true")
    sub.add_parser("models-seed"); sub.add_parser("models"); sub.add_parser("benchmarks")
    bi = sub.add_parser("benchmark-ingest"); bi.add_argument("file")
    di = sub.add_parser("drift-ingest"); di.add_argument("file")
    sub.add_parser("drift-registry")
    dd = sub.add_parser("drift-deps-load"); dd.add_argument("slug"); dd.add_argument("version"); dd.add_argument("file")
    rr = sub.add_parser("run-reliability"); rr.add_argument("run_id")
    c = sub.add_parser("create-dataset"); c.add_argument("slug"); c.add_argument("--name", required=True)
    c.add_argument("--workflow", required=True); c.add_argument("--turn-mode", required=True, choices=["single_turn", "multi_turn"])
    i = sub.add_parser("ingest"); i.add_argument("slug"); i.add_argument("file")
    i.add_argument("--source-type", default="import", choices=["import", "synthetic", "trace", "manual"]); i.add_argument("--source-ref")
    fx = sub.add_parser("fixtures"); fx.add_argument("slug"); fx.add_argument("directory")
    pr = sub.add_parser("promote"); pr.add_argument("slug"); pr.add_argument("--ingestion")
    a = sub.add_parser("approve"); a.add_argument("slug"); a.add_argument("--as-user", required=True); a.add_argument("--note")
    a.add_argument("--case-keys", help="comma-separated ids; without it every draft case whose rule is confirmed is approved")
    rv = sub.add_parser("revoke-unconfirmed"); rv.add_argument("slug"); rv.add_argument("--as-user", required=True)
    pu = sub.add_parser("publish"); pu.add_argument("slug"); pu.add_argument("version"); pu.add_argument("--as-user", required=True)
    pu.add_argument("--note"); pu.add_argument("--summary")
    v = sub.add_parser("verify"); v.add_argument("slug", nargs="?"); v.add_argument("--deep", action="store_true")
    b = sub.add_parser("bundle"); b.add_argument("slug"); b.add_argument("version"); b.add_argument("--out", required=True)
    js = sub.add_parser("job-submit"); js.add_argument("--as-user", required=True); js.add_argument("--config", default="-", help="a JSON file of the run request, or - for stdin")
    jl = sub.add_parser("jobs"); jl.add_argument("--state"); jl.add_argument("--limit", type=int, default=20)
    for name in ("job", "job-events", "job-cancel"):
        jx = sub.add_parser(name); jx.add_argument("job_id")
        if name == "job-events":
            jx.add_argument("--after", type=int, default=0); jx.add_argument("--follow", action="store_true")
    e = sub.add_parser("export"); e.add_argument("slug"); e.add_argument("version")
    e.add_argument("--format", default="jsonl", choices=list(FORMATS)); e.add_argument("--out")
    args = p.parse_args()
    try:
        return asyncio.run(run(args))
    except (LakeValidationError, LakeError, RunFolderError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
