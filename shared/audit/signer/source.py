"""Read-only access to the ledger for the signer: it re-reads the chain itself instead of trusting the caller's claims."""
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


class Snapshot:
    """One REPEATABLE READ view, so head and events are consistent even while events are being appended."""

    def __init__(self, conn):
        self.conn = conn

    async def chain(self, chain_id: str):
        return (await self.conn.execute(text(
            "SELECT chain_id, scope, tenant_id, environment_id, genesis_hash, head_sequence, head_hash FROM chains WHERE chain_id = :c"),
            {"c": chain_id})).mappings().first()

    async def event(self, chain_id: str, sequence: int):
        return (await self.conn.execute(text("SELECT * FROM events WHERE chain_id = :c AND sequence_number = :s"),
                                        {"c": chain_id, "s": sequence})).mappings().first()

    async def events(self, chain_id: str, after: int, until: int, batch: int = 1000) -> AsyncIterator:
        cursor = after
        while cursor < until:
            rows = (await self.conn.execute(text(
                "SELECT * FROM events WHERE chain_id = :c AND sequence_number > :a AND sequence_number <= :u ORDER BY sequence_number LIMIT :n"),
                {"c": chain_id, "a": cursor, "u": until, "n": batch})).mappings().all()
            if not rows:
                return
            for row in rows:
                yield row
            cursor = rows[-1]["sequence_number"]


class DbEventSource:
    def __init__(self, url: str, schema: str = "audit"):
        self.url, self.schema = url, schema
        self._engine: Optional[AsyncEngine] = None

    def engine(self) -> AsyncEngine:
        if self._engine is None:
            if not self.url:
                raise RuntimeError("AUDIT_SIGNER_DATABASE_URL is not set")
            self._engine = create_async_engine(self.url, pool_pre_ping=True, pool_size=3,
                                               connect_args={"server_settings": {"search_path": self.schema, "application_name": "audit-signer"}})
        return self._engine

    async def environment_id(self) -> str:
        async with self.engine().connect() as conn:
            return str((await conn.execute(text("SELECT environment_id FROM environment"))).scalar_one())

    @asynccontextmanager
    async def snapshot(self):
        async with self.engine().connect() as conn:
            await conn.execution_options(isolation_level="REPEATABLE READ", postgresql_readonly=True)
            yield Snapshot(conn)

    async def dispose(self) -> None:
        if self._engine is not None:
            await self._engine.dispose()
            self._engine = None
