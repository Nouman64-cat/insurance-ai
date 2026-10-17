from uuid import UUID, uuid5, NAMESPACE_URL
from datetime import datetime, timedelta, timezone
from sqlalchemy import text

EXAMPLES=[
 ('Premium receipt not received','BILLING','HIGH','OPEN','Customer requests a copy of the receipt for their latest premium.'),
 ('Update correspondence address','POLICY_SERVICING','NORMAL','IN_PROGRESS','Customer has moved and needs guidance on the address amendment process.'),
 ('Missing identity document','DOCUMENTS','NORMAL','WAITING_CUSTOMER','Identity document is unclear. Waiting for a readable replacement.'),
 ('Claim progress enquiry','CLAIM_ENQUIRY','URGENT','IN_PROGRESS','Customer requests an update on a pending disability claim.'),
 ('Complaint about delayed callback','COMPLAINT','HIGH','RESOLVED','Customer reported a delayed callback from the servicing team.'),
 ('Policy maturity information','GENERAL','LOW','CLOSED','Customer requested an explanation of the maturity documentation process.'),
 ('Duplicate servicing enquiry','GENERAL','LOW','CANCELLED','Requester withdrew this duplicate enquiry.'),
 ('Surrender process enquiry','POLICY_SERVICING','HIGH','OPEN','Customer asks about the documents and review needed for surrender before maturity.'),
]
async def seed(engine,u):
 created=0
 async with engine.begin() as c:
  for i,(title,category,priority,status,description) in enumerate(EXAMPLES):
   key=uuid5(NAMESPACE_URL,f"customer-service-demo-v1:{u['tenant_id']}:{i}")
   args={'id':key,'t':UUID(u['tenant_id']),'r':UUID(u['id']),'n':'Demo requester','title':'[DEMO] '+title,'description':description,'category':category,'priority':priority,'status':status,'due':datetime.now(timezone.utc)+timedelta(hours=-12 if i in (0,3) else 48),'resolution':'Demo: servicing team explained the process and recorded the outcome.' if status in ('RESOLVED','CLOSED') else None}
   row=(await c.execute(text('INSERT INTO customer_service.tickets(id,tenant_id,requester_id,requester_name,title,description,category,priority,status,due_at,resolution,idempotency_key) VALUES (:id,:t,:r,:n,:title,:description,:category,:priority,:status,:due,:resolution,:id) ON CONFLICT(id) DO NOTHING RETURNING id'),args)).first()
   if not row:continue
   created+=1
   for kind,body,internal in [('CREATED',description,False),('REPLY','Demo: your enquiry has been received by the service desk.',False),('NOTE','Demo internal note: review the owning insurance workflow before taking any action.',True)]:
    await c.execute(text('INSERT INTO customer_service.events(ticket_id,actor_id,actor_name,kind,body,internal) VALUES (:id,:a,:n,:k,:b,:i)'),{'id':key,'a':UUID(u['id']),'n':'Demo service desk','k':kind,'b':body,'i':internal})
 return {'created':created,'available':len(EXAMPLES)}
