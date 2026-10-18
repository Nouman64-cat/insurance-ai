"""Claims Manager -> Finance handoff without invented evidence or cross-role actions."""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import MemorySaver
import graph
from test_claims_commission_tools import FakeClient, _call, _workspace, CLAIM, WS_PATH
from test_commission_specialist import initial, call
from test_finance_specialist import CLAIM as FIN_CLAIM, WS as FIN_WS, PATH as FIN_PATH, service as finance_service
from permission import is_role_allowed, get_tools_for_role
from skills.registry import schema
from skills.selector import select
from claims_specialist import CLAIMS_TOOLS, CLAIMS_DOMAINS
from finance_specialist import FINANCE_TOOLS, FINANCE_DOMAINS
from tool_executor import ChoiceNeeded

APPROVED={**CLAIM,'status':'Approved','approved_amount':900000}
PAYEE={'id':'payee-1','name':'Verified person','amount':900000,'verified':False}

def manager(ws=None,extra=None):
    return FakeClient({('GET','/claims'):[APPROVED],('GET','/claims/c-1'):APPROVED,('GET',WS_PATH):ws or _workspace(claim={'status':'Approved','approved_amount':900000},can={'verify_payees':True}),**(extra or {})})


def test_role_bindings_and_skills_match_new_workflows():
    for tool,role,scope in [('prepare_claim_settlement','ClaimsManager',CLAIMS_TOOLS),('list_finance_payments','Finance',FINANCE_TOOLS)]:
        assert tool in scope and schema(tool,role)['success']
        for denied in ('Admin','SuperAdmin','ClaimsAdjuster','Underwriter','Agent','Viewer','Medical Underwriter','Financial Underwriter'):
            assert not is_role_allowed(tool,denied)
    assert not is_role_allowed('prepare_claim_settlement','Finance')
    assert not is_role_allowed('list_finance_payments','ClaimsManager')
    assert 'claim-settlement-approval' in select('prepare settlement and authorise finance payment','ClaimsManager',specialist='claims')
    assert 'finance-payments' in select('external payment register bank reference','Finance',specialist='finance')
    class Bound:
        def bind_tools(self,tools,**kw): self.names={t.name for t in tools}; return self
    for role,scope,domains in [('ClaimsManager',CLAIMS_TOOLS,CLAIMS_DOMAINS),('Finance',FINANCE_TOOLS,FINANCE_DOMAINS)]:
        allowed=frozenset(t.name for t in get_tools_for_role(role) if t.name in scope)
        bound=Bound()
        with patch.dict(graph._LLM_CACHE,{},clear=True),patch('graph.providers.build_chat',return_value=bound):
            graph._llm({'version':'settlement-binding','primary':{}},role,domains=domains,tool_scope=allowed)
        assert bound.names==allowed
        assert ('prepare_claim_settlement' in bound.names)==(role=='ClaimsManager')
        assert ('pay_authorized_claim' in bound.names)==(role=='Finance')


def test_prepare_approved_register_claim_without_adoption_approval_or_payment():
    prepared=_workspace(claim={'status':'Approved'},settlement={'payees':[PAYEE]},can={'verify_payees':True})
    client=manager(extra={('GET',WS_PATH):(409,{'detail':'No workflow'}),('POST',WS_PATH+'/settlement/prepare'):prepared})
    out=_call('prepare_claim_settlement',{'claim_number':CLAIM['claim_number']},client,'ClaimsManager')
    assert out['success']
    assert [w['path'] for w in client.writes()]==[WS_PATH+'/settlement/prepare']
    assert 'separate steps' in out['message']
    client=manager(prepared)
    assert _call('prepare_claim_settlement',{'claim_number':CLAIM['claim_number']},client,'ClaimsManager')['success']
    assert not client.writes()


def test_verification_requires_real_missing_evidence_and_resolves_payee_ids():
    ws=_workspace(settlement={'payees':[PAYEE]})
    client=manager(ws)
    out=_call('verify_claim_payees',{'claim_number':CLAIM['claim_number']},client,'ClaimsManager')
    assert out['needs_user_input'] and 'iban' in out['missing_fields'] and not client.writes()
    duplicate={**PAYEE,'id':'payee-2'}
    ws=_workspace(settlement={'payees':[PAYEE,duplicate]})
    client=manager(ws)
    with pytest.raises(ChoiceNeeded):
        _call('verify_claim_payees',{'claim_number':CLAIM['claim_number'],'payee_name':PAYEE['name']},client,'ClaimsManager')
    assert not client.writes()
    saved=_workspace(settlement={'payees':[{**PAYEE,'verified':True},duplicate]})
    client=manager(ws,{('POST',WS_PATH+'/settlement/payees'):saved})
    details={'claim_number':CLAIM['claim_number'],'payee_id':PAYEE['id'],'cnic':'3520211111111','bank_name':'Bank',
             'account_title':PAYEE['name'],'iban':'PK36SCBL0000001123456702','identity_verified_by':'Original CNIC checked'}
    assert _call('verify_claim_payees',details,client,'ClaimsManager')['success']
    assert client.writes()[0]['body']['payees'][0]['id']==PAYEE['id']
    assert len(client.writes())==1


