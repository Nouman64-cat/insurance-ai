"""The evaluation worker's commands. Run inside the eval-runner container (envctl.py wraps this):

    python evals/environment/envctl.py guard      # every safety check, and what it found
    python -m evals.tools.runner snapshot         # once, on a freshly started stack: record what the application seeded itself
    python -m evals.tools.runner reset            # back to that baseline (truncate + restore), then verify it is clean
    python -m evals.tools.runner seed             # seed the fixtures (idempotent)
    python -m evals.tools.runner fresh            # reset + seed: the state every independent execution starts from

Every command first runs the guards in shared/evaluation/safety.py; none of them can act on a database that is not marked as
this environment's evaluation database.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from sqlmodel.ext.asyncio.session import AsyncSession

from shared.evaluation import environment as env_lib
from shared.evaluation import seeding
from shared.evaluation.safety import EvaluationGuardError, assert_evaluation_process, parse_database_url

ROOT = Path(os.environ.get("EVAL_WORK_DIR", "/work"))
FIXTURES = Path(os.environ.get("EVAL_FIXTURES", ROOT / "evals/datasets/individual-insurance/fixtures"))
EXTRAS = Path(os.environ.get("EVAL_EXTRAS", ROOT / "evals/environment/world-extras.json"))
OUTPUT = Path(os.environ.get("EVAL_OUTPUT", ROOT / "runs"))


def _password_hash() -> str:
    from passlib.context import CryptContext
    password = (os.environ.get("EVAL_USER_PASSWORD") or "").strip()
    if not password:
        raise EvaluationGuardError("EVAL_USER_PASSWORD is not set")
    return CryptContext(schemes=["bcrypt"], deprecated="auto").hash(password)


async def cmd_guard() -> int:
    assert_evaluation_process()
    host, name = parse_database_url(os.environ["DATABASE_URL"])
    engine = env_lib.evaluation_engine()
    async with engine.connect() as conn:
        marker = await env_lib.require_marker(conn)
    await engine.dispose()
    print(json.dumps({"guard": "ok", "database": f"{host}/{name}", "snapshot_taken_at": str(marker["snapshot_taken_at"]),
                      "snapshot_tables": len(marker["snapshot_tables"] or {})}, indent=1))
    return 0


async def cmd_snapshot(force: bool = False) -> int:
    engine = env_lib.evaluation_engine()
    async with engine.begin() as conn:
        from sqlalchemy import text
        tenants = (await conn.execute(text("select count(*) from tenants"))).scalar_one()
        if tenants and not force:
            raise EvaluationGuardError(f"{tenants} tenant(s) already exist: a baseline is taken before anything is seeded (use --force to replace it)")
        kept = await env_lib.snapshot(conn)
    await engine.dispose()
    print(f"baseline recorded: {len(kept)} tables with data, {sum(kept.values())} rows")
    return 0


async def cmd_reset() -> int:
    engine = env_lib.evaluation_engine()
    async with engine.begin() as conn:
        await env_lib.reset(conn)
    async with engine.connect() as conn:
        report = await env_lib.verify_clean(conn)
    await engine.dispose()
    print("reset: clean" if report.ok else "reset: NOT clean\n  " + "\n  ".join(report.problems))
    return 0 if report.ok else 1


async def cmd_seed() -> int:
    world = seeding.load_world(FIXTURES, EXTRAS)
    engine = env_lib.evaluation_engine()
    async with engine.connect() as conn:
        await env_lib.require_marker(conn)
    async with AsyncSession(engine, expire_on_commit=False) as session:
        report = await seeding.seed(session, world, password_hash=_password_hash())
        await session.commit()
    await engine.dispose()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "world-ids.json").write_text(json.dumps({"ids": report.ids, "canaries": world.canaries}, indent=1), encoding="utf-8")
    print("seeded: " + ", ".join(f"{k}={v}" for k, v in sorted(report.counts.items())))
    return 0


async def main(argv: list[str]) -> int:
    cmd = argv[0] if argv else "guard"
    try:
        if cmd == "guard":
            return await cmd_guard()
        if cmd == "snapshot":
            return await cmd_snapshot("--force" in argv)
        if cmd == "reset":
            return await cmd_reset()
        if cmd == "seed":
            return await cmd_seed()
        if cmd == "fresh":
            return await cmd_reset() or await cmd_seed()
    except (EvaluationGuardError, seeding.FixtureError) as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 3
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
