"""The ledger: appending, chaining, idempotency, concurrency, isolation, and what the database refuses."""
import asyncio
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

from app import db
from app.services import audit_service, chain_verifier, hash_chain
from tests.support import LedgerCase, TestDatabase, intent


class AppendTests(LedgerCase):
    async def test_first_event_links_to_genesis_and_every_hash_recomputes(self):
        tenant = uuid4()
        [result] = await audit_service.ingest([intent(tenant)])
        self.assertEqual((result.status, result.sequence_number), (audit_service.APPENDED, 1))
        chain_id = await self.chain_id(tenant)
        [event] = await self.fetch("SELECT * FROM events WHERE chain_id = :c", c=chain_id)
        self.assertEqual(event["previous_hash"], hash_chain.genesis_hash(chain_id))
        self.assertEqual(event["hash_version"], 1)
        self.assertEqual(event["current_hash"], hash_chain.compute_event_hash(chain_id, 1, event["previous_hash"], event))
        [head] = await self.fetch("SELECT * FROM chains WHERE chain_id = :c", c=chain_id)
        self.assertEqual((head["head_sequence"], head["head_hash"]), (1, event["current_hash"]))
        self.assertEqual(head["genesis_hash"], hash_chain.genesis_hash(chain_id))

    async def test_events_form_a_chain(self):
        tenant = uuid4()
        results = await audit_service.ingest([intent(tenant, n) for n in range(5)])
        self.assertEqual([r.sequence_number for r in results], [1, 2, 3, 4, 5])
        rows = await self.fetch("SELECT * FROM events WHERE tenant_id = :t ORDER BY sequence_number", t=tenant)
        for previous, row in zip(rows, rows[1:]):
            self.assertEqual(row["previous_hash"], previous["current_hash"])
        verdict = await chain_verifier.verify_chain(await self.chain_id(tenant))
        self.assertEqual((verdict.status, verdict.total_events_checked), ("VALID", 5))

    async def test_ledger_event_carries_every_required_field(self):
        tenant = uuid4()
        await audit_service.ingest([intent(tenant, 1, case_id="CASE-1", correlation_id="corr-1", previous_value={"a": 1})])
        [row] = await self.fetch("SELECT * FROM events WHERE tenant_id = :t", t=tenant)
        for column in ("event_id", "tenant_id", "environment_id", "chain_id", "sequence_number", "occurred_at", "actor_id",
                       "actor_type", "actor_role", "service_name", "action", "entity_type", "entity_id", "case_id",
                       "correlation_id", "source_event_id", "previous_value", "new_value", "outcome", "metadata",
                       "previous_hash", "current_hash", "hash_version"):
            self.assertIn(column, row.keys())
        self.assertEqual((row["case_id"], row["correlation_id"], row["previous_value"]), ("CASE-1", "corr-1", {"a": 1}))
        self.assertEqual(row["environment_id"], await self.environment_id())

    async def test_redelivery_of_the_same_intent_is_a_no_op(self):
        tenant = uuid4()
        once = intent(tenant, 1)
        [first] = await audit_service.ingest([once])
        [second] = await audit_service.ingest([once])
        self.assertEqual((first.status, second.status), (audit_service.APPENDED, audit_service.DUPLICATE))
        self.assertEqual((second.event_id, second.sequence_number, second.current_hash), (first.event_id, 1, first.current_hash))
        self.assertEqual(len(await self.fetch("SELECT 1 FROM events WHERE tenant_id = :t", t=tenant)), 1)

    async def test_duplicates_inside_one_batch_and_mixed_batches(self):
        tenant = uuid4()
        a, b = intent(tenant, 1), intent(tenant, 2)
        results = await audit_service.ingest([a, a, b])
        self.assertEqual([r.status for r in results], ["APPENDED", "DUPLICATE", "APPENDED"])
        self.assertEqual([r.sequence_number for r in results], [1, 1, 2])
        again = await audit_service.ingest([b, intent(tenant, 3), a])
        self.assertEqual([r.status for r in again], ["DUPLICATE", "APPENDED", "DUPLICATE"])
        self.assertEqual(again[1].sequence_number, 3)

    async def test_same_source_id_from_different_services_is_two_events(self):
        tenant = uuid4()
        a = intent(tenant, 1, source_service="svc-a", source_event_id="same")
        b = intent(tenant, 2, source_service="svc-b", source_event_id="same")
        results = await audit_service.ingest([a, b])
        self.assertEqual([r.status for r in results], ["APPENDED", "APPENDED"])

    async def test_concurrent_inserts_never_duplicate_or_skip_a_sequence(self):
        tenant = uuid4()
        results = await asyncio.gather(*(audit_service.ingest([intent(tenant, n) for n in range(i * 3, i * 3 + 3)]) for i in range(15)))
        sequences = sorted(r.sequence_number for batch in results for r in batch)
        self.assertEqual(sequences, list(range(1, 46)))
        verdict = await chain_verifier.verify_chain(await self.chain_id(tenant))
        self.assertEqual((verdict.status, verdict.total_events_checked), ("VALID", 45))

    async def test_concurrent_delivery_of_the_same_event_writes_it_once(self):
        tenant = uuid4()
        same = intent(tenant, 1)
        results = await asyncio.gather(*(audit_service.ingest([same]) for _ in range(12)))
        statuses = sorted(r[0].status for r in results)
        self.assertEqual(statuses, ["APPENDED"] + ["DUPLICATE"] * 11)
        self.assertEqual(len(await self.fetch("SELECT 1 FROM events WHERE tenant_id = :t", t=tenant)), 1)

    async def test_a_failed_transaction_leaves_no_gap(self):
        tenant = uuid4()
        await audit_service.ingest([intent(tenant, 1)])

        class Boom(Exception):
            pass

        with self.assertRaises(Boom):
            async with db.transaction() as conn:
                await audit_service.append_to_chain(conn, [intent(tenant, 2), intent(tenant, 3)])
                raise Boom()
        [after] = await audit_service.ingest([intent(tenant, 4)])
        self.assertEqual(after.sequence_number, 2)
        verdict = await chain_verifier.verify_chain(await self.chain_id(tenant))
        self.assertEqual((verdict.status, verdict.total_events_checked), ("VALID", 2))

    async def test_tenants_and_the_platform_have_separate_chains(self):
        a, b = uuid4(), uuid4()
        await audit_service.ingest([intent(a, 1), intent(a, 2), intent(b, 1), intent(None, 1, module="administration", action="tenant.created")])
        heads = {r["tenant_id"]: r for r in await self.fetch("SELECT * FROM chains")}
        self.assertEqual(heads[a]["head_sequence"], 2)
        self.assertEqual(heads[b]["head_sequence"], 1)
        self.assertEqual(heads[None]["scope"], "PLATFORM")
        self.assertEqual(heads[None]["chain_id"], await self.chain_id(None))
        self.assertEqual(len({heads[k]["genesis_hash"] for k in (a, b, None)}), 3)
        # An event for tenant A never lands in B's chain.
        rows = await self.fetch("SELECT chain_id, tenant_id FROM events")
        for row in rows:
            self.assertTrue(row["chain_id"].endswith(str(row["tenant_id"]) if row["tenant_id"] else "platform"))

    async def test_a_batch_for_several_tenants_is_split_per_chain(self):
        a, b = uuid4(), uuid4()
        results = await audit_service.ingest([intent(a, 1), intent(b, 1), intent(a, 2)])
        self.assertEqual([r.sequence_number for r in results], [1, 1, 2])
        self.assertEqual(results[0].chain_id, results[2].chain_id)
        self.assertNotEqual(results[0].chain_id, results[1].chain_id)

    async def test_source_id_reused_for_another_tenant_is_rejected_not_duplicated(self):
        a, b = uuid4(), uuid4()
        await audit_service.ingest([intent(a, 1, source_event_id="shared-id")])
        [result] = await audit_service.ingest([intent(b, 1, source_event_id="shared-id")])
        self.assertEqual((result.status, result.error_code), (audit_service.REJECTED, "SOURCE_EVENT_ID_REUSED"))
        self.assertEqual(await self.fetch("SELECT 1 FROM events WHERE tenant_id = :t", t=b), [])


