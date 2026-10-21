import os, unittest, json
from uuid import uuid4
from unittest.mock import patch
import httpx
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine
import main, migrate, provision
from shared.audit.outbox import OutboxRelay
from shared.audit.schema import AuditIntent

TABLE = 'customer_service.audit_outbox'


class FakePublisher:
 def __init__(self): self.sent = []
 async def publish(self, key, value): self.sent.append((key, value))


class TicketAudit(unittest.IsolatedAsyncioTestCase):
 """Every ticket event is mirrored by an audit intent committed in the same transaction; ticket text is never copied."""
 async def asyncSetUp(self):
  self.db = 'cs_test_' + uuid4().hex[:10]
  admin_url = make_url(os.environ.get('CS_TEST_ADMIN_URL') or make_url(os.environ['CS_DATABASE_URL']).set(username=os.environ.get('POSTGRES_USER', 'postgres'), password=os.environ.get('POSTGRES_PASSWORD', '')).render_as_string(hide_password=False))
  self.admin = create_async_engine(admin_url, isolation_level='AUTOCOMMIT')
  async with self.admin.connect() as c: await c.execute(text('CREATE DATABASE ' + self.db))
  test_admin = admin_url.set(database=self.db).render_as_string(hide_password=False)
  with patch.dict(os.environ, {'CS_PROVISION_DATABASE_URL': test_admin}): await provision.main()
  owner = admin_url.set(database=self.db, username='customer_service_owner', password=os.environ['CS_DB_OWNER_PASSWORD']).render_as_string(hide_password=False)
  with patch.dict(os.environ, {'CS_MIGRATION_DATABASE_URL': owner}): await migrate.run()
  main.engine = create_async_engine(admin_url.set(database=self.db, username='customer_service_app', password=os.environ['CS_DB_APP_PASSWORD']))
  self.tenant = uuid4()
  self.user = {'id': str(uuid4()), 'tenant_id': str(self.tenant), 'role_name': 'Agent', 'staff': False, 'can_work': False, 'full_name': 'Ayesha Agent', 'email': 'ayesha@example.test', 'token': 'Bearer test'}
  main.app.dependency_overrides[main.identity] = lambda: self.user
  self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test')
 async def asyncTearDown(self):
  main.app.dependency_overrides.clear()
  await self.client.aclose(); await main.engine.dispose()
  async with self.admin.connect() as c: await c.execute(text('DROP DATABASE ' + self.db + ' WITH (FORCE)'))
  await self.admin.dispose()
 async def intents(self):
  async with main.engine.begin() as c: rows = (await c.execute(text(f'SELECT payload FROM {TABLE} ORDER BY created_at, id'))).all()
  return [AuditIntent.model_validate(r[0]) for r in rows]
 async def ticket(self):
  r = await self.client.post('/v1/tickets', json={'title': 'Claim enquiry', 'description': 'My CNIC 35202-1234567-1 is wrong on the policy', 'idempotency_key': str(uuid4())})
  self.assertEqual(r.status_code, 200, r.text); return r.json()

 async def test_the_ticket_lifecycle_is_audited_without_copying_ticket_text(self):
  t = await self.ticket()
  self.user.update(staff=True, can_work=True, role_name='CustomerService', full_name='Sana Service')
  await self.client.post(f"/v1/tickets/{t['id']}/assignment", json={'version': 1, 'user_id': self.user['id']})
  await self.client.post(f"/v1/tickets/{t['id']}/comments", json={'body': 'Secret internal note about the customer', 'internal': True})
  await self.client.post(f"/v1/tickets/{t['id']}/status", json={'version': 2, 'status': 'IN_PROGRESS', 'reason': 'Starting work on it'})
  await self.client.post(f"/v1/tickets/{t['id']}/status", json={'version': 3, 'status': 'RESOLVED', 'reason': 'Fixed the CNIC on the policy'})
  intents = await self.intents()
  self.assertEqual([i.action for i in intents], ['ticket.created', 'ticket.assigned', 'ticket.note_added', 'ticket.in_progress', 'ticket.resolved'])
  created, assigned, note, started, resolved = intents
  self.assertEqual((created.module, created.entity_type, created.entity_id, created.tenant_id, created.actor_role, created.source_service),
                   ('customer_service', 'ticket', t['id'], self.tenant, 'Agent', 'customer-service'))
  self.assertEqual((assigned.actor_role, assigned.metadata['actor_name']), ('CustomerService', 'Sana Service'))
  self.assertEqual((resolved.previous_value, resolved.new_value), ({'status': 'IN_PROGRESS'}, {'status': 'RESOLVED'}))
  self.assertEqual((note.metadata['internal'], note.metadata['body_length']), (True, len('Secret internal note about the customer')))
  wire = json.dumps([i.model_dump(mode='json') for i in intents])
  for text_ in ('Secret internal note', '35202-1234567-1', 'Fixed the CNIC', 'Starting work'):
   self.assertNotIn(text_, wire)

 async def test_a_customer_acting_through_the_portal_is_a_customer_actor(self):
  self.user.update(role_name='Customer')
  await self.ticket()
  [created] = await self.intents()
  self.assertEqual((created.actor_type, created.actor_role), ('CUSTOMER', 'Customer'))

 async def test_an_idempotent_replay_does_not_audit_twice(self):
  payload = {'title': 'Same enquiry', 'description': 'Please explain policy servicing', 'idempotency_key': str(uuid4())}
  for _ in range(3): self.assertEqual((await self.client.post('/v1/tickets', json=payload)).status_code, 200)
  self.assertEqual([i.action for i in await self.intents()], ['ticket.created'])

 async def test_a_rejected_change_leaves_no_audit_intent(self):
  t = await self.ticket()
  r = await self.client.post(f"/v1/tickets/{t['id']}/status", json={'version': 1, 'status': 'RESOLVED', 'reason': 'Invalid transition from open'})
  self.assertEqual(r.status_code, 409)
  self.assertEqual([i.action for i in await self.intents()], ['ticket.created'])

 async def test_other_tenants_intents_carry_their_own_tenant(self):
  await self.ticket()
  other = uuid4(); self.user.update(tenant_id=str(other), id=str(uuid4()))
  await self.ticket()
  self.assertEqual(sorted(str(i.tenant_id) for i in await self.intents()), sorted([str(self.tenant), str(other)]))

 async def test_intents_reach_the_relay_and_the_app_role_cannot_rewrite_events(self):
  await self.ticket()
  publisher = FakePublisher()
  relay = OutboxRelay(main.engine.begin, publisher, table=TABLE)
  self.assertEqual(await relay.relay_once(), 1)
  self.assertEqual((await relay.stats())['pending'], 0)
  self.assertEqual(json.loads(publisher.sent[0][1])['action'], 'ticket.created')
  with self.assertRaises(Exception):
   async with main.engine.begin() as c: await c.execute(text('UPDATE customer_service.events SET kind = \'X\''))
