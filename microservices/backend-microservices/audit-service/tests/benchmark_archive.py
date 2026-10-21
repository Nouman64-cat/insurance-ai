"""Stage 3 benchmark. Real PostgreSQL (disposable database), real signer, real MinIO, real encryption/compression.

    docker compose exec -T audit-service python -m tests.benchmark_archive [events] [--memory-store]

Prints a JSON report: ingestion latency, archive throughput (export / upload / validate), compression ratio, MinIO transfer speed,
catalog search and retrieval time, verification speed, CPU and memory, and space reclaimed from hot storage. Objects written to MinIO are
removed afterwards with the writer's own prefix left behind only when Object Lock is on (benchmark uses lock_days=0)."""
import asyncio
import json
import resource
import sys
import time
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from sqlalchemy import text

from app import db
from app.archive import crypto, repository as repo
from app.archive.cleanup import CleanupService
from app.archive.retrieval import RetrievalService
from app.archive.store import S3Store
from app.archive.worker import ArchiveWorker
from app.checkpoints.storage import TrustedStorage
from app.config import settings
from app.services import audit_service, chain_verifier
from app.verification import integrity_verifier as iv
from tests.archive_support import MemoryStore
from tests.signing_support import OffsetClock, SignerHarness, override_settings
from tests.support import TestDatabase, intent


def pct(values, p):
    values = sorted(values)
    return values[min(len(values) - 1, int(len(values) * p))]


