"""Approved register claims can be prepared, verified and authorised by their Claims Manager."""
import asyncio
from datetime import date
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlmodel import select
from database import _session_factory, get_session, engine
from routers import claim_workflow as workflow
from routers.auth import create_access_token
from shared.models.core import Claim, ClaimProcess, ClaimStatusEnum, User, Role
from test_group_census import _setup
from test_specialist_claim_documents import cleanup_claim_test


@pytest.mark.parametrize('existing_process', [False, True])
def test_claim_manager_can_unlock_finance_for_approved_legacy_claim(monkeypatch, existing_process):
    async def no_publish(*a): pass
    monkeypatch.setattr(workflow, '_publish', no_publish)
    async def run():
        async with _session_factory() as session:
            fx = await _setup(session)
            try:
                users={}
                for name in ('ClaimsManager','Finance','Admin'):
                    role=(await session.exec(select(Role).where(Role.name==name))).first()
                    user=User(tenant_id=fx['tenant_id'],role_id=role.id,email=f'{uuid4().hex}@test.invalid',username=uuid4().hex,hashed_password='test',full_name=name)
                    session.add(user); await session.flush(); users[name]=user
                claim=Claim(tenant_id=fx['tenant_id'],policy_id=fx['individual_policy'],claim_type='Hospitalization / Reimbursement',
                    claim_number=f'CLM-APPROVAL-{uuid4().hex[:8]}',claimant_name='Ali Individual',claimant_cnic='3520211111111',
                    claimant_relationship='Self',incident_date=date(2026,10,10),submitted_amount=185000,approved_amount=185000,status=ClaimStatusEnum.APPROVED)
                session.add(claim); await session.flush()
                if existing_process:
                    session.add(ClaimProcess(tenant_id=fx['tenant_id'],policy_id=claim.policy_id,claim_id=claim.id,category='Hospitalization',segment='Individual',event_date=claim.incident_date))
                await session.commit()
                app=FastAPI();app.include_router(workflow.router)
                async def dep():
                    async with _session_factory() as request_session: yield request_session
                app.dependency_overrides[get_session]=dep
                headers={name:{'Authorization':'Bearer '+create_access_token({'sub':str(u.id)})} for name,u in users.items()}
                base=f'/tenants/{fx["tenant_id"]}/policies/{claim.policy_id}/claims-management/{claim.id}'
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
                    for name in ('Finance','Admin'):
                        assert (await client.post(base+'/settlement/prepare',headers=headers[name])).status_code==403
                        assert (await client.post(base+'/settlement/authorize',headers=headers[name])).status_code==403
                    assert (await client.post(base+'/settlement/prepare')).status_code==401
                    response=await client.post(base+'/settlement/prepare',headers=headers['ClaimsManager'])
                    assert response.status_code==200,response.text
                    ws=response.json();payees=ws['settlement']['payees']
                    assert len(payees)==1 and payees[0]['name']=='Ali Individual' and payees[0]['amount']==185000
                    assert not payees[0]['verified'] and not ws['can']['disburse'] and not ws['can']['authorize']
                    assert next(s['key'] for s in ws['stages'] if s['state'] not in ('complete','skipped'))=='settlement'
                    assert ws['eligibility']['verified_at'] is None
                    assert (await client.post(base+'/settlement/authorize',headers=headers['ClaimsManager'])).status_code==409
                    bad=await client.post(base+'/settlement/payees',headers=headers['ClaimsManager'],json={'payees':[{'id':payees[0]['id'],'verify':True}]})
                    assert bad.status_code==400
                    response=await client.post(base+'/settlement/payees',headers=headers['ClaimsManager'],json={'payees':[{'id':payees[0]['id'],
                        'cnic':'3520211111111','bank_name':'Test Bank','account_title':'Ali Individual','iban':'PK36SCBL0000001123456702','method':'Original identity evidence checked','verify':True}]})
                    assert response.status_code==200,response.text
                    assert response.json()['can']['authorize']
                    response=await client.post(base+'/settlement/authorize',headers=headers['ClaimsManager'])
                    assert response.status_code==200,response.text
                    ws=response.json()
                    assert ws['settlement']['authorized_at'] and ws['settlement']['authorized_amount']==185000 and ws['can']['disburse']
                    assert ws['claim']['status']=='Approved'
                    # Preparing again must preserve verified payees and existing authorisation.
                    again=await client.post(base+'/settlement/prepare',headers=headers['ClaimsManager'])
                    assert again.json()['settlement']['authorized_at']==ws['settlement']['authorized_at']
                    assert again.json()['settlement']['payees'][0]['verified']
                    assert (await client.post(base+'/settlement/payees',headers=headers['ClaimsManager'],json={'payees':[{'id':payees[0]['id'],'verify':False}]})).status_code==409
                    assert (await client.post(base+'/settlement/disburse',headers=headers['ClaimsManager'],json={'method':'Bank Transfer'})).status_code==403
                    foreign=base.replace(str(fx['tenant_id']),str(uuid4()))
                    assert (await client.post(foreign+'/settlement/prepare',headers=headers['ClaimsManager'])).status_code==403
            finally:
                await cleanup_claim_test(session,fx)
        await engine.dispose()
    asyncio.run(run())
