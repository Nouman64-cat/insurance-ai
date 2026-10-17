"""Controlled text-chat boundary probes using a synthetic in-memory graph.

No live business data, real tokens, privileged actions or external HTTP calls.
True values in the output identify current authorization defects, not passes.
"""
import asyncio,json
from types import SimpleNamespace
from unittest.mock import patch,AsyncMock
from fastapi import FastAPI
import httpx
from routers.chat import router
from schemas import ExecuteToolRequest
from langchain_core.messages import AIMessage
class FakeGraph:
 def __init__(self):self.inputs=[]
 async def aget_state(self,config):
  return SimpleNamespace(next=('permission_gate',),tasks=[SimpleNamespace(interrupts=[SimpleNamespace(value={'kind':'clarify','question':'SYNTHETIC_ONLY_PRIVATE_QUESTION','tool_call':{'name':'create_proposal','args':{}}})])],values={'tenant_id':'tenant-A','user_role':'Admin','jwt_token':'synthetic-A'})
 async def astream(self,input_,config,**kwargs):
  self.inputs.append(input_)
  yield 'updates',{'agent':{'messages':[AIMessage(content='Synthetic resume reached')]}}
async def main():
 app=FastAPI();app.include_router(router);fake=FakeGraph();app.state.graph=fake
 async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://audit') as client:
  a=await client.post('/chat/stream',json={'thread_id':'synthetic-owned-by-A'},headers={'Authorization':'Bearer invalid-token','X-Tenant-Id':'tenant-B'})
  b=await client.post('/chat/resume',json={'thread_id':'synthetic-owned-by-A','resume_value':'yes'},headers={'Authorization':'Bearer invalid-token','X-Tenant-Id':'tenant-B'})
  executor=AsyncMock(return_value={'success':True,'fixture_only':True})
  with patch('routers.chat.execute_tool',executor):
   c=await client.post('/chat/execute-tool',json={'name':'add_user','role':'SuperAdmin','args':{'email':'synthetic@example.invalid'}},headers={'Authorization':'Bearer invalid-token','X-Tenant-Id':'tenant-B'})
  print(json.dumps({'invalid_token_can_read_synthetic_other_tenant_interrupt':a.status_code==200 and 'SYNTHETIC_ONLY_PRIVATE_QUESTION' in a.text,'invalid_token_can_resume_synthetic_other_tenant_thread':b.status_code==200 and len(fake.inputs)>0,'client_supplied_superadmin_role_reaches_mocked_mutation':executor.await_count==1,'effective_role_at_executor':executor.call_args.args[2].role if executor.await_count else None,'real_business_data_accessed':False,'real_mutations_executed':False},indent=2))
asyncio.run(main())
