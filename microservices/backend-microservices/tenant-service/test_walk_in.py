"""Walk-in lead intake, routing, escalation and status — tenant-service side, against a disposable PostgreSQL database.

Run: docker compose exec -T tenant-service python test_walk_in.py
"""
import os
os.environ["DISABLE_PGVECTOR"] = "true"
os.environ.setdefault("CM_TO_TENANT_KEY", "test-key-" + "y" * 32)
os.environ["GEMINI_API_KEY"] = "test"
import asyncio
import json
import sys
import unittest
from datetime import datetime, timedelta
from uuid import uuid4

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers import walk_in_leads as staff_router
from routers.customer_portal_walkin import router
from services import lead_routing as routing
from shared.models.core import (FamilyGroup, AcquisitionSource, Branch, Case, Customer, InsurancePlan, Policy, Role, Tenant, User, UserStatus, WalkInLead, WalkInLeadEvent)
from shared.security.service_auth import sign

KEY = os.environ["CM_TO_TENANT_KEY"]
DB = "tenant_walkin_test_" + uuid4().hex[:10]
ADMIN = f"postgresql+asyncpg://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}@host.docker.internal:5432"
factory = None
BASE = "/internal/customer-portal/v1/walk-in"


class WalkIn(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.mails = []
        self.mail_ok = True

        async def fake_send(to, subject, body):
            self.mails.append((to, subject))
            return self.mail_ok
        routing._send = fake_send
        self.ai_answer = RuntimeError("ai down")

        async def fake_ai(shortlist, city, plan, category):
            if isinstance(self.ai_answer, Exception):
                raise self.ai_answer
            return self.ai_answer(shortlist) if callable(self.ai_answer) else self.ai_answer
        routing._ask_ai = fake_ai

        async with factory() as s:
            role_agent = (await s.exec(select(Role).where(Role.name == "Agent"))).first() or Role(name="Agent")
            role_admin = (await s.exec(select(Role).where(Role.name == "Admin"))).first() or Role(name="Admin")
            s.add_all([role_agent, role_admin]); await s.flush()
            self.t = Tenant(name=f"T {uuid4()}", code="T" + uuid4().hex[:8]); self.t2 = Tenant(name=f"T2 {uuid4()}", code="U" + uuid4().hex[:8])
            s.add_all([self.t, self.t2]); await s.flush()
            self.lhr = Branch(tenant_id=self.t.id, branch_code="L1", name="Lahore", city="Lahore")
            self.isb = Branch(tenant_id=self.t.id, branch_code="I1", name="Islamabad", city="Islamabad")
            s.add_all([self.lhr, self.isb]); await s.flush()

            def user(tag, role, branch=None, tenant=None, **kw):
                return User(tenant_id=(tenant or self.t).id, role_id=role.id, branch_id=branch.id if branch else None, email=f"{tag}-{uuid4().hex[:6]}@x.test",
                            username=f"{tag}-{uuid4().hex[:6]}", hashed_password="x", full_name=tag, status=UserStatus.ACTIVE, is_active=True,
                            last_login=datetime.utcnow(), **kw)
            self.a_lhr, self.a_isb = user("Lahore Agent", role_agent, self.lhr), user("Isb Agent", role_agent, self.isb)
            self.admin = user("Admin", role_admin)
            self.other = user("Foreign", role_agent, tenant=self.t2)
            s.add_all([self.a_lhr, self.a_isb, self.admin, self.other]); await s.flush()
            self.lhr.manager_user_id = self.a_lhr.id
            self.plan = InsurancePlan(tenant_id=self.t.id, code="TL", label="Term Life", insurance_type="TERM_LIFE", status="Active", entry_age_min=18, entry_age_max=60,
                                      term_min_years=5, term_max_years=30, max_maturity_age=70, max_income_multiple=10)
            self.draft = InsurancePlan(tenant_id=self.t.id, code="DR", label="Draft Plan", insurance_type="TERM_LIFE", status="Draft", entry_age_min=18, entry_age_max=60,
                                       term_min_years=5, term_max_years=30, max_maturity_age=70, max_income_multiple=10)
            self.family = InsurancePlan(tenant_id=self.t.id, code="FM", label="Family Cover", insurance_type="TERM_LIFE", category="Family", status="Active", entry_age_min=18,
                                        entry_age_max=60, term_min_years=1, term_max_years=30, max_maturity_age=70, max_income_multiple=10)
            s.add_all([self.plan, self.draft, self.family]); await s.commit()
        self.app = FastAPI(); self.app.include_router(router); self.app.include_router(staff_router.router)

        async def session_dependency():
            async with factory() as s:
                yield s
        self.app.dependency_overrides[get_session] = session_dependency
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.http.aclose()

    async def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        return await self.http.request(method, path, content=data, headers={**sign(KEY, method, path, data, caller="customer-management"), "Content-Type": "application/json"})

    TOP = ("tenant_id", "email", "request_key", "plan_id", "preferred_contact", "message", "consent", "applicant_type", "household")

    def body(self, **kw):
        prof = dict(first_name="Walk", last_name="In", date_of_birth="1990-05-05", gender="Male", mobile_number="+92 300 1234567", city="Lahore")
        top = dict(tenant_id=str(self.t.id), email="walkin@x.test", request_key="k-" + uuid4().hex[:10], plan_id=str(self.plan.id), preferred_contact="Phone", consent=True)
        for k, v in kw.items():
            (top if k in self.TOP else prof)[k] = v
        return {**top, "profile": prof}

    async def submit(self, **kw):
        r = await self.call("POST", f"{BASE}/leads", self.body(**kw))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    async def lead(self, ref):
        async with factory() as s:
            return (await s.exec(select(WalkInLead).where(WalkInLead.reference == ref))).one()

    # access --------------------------------------------------------------------
    async def test_adapter_requires_signature(self):
        self.assertEqual((await self.http.get(f"{BASE}/plans?tenant_id={self.t.id}")).status_code, 401)

    async def test_plans_are_real_active_rows_without_pricing(self):
        r = await self.call("GET", f"{BASE}/plans?tenant_id={self.t.id}")
        plans = r.json()["plans"]
        self.assertEqual(sorted(p["code"] for p in plans), ["FM", "TL"])          # draft excluded
        self.assertNotIn("base_premium_rate", plans[0]); self.assertNotIn("smoker_factor", plans[0])
        self.assertEqual({p["code"]: p["category"] for p in plans}["FM"], "Family")

    # lead creation -------------------------------------------------------------
    async def test_submit_creates_one_lead_customer_with_plan_and_source(self):
        out = await self.submit()
        self.assertTrue(out["reference"].startswith("WI-"))
        async with factory() as s:
            c = (await s.exec(select(Customer).where(Customer.tenant_id == self.t.id))).one()
            self.assertEqual((c.profile_status.value, c.city, c.details["lead_source"]), ("LEAD", "Lahore", "Digital Walk-In"))
            self.assertEqual(c.details["walk_in"]["plan_label"], "Term Life")
            src = await s.get(AcquisitionSource, c.acquisition_source_id)
            self.assertEqual(src.name, "Digital Walk-In")

    async def test_duplicate_submit_does_not_duplicate(self):
        b = self.body()
        first = (await self.call("POST", f"{BASE}/leads", b)).json()
        again = (await self.call("POST", f"{BASE}/leads", b)).json()
        same_plan_new_key = (await self.call("POST", f"{BASE}/leads", self.body())).json()
        self.assertEqual((first["reference"], again["reference"], same_plan_new_key["reference"]), (first["reference"],) * 3)
        async with factory() as s:
            self.assertEqual(len((await s.exec(select(Customer).where(Customer.tenant_id == self.t.id))).all()), 1)

    async def test_consent_and_validation(self):
        for bad in ({"consent": False}, {"mobile_number": "abc"}, {"email": "nope"}, {"plan_id": str(self.draft.id)}, {"plan_id": str(uuid4())}):
            r = await self.call("POST", f"{BASE}/leads", self.body(**bad))
            self.assertEqual(r.status_code, 422, (bad, r.text))

    async def test_full_profile_is_stored_like_the_staff_form(self):
        await self.submit(cnic="35201-1234567-1", occupation="Engineer", declared_annual_income=2400000, employer_name="Acme", height_cm=175, weight_kg=70,
                          is_smoker=False, beneficiary_first_name="Sara", beneficiary_relationship="Spouse", beneficiary_share=100, credit_score=720,
                          policy_coverage=5000000, policy_term=10, smoking_status="Non-smoker", marital_status="Married")
        async with factory() as s:
            c = (await s.exec(select(Customer).where(Customer.tenant_id == self.t.id))).one()
            self.assertEqual((c.cnic, c.occupation, c.declared_income, c.marital_status.value, c.height_cm), ("35201-1234567-1", "Engineer", 2400000, "Married", 175))
            d = c.details
            self.assertEqual((d["occupation_details"]["employer_name"], d["income_record"]["declared_income"], d["beneficiary"]["first_name"],
                              d["financial_records"]["credit_bureau"]["credit_score"], d["contact"]["email"], d["lifestyle"]["bmi"]),
                             ("Acme", 2400000, "Sara", 720, "walkin@x.test", 22.9))
            self.assertEqual(d["pending_plan"], {"product_name": "Term Life", "insurance_type": "TERM_LIFE", "coverage_amount": 5000000, "term_years": 10})

    async def test_cnic_of_another_customer_is_refused_without_linking(self):
        async with factory() as s:
            s.add(Customer(tenant_id=self.t.id, name="Other", cnic="35201-1234567-1")); await s.commit()
        r = await self.call("POST", f"{BASE}/leads", self.body(cnic="35201-1234567-1"))
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (409, "CNIC_UNAVAILABLE"))

    # family ---------------------------------------------------------------------
    SELF = {"relationship": "Self", "name": "Walk In", "cnic": "35201-1111111-1", "dob": "1985-01-01", "gender": "Male", "occupation": "Engineer", "declared_income": 3000000,
            "is_smoker": False, "height_cm": 175, "weight_kg": 72}
    SPOUSE = {"relationship": "Spouse", "name": "Sara In", "is_insured": True, "cnic": "35201-7654321-2", "dob": "1992-02-02", "gender": "Female", "occupation": "Teacher",
              "declared_income": 900000, "share_pct": 50}
    KID = {"relationship": "Child", "name": "Ali In", "dob": "2015-03-03", "share_pct": 25}
    FAM = {"family_name": "Walk Family", "contact_person": "Walk In", "contact_phone": "+92 300 1234567", "household_declared_income": 3000000, "city": "Lahore",
           "province": "Punjab", "policy_type": "Floater", "total_sum_insured": 5000000, "term_years": 1, "effective_date": "2026-11-01",
           "members": [SELF, SPOUSE, KID, {**KID, "name": "Zoya In"}]}

    async def submit_family(self, **fam):
        body = self.body(applicant_type="Family", plan_id=str(self.family.id))
        body.pop("profile")
        body["family"] = {**self.FAM, **fam}
        return await self.call("POST", f"{BASE}/leads", body)

    async def test_family_request_creates_one_family_lead_not_customers(self):
        r = await self.submit_family()
        self.assertEqual(r.status_code, 200, r.text)
        lead = await self.lead(r.json()["reference"])
        self.assertEqual((lead.applicant_type, lead.customer_id, lead.routing_status), ("Family", None, "Assigned"))
        async with factory() as s:
            g = await s.get(FamilyGroup, lead.family_group_id)
            self.assertEqual((g.name, g.profile_status.value, g.city, g.province, g.contact_email, g.contact_person, g.assigned_agent_id),
                             ("Walk Family", "LEAD", "Lahore", "Punjab", "walkin@x.test", "Walk In", lead.assigned_agent_id))
            self.assertEqual(g.household_declared_income, 3000000)
            self.assertEqual(len((await s.exec(select(Customer).where(Customer.tenant_id == self.t.id))).all()), 0)       # members are enrolled by the agent
            self.assertEqual((await s.get(AcquisitionSource, g.acquisition_source_id)).user_id, lead.assigned_agent_id)
        # kept in the staff form's own shape, so the agent can enrol from it
        self.assertEqual([m["relationship"] for m in lead.household_json["members"]], ["Self", "Spouse", "Child", "Child"])
        self.assertEqual((lead.household_json["family"]["policy_type"], lead.household_json["members"][0]["is_insured"]), ("Floater", True))
        st = (await self.status())[0]
        self.assertEqual((st["stage"], st["applicant_type"]), ("Agent Assigned", "Family"))
        self.assertIsNone(st["payment"])

    async def test_family_rules_are_the_staff_forms_rules(self):
        m = self.FAM["members"]
        bad = [
            dict(members=[m[0], {**m[1], "share_pct": 10}, m[2], m[3]]),                     # nominee shares != 100
            dict(members=[m[0], m[1], {**m[2], "is_insured": True}, m[3]]),                    # a child cannot be insured: flag ignored, share rule still holds
            dict(members=[m[0], m[1], m[1]]),                                                  # two spouses
            dict(members=[m[1], m[2], m[3]]),                                                  # no head
            dict(members=[m[0]]),                                                              # a family needs two members
            dict(members=[{**m[0], "cnic": None}, m[1], m[2], m[3]]),                          # the head is insured: needs a CNIC
            dict(members=[m[0], {**m[1], "cnic": m[0]["cnic"]}, m[2], m[3]]),                  # same CNIC twice
            dict(total_sum_insured=None),                                                      # a floater needs a sum assured
            dict(policy_type="LifeBundle"),                                                    # a bundle needs each insured member's cover
        ]
        for i, kw in enumerate(bad):
            r = await self.submit_family(**kw)
            if i == 1:
                self.assertEqual(r.status_code, 200)                                           # ignored flag, not an error
                continue
            self.assertEqual(r.status_code, 422, (i, r.text))
        r = await self.call("POST", f"{BASE}/leads", self.body(applicant_type="Family"))        # a family without its form
        self.assertEqual(r.status_code, 422)
        r = await self.call("POST", f"{BASE}/leads", self.body(plan_id=str(self.family.id), email="other@x.test"))     # a family plan as an individual
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (422, "PLAN_FOR_FAMILY"))
        body = self.body(applicant_type="Family", email="third@x.test"); body["family"] = self.FAM                    # an individual plan for a family
        self.assertEqual((await self.call("POST", f"{BASE}/leads", body)).json()["detail"]["code"], "PLAN_NOT_FOR_FAMILY")

    async def test_life_bundle_with_each_members_cover(self):
        members = [{**self.SELF, "coverage_amount": 5000000}, {**self.SPOUSE, "coverage_amount": 2000000}, self.KID, {**self.KID, "name": "Zoya In"}]
        r = await self.submit_family(policy_type="LifeBundle", total_sum_insured=None, discount_percentage=10, members=members)
        self.assertEqual(r.status_code, 200, r.text)

    async def test_family_status_follows_the_group_and_staff_see_the_household(self):
        lead = await self.lead((await self.submit_family()).json()["reference"])
        async with factory() as s:
            g = await s.get(FamilyGroup, lead.family_group_id); g.profile_status = "PROSPECT"; s.add(g); await s.commit()
        self.assertEqual((await self.status())[0]["stage"], "Proposal Being Prepared")
        owner = self.a_lhr if lead.assigned_agent_id == self.a_lhr.id else self.a_isb
        stranger = self.a_isb if owner is self.a_lhr else self.a_lhr
        self.app.dependency_overrides[staff_router.staff] = lambda: (owner, "Agent")
        d = (await self.http.get(f"/tenants/{self.t.id}/walk-in-leads/{lead.id}")).json()
        self.assertEqual((d["applicant_type"], d["household"]["family"]["family_name"], len(d["household"]["members"])), ("Family", "Walk Family", 4))
        self.app.dependency_overrides[staff_router.staff] = lambda: (stranger, "Agent")
        self.assertEqual((await self.http.get(f"/tenants/{self.t.id}/walk-in-leads/{lead.id}")).status_code, 404)

    async def test_family_leads_count_towards_agent_workload(self):
        await self.submit_family()
        async with factory() as s:
            cands = await routing.eligible_agents(s, self.t.id, "Lahore", None)
        self.assertEqual(sorted(c.workload for c in cands), [0, 1])

    # routing -------------------------------------------------------------------
    async def test_ai_choice_is_used_when_valid(self):
        self.ai_answer = lambda sl: {"choice": next(a for a, c in sl.items() if c.user_id == self.a_isb.id), "reason": "fits"}
        ref = (await self.submit())["reference"]
        lead = await self.lead(ref)
        self.assertEqual((lead.routing_status, lead.routing_method, lead.assigned_agent_id), ("Assigned", "ai", self.a_isb.id))

    async def test_ai_failure_or_invalid_choice_falls_back_to_least_workload(self):
        async with factory() as s:                                    # Lahore agent already carries two open leads
            src = await routing.agent_source(s, self.t.id, self.a_lhr.id)
            for i in range(2):
                s.add(Customer(tenant_id=self.t.id, name=f"x{i}", assigned_agent_id=self.a_lhr.id, acquisition_source_id=src.id))
            await s.commit()
        async def load(uid):
            async with factory() as s:
                return len((await s.exec(select(Customer).where(Customer.assigned_agent_id == uid))).all())
        for answer in (RuntimeError("down"), {"choice": "A99"}, {"choice": str(self.other.id)}, None):
            self.ai_answer = answer
            loads = {self.a_isb.id: await load(self.a_isb.id), self.a_lhr.id: await load(self.a_lhr.id)}
            want = min(loads, key=lambda u: (loads[u], u != self.a_lhr.id))   # tie: same city (Lahore) wins
            ref = (await self.submit(email=f"e{uuid4().hex[:5]}@x.test"))["reference"]
            lead = await self.lead(ref)
            self.assertEqual((lead.routing_method, lead.assigned_agent_id), ("deterministic", want), answer)
            self.assertTrue(lead.routing_reason)

    async def test_agent_in_another_tenant_or_inactive_never_chosen(self):
        async with factory() as s:
            a = await s.get(User, self.a_isb.id); a.is_active = False; s.add(a); await s.commit()
        self.ai_answer = lambda sl: {"choice": "A1"}
        lead = await self.lead((await self.submit())["reference"])
        self.assertEqual(lead.assigned_agent_id, self.a_lhr.id)

    async def test_assignment_is_visible_to_the_agent_through_their_source(self):
        lead = await self.lead((await self.submit())["reference"])
        async with factory() as s:
            c = await s.get(Customer, lead.customer_id)
            src = await s.get(AcquisitionSource, c.acquisition_source_id)
            self.assertEqual((c.assigned_agent_id, src.user_id), (lead.assigned_agent_id, lead.assigned_agent_id))

    async def test_no_agents_goes_to_explicit_queue_and_alerts_staff(self):
        async with factory() as s:
            for u in (self.a_lhr, self.a_isb):
                row = await s.get(User, u.id); row.is_active = False; s.add(row)
            await s.commit()
        lead = await self.lead((await self.submit())["reference"])
        self.assertEqual((lead.routing_status, lead.assigned_agent_id), ("Unassigned", None))
        self.assertTrue(any("no available agent" in m[1] for m in self.mails))
        async with factory() as s:
            self.assertEqual(await routing.sweep(factory) is not None, True)
        rows = None
        self.app.dependency_overrides[staff_router.staff] = lambda: (self.admin, "Admin")
        r = await self.http.get(f"/tenants/{self.t.id}/walk-in-leads?queue=unassigned")
        self.assertEqual([x["reference"] for x in r.json()], [lead.reference])

    async def test_agent_notified_and_failed_email_is_retried(self):
        self.mail_ok = False
        lead = await self.lead((await self.submit())["reference"])
        self.assertEqual((lead.notify_status, lead.notify_attempts), ("Failed", 1))
        self.mail_ok = True
        lead_row = lead
        async with factory() as s:
            row = await s.get(WalkInLead, lead_row.id); row.next_notify_at = datetime.utcnow() - timedelta(seconds=1); s.add(row); await s.commit()
        await routing.sweep(factory)
        self.assertEqual((await self.lead(lead.reference)).notify_status, "Sent")

    # acknowledgement / escalation ----------------------------------------------
    async def test_unacknowledged_lead_escalates_to_branch_manager_and_is_queryable(self):
        lead = await self.lead((await self.submit(city="Lahore"))["reference"])
        self.assertIsNone(lead.acknowledged_at)
        late = datetime.utcnow() + timedelta(minutes=routing.ACK_MINUTES + 1)
        await routing.sweep(factory, now=late)
        lead = await self.lead(lead.reference)
        self.assertEqual(lead.routing_status, "Escalated")
        self.assertIn("StaffAlerted", [e.event_type for e in await self.events(lead)])
        self.app.dependency_overrides[staff_router.staff] = lambda: (self.admin, "Admin")
        r = await self.http.get(f"/tenants/{self.t.id}/walk-in-leads?queue=escalated")
        self.assertEqual([x["reference"] for x in r.json()], [lead.reference])

    async def events(self, lead):
        async with factory() as s:
            return (await s.exec(select(WalkInLeadEvent).where(WalkInLeadEvent.walk_in_lead_id == lead.id))).all()

    async def test_acknowledge_stops_escalation_and_agents_only_see_their_own(self):
        lead = await self.lead((await self.submit())["reference"])
        owner = self.a_lhr if lead.assigned_agent_id == self.a_lhr.id else self.a_isb
        stranger = self.a_isb if owner is self.a_lhr else self.a_lhr
        self.app.dependency_overrides[staff_router.staff] = lambda: (stranger, "Agent")
        self.assertEqual((await self.http.post(f"/tenants/{self.t.id}/walk-in-leads/{lead.id}/acknowledge")).status_code, 404)
        self.assertEqual((await self.http.get(f"/tenants/{self.t.id}/walk-in-leads")).json(), [])
        self.app.dependency_overrides[staff_router.staff] = lambda: (owner, "Agent")
        self.assertEqual((await self.http.post(f"/tenants/{self.t.id}/walk-in-leads/{lead.id}/acknowledge")).status_code, 200)
        await routing.sweep(factory, now=datetime.utcnow() + timedelta(days=2))
        self.assertEqual((await self.lead(lead.reference)).routing_status, "Assigned")

    async def test_reassign_validates_eligibility(self):
        lead = await self.lead((await self.submit())["reference"])
        self.app.dependency_overrides[staff_router.staff] = lambda: (self.admin, "Admin")
        url = f"/tenants/{self.t.id}/walk-in-leads/{lead.id}/reassign"
        self.assertEqual((await self.http.post(url, json={"agent_id": str(self.other.id)})).status_code, 422)
        target = self.a_isb if lead.assigned_agent_id == self.a_lhr.id else self.a_lhr
        self.assertEqual((await self.http.post(url, json={"agent_id": str(target.id)})).status_code, 200)
        self.assertEqual((await self.lead(lead.reference)).assigned_agent_id, target.id)

    # status --------------------------------------------------------------------
    async def status(self, email="walkin@x.test"):
        r = await self.call("GET", f"{BASE}/leads?tenant_id={self.t.id}&email={email}")
        return r.json()["leads"]

    async def test_status_follows_real_progress_and_hides_internals(self):
        lead = await self.lead((await self.submit())["reference"])
        st = (await self.status())[0]
        self.assertEqual(st["stage"], "Agent Assigned")
        self.assertIn("name", st["agent"])
        self.assertTrue({"routing_reason", "routing_method", "fraud", "notes"}.isdisjoint(st))
        async with factory() as s:
            row = await s.get(WalkInLead, lead.id); routing.acknowledge(s, row, "agent", "manual"); await s.commit()
        self.assertEqual((await self.status())[0]["stage"], "In Progress")
        async with factory() as s:
            s.add(Policy(tenant_id=self.t.id, customer_id=lead.customer_id, product_name="Term Life", insurance_type="TERM_LIFE", coverage_amount=1, term_years=10, status="Quoted"))
            await s.commit()
        self.assertEqual((await self.status())[0]["stage"], "Proposal Being Prepared")
        async with factory() as s:
            p = (await s.exec(select(Policy).where(Policy.customer_id == lead.customer_id))).one(); p.status = "UnderReview"; s.add(p); await s.commit()
        self.assertEqual((await self.status())[0]["stage"], "Application Under Review")
        async with factory() as s:
            p = (await s.exec(select(Policy).where(Policy.customer_id == lead.customer_id))).one(); p.status = "Issued"; s.add(p); await s.commit()
        self.assertEqual((await self.status())[0]["stage"], "Policy Issued")

    async def test_each_walk_in_sees_only_their_own_requests(self):
        await self.submit(email="one@x.test"); await self.submit(email="two@x.test", first_name="Two")
        self.assertEqual(len(await self.status("one@x.test")), 1)
        self.assertEqual(len(await self.status("nobody@x.test")), 0)

    async def test_existing_customer_is_linked_not_duplicated_and_not_leaked(self):
        async with factory() as s:
            c = Customer(tenant_id=self.t.id, name="Old Client", profile_status="POLICYHOLDER", details={"contact_email": "walkin@x.test"})
            s.add(c); await s.flush()
            s.add(Policy(tenant_id=self.t.id, customer_id=c.id, product_name="Whole", insurance_type="WHOLE_LIFE", coverage_amount=1, term_years=10, status="Active"))
            await s.commit(); cid = c.id
        lead = await self.lead((await self.submit())["reference"])
        self.assertEqual((lead.customer_id, lead.linked_existing), (cid, True))
        self.assertNotEqual((await self.status())[0]["stage"], "Policy Issued")       # their other policy is not revealed
        async with factory() as s:
            c = await s.get(Customer, cid)
            self.assertEqual(c.profile_status.value, "POLICYHOLDER")


if __name__ == "__main__":
    async def create():
        engine = create_async_engine(f"{ADMIN}/postgres", isolation_level="AUTOCOMMIT")
        async with engine.connect() as c:
            await c.execute(text(f'CREATE DATABASE "{DB}"'))
        await engine.dispose()
        target = create_async_engine(f"{ADMIN}/{DB}", poolclass=NullPool)
        async with target.begin() as c:
            await c.run_sync(SQLModel.metadata.create_all)
        return target

    async def drop(target):
        await target.dispose()
        engine = create_async_engine(f"{ADMIN}/postgres", isolation_level="AUTOCOMMIT")
        async with engine.connect() as c:
            await c.execute(text(f'DROP DATABASE IF EXISTS "{DB}" WITH (FORCE)'))
        await engine.dispose()

    target = asyncio.run(create())
    factory = async_sessionmaker(target, class_=AsyncSession, expire_on_commit=False)
    try:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(WalkIn))
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
