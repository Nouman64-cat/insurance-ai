"""Operator commands:  python -m app.archive.cli <command>

  init-keys   create the archive master key for THIS installation (refuses if one exists; never regenerates)
  status      is the master key readable, is the bucket reachable / versioned / Object-Locked / private?
  seed-aged   DEVELOPMENT ONLY: append synthetic events dated in past months to a throwaway tenant, so the archive cycle can be exercised
"""
import argparse
import asyncio
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone

from app.archive import crypto
from app.config import settings


def cmd_init_keys(_) -> int:
    try:
        kek_id = crypto.init_keys(settings.key_directory)
    except crypto.ArchiveCryptoError as exc:
        print(f"{exc.code}: {exc.message}", file=sys.stderr)
        return 0 if exc.code == "KEK_EXISTS" else 1     # an existing key is the expected state on a repeated run
    print(f"created archive master key {kek_id} in {settings.key_directory}")
    print("BACK THIS KEY UP SEPARATELY (not with the database): without it the archives cannot be decrypted.")
    return 0


def cmd_status(_) -> int:
    from app.archive.store import S3Store
    out = {"master_key": crypto.KeyRing(settings.key_directory).available()}
    try:
        out["bucket"] = S3Store(settings, "writer").capabilities()
    except Exception as exc:
        out["bucket"] = {"problem": str(exc)}
    print(json.dumps(out, indent=2))
    return 0 if out["master_key"] and out["bucket"].get("reachable") else 1


async def _seed(months: int, events: int, tenant: str, newest: float = 0.0) -> dict:
    from app import db, migrate
    from app.services import audit_service
    from shared.audit.schema import AuditIntent
    if settings.environment_label != "local-dev":
        raise SystemExit("seed-aged writes synthetic history and is allowed only when AUDIT_ENVIRONMENT_LABEL=local-dev")
    tenant_id = uuid.UUID(tenant) if tenant else uuid.uuid4()
    now = datetime.now(timezone.utc)
    span = timedelta(days=30 * (months - newest)).total_seconds()
    start_at = now - timedelta(days=30 * months)
    clock_state = {"i": 0}

    def clock() -> datetime:
        i = clock_state["i"]
        clock_state["i"] += 1
        return start_at + timedelta(seconds=span * min(i, events) / max(events, 1) * 0.999)

    modules = ("policies", "claims", "administration", "underwriting", "documents")
    intents = [AuditIntent(source_service="archive-seed", source_event_id=f"seed-{tenant_id}-{n}", tenant_id=tenant_id, actor_id=f"seed-user-{n % 7}",
                           actor_type="USER", actor_role="Admin", module=modules[n % len(modules)], action=f"{modules[n % len(modules)]}.seeded",
                           entity_type="seed", entity_id=f"SEED-{n}", case_id=f"CASE-{n % 40}", new_value={"n": n, "status": "Active"},
                           metadata={"synthetic": True}) for n in range(events)]
    for m in range(months + 1):          # recorded_at is back-dated here, so the matching monthly partitions must exist first
        await audit_service.ensure_partition(now - timedelta(days=30 * m))
    for start in range(0, len(intents), 500):
        await audit_service.ingest(intents[start:start + 500], clock=clock)
    await db.dispose()
    return {"tenant_id": str(tenant_id), "events": events, "spanning_months": months}


def cmd_seed(args) -> int:
    print(json.dumps(asyncio.run(_seed(args.months, args.events, args.tenant, args.newest_months_ago))))
    print("Checkpoints are created by the running service within ~15 minutes (or POST /audit/v1/checkpoints/run); then archive with AUDIT_ARCHIVE_TEST_MODE or wait for the monthly window.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m app.archive.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init-keys").set_defaults(fn=cmd_init_keys)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    seed = sub.add_parser("seed-aged")
    seed.add_argument("--months", type=int, default=8)
    seed.add_argument("--events", type=int, default=1200)
    seed.add_argument("--tenant", default="")
    seed.add_argument("--newest-months-ago", type=float, default=0.0, help="the newest seeded event is this old (use >6 for history that is archivable immediately)")
    seed.set_defaults(fn=cmd_seed)
    args = parser.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
