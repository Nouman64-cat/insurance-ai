#!/usr/bin/env python3
"""Opt-in authenticated smoke tests against the local Compose services.

Creates explicitly SYNTHETIC users/tenants/policies, performs no payment or
provider change, then removes only those fixtures. JWTs stay in process memory
and never enter the saved report. Run with INSURANCE_SYNTHETIC_LIVE_TESTS=1.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "microservices/backend-microservices/chat-agent/skills/reports/live-smoke-tests.json"

FIXTURE = r'''
import asyncio,json
from datetime import date
from uuid import uuid4
from sqlmodel import select
from database import _session_factory
from routers.auth import create_access_token
from shared.models.core import Tenant,User,Role,Customer,Policy
async def main():
    result={'tenants':[],'users':[],'policies':[],'actors':{},'missing_roles':[]}
    async with _session_factory() as s:
        for i in range(2):
            t=Tenant(name='SYNTHETIC Skill Validation '+uuid4().hex,code='SK'+uuid4().hex[:12]);s.add(t);await s.flush()
            result['tenants'].append(str(t.id))
            c=Customer(tenant_id=t.id,name='SYNTHETIC Skill Test Customer',cnic=f'99999-{uuid4().int%10**7:07d}-9',dob=date(1990,1,1));s.add(c);await s.flush()
            p=Policy(tenant_id=t.id,customer_id=c.id,product_name='SYNTHETIC Test Plan',insurance_type='TERM_LIFE',coverage_amount=100000,term_years=10,status='Proposed');s.add(p);await s.flush()
            result['policies'].append(str(p.id))
            if i==0:
                for name in ['SuperAdmin','Admin','Agent','Underwriter','Medical Underwriter','Financial Underwriter','ClaimsManager','ClaimsAdjuster','CustomerService','Viewer','Finance']:
                    role=(await s.exec(select(Role).where(Role.name==name))).first()
                    if role is None:result['missing_roles'].append(name);continue
                    user=User(tenant_id=t.id,role_id=role.id,email=uuid4().hex+'@synthetic.invalid',username=uuid4().hex,hashed_password='SYNTHETIC-NO-LOGIN',full_name='SYNTHETIC Skill Test '+name)
                    s.add(user);await s.flush();result['users'].append(str(user.id));result['actors'][name]=create_access_token({'sub':str(user.id)})
        await s.commit()
    print(json.dumps(result))
asyncio.run(main())
'''
CLEANUP = r'''
import asyncio,json
from uuid import UUID
from sqlalchemy import delete
from database import _session_factory
from shared.models.core import Tenant,User,Customer,Policy,Role
async def main():
    data=json.loads(PAYLOAD)
    async with _session_factory() as s:
        ids=[UUID(i) for i in data['tenants']]
        for model in (User,Policy,Customer):
            await s.exec(delete(model).where(model.tenant_id.in_(ids)))
        await s.exec(delete(Tenant).where(Tenant.id.in_(ids)))
        if data.get('created_role'):
            await s.exec(delete(Role).where(Role.id==UUID(data['created_role'])))
        if data.get('created_tenant'):
            await s.exec(delete(Tenant).where(Tenant.id==UUID(data['created_tenant'])))
        await s.commit()
    print('SYNTHETIC fixtures removed')
asyncio.run(main())
'''


def in_service(script: str):
    process = subprocess.run(['docker', 'compose', 'exec', '-T', 'tenant-service', 'python', '-'], input=script,
                             text=True, cwd=ROOT, capture_output=True, check=False)
    if process.returncode:
        raise RuntimeError('Synthetic fixture operation failed; inspect tenant-service test diagnostics without printing credentials.')
    return process.stdout.strip()


def main():
    if os.getenv('INSURANCE_SYNTHETIC_LIVE_TESTS') != '1':
        raise SystemExit('Set INSURANCE_SYNTHETIC_LIVE_TESTS=1 to explicitly enable isolated synthetic fixtures.')
    fixture = json.loads(in_service(FIXTURE))
    checks = []
    completed = False
    def call(role, name, arguments, tenant=None):
        body=json.dumps({'name':name,'args':arguments,'platform':'web'}).encode()
        request=urllib.request.Request('http://localhost:8016/chat/execute-tool',data=body,
            headers={'Content-Type':'application/json','X-Tenant-Id':tenant or fixture['tenants'][0],
                     'Authorization':'Bearer '+fixture['actors'][role]})
        try:
            with urllib.request.urlopen(request,timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            return {'success':False,'status_code':error.code}
    try:
        for role in fixture['actors']:
            result=call(role,'search_capabilities',{'query':'claim medical financial premium tenant user'})
            assert result.get('success'), 'Authenticated discovery failed for '+role
            checks.append({'case':'authenticated_discovery','role':role,'passed':True})
        for role in ('Admin','Agent','Underwriter'):
            if role not in fixture['actors']:continue
            result=call(role,'get_initial_premium_status',{'policy_id':fixture['policies'][0]})
            assert result.get('success') and result['result']['status']=='NotStarted'
            checks.append({'case':'proposal_payment_read_owning_service','role':role,'passed':True})
        result=call('Admin','get_initial_premium_status',{'policy_id':fixture['policies'][1]})
        assert result.get('success') is False and result.get('error_code')=='not_found'
        checks.append({'case':'cross_tenant_policy_not_found','passed':True})
        result=call('Viewer','create_platform_tenant',{'name':'SYNTHETIC Forbidden','code':'SKNO'})
        assert result.get('success') is False
        checks.append({'case':'viewer_platform_mutation_denied','passed':True})
        result=call('ClaimsManager','disburse_claim_settlement',{})
        assert result.get('success') is False
        checks.append({'case':'claims_manager_cannot_execute_finance_payment','passed':True})
        # These two mutations create only labeled test configuration and are removed below.
        if 'SuperAdmin' in fixture['actors']:
            from uuid import uuid4
            result=call('SuperAdmin','create_platform_tenant',{'name':'SYNTHETIC Adapter '+uuid4().hex,'code':'SK'+uuid4().hex[:12]})
            assert result.get('success') is True
            fixture['created_tenant']=result['result']['id']
            checks.append({'case':'tenant_creation_owning_service','passed':True})
            result=call('SuperAdmin','manage_platform_role',{'action':'create','name':'SYNTHETIC-'+uuid4().hex[:12],'description':'Synthetic adapter test; removed immediately'})
            assert result.get('success') is True
            fixture['created_role']=result['result']['id']
            checks.append({'case':'global_role_creation_owning_service','passed':True})
        completed = True
    finally:
        cleanup={k:v for k,v in fixture.items() if k!='actors'}
        in_service('PAYLOAD='+repr(json.dumps(cleanup))+'\n'+CLEANUP)
        REPORT.write_text(json.dumps({'synthetic':True,'completed':completed,'fixtures_removed':True,'checks':checks,
                                      'missing_configured_roles':fixture['missing_roles'],
                                      'limitations':['No real-provider natural-language completion test.','No real financial activity.','Model configuration writes and evidence acceptance are tested with isolated HTTP mocks.']},indent=2)+'\n')
    print(f'{len(checks)} authenticated live smoke checks passed; synthetic fixtures removed.')
    if fixture['missing_roles']:
        print('Unconfigured roles skipped: '+', '.join(fixture['missing_roles']))


if __name__=='__main__':
    main()
