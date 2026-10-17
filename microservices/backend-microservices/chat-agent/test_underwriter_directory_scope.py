"""Queue-wide underwriting requests must see the real specialist directory tools."""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver

import graph
from permission import get_tools_for_role
from specialist_router import coordinator_node
from test_commission_specialist import initial, call
from test_track_specialists import FakeService, CASES, run
from underwriting_specialist import UNDERWRITING_TOOLS, UNDERWRITING_DOMAINS, underwriting_prompt

REQUEST = 'Show applications awaiting underwriting, identify missing requirements, and assign eligible underwriters.'
DIRECTORY = [
    {'id':'medical-1','full_name':'Medical Reviewer','role':'Medical Underwriter','tracks':['medical']},
    {'id':'financial-1','full_name':'Financial Reviewer','role':'Financial Underwriter','tracks':['financial']},
]
REVIEW_TOOLS = {'list_track_underwriters','assign_underwriting_track','get_specialist_reviews'}


@pytest.mark.parametrize('skills_enabled',[False,True])
def test_actual_request_has_directory_and_assignment_bound(skills_enabled,monkeypatch):
    monkeypatch.setattr('skills.settings._value',skills_enabled)
    state=initial(REQUEST)
    assert coordinator_node(state)['active_specialist']=='underwriting'
    allowed=frozenset(t.name for t in get_tools_for_role('Admin') if t.name in UNDERWRITING_TOOLS)
    class Model:
        def bind_tools(self,tools,**kwargs):
            self.names={t.name for t in tools}; return self
    model=Model()
    with patch.dict(graph._LLM_CACHE,{},clear=True),patch('graph.providers.build_chat',return_value=model):
        graph._llm({'version':'directory-regression','primary':{}},'Admin',domains=UNDERWRITING_DOMAINS,tool_scope=allowed)
    assert REVIEW_TOOLS<=model.names
    assert len(model.names)<=graph.MAX_BOUND_TOOLS
    prompt=underwriting_prompt(allowed,'en')
    assert 'failed lookup is a service error' in prompt
    assert 'Preserve existing assignments' in prompt


@pytest.mark.parametrize('role',['Agent','Viewer','CustomerService','ClaimsAdjuster'])
def test_directory_fix_does_not_grant_other_roles_access(role):
    allowed={t.name for t in get_tools_for_role(role) if t.name in UNDERWRITING_TOOLS}
    assert not REVIEW_TOOLS & allowed


def test_directory_reports_both_tracks_and_filters_eligibility():
    service=FakeService({'GET /underwriting/underwriters':DIRECTORY})
    all_people=run('list_track_underwriters',{},service,'Admin')
    assert all_people['success'] and all_people['underwriters']==DIRECTORY
    for track,person in zip(['medical','financial'],DIRECTORY):
        result=run('list_track_underwriters',{'track':track},service,'Admin')
        assert result['underwriters']==[person]


def test_assignment_uses_verified_directory_ids_and_separate_track_endpoints():
    service=FakeService({'GET /cases':CASES,'GET /underwriting/underwriters':DIRECTORY,
                         'PUT /underwriting-tracks/medical':{},'PUT /underwriting-tracks/financial':{}})
    for track,person in zip(['medical','financial'],DIRECTORY):
        result=run('assign_underwriting_track',{'case_number':CASES[0]['caseNumber'],'track':track,'underwriter_id':person['id']},service,'Admin')
        assert result['success']
    writes=[c for c in service.calls if c[0]=='PUT']
    assert [(url.rsplit('/',1)[-1],body) for _,url,body in writes]==[
        ('medical',{'assigned_user_id':'medical-1'}),('financial',{'assigned_user_id':'financial-1'})]


def test_directory_failure_is_not_an_empty_directory():
    service=FakeService({'GET /underwriting/underwriters':(503,{'detail':'unavailable'})})
    with pytest.raises(RuntimeError): run('list_track_underwriters',{},service,'Admin')


def test_graph_keeps_directory_and_assignments_in_the_same_underwriting_turn():
    async def work():
        llm=AsyncMock()
        llm.ainvoke.side_effect=[call('list_track_underwriters',id='directory'),
            call('get_specialist_reviews',id='reviews',case_number='APP-2026-ABC'),
            call('assign_underwriting_track',id='medical',case_number='APP-2026-ABC',track='medical',underwriter_id='medical-1'),
            call('assign_underwriting_track',id='financial',case_number='APP-2026-ABC',track='financial',underwriter_id='financial-1'),
            AIMessage(content='Both reviews assigned.')]
        execute=AsyncMock(return_value={'success':True,'underwriters':DIRECTORY,'message':'Verified backend result'})
        with patch('graph._llm',return_value=llm),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',execute),patch('usage.record'):
            result=await graph.build_graph(MemorySaver()).ainvoke(initial(REQUEST),{'configurable':{'thread_id':'directory-regression'}})
        assert result['active_specialist']=='underwriting'
        assert [c.args[0] for c in execute.call_args_list]==['list_track_underwriters','get_specialist_reviews','assign_underwriting_track','assign_underwriting_track']
        assert all(c.args[2].tenant_id=='synthetic-tenant' for c in execute.call_args_list)
    asyncio.run(work())
