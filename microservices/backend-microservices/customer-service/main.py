"""Tenant-isolated customer service tickets. Domain records remain in tenant-service."""
import os, json
from uuid import UUID, uuid4
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from typing import Literal
import httpx
from fastapi import FastAPI, Depends, HTTPException, Request, Query
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
import migrate
import re, asyncio
from shared.idempotency.http import required_uuid_header
from shared.audit.context import CorrelationContextMiddleware
from shared.audit.outbox import KafkaPublisher as AuditPublisher, OutboxRelay, build_intent, enqueue

# Who works tickets (reply, assign, change status) and who may only look. Admin sees every ticket but does not work them: the service
# desk does. 'ServiceDesk' is the shared actor of the open desk (see below).
WORKERS=frozenset({'CustomerService','ClaimsManager','ServiceDesk'})
STAFF=WORKERS|{'Admin'}
SUPERVISORS=frozenset({'ClaimsManager','ServiceDesk'})
SUBMIT=frozenset({'Admin','CustomerService','ClaimsManager','ClaimsAdjuster','Underwriter','Agent','Broker'})
TRANSITIONS={'OPEN':{'IN_PROGRESS','CANCELLED'},'IN_PROGRESS':{'WAITING_CUSTOMER','RESOLVED','CANCELLED'},'WAITING_CUSTOMER':{'IN_PROGRESS','RESOLVED','CANCELLED'},'RESOLVED':{'CLOSED','IN_PROGRESS'},'CLOSED':{'IN_PROGRESS'},'CANCELLED':set()}
engine=None
@asynccontextmanager
async def lifespan(app):
    global engine
    if OPEN_DESK and (os.environ.get('CS_ENV','').lower()=='production' or not OPEN_TENANT): raise RuntimeError('CS_OPEN_DESK needs CS_OPEN_DESK_TENANT_ID and is refused when CS_ENV=production')
    if os.environ.get('CS_RUN_MIGRATIONS','true')=='true' and os.environ.get('CS_MIGRATION_DATABASE_URL'): await migrate.run()
    engine=create_async_engine(os.environ['CS_DATABASE_URL'],pool_pre_ping=True)
    stop=asyncio.Event(); relay_task=None
    if AUDIT:   # publishes committed audit intents to Kafka for the Audit Service (shared/audit/outbox.py)
        app.state.audit_relay=OutboxRelay(engine.begin,AuditPublisher(os.environ.get('KAFKA_BOOTSTRAP_SERVERS','kafka:9092')),name='customer-service audit',table=AUDIT_TABLE)
        relay_task=asyncio.create_task(app.state.audit_relay.run(stop),name='audit-outbox-relay')
    yield
    stop.set()
    if relay_task: relay_task.cancel(); await asyncio.gather(relay_task,return_exceptions=True)
    await engine.dispose()
app=FastAPI(title='Customer Service',version='1.0.0',lifespan=lifespan)
app.add_middleware(CorrelationContextMiddleware)   # X-Correlation-Id from the gateway, recorded on audit events

# The open desk: a separate portal with no sign-in, for development. Switched on with CS_OPEN_DESK=true, it acts as ONE fixed tenant
# (CS_OPEN_DESK_TENANT_ID) and one shared 'Service Desk' actor, and only for requests that carry the x-open-desk header. It refuses to
# start when CS_ENV=production. Anyone who can reach the service can use it, so never switch it on where real customers' data lives.
OPEN_DESK=os.environ.get('CS_OPEN_DESK','').lower()=='true'
OPEN_TENANT=os.environ.get('CS_OPEN_DESK_TENANT_ID','')
OPEN_ACTOR=UUID('5e2f6f0e-0d1c-5b7e-9d3a-0c0de5d3c0de')
def open_desk_user(req):
    if not OPEN_DESK or req.headers.get('x-open-desk')!='1' or req.headers.get('authorization'): return None
    return {'id':str(OPEN_ACTOR),'tenant_id':OPEN_TENANT,'full_name':'Service Desk','email':'service-desk@open','role_name':'ServiceDesk','is_active':True,'status':'ACTIVE','staff':True,'can_work':True,'token':''}
