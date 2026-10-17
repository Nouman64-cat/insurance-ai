"""Readiness follow-ups must recheck live state instead of repeating an old blocker."""
import asyncio,json
from unittest.mock import AsyncMock,patch
import pytest
from langchain_core.messages import AIMessage,HumanMessage,ToolMessage
from langgraph.checkpoint.memory import MemorySaver
import graph
from test_commission_specialist import initial,call
from track_specialists import _fresh_review_call,FINANCIAL_TOOLS
from test_track_specialists import FakeService,QUEUE,run


def stale_history():
    return [HumanMessage(content='Show the financial review for APP-2026-ABC'),
        call('get_underwriting_review',id='old-review',case_number='APP-2026-ABC'),
        ToolMessage(name='get_underwriting_review',tool_call_id='old-review',content=json.dumps({
            'success':True,'message':'Bank Statement has not been received and accepted yet.'})),
        AIMessage(content='Wait for the bank statement to be accepted.'),HumanMessage(content='can we run now?')]


@pytest.mark.parametrize('text',['can we run now?','Can you run it now?','are we ready yet?','please recheck','check again'])
def test_readiness_followup_forces_a_fresh_lookup(text):
    messages=stale_history();messages[-1]=HumanMessage(content=text)
    result=_fresh_review_call({'messages':messages},'financial_underwriting',FINANCIAL_TOOLS)
    assert result.tool_calls[0]['name']=='get_underwriting_review'
    assert result.tool_calls[0]['args']=={'case_number':'APP-2026-ABC'}


def test_refresh_does_not_loop_or_intercept_other_work():
    messages=stale_history()
    messages.append(ToolMessage(name='get_underwriting_review',tool_call_id='fresh',content='{"success":true}'))
    assert _fresh_review_call({'messages':messages},'financial_underwriting',FINANCIAL_TOOLS) is None
    for text in ['Record my review as cleared','Show claims','Run financial underwriting for another applicant']:
        assert _fresh_review_call({'messages':[HumanMessage(content=text)]},'financial_underwriting',FINANCIAL_TOOLS) is None
    assert _fresh_review_call({'messages':stale_history()},'final_underwriting',FINANCIAL_TOOLS) is None
    assert _fresh_review_call({'messages':stale_history()},'financial_underwriting',set()) is None


def test_new_conversation_uses_the_existing_assigned_case_resolver():
    result=_fresh_review_call({'messages':[HumanMessage(content='can we run now?')]},'financial_underwriting',FINANCIAL_TOOLS)
    assert result.tool_calls[0]['args']=={}


def test_real_graph_fetches_fresh_readiness_even_when_model_would_answer_without_tools():
    async def work():
        model=AsyncMock();model.ainvoke.return_value=AIMessage(content='Yes, financial underwriting is ready.')
        execute=AsyncMock(return_value={'success':True,'financial_readiness':{'ready':True,'blockers':[]},
            'message':'All financial requirements are in — AI financial underwriting can run.'})
        state={**initial('can we run now?','Financial Underwriter'),'messages':stale_history()}
        with patch('graph._llm',return_value=model),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',execute),patch('usage.record'):
            result=await graph.build_graph(MemorySaver()).ainvoke(state,{'configurable':{'thread_id':'stale-readiness'}})
        execute.assert_awaited_once()
        assert execute.call_args.args[0]=='get_underwriting_review'
        assert execute.call_args.args[1]=={'case_number':'APP-2026-ABC'}
        assert 'ready' in result['messages'][-1].content
        assert model.ainvoke.await_count==1
        assert 'old tool results and assistant replies are historical' in model.ainvoke.call_args.args[0][0].content
    asyncio.run(work())


def test_review_tool_reports_live_structured_financial_readiness():
    workspace={'reference':QUEUE[0]['reference'],'customer_name':QUEUE[0]['customer_name'],'track':'financial',
        'review':{'status':'IN_REVIEW','note':None,'assigned_user_id':'user-1'},'requirements':[], 'application_outstanding':[],
        'ai_underwriting':{'ready':True,'blockers':[],'result':None}}
    service=FakeService({'GET /underwriting/reviews':QUEUE,'GET /underwriting/reviews/case-1':workspace})
    result=run('get_underwriting_review',{'case_number':'APP-2026-ABC'},service,'Financial Underwriter')
    assert result['financial_readiness']=={'ready':True,'blockers':[]}
    assert 'AI financial underwriting can run' in result['message']
    assert 'not been received and accepted' not in result['message']
