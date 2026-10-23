"""The evaluation database: provisioning marker, snapshot of what the application seeded itself, and reset.

Why a snapshot and not "empty every table": the application seeds its own reference data when it starts (the system roles, the
early-knockout and screening rule sets, the initial-premium split rule). A reset that emptied those would silently change what
the system under test does (an early check with no rule set answers "proceed"). So, right after a clean start, `snapshot`
copies every non-empty table into the private schema `eval_snapshot`; `reset` truncates everything and restores exactly that.
The fixtures are then seeded again by shared/evaluation/seeding.py.

Every function here first runs the guards in safety.py and the marker check below, so none of them can touch a database that
was not provisioned as an evaluation database by this environment (the marker holds a token that only eval.env knows).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from shared.evaluation.safety import EvaluationGuardError, assert_evaluation_process

MARKER = "eval_environment_marker"
SNAPSHOT_SCHEMA = "eval_snapshot"


def evaluation_engine(env=None) -> AsyncEngine:
    """An engine on the evaluation database, created only after every guard passes."""
    env = os.environ if env is None else env
    assert_evaluation_process(env)
    return create_async_engine(env["DATABASE_URL"], future=True)


def _token(env=None) -> str:
    token = ((os.environ if env is None else env).get("EVAL_MARKER_TOKEN") or "").strip()
    if not token:
        raise EvaluationGuardError("EVAL_MARKER_TOKEN is not set: this process does not belong to the evaluation environment")
    return token


async def _tables(conn: AsyncConnection) -> List[str]:
    rows = await conn.execute(text("select tablename from pg_tables where schemaname = 'public' order by tablename"))
    return [r[0] for r in rows if r[0] != MARKER]


async def require_marker(conn: AsyncConnection, env=None) -> Dict[str, object]:
    """The database carries this environment's marker. Raises if there is none or the token differs."""
    exists = (await conn.execute(text("select to_regclass(:t)"), {"t": f"public.{MARKER}"})).scalar()
    if exists is None:
        raise EvaluationGuardError("this database has no evaluation marker: it was not provisioned as an evaluation database")
    row = (await conn.execute(text(f"select token, snapshot_taken_at, snapshot_tables from {MARKER} where id = 1"))).first()
    if row is None or row[0] != _token(env):
        raise EvaluationGuardError("the evaluation marker does not match this environment's token")
    return {"snapshot_taken_at": row[1], "snapshot_tables": row[2]}


async def snapshot(conn: AsyncConnection, env=None) -> Dict[str, int]:
    """Provision: write the marker, then copy every non-empty table into eval_snapshot. Run once, on a freshly started stack
    that nothing has been seeded into. Running it again replaces the snapshot (and so makes the current data the new baseline)."""
    token = _token(env)
    await conn.execute(text(f"create table if not exists {MARKER} (id int primary key, token text not null, "
                            "snapshot_taken_at timestamptz, snapshot_tables jsonb)"))
    existing = (await conn.execute(text(f"select token from {MARKER} where id = 1"))).scalar()
    if existing is not None and existing != token:
        raise EvaluationGuardError("the evaluation marker belongs to a different environment")
    await conn.execute(text(f"drop schema if exists {SNAPSHOT_SCHEMA} cascade"))
    await conn.execute(text(f"create schema {SNAPSHOT_SCHEMA}"))
    kept: Dict[str, int] = {}
    for table in await _tables(conn):
        count = (await conn.execute(text(f'select count(*) from public."{table}"'))).scalar_one()
        if count:
            await conn.execute(text(f'create table {SNAPSHOT_SCHEMA}."{table}" as table public."{table}"'))
            kept[table] = count
    await conn.execute(text(f"insert into {MARKER} (id, token, snapshot_taken_at, snapshot_tables) values (1, :t, now(), cast(:j as jsonb)) "
                            "on conflict (id) do update set snapshot_taken_at = now(), snapshot_tables = excluded.snapshot_tables"),
                       {"t": token, "j": __import__("json").dumps(kept)})
    return kept


async def reset(conn: AsyncConnection, env=None) -> Dict[str, int]:
    """Back to the provisioned baseline: everything truncated, then the snapshot restored. Fixtures are not seeded here."""
    marker = await require_marker(conn, env)
    kept: Dict[str, int] = marker["snapshot_tables"] or {}
    if marker["snapshot_taken_at"] is None:
        raise EvaluationGuardError("no snapshot has been taken: run `snapshot` on a freshly started stack first")
    tables = await _tables(conn)
    await conn.execute(text("set local session_replication_role = replica"))        # the restore order need not follow the foreign keys
    await conn.execute(text("truncate table " + ", ".join(f'public."{t}"' for t in tables)))
    for table in kept:
        await conn.execute(text(f'insert into public."{table}" select * from {SNAPSHOT_SCHEMA}."{table}"'))
    return kept


@dataclass
class CleanReport:
    ok: bool
    problems: List[str] = field(default_factory=list)


async def verify_clean(conn: AsyncConnection, env=None) -> CleanReport:
    """After a reset, every table holds exactly what the snapshot recorded and nothing else."""
    marker = await require_marker(conn, env)
    kept: Dict[str, int] = marker["snapshot_tables"] or {}
    problems = []
    for table in await _tables(conn):
        count = (await conn.execute(text(f'select count(*) from public."{table}"'))).scalar_one()
        if count != kept.get(table, 0):
            problems.append(f"{table}: {count} rows, the baseline has {kept.get(table, 0)}")
    return CleanReport(ok=not problems, problems=problems)