async def main(n: int, memory: bool) -> dict:
    out: dict = {"events": n, "store": "memory" if memory else "minio"}
    database = TestDatabase()
    await database.create()
    db.configure(database.app_url)
    tmp = Path(tempfile.mkdtemp(prefix="audit-bench-"))
    clock = OffsetClock()
    signer = SignerHarness(database, tmp, clock=clock, max_events=n)
    ov = override_settings(checkpoint_directory=str(signer.checkpoints_dir), signer_service_key="test-service-key-0123456789abcdef0123456789",
                          lock_days=0, require_object_lock=False, cleanup_safety_days=0.0, archive_chunk_bytes=1024 * 1024, archive_fetch_batch=2000,
                          checkpoint_max_events=max(n, 5000))
    ov.__enter__()
    try:
        await signer.init()
        keys = tmp / "keys"
        crypto.init_keys(str(keys))
        ring = crypto.KeyRing(str(keys))
        store = MemoryStore() if memory else S3Store(settings, "writer")
        reader = store if memory else S3Store(settings, "reader")
        tenant = uuid4()
        env = ""
        async with db.engine().connect() as c:
            env = str((await c.execute(text("SELECT environment_id FROM environment"))).scalar_one())

        # ── ingestion latency: steady load 500-1500/min is trivially below this; measure batches and a 5,000 burst ──
        start = datetime.now(timezone.utc) - timedelta(days=30 * 8)
        tick = {"i": 0}

        def aged() -> datetime:
            tick["i"] += 1
            return start + timedelta(milliseconds=tick["i"] * 20)

        lat = []
        for off in range(0, n, 250):
            batch = [intent(tenant, i, module=("policies", "claims", "administration")[i % 3], entity_id=f"ENT-{i % 400}", case_id=f"CASE-{i % 90}",
                            actor_id=f"user-{i % 30}", new_value={"status": "Active", "n": i, "premium": str(1000 + i % 500), "note": "benchmark event"})
                     for i in range(off, min(n, off + 250))]
            t = time.perf_counter()
            await audit_service.ingest(batch, clock=aged)
            lat.append((time.perf_counter() - t) * 1000)
        total_s = sum(lat) / 1000
        out["ingestion"] = {"events_per_second": round(n / total_s), "batch_250_ms_p50": round(pct(lat, .5), 1), "batch_250_ms_p95": round(pct(lat, .95), 1),
                            "per_event_ms": round(total_s * 1000 / n, 2)}
        chain = f"{env}:{tenant}"
        async with db.engine().connect() as c:
            out["hot_bytes_before"] = int((await c.execute(text("SELECT COALESCE(sum(total_bytes), 0) FROM list_event_partitions()"))).scalar_one())

        t = time.perf_counter()
        outcome = await signer.generator("bench").checkpoint_chain(chain)
        assert outcome.status == "CREATED", (outcome.error_code, outcome.error)
        out["checkpoint_sign_and_reverify_s"] = round(time.perf_counter() - t, 2)

        worker = ArchiveWorker(signer.client, store, reader, ring, "bench", clock=clock, config=settings,
                               storage=TrustedStorage(str(signer.checkpoints_dir)), work_dir=tmp / "work")
        planned = await worker.plan(chain_id=chain)
        job_id = planned[0].job_id
        cpu0, wall0 = time.process_time(), time.perf_counter()
        outcome = await worker.run_job(job_id)
        assert outcome.status == "DONE", (outcome.error_code, outcome.error)
        wall, cpu = time.perf_counter() - wall0, time.process_time() - cpu0
        async with db.engine().connect() as c:
            job = dict(await repo.get_job(c, job_id))
            row = dict((await repo.catalog_for_chain(c, chain))[0])
        r = job["result"]
        assert row["event_count"] == n, f"archive holds {row['event_count']} of {n} events"
        out["archive"] = {"total_s": round(wall, 2), "events_per_second": round(n / wall), "export_events_per_second": r["export_events_per_second"],
                          "cpu_s": round(cpu, 2), "plaintext_mb": round(row["uncompressed_bytes"] / 1e6, 2), "stored_mb": round(row["size_bytes"] / 1e6, 2),
                          "compression_ratio": round(row["uncompressed_bytes"] / row["size_bytes"], 2), "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)}

        if not memory:   # raw object-store speed with the same payload size
            blob = tmp / "speed.bin"
            blob.write_bytes(__import__("os").urandom(min(row["size_bytes"], 64 * 1024 * 1024)))
            t = time.perf_counter(); info = store.put_file(f"v1/{env}/speed-test.bin", blob, sha256="0" * 64); up = time.perf_counter() - t
            t = time.perf_counter(); reader.get_file(f"v1/{env}/speed-test.bin", tmp / "speed.down", info.version_id); down = time.perf_counter() - t
            mb = blob.stat().st_size / 1e6
            out["minio"] = {"payload_mb": round(mb, 1), "upload_mb_per_s": round(mb / up, 1), "download_mb_per_s": round(mb / down, 1)}

        t = time.perf_counter(); quick = await worker.verifier.verify(row, deep=False, env=env); q = time.perf_counter() - t
        t = time.perf_counter(); deep = await worker.verifier.verify(row, deep=True, env=env); d = time.perf_counter() - t
        assert quick.state == deep.state == "VERIFIED"
        t = time.perf_counter(); res = await chain_verifier.verify_chain(chain); hv = time.perf_counter() - t
        t = time.perf_counter(); anchored = await iv.verify_anchored(chain, storage=TrustedStorage(str(signer.checkpoints_dir))); av = time.perf_counter() - t
        out["verification"] = {"archive_quick_ms": round(q * 1000), "archive_deep_s": round(d, 2), "deep_events_per_second": round(n / d),
                               "hot_chain_s": round(hv, 2), "hot_events_per_second": round(n / hv), "anchored_chain_s": round(av, 2), "anchored_state": anchored.state}

        # ── search and retrieval ──
        async with db.engine().connect() as c:
            t = time.perf_counter(); rows, total = await repo.search_catalog(c, tenant_id=str(tenant), unrestricted=False, module="claims"); search = time.perf_counter() - t
        svc = RetrievalService(reader, ring, worker.verifier, "bench", clock=clock, config=settings)
        t = time.perf_counter()
        req = await svc.request(tenant_id=str(tenant), unrestricted=False, requested_by="bench", criteria={"entity_id": "ENT-7"})
        await svc.process_pending()
        point = time.perf_counter() - t
        t = time.perf_counter()
        req2 = await svc.request(tenant_id=str(tenant), unrestricted=False, requested_by="bench", criteria={"chain_id": chain, "from_sequence": 1, "to_sequence": min(n, 5000)})
        await svc.process_pending()
        rng = time.perf_counter() - t
        async with db.engine().connect() as c:
            staged = {r["retrieval_id"]: r["event_count"] for r in (await c.execute(text("SELECT retrieval_id, event_count FROM archive_retrievals"))).mappings().all()}
        out["retrieval"] = {"catalog_search_ms": round(search * 1000, 1), "entity_lookup_s": round(point, 2), "entity_events": staged[__import__("uuid").UUID(req["retrieval_id"])],
                            "range_s": round(rng, 2), "range_events": staged[__import__("uuid").UUID(req2["retrieval_id"])]}

        # ── space reclaimed ──
        cleanup = CleanupService(worker.verifier, clock=clock, config=settings)
        await cleanup.promote(ignore_safety_period=True)
        rep = await cleanup.remove(dry_run=False, mode="drop")
        async with db.engine().connect() as c:
            after = int((await c.execute(text("SELECT COALESCE(sum(total_bytes), 0) FROM list_event_partitions()"))).scalar_one())
            out["hot_bytes_after"] = after
        out["space_reclaimed"] = {"hot_mb_before": round(out["hot_bytes_before"] / 1e6, 1), "hot_mb_after": round(after / 1e6, 1),
                                  "reclaimed_mb": round((out["hot_bytes_before"] - after) / 1e6, 1), "cold_mb": round(row["size_bytes"] / 1e6, 2),
                                  "removed_months": rep["removed_months"]}
        res2 = await chain_verifier.verify_chain(chain)
        out["after_cleanup"] = {"chain_status": res2.status}
        async with db.engine().connect() as c:
            out["after_cleanup"]["hot_events"] = (await c.execute(text("SELECT count(*) FROM events WHERE chain_id = :c"), {"c": chain})).scalar_one()
        usage = resource.getrusage(resource.RUSAGE_SELF)
        out["process"] = {"cpu_user_s": round(usage.ru_utime, 1), "cpu_sys_s": round(usage.ru_stime, 1), "peak_rss_mb": round(usage.ru_maxrss / 1024)}
        out["env"] = env
    finally:
        ov.__exit__(None, None, None)
        await signer.close()
        await db.dispose()
        await database.drop()
    return out


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    print(json.dumps(asyncio.run(main(int(args[0]) if args else 20000, "--memory-store" in sys.argv)), indent=2, default=str))
