"""Results owned exclusively by docs-forgery. No migrations or cross-schema reads at runtime."""
import json
import os
from contextlib import asynccontextmanager
from uuid import UUID, uuid4
import asyncpg
from fastapi import HTTPException
from database_settings import runtime_dsn

_pool = None
TABLE = "docs_forgery.document_intelligence_results"
FIELDS = "id,filename,sha256,size_bytes,status,verdict,created_by,created_at,completed_at,error"


def dsn():
    try:
        return runtime_dsn()
    except ValueError as exc:
        raise HTTPException(503,str(exc)) from exc


async def _codec(connection):
    await connection.set_type_codec("jsonb", schema="pg_catalog", encoder=json.dumps, decoder=json.loads)


async def initialize():
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(dsn(), min_size=1, max_size=5, init=_codec, command_timeout=15,
                                         server_settings={"search_path":"docs_forgery,pg_catalog"})
    async with _pool.acquire() as connection:
        # Startup checks only; a separate, explicit provisioning job owns DDL.
        await connection.fetchval(f"SELECT count(*) FROM {TABLE} WHERE false")


async def close():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def connection(tenant_id):
    if _pool is None:
        raise HTTPException(503, "Document result storage is unavailable")
    async with _pool.acquire() as conn:
        async with conn.transaction():
            # Transaction-local context is cleared before a pooled connection is reused.
            await conn.execute("SELECT set_config('app.tenant_id',$1,true)", str(UUID(str(tenant_id))))
            yield conn


async def create(tenant_id, actor_id, filename, digest, size, options):
    async with connection(tenant_id) as conn:
        row = await conn.fetchrow(f"INSERT INTO {TABLE} (id,tenant_id,created_by,filename,sha256,size_bytes,options) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING {FIELDS}",
                                 uuid4(),tenant_id,actor_id,filename,digest,size,options)
    return dict(row)


async def finish(tenant_id, result_id, report=None, error=None):
    status = "failed" if error is not None else "incomplete" if report.get("incomplete") or report["verdict"] == "inconclusive" else "completed"
    async with connection(tenant_id) as conn:
        row = await conn.fetchrow(f"UPDATE {TABLE} SET status=$1,verdict=$2,report=$3,error=$4,completed_at=timezone('utc',now()) WHERE id=$5 AND tenant_id=$6 RETURNING {FIELDS},options,report",
                                 status, report.get("verdict") if report else None, report, error, result_id, tenant_id)
    if row is None: raise HTTPException(404,"Analysis not found")
    return dict(row)


async def listing(tenant_id, offset=0, limit=20):
    async with connection(tenant_id) as conn:
        count = await conn.fetchval(f"SELECT count(*) FROM {TABLE} WHERE tenant_id=$1",tenant_id)
        rows = await conn.fetch(f"SELECT {FIELDS} FROM {TABLE} WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC OFFSET $2 LIMIT $3",tenant_id,offset,limit)
    return {"items":[dict(row) for row in rows],"total":count,"offset":offset,"limit":limit}


async def get(tenant_id, result_id):
    async with connection(tenant_id) as conn:
        row = await conn.fetchrow(f"SELECT {FIELDS},options,report FROM {TABLE} WHERE tenant_id=$1 AND id=$2",tenant_id,result_id)
    if row is None: raise HTTPException(404,"Analysis not found")
    return dict(row)
