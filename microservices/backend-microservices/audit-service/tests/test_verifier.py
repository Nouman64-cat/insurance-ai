"""Chain verification: a sound chain verifies; every kind of tampering is caught, with the first bad sequence."""
import asyncio
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app import db
from app.services import audit_service, chain_verifier as cv, hash_chain
from tests.support import LedgerCase, intent


class VerifierCase(LedgerCase):
    N = 6

    async def chain(self, n: int | None = None):
        """A new tenant with n events; returns (tenant_id, chain_id)."""
        tenant = uuid4()
        await audit_service.ingest([intent(tenant, i) for i in range(n or self.N)])
        return tenant, await self.chain_id(tenant)

    async def verdict(self, chain_id: str, **kw):
        return await cv.verify_chain(chain_id, **kw)

    def assertInvalid(self, result, reason: str, sequence: int):
        self.assertEqual((result.status, result.reason, result.first_invalid_sequence), ("INVALID", reason, sequence), result.details)


class ValidChainTests(VerifierCase):
    async def test_sound_chain_is_valid(self):
        _, chain = await self.chain()
        r = await self.verdict(chain)
        self.assertEqual((r.status, r.total_events_checked, r.first_invalid_sequence, r.reason), ("VALID", 6, None, None))
        self.assertTrue(r.head_checked)
        self.assertEqual(r.calculated_hash, r.stored_head_hash)

    async def test_result_has_the_documented_shape(self):
        tenant, chain = await self.chain(3)
        api = (await self.verdict(chain)).to_api()
        self.assertEqual({k: api[k] for k in ("tenant_id", "chain_id", "status", "total_events_checked", "first_invalid_sequence", "reason")},
                         {"tenant_id": str(tenant), "chain_id": chain, "status": "VALID", "total_events_checked": 3,
                          "first_invalid_sequence": None, "reason": None})

    async def test_empty_chain_is_valid(self):
        tenant = uuid4()
        async with db.transaction() as conn:
            await conn.execute(text("SELECT ensure_chain(CAST(:t AS uuid))"), {"t": tenant})
        r = await self.verdict(await self.chain_id(tenant))
        self.assertEqual((r.status, r.total_events_checked), ("VALID", 0))

    async def test_unknown_chain(self):
        self.assertInvalid(await self.verdict("nope"), cv.CHAIN_NOT_FOUND, None)

    async def test_small_batches_cover_the_whole_chain(self):
        _, chain = await self.chain(7)
        r = await self.verdict(chain, batch_size=2)
        self.assertEqual((r.status, r.total_events_checked), ("VALID", 7))

    async def test_appends_during_verification_do_not_cause_a_false_alarm(self):
        tenant, chain = await self.chain(20)

        async def keep_appending():
            for n in range(20, 40):
                await audit_service.ingest([intent(tenant, n)])

        verdicts, _ = await asyncio.gather(asyncio.gather(*(self.verdict(chain, batch_size=3) for _ in range(5))), keep_appending())
        self.assertTrue(all(v.status == "VALID" for v in verdicts), [(v.reason, v.details) for v in verdicts])
        self.assertEqual((await self.verdict(chain)).total_events_checked, 40)


