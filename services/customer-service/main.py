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

STAFF=frozenset({'Admin','CustomerService','ClaimsManager'})
SUBMIT=frozenset({'Admin','CustomerService','ClaimsManager','ClaimsAdjuster','Underwriter','Agent','Broker'})
TRANSITIONS={'OPEN':{'IN_PROGRESS','CANCELLED'},'IN_PROGRESS':{'WAITING_CUSTOMER','RESOLVED','CANCELLED'},'WAITING_CUSTOMER':{'IN_PROGRESS','RESOLVED','CANCELLED'},'RESOLVED':{'CLOSED','IN_PROGRESS'},'CLOSED':{'IN_PROGRESS'},'CANCELLED':set()}
engine=None
@asynccontextmanager
async def lifespan(app):
    global engine
    if os.environ.get('CS_RUN_MIGRATIONS','true')=='true' and os.environ.get('CS_MIGRATION_DATABASE_URL'): await migrate.run()
    engine=create_async_engine(os.environ['CS_DATABASE_URL'],pool_pre_ping=True)
    yield
    await engine.dispose()
app=FastAPI(title='Customer Service',version='1.0.0',lifespan=lifespan)

async def identity(req: Request):
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
    return {**u,'token':token,'staff':u['role_name'] in STAFF}

class Strict(BaseModel):
    model_config=ConfigDict(extra='forbid',str_strip_whitespace=True)
class Create(Strict):
    title:str=Field(min_length=3,max_length=200)
    description:str=Field(min_length=10,max_length=5000)
    category:Literal['GENERAL','POLICY_SERVICING','BILLING','CLAIM_ENQUIRY','COMPLAINT','DOCUMENTS']='GENERAL'
    priority:Literal['LOW','NORMAL','HIGH','URGENT']='NORMAL'
    customer_id:UUID|None=None
    policy_id:UUID|None=None
    idempotency_key:UUID
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
async def event(c,id,u,kind,body,internal=False):
    await c.execute(text('INSERT INTO customer_service.events(ticket_id,actor_id,actor_name,kind,body,internal) VALUES (:id,:a,:n,:k,:b,:i)'),{'id':id,'a':UUID(u['id']),'n':u.get('full_name') or u['email'],'k':kind,'b':body,'i':internal})
def authorize_change(u,row,new):
    if new not in TRANSITIONS[row['status']]: raise HTTPException(409,'Invalid ticket transition')
    if not u['staff'] and not (str(row['requester_id'])==u['id'] and ((new=='CANCELLED' and row['status']=='OPEN') or (new=='IN_PROGRESS' and row['status'] in {'RESOLVED','CLOSED'}))): raise HTTPException(403,'Only service staff can perform this action')

@app.get('/v1/healthz')
async def health():
    async with engine.connect() as c: await c.execute(text('SELECT 1'))
    return {'status':'ok'}
@app.get('/v1/me')
async def me(u=Depends(identity)): return {k:v for k,v in u.items() if k!='token'}
@app.get('/v1/tickets')
async def listing(page:int=Query(1,ge=1),page_size:int=Query(20,ge=1,le=100),status:str|None=None,q:str=Query('',max_length=200),u=Depends(identity)):
    where='tenant_id=:t'; args={'t':UUID(u['tenant_id']),'limit':page_size,'offset':(page-1)*page_size}
    if not u['staff']: where+=' AND requester_id=:r';args['r']=UUID(u['id'])
    if status: where+=' AND status=:s';args['s']=status
    if q: where+=' AND (title ILIKE :q OR description ILIKE :q)';args['q']='%'+q+'%'
    async with engine.connect() as c:
        total=(await c.execute(text('SELECT count(*) FROM customer_service.tickets WHERE '+where),args)).scalar()
        rows=(await c.execute(text("SELECT *, (due_at<now() AND status NOT IN ('RESOLVED','CLOSED','CANCELLED')) AS overdue FROM customer_service.tickets WHERE "+where+" ORDER BY created_at DESC LIMIT :limit OFFSET :offset"),args)).mappings().all()
    return {'items':[dict(r) for r in rows],'total':total,'page':page,'page_size':page_size}
@app.post('/v1/tickets')
async def create(body:Create,u=Depends(identity)):
    # Validate linked records through the owning service using the caller's credentials.
    async with httpx.AsyncClient(timeout=15) as client:
        for kind,id in [('customers',body.customer_id),('policies',body.policy_id)]:
            if id:
                try: r=await client.get(f"{os.environ.get('TENANT_SERVICE_URL','http://tenant-service:8001')}/tenants/{u['tenant_id']}/{kind}/{id}",headers={'Authorization':u['token']})
                except httpx.HTTPError: raise HTTPException(503,'Record validation unavailable')
                if r.status_code!=200: raise HTTPException(422,'Linked record is unavailable or inaccessible')
                if kind=='policies' and body.customer_id and str(r.json().get('customer_id'))!=str(body.customer_id): raise HTTPException(422,'Policy does not belong to the selected customer')
    args=body.model_dump();args.update(id=uuid4(),t=UUID(u['tenant_id']),r=UUID(u['id']),n=u.get('full_name') or u['email'],due=datetime.now(timezone.utc)+timedelta(hours={'LOW':120,'NORMAL':72,'HIGH':24,'URGENT':4}[body.priority]))
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
    if body.internal and not u['staff']: raise HTTPException(403,'Internal notes are restricted')
    async with engine.begin() as c:
        row=await record(c,id,u,True)
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
    if not u['staff']: raise HTTPException(403,'Only service staff can assign tickets')
    if body.user_id and str(body.user_id)!=u['id']: raise HTTPException(403,'Claim the ticket yourself; arbitrary reassignment is not supported')
    async with engine.begin() as c:
        row=await record(c,id,u,True)
        if row['version']!=body.version: raise HTTPException(409,'Ticket changed. Refresh before continuing')
        if row['status'] in {'CLOSED','CANCELLED'}: raise HTTPException(409,'Ticket is closed')
        if row['assignee_id'] and str(row['assignee_id'])!=u['id'] and u['role_name']!='Admin': raise HTTPException(403,'Ticket belongs to another staff member')
        await c.execute(text('UPDATE customer_service.tickets SET assignee_id=:a,assignee_name=:n,version=version+1,updated_at=now() WHERE id=:id'),{'id':id,'a':body.user_id,'n':(u.get('full_name') or u['email']) if body.user_id else None})
        await event(c,id,u,'ASSIGNMENT','Claimed' if body.user_id else 'Released')
    return {'ok':True}

@app.post('/v1/demo/seed')
async def seed_demo(u=Depends(identity)):
    if os.environ.get('ENV_VAR','').strip().lower()!='demo': raise HTTPException(404,'Not found')
    if u['role_name']!='Admin': raise HTTPException(403,'Only tenant administrators can populate demo tickets')
    from demo import seed
    return await seed(engine,u)