class EnvironmentIdentityTests(LedgerCase):
    async def test_independently_initialised_databases_have_distinct_identities(self):
        tenant = uuid4()
        await audit_service.ingest([intent(tenant, 1)])
        mine_env, mine_chain = await self.environment_id(), await self.chain_id(tenant)
        [mine] = await self.fetch("SELECT current_hash, genesis_hash FROM events e JOIN chains c USING (chain_id) WHERE e.tenant_id = :t", t=tenant)

        other = TestDatabase()
        await other.create()
        try:
            engine = create_async_engine(other.app_url, connect_args={"server_settings": {"search_path": "audit"}})
            async with engine.connect() as conn:
                other_env = (await conn.execute(text("SELECT environment_id FROM environment"))).scalar_one()
            await engine.dispose()
            await db.dispose()
            db.configure(other.app_url)
            await audit_service.ingest([intent(tenant, 1)])  # the same tenant id and content, in another database
            other_chain = f"{other_env}:{tenant}"
            [theirs] = await self.fetch("SELECT current_hash, genesis_hash FROM events e JOIN chains c USING (chain_id) WHERE e.tenant_id = :t", t=tenant)
        finally:
            await db.dispose()
            db.configure(self.database.app_url)
            await other.drop()
        self.assertNotEqual(mine_env, other_env)
        self.assertNotEqual(mine_chain, other_chain)
        self.assertNotEqual(mine["genesis_hash"], theirs["genesis_hash"])
        self.assertNotEqual(mine["current_hash"], theirs["current_hash"])

    async def test_the_environment_cannot_be_changed(self):
        with self.assertRaises(DBAPIError):
            async with self.owner.begin() as conn:
                await conn.execute(text("UPDATE environment SET environment_id = gen_random_uuid()"))


