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
  async def fixture_execute(tool, tool_args, ctx):
   if tool == 'get_proposal_customer_context':
    return {'success': True, 'customer': {'id': 'test-customer', 'cnic': '35202-1111111-1', 'details': {}}, 'policies': []}
   if tool == 'list_customers':
    return {'success': True, 'customers': []}
   if tool == 'list_insurance_plans':
    return {'items':[{'name':'Individual Term Life'},{'name':'Family Protection'}]}
   raise AssertionError(f'Unexpected execution during revision: {tool}')
  execute=AsyncMock(side_effect=fixture_execute)
  with patch('graph.execute_tool',execute):
   initial=await app.ainvoke({'messages':[HumanMessage(content='Create a proposal for this saved customer'),AIMessage(content='',tool_calls=[{'name':name,'args':args or {},'id':'call-1'}])],'tenant_id':'test','jwt_token':'test','user_role':role,'platform':'web'},cfg)
   self.assertTrue(initial['__interrupt__'][0].value['can_revise'])
   await app.ainvoke(Command(resume=answer),cfg)
   state=(await app.aget_state(cfg)).values
  if name=="create_proposal": self.assertTrue(execute.call_args_list)
  self.assertTrue(all(c.args[0] in {'get_proposal_customer_context','list_insurance_plans','list_customers'} for c in execute.call_args_list))
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
 def test_everyday_ways_of_going_back_are_revisions(self):
  for text in ['no no I go back','Actually, I want to change','wait, wrong policy','that\'s wrong','not that one',
               'undo','I meant Hassan','oops','pick a different policy','nahi nahi galat hai','wapas jao','نہیں نہیں']:
   self.assertTrue(is_revision_text(text), text)
 def test_real_answers_are_not_mistaken_for_going_back(self):
  for text in ['No','cancel','Partial approval','He had a back injury','something went wrong at the hospital',
               'PL-2026-0006 — Ahmed Malik (Salary Protection Plan, cover PKR 10,500,000)','Natural / illness']:
   self.assertFalse(is_revision_text(text), text)
 async def test_prepare_family_reports_coming_soon_without_reading_customer(self):
  from types import SimpleNamespace
  customer='11111111-1111-4111-8111-111111111111'
  response=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'id':customer,'cnic':'3520212345678'})
  client=SimpleNamespace(get=AsyncMock(return_value=response))
  ctx=SimpleNamespace(client=client,tsvc=lambda p:p)
  result=await _prepare_family_insurance({'customer_id':customer},ctx)
  self.assertEqual(result['error_code'],'coming_soon')
  client.get.assert_not_awaited()
  self.assertEqual(result['quick_actions'][0]['payload'],'Add a new individual customer')
 async def test_family_conversion_remains_unavailable_for_existing_customers(self):
  from types import SimpleNamespace
  response=SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'family_group_id':'existing-family'})
  ctx=SimpleNamespace(client=SimpleNamespace(get=AsyncMock(return_value=response)),tsvc=lambda p:p)
  result=await _prepare_family_insurance({'customer_id':'11111111-1111-4111-8111-111111111111'},ctx)
  self.assertEqual(result['error_code'],'coming_soon')
  ctx.client.get.assert_not_awaited()
if __name__=='__main__':unittest.main()


def test_missing_fields_are_asked_in_plain_language():
    from permission import missing_args_question
    question = missing_args_question(
        "add_customer", {"first_name": "Nouma", "last_name": "Ejaz"},
        ["cnic", "date_of_birth", "occupation", "declared_income"],
    )
    assert question.startswith("To register Nouma Ejaz, I still need a few details:")
    assert "- Date of birth" in question and "- Annual income in PKR" in question
    assert "date_of_birth" not in question and "declared_income" not in question
    assert missing_args_question("assign_case", {}, ["assigned_user_name"]) == \
        "To assign this application, could you tell me who to assign it to?"
