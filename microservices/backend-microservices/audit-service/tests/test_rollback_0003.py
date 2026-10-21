"""The documented rollback of the partition migration really works: same rows, same hashes, same chain, Stage 1 guards back, grants re-applied."""
from pathlib import Path
from uuid import uuid4

import asyncpg

from app import db, migrate
from app.services import audit_service, chain_verifier
from tests.support import LedgerCase, SCHEMA, intent

SCRIPT = Path(__file__).resolve().parents[1] / "migrations" / "rollback" / "0003_unpartition_events.sql"


class RollbackTests(LedgerCase):
    per_test_database = True

    async def test_rollback_restores_a_single_table_with_every_event_and_a_valid_chain(self):
        tenant = uuid4()
        await audit_service.ingest([intent(tenant, i) for i in range(40)])
        chain = await self.chain_id(tenant)
        before = await self.fetch("SELECT event_id, sequence_number, previous_hash, current_hash FROM events WHERE chain_id = :c ORDER BY sequence_number", c=chain)
        self.assertEqual((await self.fetch("SELECT relkind::text AS relkind FROM pg_class WHERE relname = 'events' AND relnamespace = 'audit'::regnamespace"))[0]["relkind"], "p")

        conn = await asyncpg.connect(self.database.owner_url.replace("postgresql+asyncpg", "postgresql"))
        try:
            await conn.execute(SCRIPT.read_text())
        finally:
            await conn.close()
        await migrate.run(self.database.owner_url, SCHEMA)      # what the next service start does: re-apply the role grants

        self.assertEqual((await self.fetch("SELECT relkind::text AS relkind FROM pg_class WHERE relname = 'events' AND relnamespace = 'audit'::regnamespace"))[0]["relkind"], "r")
        after = await self.fetch("SELECT event_id, sequence_number, previous_hash, current_hash FROM events WHERE chain_id = :c ORDER BY sequence_number", c=chain)
        self.assertEqual(before, after)
        result = await chain_verifier.verify_chain(chain)
        self.assertEqual(result.status, chain_verifier.VALID)
        # Stage 1 guards are back: a duplicate (service, source id) and an update are refused by the table itself
        with self.assertRaises(Exception):
            async with self.owner.begin() as c:
                from sqlalchemy import text
                await c.execute(text("UPDATE events SET outcome = 'FAILURE' WHERE chain_id = :c"), {"c": chain})