def test_authorisation_needs_live_readiness_and_never_calls_payment():
    client=manager(_workspace(can={'authorize':False}))
    assert not _call('authorize_claim_disbursement',{'claim_number':CLAIM['claim_number']},client,'ClaimsManager')['success']
    assert not client.writes()
    saved=_workspace(settlement={'authorized_at':'2026-10-19','authorized_amount':900000})
    client=manager(_workspace(can={'authorize':True}),{('POST',WS_PATH+'/settlement/authorize'):saved})
    assert _call('authorize_claim_disbursement',{'claim_number':CLAIM['claim_number']},client,'ClaimsManager')['success']
    assert [w['path'] for w in client.writes()]==[WS_PATH+'/settlement/authorize']
    client=manager(saved)
    assert _call('authorize_claim_disbursement',{'claim_number':CLAIM['claim_number']},client,'ClaimsManager')['success']
    assert not client.writes()


def test_finance_payment_register_forwards_filters_and_pages_without_writing():
    client=FakeClient({('GET','/claims/payments'):{'total':42,'items':[{'id':'p','claim_number':'CLM-1','reference_number':'BANK-1','status':'Settled','amount':1000,'medical':'private'}]}})
    args={'search':'BANK-1','payment_status':'Settled','offset':25,'limit':25}
    out=_call('list_finance_payments',args,client,'Finance')
    assert out['success'] and out['total']==42
    assert client.calls[0]['params']==args and not client.writes()
    assert 'medical' not in out['payments'][0]


@pytest.mark.parametrize('references',[{}, {'reference_number':'invented-for-one-only'}, {'payee_references':{'a':'ONE'}}, {'payee_references':{'a':'DUP','b':'DUP'}}])
def test_split_payment_cannot_record_without_each_actual_reference(references):
    ws={**FIN_WS,'settlement':{**FIN_WS['settlement'],'payees':[{'id':'a','verified':True},{'id':'b','verified':True}]}}
    client=finance_service(ws)
    out=_call('pay_authorized_claim',{'claim_number':FIN_CLAIM['claim_number'],'method':'Bank Transfer',**references},client,'Finance')
    assert not out['success'] and not client.writes()


def test_finance_records_actual_split_references_without_transferring_or_reconciling():
    ws={**FIN_WS,'settlement':{**FIN_WS['settlement'],'payees':[{'id':'a','verified':True},{'id':'b','verified':True}]}}
    saved={**ws,'settlement':{**ws['settlement'],'disbursed_at':'2026-10-19','payouts':[{'reference_number':'BANK-A'},{'reference_number':'BANK-B'}]}}
    client=finance_service(ws,{('POST',FIN_PATH+'/settlement/disburse'):saved})
    refs={'a':'BANK-A','b':'BANK-B'}
    out=_call('pay_authorized_claim',{'claim_number':FIN_CLAIM['claim_number'],'method':'Bank Transfer','payee_references':refs,'note':'Bank receipts checked'},client,'Finance')
    assert out['success'] and 'No bank transfer' in out['message']
    assert client.writes()[0]['body']=={'method':'Bank Transfer','payee_references':refs,'note':'Bank receipts checked'}
    assert len(client.writes())==1


@pytest.mark.parametrize('role,tool',[('ClaimsManager','prepare_claim_settlement'),('Finance','pay_authorized_claim')])
def test_read_only_request_blocks_a_proposed_mutation(role,tool):
    async def run():
        model=AsyncMock(); model.ainvoke.side_effect=[call(tool),AIMessage(content='Current settlement status only.')]
        executor=AsyncMock()
        with patch('graph._llm',return_value=model),patch('providers.resolve',AsyncMock(return_value={})),patch('graph.execute_tool',executor):
            await graph.build_graph(MemorySaver()).ainvoke(initial('Read-only: show claim settlement payment status',role),{'configurable':{'thread_id':'settlement-read-'+role}})
        executor.assert_not_called()
    asyncio.run(run())