async def identity(req: Request):
    opened=open_desk_user(req)
    if opened: return opened
    token=req.headers.get('authorization','')
    if not token.lower().startswith('bearer '): raise HTTPException(401,'Sign in through the portal')
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r=await client.get(os.environ.get('TENANT_SERVICE_URL','http://tenant-service:8001')+'/auth/me',headers={'Authorization':token})
    except httpx.HTTPError: raise HTTPException(503,'Sign-in service unavailable')
    if r.status_code in (401,403,404): raise HTTPException(401,'Session expired')
    if r.status_code!=200: raise HTTPException(503,'Sign-in service unavailable')
    u=r.json()
    if not u.get('is_active') or str(u.get('status','')).upper()!='ACTIVE' or not u.get('tenant_id'): raise HTTPException(403,'An active tenant account is required')
    if u.get('role_name') not in SUBMIT: raise HTTPException(403,'Your role cannot access Customer Service')
    if req.headers.get('x-tenant-id') and req.headers['x-tenant-id'].lower()!=str(u['tenant_id']).lower(): raise HTTPException(403,'Tenant mismatch')
    return {**u,'token':token,'staff':u['role_name'] in STAFF,'can_work':u['role_name'] in WORKERS}

class Strict(BaseModel):
    model_config=ConfigDict(extra='forbid',str_strip_whitespace=True)
class Create(Strict):
    title:str=Field(min_length=3,max_length=200)
    description:str=Field(min_length=10,max_length=5000)
    category:Literal['GENERAL','POLICY_SERVICING','BILLING','CLAIM_ENQUIRY','COMPLAINT','DOCUMENTS']='GENERAL'
    priority:Literal['LOW','NORMAL','HIGH','URGENT']='NORMAL'
    customer_id:UUID|None=None
    policy_id:UUID|None=None
class Change(Strict):
    version:int=Field(ge=1)
    status:Literal['OPEN','IN_PROGRESS','WAITING_CUSTOMER','RESOLVED','CLOSED','CANCELLED']
    reason:str=Field(min_length=5,max_length=2000)
class Comment(Strict):
    body:str=Field(min_length=1,max_length=5000)
    internal:bool=False
class Assignment(Strict):
    version:int=Field(ge=1)
    user_id:UUID|None=None

async def record(c,id,u,lock=False):
    row=(await c.execute(text('SELECT * FROM customer_service.tickets WHERE id=:id AND tenant_id=:t'+(' FOR UPDATE' if lock else '')),{'id':id,'t':UUID(u['tenant_id'])})).mappings().first()
    if not row or (not u['staff'] and str(row['requester_id'])!=u['id']): raise HTTPException(404,'Ticket not found')
    return dict(row)
AUDIT=os.environ.get('AUDIT_ENABLED','true').strip().lower() not in ('0','false','no','off')
AUDIT_TABLE='customer_service.audit_outbox'
STATUS_ACTIONS={'RESOLVED':'ticket.resolved','CLOSED':'ticket.closed','CANCELLED':'ticket.cancelled','IN_PROGRESS':'ticket.in_progress','WAITING_CUSTOMER':'ticket.waiting_customer'}
def ticket_intent(id,u,kind,body,internal):
    """The ticket event as an audit intent. Ticket text (replies, notes, reasons) is customer data: only its length is recorded."""
    action={'CREATED':'ticket.created','REPLY':'ticket.replied','NOTE':'ticket.note_added','STATUS':'ticket.status_changed','ASSIGNMENT':'ticket.assigned' if body=='Claimed' else 'ticket.released'}.get(kind,'ticket.'+kind.lower())
    previous=new=None
    if kind=='STATUS':
        m=re.match(r'^(\w+) -> (\w+): ',body or '')
        if m:
            previous,new={'status':m[1]},{'status':m[2]}; action=STATUS_ACTIONS.get(m[2],action)
            if m[2]=='IN_PROGRESS' and m[1] in ('RESOLVED','CLOSED'): action='ticket.reopened'
    return build_intent('customer-service',module='customer_service',action=action,entity_type='ticket',entity_id=id,tenant_id=UUID(u['tenant_id']),
        previous_value=previous,new_value=new,metadata={'internal':internal,'body_length':len(body or ''),'actor_name':u.get('full_name')},
        actor_id=u['id'],actor_type='CUSTOMER' if u.get('role_name')=='Customer' else 'USER',actor_role=u.get('role_name'))
