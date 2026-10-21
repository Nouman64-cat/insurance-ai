"""Command line for the evaluation data lake (shared/evaluation). Run it inside the tenant-service container:

    docker compose exec tenant-service python eval_lake_cli.py init            # reach MinIO, create/check the bucket
    docker compose exec tenant-service python eval_lake_cli.py smoke           # write, read, lock and delete a test object
    docker compose exec tenant-service python eval_lake_cli.py schema          # print the Golden case JSON Schema
    docker compose exec tenant-service python eval_lake_cli.py datasets        # list datasets and their versions
    docker compose exec tenant-service python eval_lake_cli.py create-dataset individual-single-turn \
        --name "Individual Insurance, single turn" --workflow individual-insurance --turn-mode single_turn
    docker compose exec tenant-service python eval_lake_cli.py ingest individual-single-turn /app/cases.jsonl
    docker compose exec tenant-service python eval_lake_cli.py promote individual-single-turn
    docker compose exec tenant-service python eval_lake_cli.py approve individual-single-turn --as-user admin@example.com
    docker compose exec tenant-service python eval_lake_cli.py publish individual-single-turn 1.0.0 --as-user admin@example.com
    docker compose exec tenant-service python eval_lake_cli.py verify [slug] [--deep]
    docker compose exec tenant-service python eval_lake_cli.py export individual-single-turn 1.0.0 --format csv --out /app/out.csv
    docker compose exec tenant-service python eval_lake_cli.py reconcile

The browser-based Dataset Manager (a later stage) uses the same DataLake; this is for setup, checks and recovery.
"""
import argparse
import asyncio
import json
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
from shared.evaluation.formats import FORMATS
from shared.evaluation.lake import LakeValidationError
from shared.evaluation.object_store import LakeError
from shared.models.core import User
from shared.models.evaluation import EvalCase, EvalDataset, EvalDatasetVersion


async def _user_id(session, email: str):
    user = (await session.exec(select(User).where(User.email == email))).first()
    if user is None:
        raise LakeValidationError(f"no user with the email {email!r}")
    return user.id


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
            for row in rows:
                if row.status == "draft":
                    await lake.transition_case(session, row, "in_review", actor=actor)
                await lake.transition_case(session, row, "approved", actor=actor, note=args.note)
            print(f"approved {len(rows)} case(s)")
            return 0
        if args.command == "publish":
            actor = await _user_id(session, args.as_user)
            v = await lake.publish(dataset.id, args.version, approval={"approved_by": args.as_user, "note": args.note},
                                   published_by=actor, change_summary=args.summary)
            print(f"published {dataset.slug} {v.version}: {v.case_count} cases, snapshot sha256 {v.snapshot_sha256}")
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
    c = sub.add_parser("create-dataset"); c.add_argument("slug"); c.add_argument("--name", required=True)
    c.add_argument("--workflow", required=True); c.add_argument("--turn-mode", required=True, choices=["single_turn", "multi_turn"])
    i = sub.add_parser("ingest"); i.add_argument("slug"); i.add_argument("file")
    i.add_argument("--source-type", default="import", choices=["import", "synthetic", "trace", "manual"]); i.add_argument("--source-ref")
    pr = sub.add_parser("promote"); pr.add_argument("slug"); pr.add_argument("--ingestion")
    a = sub.add_parser("approve"); a.add_argument("slug"); a.add_argument("--as-user", required=True); a.add_argument("--note")
    pu = sub.add_parser("publish"); pu.add_argument("slug"); pu.add_argument("version"); pu.add_argument("--as-user", required=True)
    pu.add_argument("--note"); pu.add_argument("--summary")
    v = sub.add_parser("verify"); v.add_argument("slug", nargs="?"); v.add_argument("--deep", action="store_true")
    e = sub.add_parser("export"); e.add_argument("slug"); e.add_argument("version")
    e.add_argument("--format", default="jsonl", choices=list(FORMATS)); e.add_argument("--out")
    args = p.parse_args()
    try:
        return asyncio.run(run(args))
    except (LakeValidationError, LakeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
