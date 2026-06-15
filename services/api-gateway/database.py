"""
Async SQLModel / SQLAlchemy engine and session factory.

The engine is module-level so it is created once per process.
`get_session` is the FastAPI dependency injected into every route that
needs a database connection.  `create_db_and_tables` is called inside the
app's lifespan to ensure tables exist before the first request arrives.
"""

import os

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

# Falls back to the Docker-Compose service name so the container works
# without a local .env file during development.
DATABASE_URL: str = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://insurance:insurance_secret@postgres:5432/insurance_db",
)

engine = create_async_engine(
    DATABASE_URL,
    echo=False,     # set True temporarily if you want to see generated SQL
    future=True,
)

_session_factory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def create_db_and_tables() -> None:
    """
    Create all tables declared in shared.models if they do not already exist.
    The import here is intentional: it registers the SQLModel metadata before
    SQLAlchemy's `create_all` runs.
    """
    import shared.models.core  # noqa: F401 — side-effect: registers metadata

    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)


async def get_session():
    """FastAPI dependency that yields a single async session per request."""
    async with _session_factory() as session:
        yield session
