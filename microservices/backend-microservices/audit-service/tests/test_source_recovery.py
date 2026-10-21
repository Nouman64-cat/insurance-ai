"""Recovery preserves the original event and fails safely without changing the ledger."""
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from app.services import audit_service, query_service, source_recovery
from shared.audit.schema import AuditIntent


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tenant = uuid4()
        self.env = uuid4()
        self.now = datetime.now(timezone.utc)
        self.intent = AuditIntent(source_service="tenant-service", source_event_id="source-1",
                                  tenant_id=self.tenant, action="policy.updated", module="policies",
                                  entity_type="policy", previous_value={"status": "draft"},
                                  new_value={"status": "active"}, metadata={"actor_name": "Test actor"})
        self.original = audit_service._record(self.intent, env=self.env, chain_id="chain", sequence=2,
                                             previous_hash="a" * 64, recorded_at=self.now)

    async def query(self, record=None, scope=None):
        source = SimpleNamespace(**self.original)
        chain = SimpleNamespace(tenant_id=self.tenant, environment_id=self.env, genesis_hash="0" * 64)
        before = SimpleNamespace(event_id=uuid4(), sequence_number=1, current_hash="a" * 64,
                                 previous_hash="0" * 64, action="policy.created")
        after = SimpleNamespace(event_id=uuid4(), sequence_number=3, current_hash="b" * 64,
                                previous_hash=self.original["current_hash"], action="policy.updated")
        conn = AsyncMock()
        conn.execute.side_effect = [SimpleNamespace(first=lambda value=value: value)
                                   for value in (chain, None, source, before, after)]
        found = {"record": record, "partition": 2, "offset": 3887} if record else None
        with patch.object(source_recovery, "recover", AsyncMock(return_value=found)) as recover:
            result = await query_service.get_missing_event(conn, "chain", 2, scope or query_service.Scope(unrestricted=True))
        return result, recover

    async def test_rebuild_matches_original_hash_and_all_details(self):
        rebuilt = source_recovery.rebuild(self.intent, event_id=self.original["event_id"],
                                         environment_id=self.env, chain_id="chain", sequence=2,
                                         previous_hash="a" * 64, recorded_at=self.now)
        self.assertEqual(rebuilt, self.original)
        result, _ = await self.query(rebuilt)
        self.assertTrue(result["recovered"]["hash_verified"])
        self.assertFalse(result["present"])
        self.assertEqual(result["recovered"]["event"]["new_value"], {"status": "active"})
        self.assertEqual(result["recovered"]["event"]["actor_name"], "Test actor")

    async def test_mismatch_is_not_verified(self):
        result, _ = await self.query({**self.original, "current_hash": "f" * 64})
        self.assertFalse(result["recovered"]["hash_verified"])

    async def test_unavailable_source_keeps_surviving_record(self):
        result, _ = await self.query()
        self.assertIsNone(result["recovered"])
        self.assertEqual(result["recorded"]["event_id"], str(self.original["event_id"]))

    async def test_other_tenant_cannot_trigger_recovery(self):
        result, recover = await self.query(self.original, query_service.Scope(tenant_id=uuid4()))
        self.assertIsNone(result)
        recover.assert_not_awaited()

    async def test_source_with_wrong_tenant_is_withheld(self):
        result, _ = await self.query({**self.original, "tenant_id": uuid4()})
        self.assertIsNone(result["recovered"])

    async def test_broker_failure_is_best_effort(self):
        with patch.object(source_recovery, "_find_message", AsyncMock(side_effect=TimeoutError)):
            result = await source_recovery.recover(source_service="tenant-service", source_event_id="source-1",
                recorded_at=self.now, event_id=self.original["event_id"], environment_id=self.env,
                chain_id="chain", sequence=2, previous_hash="a" * 64)
        self.assertIsNone(result)
