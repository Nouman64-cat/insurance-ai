import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from graph import build_graph
from tool_executor import close_shared_client


def _psycopg_conn_string(database_url: str) -> str:
    # The rest of the platform uses SQLAlchemy's asyncpg driver
    # (postgresql+asyncpg://...); langgraph-checkpoint-postgres talks to the
    # same database directly via psycopg, which needs the plain scheme.
    return database_url.replace("postgresql+asyncpg://", "postgresql://")


@asynccontextmanager
async def lifespan(app: FastAPI):
    conn_string = _psycopg_conn_string(os.environ["DATABASE_URL"])
    # A POOL, not the single shared connection `from_conn_string` gives. Chat requests overlap — a streaming turn, the
    # mount-time "is this thread paused?" check, a regenerate reading the checkpoint history — and on one connection
    # they collided with "another command is already in progress", which stopped a reply dead. Same settings the
    # saver's own helper uses (autocommit, no prepared statements, dict rows).
    pool = AsyncConnectionPool(
        conninfo=conn_string, min_size=1, max_size=int(os.environ.get("CHAT_DB_POOL_SIZE", "10")), open=False,
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
    )
    await pool.open()
    try:
        saver = AsyncPostgresSaver(pool)
        await saver.setup()
        app.state.graph = build_graph(saver)
        try:
            yield
        finally:
            # The pooled HTTP client outlives individual requests, so close it
            # here rather than leaking its connections on shutdown.
            await close_shared_client()
    finally:
        await pool.close()


app = FastAPI(title="Chat Agent", version="0.1.0", lifespan=lifespan)

from routers.chat import router as chat_router  # noqa: E402

app.include_router(chat_router)


@app.get("/health")
async def health_check():
    return {"service": "chat-agent", "status": "healthy"}