class DatabaseProtectionTests(LedgerCase):
    """What the database itself refuses, even to code that bypasses the service."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.tenant = uuid4()
        await audit_service.ingest([intent(self.tenant, n) for n in range(3)])
        self.chain = await self.chain_id(self.tenant)

    async def refused(self, sql: str, **params):
        with self.assertRaises(DBAPIError) as ctx:
            async with db.transaction() as conn:
                await conn.execute(text(sql), params)
        return str(ctx.exception.orig)

    async def test_application_role_cannot_update_or_delete_or_truncate_events(self):
        for sql in ("UPDATE events SET action = 'x'", "DELETE FROM events", "TRUNCATE events"):
            with self.subTest(sql=sql):
                self.assertIn("permission denied", await self.refused(sql))
        self.assertEqual(len(await self.fetch("SELECT 1 FROM events WHERE chain_id = :c", c=self.chain)), 3)

    async def test_application_role_cannot_touch_chains_or_history_or_ddl(self):
        for sql in ("UPDATE chains SET head_sequence = 0", "DELETE FROM chains", "INSERT INTO chains (chain_id) VALUES ('x')",
                    "UPDATE verification_runs SET status = 'VALID'", "DELETE FROM dead_letters", "UPDATE environment SET singleton = true",
                    "DROP TABLE events", "ALTER TABLE events DISABLE TRIGGER USER", "CREATE TABLE audit.x (a int)"):
            with self.subTest(sql=sql):
                message = (await self.refused(sql)).lower()
                self.assertTrue("denied" in message or "must be owner" in message, message)

    async def test_even_the_schema_owner_cannot_change_records_without_disabling_the_triggers(self):
        for sql in ("UPDATE events SET action = 'x'", "DELETE FROM events", "TRUNCATE events",
                    "UPDATE chains SET head_sequence = 99", "DELETE FROM chains"):
            with self.subTest(sql=sql):
                with self.assertRaises(DBAPIError) as ctx:
                    async with self.owner.begin() as conn:
                        await conn.execute(text(sql))
                self.assertIn("append-only" if "chains SET" not in sql else "advance", str(ctx.exception.orig))

    async def test_a_forged_event_with_a_sequence_gap_is_refused(self):
        message = await self._forge(sequence=7)
        self.assertIn("not the next sequence", message)

    async def test_a_forged_event_with_a_wrong_previous_hash_is_refused(self):
        message = await self._forge(sequence=4, previous_hash="0" * 64)
        self.assertIn("previous_hash", message)

    async def test_a_forged_duplicate_sequence_is_refused(self):
        message = await self._forge(sequence=3)
        self.assertIn("not the next sequence", message)

    async def test_an_event_for_another_tenant_cannot_enter_this_chain(self):
        head = (await self.fetch("SELECT head_hash FROM chains WHERE chain_id = :c", c=self.chain))[0]["head_hash"]
        message = await self._forge(sequence=4, previous_hash=head, tenant_id=uuid4())
        self.assertIn("tenant or environment mismatch", message)

    async def test_an_event_for_another_environment_cannot_enter_this_chain(self):
        head = (await self.fetch("SELECT head_hash FROM chains WHERE chain_id = :c", c=self.chain))[0]["head_hash"]
        message = await self._forge(sequence=4, previous_hash=head, environment_id=uuid4())
        self.assertIn("tenant or environment mismatch", message)

    async def test_ensure_chain_derives_identity_from_the_environment(self):
        async with db.transaction() as conn:
            self.assertEqual((await conn.execute(text("SELECT ensure_chain(CAST(:t AS uuid))"), {"t": self.tenant})).scalar_one(), self.chain)

    async def _forge(self, *, sequence: int, previous_hash: str | None = None, tenant_id: UUID | None = None,
                     environment_id: UUID | None = None) -> str:
        """Insert an event by hand as the application role, the way code that bypasses the service would."""
        head = (await self.fetch("SELECT head_hash FROM chains WHERE chain_id = :c", c=self.chain))[0]["head_hash"]
        with self.assertRaises(DBAPIError) as ctx:
            async with db.transaction() as conn:
                await conn.execute(text("SELECT * FROM lock_chain(:c)"), {"c": self.chain})
                await conn.execute(text("""
                    INSERT INTO events (event_id, chain_id, sequence_number, tenant_id, environment_id, occurred_at, recorded_at,
                        actor_type, service_name, module, action, entity_type, source_event_id, outcome, previous_hash, current_hash, hash_version)
                    VALUES (gen_random_uuid(), :c, :s, :t, :e, now(), now(), 'USER', 'forger', 'm', 'a', 'e', gen_random_uuid()::text,
                            'SUCCESS', :p, :h, 1)"""),
                    {"c": self.chain, "s": sequence, "t": tenant_id or self.tenant, "e": environment_id or await self.environment_id(),
                     "p": previous_hash or head, "h": "f" * 64})
        return str(ctx.exception.orig)

    async def test_a_chain_cannot_be_created_with_a_forged_genesis(self):
        env = await self.environment_id()
        with self.assertRaises(DBAPIError) as ctx:
            async with self.owner.begin() as conn:
                await conn.execute(text("""INSERT INTO chains (chain_id, scope, tenant_id, environment_id, genesis_hash, head_sequence, head_hash)
                    VALUES (:c, 'TENANT', :t, :e, :g, 0, :g)"""), {"c": f"{env}:{(t := uuid4())}", "t": t, "e": env, "g": "a" * 64})
        self.assertIn("genesis", str(ctx.exception.orig))