class TamperingTests(VerifierCase):
    async def test_modified_event_content(self):
        for column, value in (("new_value", '{"status": "Hacked"}'), ("metadata", '{"x": 1}'), ("actor_id", "'mallory'"),
                              ("outcome", "'FAILURE'"), ("occurred_at", "now()"), ("entity_id", "'POL-X'")):
            with self.subTest(column=column):
                _, chain = await self.chain()
                literal = f"'{value}'::jsonb" if column in ("new_value", "metadata") else value
                async with self.privileged() as conn:
                    await conn.execute(text(f"UPDATE events SET {column} = {literal} WHERE chain_id = :c AND sequence_number = 3"), {"c": chain})
                r = await self.verdict(chain)
                self.assertInvalid(r, cv.EVENT_HASH_MISMATCH, 3)
                self.assertEqual(r.total_events_checked, 2)
                self.assertNotEqual(r.details["stored_hash"], r.details["calculated_hash"])

    async def test_deleted_event_in_the_middle(self):
        _, chain = await self.chain()
        async with self.privileged() as conn:
            await conn.execute(text("DELETE FROM events WHERE chain_id = :c AND sequence_number = 3"), {"c": chain})
        r = await self.verdict(chain)
        self.assertInvalid(r, cv.SEQUENCE_GAP, 3)
        self.assertEqual((r.details["expected_sequence"], r.details["found_sequence"]), (3, 4))

    async def test_deleted_first_event(self):
        _, chain = await self.chain()
        async with self.privileged() as conn:
            await conn.execute(text("DELETE FROM events WHERE chain_id = :c AND sequence_number = 1"), {"c": chain})
        self.assertInvalid(await self.verdict(chain), cv.SEQUENCE_GAP, 1)

    async def test_deleted_last_event_is_caught_by_the_chain_head(self):
        _, chain = await self.chain()
        async with self.privileged() as conn:
            await conn.execute(text("DELETE FROM events WHERE chain_id = :c AND sequence_number = 6"), {"c": chain})
        r = await self.verdict(chain)
        self.assertInvalid(r, cv.CHAIN_HEAD_SEQUENCE_MISMATCH, 6)
        self.assertEqual((r.details["last_verified_sequence"], r.details["stored_head_sequence"]), (5, 6))

    async def test_all_events_deleted(self):
        _, chain = await self.chain(3)
        async with self.privileged() as conn:
            await conn.execute(text("DELETE FROM events WHERE chain_id = :c"), {"c": chain})
        self.assertInvalid(await self.verdict(chain), cv.CHAIN_HEAD_SEQUENCE_MISMATCH, 1)

    async def test_reordered_events(self):
        _, chain = await self.chain()
        async with self.privileged() as conn:
            for new, old in ((1000, 3), (3, 4), (4, 1000)):
                await conn.execute(text("UPDATE events SET sequence_number = :n WHERE chain_id = :c AND sequence_number = :o"),
                                   {"n": new, "c": chain, "o": old})
        r = await self.verdict(chain)
        self.assertInvalid(r, cv.EVENTS_REORDERED, 3)
        self.assertEqual(r.details["references_sequence"], 4)

    async def test_a_forged_extra_event_beyond_the_head(self):
        _, chain = await self.chain(3)
        async with self.privileged() as conn:
            row = (await conn.execute(text("SELECT * FROM events WHERE chain_id = :c AND sequence_number = 3"), {"c": chain})).mappings().one()
            forged = dict(row, event_id=uuid4(), sequence_number=4, source_event_id="forged", previous_hash=row["current_hash"])
            forged["current_hash"] = hash_chain.compute_event_hash(chain, 4, row["current_hash"], forged)
            await conn.execute(text("""INSERT INTO events SELECT * FROM jsonb_populate_record(NULL::events, CAST(:j AS jsonb))"""),
                               {"j": __import__("json").dumps(forged, default=str)})
        self.assertInvalid(await self.verdict(chain), cv.CHAIN_HEAD_SEQUENCE_MISMATCH, 4)

    async def test_chain_head_hash_changed(self):
        _, chain = await self.chain()
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE chains SET head_hash = repeat('a', 64) WHERE chain_id = :c"), {"c": chain})
        self.assertInvalid(await self.verdict(chain), cv.CHAIN_HEAD_HASH_MISMATCH, 6)

    async def test_chain_head_sequence_changed(self):
        for head in (4, 9):
            with self.subTest(head=head):
                _, chain = await self.chain()
                async with self.privileged() as conn:
                    await conn.execute(text("UPDATE chains SET head_sequence = :h WHERE chain_id = :c"), {"h": head, "c": chain})
                r = await self.verdict(chain)
                self.assertEqual((r.status, r.reason), ("INVALID", cv.CHAIN_HEAD_SEQUENCE_MISMATCH))
                self.assertEqual(r.first_invalid_sequence, min(6, head) + 1)

    async def test_modified_event_with_its_own_hash_recomputed_breaks_the_next_link(self):
        _, chain = await self.chain()
        async with self.privileged() as conn:
            row = (await conn.execute(text("SELECT * FROM events WHERE chain_id = :c AND sequence_number = 3"), {"c": chain})).mappings().one()
            forged = dict(row, new_value={"status": "Hacked"})
            new_hash = hash_chain.compute_event_hash(chain, 3, row["previous_hash"], forged)
            await conn.execute(text("UPDATE events SET new_value = CAST(:v AS jsonb), current_hash = :h WHERE event_id = :e"),
                               {"v": '{"status": "Hacked"}', "h": new_hash, "e": row["event_id"]})
        r = await self.verdict(chain)
        self.assertInvalid(r, cv.PREVIOUS_HASH_MISMATCH, 4)
        self.assertEqual(r.total_events_checked, 3)

    async def test_the_first_violation_is_the_one_reported(self):
        _, chain = await self.chain()
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET action = 'x' WHERE chain_id = :c AND sequence_number IN (2, 5)"), {"c": chain})
        self.assertInvalid(await self.verdict(chain), cv.EVENT_HASH_MISMATCH, 2)

    async def test_changed_genesis_link(self):
        _, chain = await self.chain()
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET previous_hash = repeat('b', 64) WHERE chain_id = :c AND sequence_number = 1"), {"c": chain})
        self.assertInvalid(await self.verdict(chain), cv.GENESIS_MISMATCH, 1)

    async def test_changed_chain_genesis_record(self):
        _, chain = await self.chain()
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE chains SET genesis_hash = repeat('c', 64) WHERE chain_id = :c"), {"c": chain})
        self.assertInvalid(await self.verdict(chain), cv.GENESIS_MISMATCH, 0)

    async def test_event_of_another_tenant_inside_a_chain(self):
        _, chain = await self.chain()
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET tenant_id = :t WHERE chain_id = :c AND sequence_number = 4"), {"t": uuid4(), "c": chain})
        self.assertInvalid(await self.verdict(chain), cv.TENANT_MISMATCH, 4)

    async def test_tampering_one_tenant_does_not_affect_another(self):
        _, bad = await self.chain()
        _, good = await self.chain()
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET action = 'x' WHERE chain_id = :c AND sequence_number = 2"), {"c": bad})
        self.assertEqual((await self.verdict(bad)).status, "INVALID")
        self.assertEqual((await self.verdict(good)).status, "VALID")

    async def test_documented_limit_a_complete_rewrite_by_a_privileged_attacker_is_not_detected(self):
        """SHA-256 chaining alone cannot stop someone who can rewrite every event AND the chain head. This test pins
        that limit so it stays documented; Stage 2 (signed checkpoints held outside the database) closes it."""
        _, chain = await self.chain(4)
        async with self.privileged() as conn:
            rows = (await conn.execute(text("SELECT * FROM events WHERE chain_id = :c ORDER BY sequence_number"), {"c": chain})).mappings().all()
            previous = hash_chain.genesis_hash(chain)
            for row in rows:
                forged = dict(row, new_value={"status": "Rewritten"}, previous_hash=previous)
                current = hash_chain.compute_event_hash(chain, row["sequence_number"], previous, forged)
                await conn.execute(text("UPDATE events SET new_value = CAST(:v AS jsonb), previous_hash = :p, current_hash = :h WHERE event_id = :e"),
                                   {"v": '{"status": "Rewritten"}', "p": previous, "h": current, "e": row["event_id"]})
                previous = current
            await conn.execute(text("UPDATE chains SET head_hash = :h WHERE chain_id = :c"), {"h": previous, "c": chain})
        self.assertEqual((await self.verdict(chain)).status, "VALID")