async def event(c,id,u,kind,body,internal=False):
    await c.execute(text('INSERT INTO customer_service.events(ticket_id,actor_id,actor_name,kind,body,internal) VALUES (:id,:a,:n,:k,:b,:i)'),{'id':id,'a':UUID(u['id']),'n':u.get('full_name') or u['email'],'k':kind,'b':body,'i':internal})
    if AUDIT: await enqueue(c,ticket_intent(id,u,kind,body,internal),table=AUDIT_TABLE)   # same transaction: the ticket change and its audit intent commit together
def authorize_change(u,row,new):
    if new not in TRANSITIONS[row['status']]: raise HTTPException(409,'Invalid ticket transition')
    own=str(row['requester_id'])==u['id'] and ((new=='CANCELLED' and row['status']=='OPEN') or (new=='IN_PROGRESS' and row['status'] in {'RESOLVED','CLOSED'}))
    if not (u.get('can_work') or own): raise HTTPException(403,'Only the service desk can perform this action')

@app.get('/v1/healthz')
async def health():
    async with engine.connect() as c: await c.execute(text('SELECT 1'))
    return {'status':'ok'}
@app.get('/internal/v1/audit/health',include_in_schema=False)
async def audit_health(req: Request):
    relay=getattr(req.app.state,'audit_relay',None)
    return await relay.stats() if relay else {'enabled':False}
@app.get('/v1/me')
async def me(u=Depends(identity)): return {k:v for k,v in u.items() if k!='token'}
OPEN_STATUSES="('OPEN','IN_PROGRESS','WAITING_CUSTOMER')"
FINISHED_STATUSES="('RESOLVED','CLOSED','CANCELLED')"
# Plain-language views of the queue. `active` is everything still being worked; the rest narrow it down to what needs a person.
VIEWS={
    'active':'status IN '+OPEN_STATUSES,
    'finished':'status IN '+FINISHED_STATUSES,
    'unassigned':'assignee_id IS NULL AND status IN '+OPEN_STATUSES,
    'overdue':'due_at<now() AND status IN '+OPEN_STATUSES,
    'waiting':"status='WAITING_CUSTOMER'",
}
def scope(u,args):
    where='tenant_id=:t'; args['t']=UUID(u['tenant_id'])
    if not u['staff']: where+=' AND requester_id=:r';args['r']=UUID(u['id'])
    return where
@app.get('/v1/tickets/summary')
async def summary(u=Depends(identity)):
    """How the queue stands, in the counts the desk shows at the top: what is still open, what is late, what nobody has taken yet,
    what is mine, and what is waiting on the customer."""
    args={}; where=scope(u,args); args['me']=UUID(u['id'])
    async with engine.connect() as c:
        row=(await c.execute(text("""SELECT
            count(*) FILTER (WHERE status IN """+OPEN_STATUSES+""") AS active,
            count(*) FILTER (WHERE due_at<now() AND status IN """+OPEN_STATUSES+""") AS overdue,
            count(*) FILTER (WHERE assignee_id IS NULL AND status IN """+OPEN_STATUSES+""") AS unassigned,
            count(*) FILTER (WHERE assignee_id=:me AND status IN """+OPEN_STATUSES+""") AS mine,
            count(*) FILTER (WHERE status='WAITING_CUSTOMER') AS waiting,
            count(*) FILTER (WHERE status IN """+FINISHED_STATUSES+""") AS finished,
            count(*) AS total
            FROM customer_service.tickets WHERE """+where),args)).mappings().one()
    return {k:int(v or 0) for k,v in row.items()}
