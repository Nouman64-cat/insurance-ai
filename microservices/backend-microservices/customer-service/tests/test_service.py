import os, unittest
from uuid import uuid4
from unittest.mock import patch
import httpx
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine
import main, migrate, provision

async def await_ticket(client, payload):
 body=dict(payload); key=body.pop('idempotency_key')
 return await client.post('/v1/tickets',json=body,headers={'Idempotency-Key':key})

class Tickets(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.db='cs_test_'+uuid4().hex[:10]
  admin_url=make_url(os.environ.get('CS_TEST_ADMIN_URL') or make_url(os.environ['CS_DATABASE_URL']).set(username=os.environ.get('POSTGRES_USER','postgres'),password=os.environ.get('POSTGRES_PASSWORD','')).render_as_string(hide_password=False))
  self.admin=create_async_engine(admin_url,isolation_level='AUTOCOMMIT')
  async with self.admin.connect() as c: await c.execute(text('CREATE DATABASE '+self.db))
  test_admin=admin_url.set(database=self.db).render_as_string(hide_password=False)
  with patch.dict(os.environ,{'CS_PROVISION_DATABASE_URL':test_admin}): await provision.main()
  owner=admin_url.set(database=self.db,username='customer_service_owner',password=os.environ['CS_DB_OWNER_PASSWORD']).render_as_string(hide_password=False)
  with patch.dict(os.environ,{'CS_MIGRATION_DATABASE_URL':owner}): await migrate.run()
  app_url=admin_url.set(database=self.db,username='customer_service_app',password=os.environ['CS_DB_APP_PASSWORD'])
  main.engine=create_async_engine(app_url)
  self.user={'id':str(uuid4()),'tenant_id':str(uuid4()),'role_name':'Agent','staff':False,'can_work':False,'full_name':'Test agent','email':'test@example.test','token':'Bearer test'}
  main.app.dependency_overrides[main.identity]=lambda:self.user
  self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url='http://test')
 async def asyncTearDown(self):
  main.app.dependency_overrides.clear()
  await self.client.aclose();await main.engine.dispose()
  async with self.admin.connect() as c: await c.execute(text('DROP DATABASE '+self.db+' WITH (FORCE)'))
  await self.admin.dispose()
 async def ticket(self):
  self.payload={'title':'Test enquiry','description':'Please explain policy servicing','idempotency_key':str(uuid4())}
  r=await await_ticket(self.client, self.payload);self.assertEqual(r.status_code,200,r.text);return r.json()
 async def test_header_is_required_and_payload_key_is_not_accepted(self):
  body={'title':'Header test','description':'A valid ticket description'}
  self.assertEqual((await self.client.post('/v1/tickets',json=body)).status_code,400)
  self.assertEqual((await self.client.post('/v1/tickets',json=body,headers={'Idempotency-Key':'bad'})).status_code,400)
  key=str(uuid4())
  first=await self.client.post('/v1/tickets',json=body,headers={'Idempotency-Key':key})
  self.assertEqual(first.status_code,200,first.text)
  other=await self.client.post('/v1/tickets',json=body,headers={'Idempotency-Key':str(uuid4())})
  self.assertNotEqual(first.json()['id'],other.json()['id'])
  self.assertEqual((await self.client.post('/v1/tickets',json={**body,'idempotency_key':key},headers={'Idempotency-Key':key})).status_code,422)

 async def test_idempotency_and_payload_conflict(self):
  t=await self.ticket();r=await await_ticket(self.client, self.payload);self.assertEqual(t['id'],r.json()['id'])
  self.payload['title']='Different enquiry';self.assertEqual((await await_ticket(self.client, self.payload)).status_code,409)
 async def test_tenant_and_requester_isolation(self):
  t=await self.ticket();self.user['id']=str(uuid4())
  self.assertEqual((await self.client.get('/v1/tickets/'+t['id'])).status_code,404)
  self.assertEqual((await self.client.get('/v1/tickets')).json()['total'],0)
  self.user.update(staff=True,can_work=True,tenant_id=str(uuid4()),role_name='CustomerService')
  self.assertEqual((await self.client.get('/v1/tickets/'+t['id'])).status_code,404)
 async def test_internal_notes_and_staff_actions(self):
  t=await self.ticket();id=t['id'];r=await self.client.post(f'/v1/tickets/{id}/comments',json={'body':'Private note','internal':True});self.assertEqual(r.status_code,403)
  self.user.update(staff=True,can_work=True,role_name='CustomerService')
  self.assertEqual((await self.client.post(f'/v1/tickets/{id}/comments',json={'body':'Private note','internal':True})).status_code,200)
  self.user.update(staff=False,can_work=False,role_name='Agent')
  self.assertEqual(len((await self.client.get('/v1/tickets/'+id)).json()['events']),1)
  self.assertEqual((await self.client.post(f'/v1/tickets/{id}/status',json={'version':1,'status':'IN_PROGRESS','reason':'Starting work'})).status_code,403)
 async def test_status_version_resolution_reopen(self):
  t=await self.ticket();id=t['id'];self.user.update(staff=True,can_work=True,role_name='CustomerService')
  self.assertEqual((await self.client.post(f'/v1/tickets/{id}/status',json={'version':1,'status':'RESOLVED','reason':'Done already'})).status_code,409)
  for version,status in [(1,'IN_PROGRESS'),(2,'RESOLVED'),(3,'CLOSED')]:
   self.assertEqual((await self.client.post(f'/v1/tickets/{id}/status',json={'version':version,'status':status,'reason':'Resolved the enquiry'})).status_code,200)
  self.assertEqual((await self.client.post(f'/v1/tickets/{id}/status',json={'version':1,'status':'IN_PROGRESS','reason':'Stale change'})).status_code,409)
  self.user.update(staff=False,can_work=False,role_name='Agent')
  self.assertEqual((await self.client.post(f'/v1/tickets/{id}/status',json={'version':4,'status':'IN_PROGRESS','reason':'Problem still exists'})).status_code,200)
 async def test_claim_and_forbid_other_assignee(self):
  t=await self.ticket();id=t['id'];payload={'version':1,'user_id':self.user['id']}
  self.assertEqual((await self.client.post(f'/v1/tickets/{id}/assignment',json=payload)).status_code,403)
  self.user.update(staff=True,can_work=True,role_name='CustomerService')
  self.assertEqual((await self.client.post(f'/v1/tickets/{id}/assignment',json=payload)).status_code,200)
  payload.update(version=2,user_id=str(uuid4()))
  self.assertEqual((await self.client.post(f'/v1/tickets/{id}/assignment',json=payload)).status_code,403)
 async def test_inaccessible_customer_rejected(self):
  from unittest.mock import AsyncMock
  payload={'title':'Linked enquiry','description':'Review the customer record','customer_id':str(uuid4()),'idempotency_key':str(uuid4())}
  client=AsyncMock();client.get.return_value=httpx.Response(403)
  with patch('main.httpx.AsyncClient') as factory:
   factory.return_value.__aenter__.return_value=client
   self.assertEqual((await await_ticket(self.client, payload)).status_code,422)
  self.assertEqual((await self.client.get('/v1/tickets')).json()['total'],0)
 async def test_demo_seed_is_guarded_and_idempotent(self):
  self.user.update(staff=True,can_work=True,role_name='Admin')
  with patch.dict(os.environ,{'ENV_VAR':'production'}):
   self.assertEqual((await self.client.post('/v1/demo/seed')).status_code,404)
  with patch.dict(os.environ,{'ENV_VAR':'demo'}):
   self.assertEqual((await self.client.post('/v1/demo/seed')).json()['created'],8)
   self.assertEqual((await self.client.post('/v1/demo/seed')).json()['created'],0)
   self.user.update(staff=False,can_work=False,role_name='Agent')
   self.assertEqual((await self.client.post('/v1/demo/seed')).status_code,403)
 async def test_no_auth_and_database_audit_protection(self):
  main.app.dependency_overrides.clear()
  self.assertEqual((await self.client.get('/v1/tickets')).status_code,401)
  async with main.engine.connect() as c:
   self.assertFalse((await c.execute(text("SELECT has_table_privilege(current_user,'customer_service.events','DELETE')"))).scalar())
   self.assertFalse((await c.execute(text("SELECT has_table_privilege(current_user,'customer_service.events','UPDATE')"))).scalar())

 async def make(self,title,priority='NORMAL'):
  r=await await_ticket(self.client, {'title':title,'description':'Please look into this one','priority':priority,'idempotency_key':str(uuid4())});self.assertEqual(r.status_code,200,r.text);return r.json()
 async def test_views_and_summary_tell_the_desk_what_needs_a_person(self):
  self.user.update(staff=True,can_work=True,role_name='CustomerService')
  a=await self.make('Late one','URGENT');b=await self.make('Taken one');c=await self.make('Waiting one');d=await self.make('Done one')
  async with main.engine.begin() as conn:                                      # make "Late one" overdue without waiting for the clock
   await conn.execute(text("UPDATE customer_service.tickets SET due_at=now()-interval '2 hours' WHERE id=:i"),{'i':a['id']})
  v=lambda q:self.client.get('/v1/tickets?'+q)
  r=await self.client.post(f"/v1/tickets/{b['id']}/assignment",json={'version':b['version'],'user_id':self.user['id']});self.assertEqual(r.status_code,200,r.text)
  for t,steps in ((c,['IN_PROGRESS','WAITING_CUSTOMER']),(d,['IN_PROGRESS','RESOLVED'])):
   ver=t['version']
   for st in steps:
    r=await self.client.post(f"/v1/tickets/{t['id']}/status",json={'version':ver,'status':st,'reason':'moving it along'});self.assertEqual(r.status_code,200,r.text);ver+=1
  titles=lambda r:[x['title'] for x in r.json()['items']]
  self.assertEqual(sorted(titles(await v('view=active'))),['Late one','Taken one','Waiting one'])
  self.assertEqual(titles(await v('view=overdue')),['Late one'])
  self.assertEqual(sorted(titles(await v('view=unassigned'))),['Late one','Waiting one'])
  self.assertEqual(titles(await v('view=mine')),['Taken one'])
  self.assertEqual(titles(await v('view=waiting')),['Waiting one'])
  self.assertEqual(titles(await v('view=finished')),['Done one'])
  self.assertEqual((await v('view=active')).json()['items'][0]['title'],'Late one')      # the late one leads
  self.assertEqual((await v('view=bogus')).status_code,422)
  s=(await self.client.get('/v1/tickets/summary')).json()
  self.assertEqual((s['active'],s['overdue'],s['unassigned'],s['mine'],s['waiting'],s['finished'],s['total']),(3,1,2,1,1,1,4))
 async def test_a_requester_only_counts_their_own_tickets(self):
  await self.make('Mine')
  other=dict(self.user);self.user['id']=str(uuid4())                              # someone else in the same tenant (not staff)
  await self.make('Theirs')
  s=(await self.client.get('/v1/tickets/summary')).json();self.assertEqual(s['total'],1)
  self.user.update(staff=True,can_work=True,role_name='CustomerService');self.assertEqual((await self.client.get('/v1/tickets/summary')).json()['total'],2)


 # customers of the customer portal ---------------------------------------------------------------
 def signed(self,method,path,body=None,key=None,customer=None,tenant=None):
  import json,sys
  sys.path.insert(0,'/app/shared_copy') if False else None
  import hashlib,hmac,time
  operation_key=body.get('idempotency_key') if body else None
  body={k:v for k,v in body.items() if k!='idempotency_key'} if body is not None else None
  data=json.dumps(body).encode() if body is not None else b''
  ts=str(int(time.time()));key=key if key is not None else os.environ['CS_PORTAL_KEY']
  sig=hmac.new(key.encode(),f"{ts}\n{method}\n{path}\n{hashlib.sha256(data).hexdigest()}".encode(),hashlib.sha256).hexdigest()
  h={'x-service-signature':sig,'x-service-timestamp':ts,'x-service-caller':'customer-management','x-portal-tenant':tenant or self.tenant,'x-portal-customer':customer or self.cust,'x-portal-name':'Sana Customer','content-type':'application/json'}
  if operation_key: h['Idempotency-Key']=operation_key
  from shared.security.service_auth import sign
  context={k:v for k,v in h.items() if k.startswith('x-portal-') or k=='Idempotency-Key'}
  h.update(sign(key,method,path,data,caller='customer-management',bound_headers=context))
  return self.client.request(method,path,content=data,headers=h)
 async def test_portal_customer_tickets(self):
  os.environ.setdefault('CS_PORTAL_KEY','k'*32);self.tenant=str(uuid4());self.cust=str(uuid4());B='/internal/v1/portal/tickets'
  body={'title':'Address change','description':'Please update my address on file','category':'POLICY_SERVICING','idempotency_key':str(uuid4())}
  self.assertEqual((await self.signed('POST',B,body,key='wrong')).status_code,401)
  r=await self.signed('POST',B,body);self.assertEqual(r.status_code,200,r.text);t=r.json()
  self.assertEqual((t['priority'],str(t['customer_id']),t['requester_name']),('NORMAL',self.cust,'Sana Customer'))
  self.assertEqual((await self.signed('POST',B,body)).json()['id'],t['id'])                      # idempotent
  self.assertEqual((await self.signed('POST',B,{**body,'priority':'URGENT'})).status_code,422)   # priority is not the customer's to set
  self.assertEqual(len((await self.signed('GET',B)).json()['items']),1)
  self.assertEqual((await self.signed('GET',B,customer=str(uuid4()))).json()['items'],[])        # another customer sees nothing
  self.assertEqual((await self.signed('GET',f'{B}/{t["id"]}',customer=str(uuid4()))).status_code,404)
  self.assertEqual((await self.signed('GET',f'{B}/{t["id"]}',tenant=str(uuid4()))).status_code,404)
  # staff reply + internal note; the customer sees the reply only
  self.user.update(staff=True,can_work=True,role_name='CustomerService',tenant_id=self.tenant)
  await self.client.post(f'/v1/tickets/{t["id"]}/comments',json={'body':'Secret staff note','internal':True})
  await self.client.post(f'/v1/tickets/{t["id"]}/comments',json={'body':'We have updated it','internal':False})
  d=(await self.signed('GET',f'{B}/{t["id"]}')).json();bodies=[e['body'] for e in d['events']]
  self.assertIn('We have updated it',bodies);self.assertNotIn('Secret staff note',bodies);self.assertNotIn('internal',d['events'][0])
  self.assertEqual((await self.signed('POST',f'{B}/{t["id"]}/reply',{'body':'Thank you'})).status_code,200)
  self.assertEqual((await self.signed('POST',f'{B}/{t["id"]}/reply',{'body':'x','internal':True})).status_code,422)
  self.assertEqual((await self.signed('POST',f'{B}/{t["id"]}/withdraw',{})).status_code,200)       # still OPEN: may be withdrawn
  self.assertEqual((await self.signed('GET',f'{B}/{t["id"]}')).json()['status'],'CANCELLED')


 async def test_admin_can_view_but_not_work_tickets(self):
  t=await self.ticket();id=t['id'];self.user.update(staff=True,can_work=False,role_name='Admin',tenant_id=self.user['tenant_id'],id=str(uuid4()))
  self.assertEqual((await self.client.get('/v1/tickets/'+id)).status_code,200)
  self.assertEqual((await self.client.get('/v1/tickets')).json()['total'],1)
  self.assertEqual((await self.client.get('/v1/tickets/summary')).status_code,200)
  self.assertEqual((await self.client.post(f'/v1/tickets/{id}/comments',json={'body':'Admin reply'})).status_code,403)
  self.assertEqual((await self.client.post(f'/v1/tickets/{id}/comments',json={'body':'Admin note','internal':True})).status_code,403)
  self.assertEqual((await self.client.post(f'/v1/tickets/{id}/assignment',json={'version':1,'user_id':self.user['id']})).status_code,403)
  self.assertEqual((await self.client.post(f'/v1/tickets/{id}/status',json={'version':1,'status':'IN_PROGRESS','reason':'Admin starts it'})).status_code,403)
 async def test_open_desk_acts_as_one_fixed_tenant_and_only_when_switched_on(self):
  main.app.dependency_overrides.clear()
  tenant=str(uuid4());h={'x-open-desk':'1'}
  with patch.object(main,'OPEN_DESK',False):
   self.assertEqual((await self.client.get('/v1/tickets',headers=h)).status_code,401)                       # off: no way in without signing in
  with patch.object(main,'OPEN_DESK',True),patch.object(main,'OPEN_TENANT',tenant):
   self.assertEqual((await self.client.get('/v1/tickets')).status_code,401)                                 # needs the open-desk header
   # Keep this auth-path test independent of a live tenant-service's availability.
   from unittest.mock import AsyncMock
   with patch('main.httpx.AsyncClient') as auth_client:
    auth_client.return_value.__aenter__.return_value.get = AsyncMock(return_value=httpx.Response(401))
    self.assertEqual((await self.client.get('/v1/tickets',headers={**h,'authorization':'Bearer x'})).status_code,401)
   me=(await self.client.get('/v1/me',headers=h)).json();self.assertEqual((me['role_name'],me['tenant_id'],me['can_work']),('ServiceDesk',tenant,True))
   # a customer's ticket in that tenant, then the desk works it; another tenant's ticket stays invisible
   cust=str(uuid4());other=str(uuid4())
   body={'title':'Portal question','description':'Where is my receipt please','idempotency_key':str(uuid4())}
   async with main.engine.begin() as c:
    for t_,n in ((tenant,'mine'),(other,'theirs')):
     await main.insert_ticket(main.Create(**{k:v for k,v in body.items() if k!='idempotency_key'}),{'id':cust,'tenant_id':t_,'full_name':n,'email':n},uuid4())
   items=(await self.client.get('/v1/tickets',headers=h)).json()['items'];self.assertEqual([i['requester_name'] for i in items],['mine'])
   i=items[0];ok=await self.client.post(f"/v1/tickets/{i['id']}/assignment",json={'version':i['version'],'user_id':str(main.OPEN_ACTOR)},headers=h);self.assertEqual(ok.status_code,200,ok.text)
   self.assertEqual((await self.client.post(f"/v1/tickets/{i['id']}/comments",json={'body':'Sent it to you'},headers=h)).status_code,200)

