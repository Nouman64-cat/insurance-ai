"""External payments are recorded with real references and visible only to tenant Finance."""
import asyncio
from datetime import datetime, date
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlmodel import select, delete
from database import _session_factory, get_session, engine
from routers import claims, claim_workflow as workflow
from routers.auth import create_access_token
from shared.models.core import Claim, ClaimPayout, ClaimProcess, ClaimStatusEnum, Artifact, User, Role
from test_group_census import _setup
from test_specialist_claim_documents import cleanup_claim_test


@pytest.mark.parametrize("multiple", [False, True])
def test_finance_records_external_reference_and_paid_status_without_duplicate(monkeypatch, multiple):
    async def cleared(*a):
        return None
    monkeypatch.setattr(workflow, '_assert_underwriting_cleared', cleared)
    async def workspace(session, policy, claim, proc):
        return {'claim': {'status': claim.status.value}, 'settlement': {'payouts': await workflow._payouts(session, claim)}}
    monkeypatch.setattr(workflow, '_workspace', workspace)
    monkeypatch.setattr(workflow, '_publish', cleared)

    async def run():
        async with _session_factory() as session:
            fx = await _setup(session)
            try:
                users = {}
                for name in ('Finance', 'ClaimsManager'):
                    role = (await session.exec(select(Role).where(Role.name == name))).first()
                    user = User(tenant_id=fx['tenant_id'], role_id=role.id, email=f'{uuid4().hex}@test.invalid',
                        username=uuid4().hex, hashed_password='not-a-password', full_name=f'Test {name}')
                    session.add(user); await session.flush(); users[name] = user
                claim = Claim(tenant_id=fx['tenant_id'], policy_id=fx['individual_policy'], claim_type='Death Claim',
                    claim_number=f'CLM-FIN-{uuid4().hex[:8]}', claimant_name='Verified payee', submitted_amount=1000,
                    approved_amount=1000, status=ClaimStatusEnum.APPROVED)
                session.add(claim); await session.flush()
                proc = ClaimProcess(tenant_id=fx['tenant_id'], policy_id=claim.policy_id, claim_id=claim.id,
                    category='Death', segment='Individual', event_date=date(2026,10,18), authorized_at=datetime.utcnow(),
                    authorized_amount=1000, payees_json=[{'id':'p1','name':'Verified payee','amount':1000,'verified':True,'share_pct':100}])
                if multiple:
                    proc.payees_json = [{'id':'p1','name':'Verified payee','amount':500,'verified':True,'share_pct':50},
                                        {'id':'p2','name':'Second payee','amount':500,'verified':True,'share_pct':50}]
                session.add(proc)
                session.add(Artifact(tenant_id=fx['tenant_id'], claim_id=claim.id, document_type='Death Certificate', status='Accepted'))
                await session.commit()
                app = FastAPI(); app.include_router(claims.router); app.include_router(workflow.router)
                async def dep():
                    async with _session_factory() as request_session:
                        yield request_session
                app.dependency_overrides[get_session] = dep
                headers = {name: {'Authorization':'Bearer '+create_access_token({'sub':str(u.id)})} for name,u in users.items()}
                register = f"/tenants/{fx['tenant_id']}/claims/payments"
                record = f"/tenants/{fx['tenant_id']}/policies/{claim.policy_id}/claims-management/{claim.id}/settlement/disburse"
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                    assert (await client.get(register)).status_code == 401
                    assert (await client.get(register,headers=headers['ClaimsManager'])).status_code == 403
                    assert (await client.get(f'/tenants/{uuid4()}/claims/payments',headers=headers['Finance'])).status_code == 403
                    assert (await client.post(record,json={'reference_number':'   '},headers=headers['Finance'])).status_code == 422
                    assert (await client.post(record,json={'reference_number':'BANK-EXTERNAL-100'},headers=headers['ClaimsManager'])).status_code == 403
                    # An approved claim still requires settlement authorisation.
                    proc.authorized_at = None; session.add(proc); await session.commit()
                    assert (await client.post(record,json={'reference_number':'BANK-EXTERNAL-100'},headers=headers['Finance'])).status_code == 409
                    proc.authorized_at = datetime.utcnow(); session.add(proc); await session.commit()
                    details = {'reference_number':' BANK-EXTERNAL-100 '} if not multiple else {'payee_references': {'p1':'BANK-EXTERNAL-100-A','p2':'BANK-EXTERNAL-100-B'}}
                    if multiple:
                        bad = await client.post(record,json={'payee_references': {'p1':'DUP','p2':'DUP'}},headers=headers['Finance'])
                        assert bad.status_code == 422
                        bad = await client.post(record,json={'reference_number':'ONE-REFERENCE'},headers=headers['Finance'])
                        assert bad.status_code == 422
                    responses = await asyncio.gather(*(client.post(record,json={'method':'Bank Transfer', **details, 'note':'Confirmed from the bank receipt'},headers=headers['Finance']) for _ in range(2)))
                    assert sorted(r.status_code for r in responses) == [200,409], [r.text for r in responses]
                    response = next(r for r in responses if r.status_code == 200)
                    assert response.json()['claim']['status'] == 'Settled'
                    assert (await client.post(record,json={'reference_number':'BANK-EXTERNAL-100'},headers=headers['Finance'])).status_code == 409
                    listing = await client.get(register,params={'search':'BANK-EXTERNAL-100','payment_status':'Settled'},headers=headers['Finance'])
                    assert listing.status_code == 200, listing.text
                    data = listing.json(); assert data['total'] == (2 if multiple else 1)
                    item = data['items'][0]
                    assert item['reference_number'].startswith('BANK-EXTERNAL-100') and item['status'] == 'Settled'
                    assert 'Confirmed from the bank receipt' in item['notes']
                    assert item['completed_at'] and item['payee_name'] in ('Verified payee','Second payee')
                    assert 'fraud_probability' not in item and 'claimant_cnic' not in item
                    assert (await client.get(register,params={'search':'%'},headers=headers['Finance'])).json()['total'] == 0
                    assert (await client.get(register,params={'offset':2,'limit':1},headers=headers['Finance'])).json()['items'] == []
                    assert (await client.get(register,params={'limit':201},headers=headers['Finance'])).status_code == 422
            finally:
                await session.rollback()
                await session.exec(delete(ClaimPayout).where(ClaimPayout.tenant_id == fx['tenant_id']))
                await session.commit()
                await cleanup_claim_test(session, fx)
        await engine.dispose()
    asyncio.run(run())
