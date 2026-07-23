import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from graph import build_graph


def _psycopg_conn_string(database_url: str) -> str:
    # The rest of the platform uses SQLAlchemy's asyncpg driver
    # (postgresql+asyncpg://...); langgraph-checkpoint-postgres talks to the
    # same database directly via psycopg, which needs the plain scheme.
    return database_url.replace("postgresql+asyncpg://", "postgresql://")


@asynccontextmanager
async def lifespan(app: FastAPI):
    conn_string = _psycopg_conn_string(os.environ["DATABASE_URL"])
    async with AsyncPostgresSaver.from_conn_string(conn_string) as saver:
        await saver.setup()
        app.state.graph = build_graph(saver)
        yield


app = FastAPI(title="Chat Agent", version="0.1.0", lifespan=lifespan)

from routers.chat import router as chat_router  # noqa: E402

app.include_router(chat_router)


@app.get("/health")
async def health_check():
    return {"service": "chat-agent", "status": "healthy"}