@app.get('/v1/tickets')
async def listing(page:int=Query(1,ge=1),page_size:int=Query(20,ge=1,le=100),status:str|None=None,q:str=Query('',max_length=200),view:str|None=Query(None,pattern='^(active|finished|unassigned|overdue|waiting|mine)$'),u=Depends(identity)):
    args={'limit':page_size,'offset':(page-1)*page_size}; where=scope(u,args)
    if status: where+=' AND status=:s';args['s']=status
    if view=='mine': where+=' AND assignee_id=:me AND status IN '+OPEN_STATUSES;args['me']=UUID(u['id'])
    elif view: where+=' AND '+VIEWS[view]
    if q: where+=' AND (title ILIKE :q OR description ILIKE :q)';args['q']='%'+q+'%'
    # What needs doing first: late and soon-due open tickets lead; finished ones follow, newest first.
    order="CASE WHEN status IN "+OPEN_STATUSES+" THEN 0 ELSE 1 END, CASE WHEN status IN "+OPEN_STATUSES+" THEN due_at END ASC, updated_at DESC" if view in (None,'active','unassigned','overdue','waiting','mine') else "updated_at DESC"
    async with engine.connect() as c:
        total=(await c.execute(text('SELECT count(*) FROM customer_service.tickets WHERE '+where),args)).scalar()
        rows=(await c.execute(text("SELECT *, (due_at<now() AND status NOT IN ('RESOLVED','CLOSED','CANCELLED')) AS overdue FROM customer_service.tickets WHERE "+where+" ORDER BY "+order+" LIMIT :limit OFFSET :offset"),args)).mappings().all()
    return {'items':[dict(r) for r in rows],'total':total,'page':page,'page_size':page_size}
@app.post('/v1/tickets')
async def create(body:Create,request:Request,u=Depends(identity)):
    key=required_uuid_header(request)
    # Validate linked records through the owning service using the caller's credentials.
    async with httpx.AsyncClient(timeout=15) as client:
        for kind,id in [('customers',body.customer_id),('policies',body.policy_id)]:
            if id:
                try: r=await client.get(f"{os.environ.get('TENANT_SERVICE_URL','http://tenant-service:8001')}/tenants/{u['tenant_id']}/{kind}/{id}",headers={'Authorization':u['token']})
                except httpx.HTTPError: raise HTTPException(503,'Record validation unavailable')
                if r.status_code!=200: raise HTTPException(422,'Linked record is unavailable or inaccessible')
                if kind=='policies' and body.customer_id and str(r.json().get('customer_id'))!=str(body.customer_id): raise HTTPException(422,'Policy does not belong to the selected customer')
    return await insert_ticket(body,u,key)
async def insert_ticket(body,u,key):
    """Create the ticket (idempotent on the key). Shared by staff/portal users and by customers signed in to the customer portal."""
    args=body.model_dump();args.update(idempotency_key=key,id=uuid4(),t=UUID(u['tenant_id']),r=UUID(u['id']),n=u.get('full_name') or u['email'],due=datetime.now(timezone.utc)+timedelta(hours={'LOW':120,'NORMAL':72,'HIGH':24,'URGENT':4}[body.priority]))
    async with engine.begin() as c:
        row=(await c.execute(text("INSERT INTO customer_service.tickets(id,tenant_id,requester_id,requester_name,customer_id,policy_id,title,description,category,priority,idempotency_key,due_at) VALUES (:id,:t,:r,:n,:customer_id,:policy_id,:title,:description,:category,:priority,:idempotency_key,:due) ON CONFLICT(tenant_id,requester_id,idempotency_key) DO NOTHING RETURNING *"),args)).mappings().first()
        if row: await event(c,row['id'],u,'CREATED',body.description)
        else:
            row=(await c.execute(text('SELECT * FROM customer_service.tickets WHERE tenant_id=:t AND requester_id=:r AND idempotency_key=:idempotency_key'),args)).mappings().one()
            if any(row[k]!=args[k] for k in ['title','description','category','priority','customer_id','policy_id']): raise HTTPException(409,'Idempotency key belongs to another submission')
    return dict(row)

