"""Database access. The engine is created lazily so tests can point it at a disposable database."""
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from app.config import settings

_engine: Optional[AsyncEngine] = None


def configure(url: str, schema: str = settings.schema) -> AsyncEngine:
    """(Re)create the engine. Every connection uses the service's schema only."""
    global _engine
    _engine = create_async_engine(
        url,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=10,
        connect_args={"server_settings": {"search_path": schema, "application_name": "audit-service"}},
    )
    return _engine


def engine() -> AsyncEngine:
    if _engine is None:
        if not settings.database_url:
            raise RuntimeError("AUDIT_DATABASE_URL is not set")
        configure(settings.database_url)
    return _engine  # type: ignore[return-value]


@asynccontextmanager
async def transaction() -> AsyncIterator[AsyncConnection]:
    """One database transaction: committed on success, rolled back on any exception."""
    async with engine().begin() as conn:
        yield conn


async def dispose() -> None:
    global _engine
    if _engine is not None:
        await _engine.dispose()
        _engine = None
