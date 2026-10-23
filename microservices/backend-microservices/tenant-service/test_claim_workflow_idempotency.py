"""Claim registration and lifecycle steps are idempotent on real PostgreSQL (run: python -m pytest -q test_claim_workflow_idempotency.py)."""
import asyncio
from datetime import date
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlmodel import select

from database import _session_factory, get_session
from routers import claim_workflow as workflow
from routers.auth import create_access_token
from shared.models.core import Claim, Role, User
from test_group_census import _setup
from test_specialist_claim_documents import cleanup_claim_test


def test_registration_and_lifecycle_steps_are_idempotent(monkeypatch):
    async def no_publish(*a):
        pass
    monkeypatch.setattr(workflow, '_publish', no_publish)

    async def run():
        async with _session_factory() as session:
            fx = await _setup(session)
            try:
                role = (await session.exec(select(Role).where(Role.name == 'ClaimsManager'))).first()
                user = User(tenant_id=fx['tenant_id'], role_id=role.id, email=f'{uuid4().hex}@test.invalid', username=uuid4().hex,
                            hashed_password='test', full_name='Claims Manager')
                session.add(user)
                await session.commit()
                app = FastAPI()
                app.include_router(workflow.router)

                async def dep():
                    async with _session_factory() as s:
                        yield s
                app.dependency_overrides[get_session] = dep
                auth = {'Authorization': 'Bearer ' + create_access_token({'sub': str(user.id)})}
                base = f'/tenants/{fx["tenant_id"]}/policies/{fx["individual_policy"]}/claims-management'
                body = {'category': 'Hospitalization', 'event_date': '2026-10-10', 'claimed_amount': 185000, 'claimant_name': 'Ali Individual',
                        'claimant_relationship': 'Self', 'event_description': 'Admitted with appendicitis', 'channel': 'Branch'}

                async def count(sql, **p):
                    async with _session_factory() as s:
                        return (await s.execute(text(sql), p)).scalar()

                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
                    key = {**auth, 'Idempotency-Key': 'claim-register-operation-1'}
                    first = await c.post(base, json=body, headers=key)
                    assert first.status_code == 201, first.text
                    claim_id = first.json()['claim']['id']
                    replay = await c.post(base, json=body, headers=key)
                    assert replay.status_code == 201 and replay.headers['idempotency-replayed'] == 'true', replay.text
                    assert replay.json()['claim']['id'] == claim_id and replay.json()['claim']['claim_number'] == first.json()['claim']['claim_number']
                    assert await count('SELECT count(*) FROM claims WHERE policy_id = :p', p=fx['individual_policy']) == 1
                    conflict = await c.post(base, json={**body, 'claimed_amount': 999}, headers=key)
                    assert conflict.status_code == 409
                    stored = str(await count("SELECT string_agg(response_json::text, ' ') FROM idempotency_records WHERE operation = 'tenant.claim.register'"))
                    assert 'Ali Individual' not in stored and '185000' not in stored, 'the receipt holds the claim id only'

                    # concurrent identical registrations create one claim
                    k2 = {**auth, 'Idempotency-Key': 'claim-register-operation-2'}
                    other = {**body, 'event_date': '2026-09-01'}
                    rs = await asyncio.gather(*[c.post(base, json=other, headers=k2) for _ in range(5)])
                    assert all(r.status_code in (201, 409) for r in rs), [r.status_code for r in rs]
                    assert sum(r.status_code == 201 for r in rs) >= 1
                    assert await count("SELECT count(*) FROM claims WHERE policy_id = :p AND incident_date = '2026-09-01'", p=fx['individual_policy']) == 1

                    # a lifecycle step: asking for one extra document twice under one key adds one document
                    step = f'{base}/{claim_id}/documents'
                    kd = {**auth, 'Idempotency-Key': 'claim-extra-doc-operation-1'}
                    d1 = await c.post(step, json={'label': 'Discharge summary', 'required': True}, headers=kd)
                    assert d1.status_code == 200, d1.text
                    d2 = await c.post(step, json={'label': 'Discharge summary', 'required': True}, headers=kd)
                    assert d2.status_code == 200 and d2.headers['idempotency-replayed'] == 'true'
                    extras = [d for d in d1.json()['documents']['items'] if d['key'].startswith('extra-')]
                    assert len(extras) == 1
                    d3 = await c.post(step, json={'label': 'Discharge summary', 'required': True}, headers={**auth, 'Idempotency-Key': 'claim-extra-doc-operation-2'})
                    assert d3.status_code == 200
                    assert len([d for d in d3.json()['documents']['items'] if d['key'].startswith('extra-')]) == 2, 'a new key is a new request, even with identical content'
            finally:
                await cleanup_claim_test(session, fx)
    asyncio.run(run())