@app.get('/v1/tickets/{id}')
async def detail(id:UUID,u=Depends(identity)):
    async with engine.connect() as c:
        row=await record(c,id,u)
        rows=(await c.execute(text('SELECT * FROM customer_service.events WHERE ticket_id=:id'+('' if u['staff'] else ' AND NOT internal')+' ORDER BY id'),{'id':id})).mappings().all()
    return {**row,'events':[dict(r) for r in rows]}
@app.post('/v1/tickets/{id}/comments')
async def comment(id:UUID,body:Comment,u=Depends(identity)):
    if body.internal and not u.get('can_work'): raise HTTPException(403,'Internal notes are restricted')
    async with engine.begin() as c:
        row=await record(c,id,u,True)
        if not u.get('can_work') and str(row['requester_id'])!=u['id']: raise HTTPException(403,'Only the service desk can reply to a customer')
        if row['status'] in {'CLOSED','CANCELLED'}: raise HTTPException(409,'Reopen the ticket before replying')
        await event(c,id,u,'NOTE' if body.internal else 'REPLY',body.body,body.internal)
    return {'ok':True}
@app.post('/v1/tickets/{id}/status')
async def change(id:UUID,body:Change,u=Depends(identity)):
    async with engine.begin() as c:
        row=await record(c,id,u,True)
        if row['version']!=body.version: raise HTTPException(409,'Ticket changed. Refresh before continuing')
        authorize_change(u,row,body.status)
        await c.execute(text("UPDATE customer_service.tickets SET status=:s, resolution=CASE WHEN :s='RESOLVED' THEN :reason WHEN :s='IN_PROGRESS' THEN NULL ELSE resolution END, version=version+1, updated_at=now() WHERE id=:id"),{'s':body.status,'reason':body.reason,'id':id})
        await event(c,id,u,'STATUS',row['status']+' -> '+body.status+': '+body.reason)
    return {'ok':True}
@app.post('/v1/tickets/{id}/assignment')
async def assign(id:UUID,body:Assignment,u=Depends(identity)):
    if not u.get('can_work'): raise HTTPException(403,'Only the service desk can assign tickets')
    if body.user_id and str(body.user_id)!=u['id']: raise HTTPException(403,'Claim the ticket yourself; arbitrary reassignment is not supported')
    async with engine.begin() as c:
        row=await record(c,id,u,True)
        if row['version']!=body.version: raise HTTPException(409,'Ticket changed. Refresh before continuing')
        if row['status'] in {'CLOSED','CANCELLED'}: raise HTTPException(409,'Ticket is closed')
        if row['assignee_id'] and str(row['assignee_id'])!=u['id'] and u['role_name'] not in SUPERVISORS: raise HTTPException(403,'Ticket belongs to another staff member')
        await c.execute(text('UPDATE customer_service.tickets SET assignee_id=:a,assignee_name=:n,version=version+1,updated_at=now() WHERE id=:id'),{'id':id,'a':body.user_id,'n':(u.get('full_name') or u['email']) if body.user_id else None})
        await event(c,id,u,'ASSIGNMENT','Claimed' if body.user_id else 'Released')
    return {'ok':True}

@app.post('/v1/demo/seed')
async def seed_demo(u=Depends(identity)):
    if os.environ.get('ENV_VAR','').strip().lower()!='demo': raise HTTPException(404,'Not found')
    if u['role_name']!='Admin': raise HTTPException(403,'Only tenant administrators can populate demo tickets')
    from demo import seed
    return await seed(engine,u)