class IdentityChecks(unittest.IsolatedAsyncioTestCase):
 async def test_verified_identity_and_spoofing(self):
  from starlette.requests import Request
  from unittest.mock import AsyncMock
  from fastapi import HTTPException
  def req(tenant):
   return Request({'type':'http','headers':[(b'authorization',b'Bearer test-token'),(b'x-tenant-id',tenant.encode())]})
  user={'id':str(uuid4()),'tenant_id':str(uuid4()),'is_active':True,'status':'ACTIVE','role_name':'Agent'}
  client=AsyncMock();client.get.return_value=httpx.Response(200,json=user)
  with patch('main.httpx.AsyncClient') as factory:
   factory.return_value.__aenter__.return_value=client
   identity=await main.identity(req(user['tenant_id']))
   self.assertFalse(identity['staff'])
   with self.assertRaises(HTTPException) as err:await main.identity(req(str(uuid4())))
   self.assertEqual(err.exception.status_code,403)
   user['is_active']=False;client.get.return_value=httpx.Response(200,json=user)
   with self.assertRaises(HTTPException) as err:await main.identity(req(user['tenant_id']))
   self.assertEqual(err.exception.status_code,403)
   client.get.return_value=httpx.Response(500)
   with self.assertRaises(HTTPException) as err:await main.identity(req(user['tenant_id']))
   self.assertEqual(err.exception.status_code,503)

if __name__=="__main__": unittest.main()