class RangeTests(VerifierCase):
    async def test_bounded_range_with_trusted_starting_hash(self):
        _, chain = await self.chain()
        trusted = (await self.fetch("SELECT current_hash FROM events WHERE chain_id = :c AND sequence_number = 2", c=chain))[0]["current_hash"]
        r = await self.verdict(chain, from_sequence=3, to_sequence=5, trusted_previous_hash=trusted)
        self.assertEqual((r.status, r.total_events_checked, r.head_checked), ("VALID", 3, False))

    async def test_range_to_the_end_checks_the_head(self):
        _, chain = await self.chain()
        trusted = (await self.fetch("SELECT current_hash FROM events WHERE chain_id = :c AND sequence_number = 4", c=chain))[0]["current_hash"]
        r = await self.verdict(chain, from_sequence=5, trusted_previous_hash=trusted)
        self.assertEqual((r.status, r.total_events_checked, r.head_checked), ("VALID", 2, True))

    async def test_a_range_needs_a_trusted_starting_hash(self):
        _, chain = await self.chain()
        with self.assertRaises(ValueError):
            await self.verdict(chain, from_sequence=3)
        with self.assertRaises(ValueError):
            await self.verdict(chain, from_sequence=3, to_sequence=2, trusted_previous_hash="a" * 64)

    async def test_a_wrong_trusted_hash_is_a_violation(self):
        _, chain = await self.chain()
        self.assertInvalid(await self.verdict(chain, from_sequence=3, trusted_previous_hash="d" * 64), cv.PREVIOUS_HASH_MISMATCH, 3)

    async def test_tampering_outside_the_range_is_outside_its_scope(self):
        _, chain = await self.chain()
        trusted = (await self.fetch("SELECT current_hash FROM events WHERE chain_id = :c AND sequence_number = 2", c=chain))[0]["current_hash"]
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET action = 'x' WHERE chain_id = :c AND sequence_number = 1"), {"c": chain})
        self.assertEqual((await self.verdict(chain, from_sequence=3, to_sequence=4, trusted_previous_hash=trusted)).status, "VALID")
        self.assertInvalid(await self.verdict(chain), cv.EVENT_HASH_MISMATCH, 1)

    async def test_tampering_inside_the_range_is_caught(self):
        _, chain = await self.chain()
        trusted = (await self.fetch("SELECT current_hash FROM events WHERE chain_id = :c AND sequence_number = 2", c=chain))[0]["current_hash"]
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET action = 'x' WHERE chain_id = :c AND sequence_number = 4"), {"c": chain})
        self.assertInvalid(await self.verdict(chain, from_sequence=3, to_sequence=5, trusted_previous_hash=trusted), cv.EVENT_HASH_MISMATCH, 4)