# ── Customers of the customer portal ──────────────────────────────────────────────────────────────────
# A policyholder is not a tenant user, so they never reach the routes above. Customer Management (which signs them in) calls these
# with an HMAC signature made with CS_PORTAL_KEY and names the customer; they see and write only tickets they raised themselves,
# can never write internal notes, and see no internal ones.
import hmac, hashlib, time
PORTAL_KEY_ENV='CS_PORTAL_KEY'
async def portal_identity(req: Request):
    key=os.environ.get(PORTAL_KEY_ENV,'')
    ts=req.headers.get('x-service-timestamp',''); sig=req.headers.get('x-service-signature','')
    path=req.url.path+('?'+req.url.query if req.url.query else '')
    body=await req.body()
    from shared.security.service_auth import verify
    ok=req.headers.get('x-service-caller')=='customer-management' and verify(key,req.method,path,body,req.headers)
    # The operation key must be bound to the signature, otherwise a captured
    # request could be replayed with a new key to create another ticket.
    if req.headers.get('idempotency-key') and req.headers.get('x-service-signature-version')!='2': ok=False
    if not ok: raise HTTPException(401,'Invalid service signature')
    try: t=UUID(req.headers['x-portal-tenant']); cid=UUID(req.headers['x-portal-customer'])
    except (KeyError,ValueError): raise HTTPException(400,'Customer not named')
    name=req.headers.get('x-portal-name','Customer')[:120] or 'Customer'
    return {'id':str(cid),'tenant_id':str(t),'full_name':name,'email':name,'role_name':'Customer','staff':False,'token':''}
class PortalCreate(Strict):
    title:str=Field(min_length=3,max_length=200)
    description:str=Field(min_length=10,max_length=5000)
    category:Literal['GENERAL','POLICY_SERVICING','BILLING','CLAIM_ENQUIRY','COMPLAINT','DOCUMENTS']='GENERAL'
    policy_id:UUID|None=None
class PortalReply(Strict):
    body:str=Field(min_length=1,max_length=5000)
@app.get('/internal/v1/portal/tickets')
async def portal_list(u=Depends(portal_identity)):
    args={}; where=scope(u,args)
    async with engine.connect() as c:
        rows=(await c.execute(text("SELECT id,title,category,status,priority,created_at,updated_at,policy_id,(due_at<now() AND status NOT IN ('RESOLVED','CLOSED','CANCELLED')) AS overdue FROM customer_service.tickets WHERE "+where+" ORDER BY updated_at DESC LIMIT 100"),args)).mappings().all()
    return {'items':[dict(r) for r in rows]}
@app.post('/internal/v1/portal/tickets')
async def portal_create(body:PortalCreate,request:Request,u=Depends(portal_identity)):
    key=required_uuid_header(request)
    # priority and the customer link are decided here, not by the browser; the policy was checked by Customer Management
    full=Create(title=body.title,description=body.description,category=body.category,priority='NORMAL',customer_id=UUID(u['id']),policy_id=body.policy_id)
    return await insert_ticket(full,u,key)
def portal_view(d):
    keep=('id','title','description','category','status','resolution','created_at','updated_at','policy_id','version')
    return {**{k:d.get(k) for k in keep},'events':[{k:e[k] for k in ('id','actor_name','kind','body','created_at')} for e in d.get('events',[]) if e['kind'] in ('CREATED','REPLY','STATUS')]}
@app.get('/internal/v1/portal/tickets/{id}')
async def portal_detail(id:UUID,u=Depends(portal_identity)):
    return portal_view(await detail(id,u))
@app.post('/internal/v1/portal/tickets/{id}/reply')
async def portal_reply(id:UUID,body:PortalReply,u=Depends(portal_identity)):
    return await comment(id,Comment(body=body.body,internal=False),u)
@app.post('/internal/v1/portal/tickets/{id}/withdraw')
async def portal_withdraw(id:UUID,u=Depends(portal_identity)):
    async with engine.connect() as c: row=await record(c,id,u)
    return await change(id,Change(version=row['version'],status='CANCELLED',reason='Withdrawn by the customer'),u)
@app.post('/internal/v1/portal/tickets/{id}/reopen')
async def portal_reopen(id:UUID,body:PortalReply,u=Depends(portal_identity)):
    async with engine.connect() as c: row=await record(c,id,u)
    return await change(id,Change(version=row['version'],status='IN_PROGRESS',reason=body.body if len(body.body)>=5 else 'Customer says it is not resolved'),u)
