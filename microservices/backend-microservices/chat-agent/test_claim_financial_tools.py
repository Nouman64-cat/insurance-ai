"""Claims-manager claim financial tools: scope, evidence, named records and live verification."""
import pytest
from test_claims_commission_tools import FakeClient, _call
from permission import is_role_allowed
from skills.selector import select
from skills.registry import schema
from tool_executor import ChoiceNeeded
from claims_specialist import CLAIMS_TOOLS, CLAIMS_DOMAINS
from toolsets import tool_names_for

CLAIM={'id':'claim-a','claim_number':'CLM-2026-0001','customer_name':'Synthetic insured'}
REVIEW={'claim_number':'CLM-2026-0001','case_id':'case-a','review':{'assigned_user_name':'Financial Reviewer','status':'IN_REVIEW'},
        'requirements':[{'key':'claim_exclusions','label':'Plan exclusions to check','status':'Required'}],
        'ready_to_clear':False,'checks':{}}
BASE='/claims/claim-a/financial-underwriting'


def service(overrides=None):
    return FakeClient({('GET','/claims'):[CLAIM],('GET',BASE):REVIEW,**(overrides or {})})


@pytest.mark.parametrize('tool',['get_claim_financial_review','record_claim_financial_check'])
def test_claims_manager_has_named_capabilities_bound_to_claims_specialist(tool):
    assert is_role_allowed(tool,'ClaimsManager')
    assert tool in CLAIMS_TOOLS and tool in tool_names_for(CLAIMS_DOMAINS)
    for role in ['Agent','Admin','Viewer','ClaimsAdjuster','Finance','Medical Underwriter','Financial Underwriter']:
        assert not is_role_allowed(tool,role)
    assert schema(tool,'ClaimsManager')['success']


def test_claim_financial_skill_selected_for_claims_manager():
    assert 'claim-financial-underwriting' in select('Review claim financial underwriting exclusions and contestability','ClaimsManager',specialist='claims')


def test_reads_real_claim_requirement_details_without_mutation():
    client=service()
    result=_call('get_claim_financial_review',{'claim_number':CLAIM['claim_number']},client,'ClaimsManager')
    assert result['success'] and result['requirements']==REVIEW['requirements']
    assert 'Plan exclusions to check' in result['message']
    assert not client.writes()


def test_records_only_explicit_finding_and_rationale_then_verifies_backend_result():
    client=service({('POST',BASE+'/checks'):{**REVIEW,'checks':{'claim_exclusions':{'finding':'Clear','note':'Contract and claim evidence checked.'}}}})
    result=_call('record_claim_financial_check',{'claim_number':CLAIM['claim_number'],'key':'claim_exclusions','finding':'Clear','note':'Contract and claim evidence checked.'},client,'ClaimsManager')
    assert result['success']
    assert 'must record the review decision' in result['message']
    assert client.writes()==[{'method':'POST','path':BASE+'/checks','body':{'key':'claim_exclusions','finding':'Clear','note':'Contract and claim evidence checked.'},'params':None}]


def test_nonapplicable_check_or_unverified_save_cannot_claim_success():
    client=service()
    args={'claim_number':CLAIM['claim_number'],'key':'claim_contestability','finding':'Clear','note':'Evidence checked.'}
    assert not _call('record_claim_financial_check',args,client,'ClaimsManager')['success']
    assert not client.writes()
    args['key']='claim_exclusions'
    assert not _call('record_claim_financial_check',args,client,'ClaimsManager')['success']


def test_unknown_reference_does_not_fall_back_to_an_unrelated_single_claim():
    client=service()
    with pytest.raises(LookupError):_call('get_claim_financial_review',{'claim_number':'CLM-DOES-NOT-EXIST'},client,'ClaimsManager')
    assert not client.writes()


def test_ambiguous_names_ask_for_a_verified_claim():
    client=service({('GET','/claims'):[CLAIM,{**CLAIM,'id':'claim-b','claim_number':'CLM-2026-0002'}]})
    with pytest.raises(ChoiceNeeded):_call('get_claim_financial_review',{'claimant_name':'Synthetic insured'},client,'ClaimsManager')
    assert not client.writes()


def test_repeated_identical_finding_is_idempotent_and_does_not_reset_a_decision():
    note='Original evidence checked.'
    client=service({('GET',BASE):{**REVIEW,'review':{'status':'CLEARED'},'checks':{'claim_exclusions':{'finding':'Clear','note':note}}}})
    result=_call('record_claim_financial_check',{'claim_number':CLAIM['claim_number'],'key':'claim_exclusions','finding':'Clear','note':note},client,'ClaimsManager')
    assert result['success'] and not client.writes()
    assert result['review']['status']=='CLEARED'


def test_final_resolution_actions_are_offered_only_to_claims_manager_when_ready():
    from tool_executor import _claim_actions
    claim={"id":"claim-a","claim_number":"CLM-A","status":"Re-Underwriting Required","underwriting_review":{"ready":True}}
    for role in ['Underwriter','Medical Underwriter','Financial Underwriter','ClaimsAdjuster','Admin','SuperAdmin','Finance']:
        assert not any('Resolve underwriting' in c.get('payload','') for c in _claim_actions(claim,role))
    assert any('Resolve underwriting' in c.get('payload','') for c in _claim_actions(claim,'ClaimsManager'))
    claim['underwriting_review']['ready']=False
    assert not any('Resolve underwriting' in c.get('payload','') for c in _claim_actions(claim,'ClaimsManager'))