class HistoryTests(VerifierCase):
    async def test_runs_are_recorded_and_cannot_be_changed(self):
        _, chain = await self.chain(3)
        result = await self.verdict(chain)
        run_id = await cv.record_run(result, "ON_DEMAND", "tester")
        [row] = await self.fetch("SELECT * FROM verification_runs WHERE run_id = :r", r=run_id)
        self.assertEqual((row["status"], row["total_events_checked"], row["trigger"], row["requested_by"]), ("VALID", 3, "ON_DEMAND", "tester"))
        for sql in ("UPDATE verification_runs SET status = 'VALID'", "DELETE FROM verification_runs"):
            with self.assertRaises(DBAPIError):
                async with db.transaction() as conn:
                    await conn.execute(text(sql))

    async def test_scheduled_verification_flags_a_tampered_chain(self):
        _, good = await self.chain(3)
        _, bad = await self.chain(3)
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET action = 'x' WHERE chain_id = :c AND sequence_number = 2"), {"c": bad})
        results = {r.chain_id: r for r in await cv.verify_all("SCHEDULED")}
        self.assertEqual((results[good].status, results[bad].status), ("VALID", "INVALID"))
        [row] = await self.fetch("SELECT status, reason, first_invalid_sequence, trigger FROM verification_runs WHERE chain_id = :c", c=bad)
        self.assertEqual((row["status"], row["reason"], row["first_invalid_sequence"], row["trigger"]), ("INVALID", "EVENT_HASH_MISMATCH", 2, "SCHEDULED"))

    async def test_the_scheduler_loop_verifies_every_chain_and_records_it(self):
        _, good = await self.chain(3)
        _, bad = await self.chain(3)
        async with self.privileged() as conn:
            await conn.execute(text("UPDATE events SET action = 'x' WHERE chain_id = :c AND sequence_number = 2"), {"c": bad})
        stop = asyncio.Event()
        saved = (cv.settings.verify_initial_delay_seconds, cv.settings.verify_interval_seconds)
        object.__setattr__(cv.settings, "verify_initial_delay_seconds", 0.05)
        object.__setattr__(cv.settings, "verify_interval_seconds", 3600)
        try:
            task = asyncio.create_task(cv.scheduler(stop))
            for _ in range(100):
                rows = await self.fetch("SELECT chain_id, status FROM verification_runs WHERE trigger = 'SCHEDULED'")
                if {r["chain_id"] for r in rows} >= {good, bad}:
                    break
                await asyncio.sleep(0.1)
            stop.set()
            await asyncio.wait_for(task, timeout=5)
        finally:
            object.__setattr__(cv.settings, "verify_initial_delay_seconds", saved[0])
            object.__setattr__(cv.settings, "verify_interval_seconds", saved[1])
        statuses = {r["chain_id"]: r["status"] for r in await self.fetch("SELECT chain_id, status FROM verification_runs WHERE trigger = 'SCHEDULED'")}
        self.assertEqual((statuses[good], statuses[bad]), ("VALID", "INVALID"))
