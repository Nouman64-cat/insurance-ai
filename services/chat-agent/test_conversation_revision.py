import unittest
from unittest.mock import AsyncMock, patch
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
from state import ChatState
import graph
from conversation_revision import select_plan, revision_message, is_revision_text
from tool_executor import _prepare_family_insurance, Ctx

class RevisionTests(unittest.IsolatedAsyncioTestCase):
 async def gate(self, answer, name="create_proposal", args=None, role="Agent"):
  builder=StateGraph(ChatState)
  builder.add_node('permission_gate',graph.permission_gate)
  builder.add_node('agent',lambda state:{})
  builder.add_edge(START,'permission_gate');builder.add_edge('agent',END)
  app=builder.compile(checkpointer=MemorySaver());cfg={'configurable':{'thread_id':'revision-test'}}
  execute=AsyncMock(return_value={'items':[{'name':'Individual Term Life'},{'name':'Family Protection'}]})
  with patch('graph.execute_tool',execute):
   initial=await app.ainvoke({'messages':[HumanMessage(content='Create a proposal for this saved customer'),AIMessage(content='',tool_calls=[{'name':name,'args':args or {},'id':'call-1'}])],'tenant_id':'test','jwt_token':'test','user_role':role,'platform':'web'},cfg)
   self.assertTrue(initial['__interrupt__'][0].value['can_revise'])
   await app.ainvoke(Command(resume=answer),cfg)
   state=(await app.aget_state(cfg)).values
  if name=="create_proposal": self.assertTrue(execute.call_args_list)
  self.assertTrue(all(c.args[0]=='list_insurance_plans' for c in execute.call_args_list))
  self.assertTrue(any(isinstance(m,ToolMessage) for m in state['messages']))
  return state
 async def test_explicit_revision_supersedes_pending_action(self):
  state=await self.gate({'kind':'revise','message':'Actually, I need family insurance'})
  self.assertEqual(state['messages'][-1].content,'Actually, I need family insurance')
  self.assertIsNone(state.get('lead_tool'))
 async def test_requested_action_executes_without_extra_confirmation(self):
  builder=StateGraph(ChatState)
  builder.add_node('permission_gate',graph.permission_gate)
  builder.add_node('agent',lambda state:{})
  builder.add_edge(START,'permission_gate');builder.add_edge('agent',END)
  app=builder.compile(checkpointer=MemorySaver())
  execute=AsyncMock(return_value={'success':True,'message':'User deleted'})
  with patch('graph.execute_tool',execute):
   result=await app.ainvoke({'messages':[HumanMessage(content='Delete this user'),AIMessage(content='',tool_calls=[{'name':'delete_user','args':{'email':'test@example.test'},'id':'call-1'}])],'tenant_id':'test','jwt_token':'test','user_role':'Admin','platform':'web'},{'configurable':{'thread_id':'no-confirm'}})
  self.assertNotIn('__interrupt__',result)
  execute.assert_awaited_once()
  self.assertEqual(execute.call_args.args[0],'delete_user')
 async def test_spoken_correction_does_not_select_a_plan(self):
  await self.gate('Actually, I need family insurance instead')
 async def test_unknown_plan_never_executes(self):
  await self.gate('Not one of those products')
 def test_plan_matching_rejects_empty_and_ambiguous(self):
  self.assertIsNone(select_plan('', ['Term Life']))
  self.assertIsNone(select_plan('Life',['Term Life','Whole Life']))
  self.assertIsNone(select_plan('Something else',['Term Life']))
  self.assertEqual(select_plan('term life',['Term Life']),'Term Life')
 def test_revision_contract(self):
  self.assertIsNone(revision_message({'kind':'revise','message':''}))
  self.assertTrue(is_revision_text('Switch to family insurance'))
  self.assertFalse(is_revision_text('Yes'))
 async def test_prepare_family_is_read_only_and_links_existing_customer(self):
  from types import SimpleNamespace
  customer='11111111-1111-4111-8111-111111111111'
  response=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'id':customer,'cnic':'3520212345678'})
  client=SimpleNamespace(get=AsyncMock(return_value=response))
  ctx=SimpleNamespace(client=client,tsvc=lambda p:p)
  result=await _prepare_family_insurance({'customer_id':customer},ctx)
  self.assertIn('head='+customer,result['quick_actions'][0]['payload'])
  self.assertIn('unchanged',result['message'])
 async def test_existing_family_is_reused(self):
  from types import SimpleNamespace
  response=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'family_group_id':'existing-family'})
  ctx=SimpleNamespace(client=SimpleNamespace(get=AsyncMock(return_value=response)),tsvc=lambda p:p)
  result=await _prepare_family_insurance({'customer_id':'11111111-1111-4111-8111-111111111111'},ctx)
  self.assertEqual(result['quick_actions'][0]['payload'],'admin/families/existing-family')
if __name__=='__main__':unittest.main()
