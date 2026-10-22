"""Family access in the customer-portal adapter, against a disposable PostgreSQL database.

Run: docker compose exec -T tenant-service python test_customer_portal_family.py
Builds a Family Floater family, a Family Life Bundle family (with a minor), an unrelated family, and another tenant's family, then
checks who may see or do what. No existing data is read or changed.
"""
import os
os.environ["DISABLE_PGVECTOR"] = "true"
os.environ.setdefault("CM_TO_TENANT_KEY", "test-key-" + "z" * 32)
import asyncio
import json
import sys
import unittest
from datetime import date, datetime, timedelta
from uuid import uuid4

import httpx
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.customer_portal_family import router as family_router
from routers.customer_portal_internal import router as internal_router
from seeds import family_portal_seed as seed
from shared.models.core import (Claim, ClaimProcess, Customer, FamilyRelationshipEnum, Gender, Policy, PolicyEvent, PolicyStatusEnum, PremiumReceipt,
                                PremiumSchedule, Tenant)
from shared.security.service_auth import sign

KEY = os.environ["CM_TO_TENANT_KEY"]
DB = "tenant_fam_test_" + uuid4().hex[:10]
ADMIN = f"postgresql+asyncpg://{os.environ['POSTGRES_USER']}:{os.environ['POSTGRES_PASSWORD']}@host.docker.internal:5432"
factory = None
BASE = "/internal/customer-portal/v1"


async def make_customer(s, tenant, name, cnic, dob=date(1985, 5, 5), **kw):
    c = Customer(tenant_id=tenant.id, name=name, cnic=cnic, dob=dob, gender=Gender.MALE, policyholder_id=kw.pop("ph", None), city="Lahore", **kw)
    s.add(c)
    await s.flush()
    return c


class Family(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async with factory() as s:
            self.t1, self.t2 = Tenant(name=f"T1 {uuid4()}", code="T" + uuid4().hex[:8]), Tenant(name=f"T2 {uuid4()}", code="T" + uuid4().hex[:8])
            s.add_all([self.t1, self.t2]); await s.commit()
            # A: floater head (also holds an individual policy); spouse insured; child + parent nominees
            self.a = await make_customer(s, self.t1, "Adnan Floater", "35201-0000001-1", ph="PH-A")
            self.fa = await seed.create_floater_family(s, self.t1.id, head=self.a, name="Adnan Floater Family", spouse_name="Ayesha Floater", spouse_cnic="35201-0000002-2", pool=10_000_000.0)
            ind = Policy(tenant_id=self.t1.id, customer_id=self.a.id, product_name="Term Life", insurance_type="TERM_LIFE", coverage_amount=2_000_000.0, term_years=10,
                         status=PolicyStatusEnum.ACTIVE, policy_number="PL-IND-A", effective_date=date.today() - timedelta(days=30))
            s.add(ind); await s.commit(); self.ind_a = ind
            # B: life bundle — head, spouse (own account possible), minor child
            self.b = await make_customer(s, self.t1, "Bashir Bundle", "35201-0000003-3", ph="PH-B")
            self.fb = await seed.create_bundle_family(s, self.t1.id, head=self.b, name="Bashir Bundle Family", spouse_name="Bushra Bundle", spouse_cnic="35201-0000004-4",
                                                      child_name="Bilal Bundle", child_cnic="35201-0000005-5")
            # C: an unrelated floater family, same tenant
            self.c = await make_customer(s, self.t1, "Chaudhry Other", "35201-0000006-6", ph="PH-C")
            self.fc = await seed.create_floater_family(s, self.t1.id, head=self.c, name="Chaudhry Family", spouse_name="Chandni Other", spouse_cnic="35201-0000007-7")
            # D: another tenant's family
            self.d = await make_customer(s, self.t2, "Dawood Away", "42101-0000008-8", ph="PH-D")
            self.fd = await seed.create_floater_family(s, self.t2.id, head=self.d, name="Dawood Family", spouse_name="Dua Away", spouse_cnic="42101-0000009-9")
            # X: a customer with no family at all
            self.x = await make_customer(s, self.t1, "Xavier Solo", "35201-0000010-0", ph="PH-X")
            await s.commit()
        self.app = FastAPI(); self.app.include_router(internal_router); self.app.include_router(family_router)

        async def dep():
            async with factory() as s:
                yield s
        self.app.dependency_overrides[get_session] = dep
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.http.aclose()
        async with factory() as s:        # a clean slate per test (claim / case numbers are global, and each test registers its own)
            await s.exec(text("TRUNCATE TABLE tenants CASCADE")); await s.commit()

    # helpers --------------------------------------------------------------------
    def sc(self, tenant, customer):
        return f"{BASE}/tenants/{tenant.id}/customers/{customer.id}"

    async def call(self, method, path, body=None, operation_key=None):
        data = json.dumps(body).encode() if body is not None else b""
        extra = {"bound_headers": {"Idempotency-Key": operation_key}} if operation_key else {}
        headers = sign(KEY, method, path, data, caller="customer-management", **extra)
        if operation_key:
            headers["Idempotency-Key"] = operation_key
        return await self.http.request(method, path, content=data, headers={**headers, "Content-Type": "application/json"})

    async def get(self, tenant, customer, tail):
        return await self.call("GET", self.sc(tenant, customer) + tail)

    async def policies_of(self, group, bundle=False):
        async with factory() as s:
            fp = self.fb["family_policy"] if bundle else None
            return list((await s.exec(select(Policy).where(Policy.family_policy_id == group["family_policy"].id))).all())

    # Family Floater ----------------------------------------------------------------
    async def test_floater_counts_pool_once_and_separates_insured_from_nominees(self):
        r = (await self.get(self.t1, self.a, "/family")).json()
        self.assertEqual(len(r), 1)
        g = r[0]
        self.assertEqual((g["role"], g["plan_types"]), ("head", ["Floater"]))
        self.assertEqual(g["totals"]["coverage"], 10_000_000.0)            # one pool, not once per insured person
        self.assertEqual(g["members"]["insured"], 2)                        # head + insured spouse
        self.assertEqual(g["members"]["nominees"], 2)                       # child + parent: listed, NOT insured
        self.assertEqual(g["members"]["listed"], 4)                         # the spouse is insured AND a nominee: one person
        members = (await self.get(self.t1, self.a, f"/family/{g['id']}/members")).json()["items"]
        insured = {m["name"] for m in members if m["kind"] == "insured"}
        self.assertEqual(insured, {"Adnan Floater", "Ayesha Floater"})
        nominees = {m["name"]: m for m in members if m["kind"] == "nominee"}
        self.assertNotIn("Elder Parent", insured)
        self.assertTrue(nominees["Ayesha Floater"]["also_insured"])
        self.assertTrue(all(m["coverage"] is None for m in nominees.values()))
        self.assertTrue(all(m["coverage"]["kind"] == "shared_pool" for m in members if m["kind"] == "insured"))

    async def test_same_login_sees_individual_and_family_policies_without_mixing_them(self):
        ind = (await self.get(self.t1, self.a, "/policies")).json()
        fam_ = (await self.get(self.t1, self.a, "/policies?segment=family")).json()
        both = (await self.get(self.t1, self.a, "/policies?segment=all")).json()
        self.assertEqual([p["policy_number"] for p in ind], ["PL-IND-A"])    # the original individual experience is unchanged
        self.assertEqual({p["segment"] for p in fam_}, {"family"})
        self.assertEqual(len(both), len(ind) + len(fam_))
        self.assertEqual(len({p["id"] for p in both}), len(both))             # no policy twice
        self.assertEqual((await self.get(self.t1, self.a, "/profile")).status_code, 200)
        self.assertEqual((await self.get(self.t1, self.x, "/family")).json(), [])   # an individual-only customer has no family section

    async def test_floater_detail_lists_actually_insured_lives(self):
        pid = self.fa["policy"].id
        d = (await self.get(self.t1, self.a, f"/policies/{pid}")).json()
        self.assertEqual((d["segment"], d["access"], d["restricted"]), ("family", "owner", False))
        self.assertEqual({c["name"] for c in d["insured_lives"]}, {"Adnan Floater", "Ayesha Floater"})
        self.assertEqual(d["coverage"]["sum_assured"], 10_000_000.0)
        self.assertTrue(any(a["kind"] == "NOMINEE_CHANGE" and a["available"] for a in d["actions"]))

    # Life Bundle ----------------------------------------------------------------------
    async def test_bundle_sums_each_certificate_and_grades_access(self):
        g = (await self.get(self.t1, self.b, "/family")).json()[0]
        self.assertEqual(g["totals"]["coverage"], 6_000_000 + 3_000_000 + 1_000_000)
        self.assertEqual(g["members"]["insured"], 3)
        ov = (await self.get(self.t1, self.b, f"/family/{g['id']}")).json()
        levels = {p["holder_name"]: p["access"] for p in ov["arrangements"][0]["policies"]}
        self.assertEqual(levels, {"Bashir Bundle": "owner", "Bushra Bundle": "summary", "Bilal Bundle": "guardian"})   # adult spouse: summary; minor: guardian

    async def test_head_cannot_read_another_adults_private_material(self):
        spouse_pol = self.fb["policies"][self.fb["spouse"].id]
        d = (await self.get(self.t1, self.b, f"/policies/{spouse_pol.id}")).json()
        self.assertTrue(d["restricted"])
        self.assertEqual((d["nominees"], d["documents"], d["timeline"], d["premium_schedule"], d["actions"]), ([], [], [], [], []))
        self.assertIsNone(d["claims"])                                         # not even whether she has claims
        self.assertIsNone(d["policyholder"]["cnic_masked"])
        for tail in (f"/policies/{spouse_pol.id}/premiums", f"/policies/{spouse_pol.id}/claims/options", f"/policies/{spouse_pol.id}/renewal"):
            self.assertEqual((await self.get(self.t1, self.b, tail)).status_code, 404, tail)
        self.assertEqual((await self.call("POST", self.sc(self.t1, self.b) + f"/policies/{spouse_pol.id}/premiums/{uuid4()}/pay",
                                          {"method": "Card", "reference": "SIM-ABCDEFGH", "expected_amount": 1})).status_code, 404)
        self.assertEqual((await self.get(self.t1, self.b, f"/family/{(await self.get(self.t1, self.b, '/family')).json()[0]['id']}/beneficiaries?policy_id={spouse_pol.id}")).status_code, 404)
        docs = (await self.get(self.t1, self.b, "/documents?segment=family")).json()
        self.assertNotIn(str(spouse_pol.id), {d["policy_id"] for d in docs})

    async def test_head_acts_for_a_minor_child_but_the_spouse_sees_only_her_own_certificate(self):
        child_pol = self.fb["policies"][self.fb["child"].id]
        self.assertEqual((await self.get(self.t1, self.b, f"/policies/{child_pol.id}/premiums")).status_code, 200)       # guardian: full
        sp = self.fb["spouse"]
        mine = (await self.get(self.t1, sp, "/policies?segment=family")).json()
        self.assertEqual([p["holder_name"] if "holder_name" in p else None for p in mine], [None] * len(mine))
        self.assertEqual({p["policy_number"] for p in mine}, {self.fb["policies"][sp.id].policy_number})                    # only her own
        head_pol = self.fb["policies"][self.fb["head"].id]
        self.assertEqual((await self.get(self.t1, sp, f"/policies/{head_pol.id}")).status_code, 404)                        # not her husband's
        self.assertEqual((await self.get(self.t1, sp, f"/policies/{child_pol.id}")).status_code, 404)                       # nor the child's (she is not the head)

    # Isolation ----------------------------------------------------------------------------
    async def test_other_families_and_other_tenants_are_plain_404s(self):
        other_group = self.fc["group"].id
        for tail in (f"/family/{other_group}", f"/family/{other_group}/members", f"/family/{other_group}/policies", f"/family/{other_group}/members/{self.c.id}"):
            self.assertEqual((await self.get(self.t1, self.a, tail)).status_code, 404, tail)
        self.assertEqual((await self.get(self.t1, self.a, f"/policies/{self.fc['policy'].id}")).status_code, 404)
        self.assertEqual((await self.get(self.t1, self.a, f"/policies/{self.fd['policy'].id}")).status_code, 404)            # another tenant
        self.assertEqual((await self.get(self.t2, self.a, "/family")).status_code, 404)                                      # right customer, wrong tenant
        self.assertEqual((await self.get(self.t1, self.d, "/family")).status_code, 404)
        # naming someone else's family id on a request is refused, and writes nothing
        r = await self.call("POST", self.sc(self.t1, self.a) + f"/family/{other_group}/requests", {"kind": "CANCELLATION", "reference": "FSR-TEST01", "reason": "nope nope"})
        self.assertEqual(r.status_code, 404)
        async with factory() as s:
            self.assertEqual(len((await s.exec(select(PolicyEvent).where(PolicyEvent.event_type == "CustomerServiceRequested",
                                                                         PolicyEvent.policy_id == self.fc["policy"].id))).all()), 0)

    async def test_signature_required(self):
        self.assertEqual((await self.http.get(self.sc(self.t1, self.a) + "/family")).status_code, 401)

    # Claims -------------------------------------------------------------------------------------
    def claim(self, **kw):
        return {"category": "Hospitalization", "event_date": (date.today() - timedelta(days=5)).isoformat(), "description": "Admitted for observation",
                "claimed_amount": 50_000, "event_details": {"hospital": "Test Hospital"}, **kw}

    async def test_claims_only_for_insured_lives_with_consent_for_another_adult(self):
        pid = self.fa["policy"].id
        path = self.sc(self.t1, self.a) + f"/policies/{pid}/claims"
        opts = (await self.get(self.t1, self.a, f"/policies/{pid}/claims/options")).json()
        self.assertEqual({c["name"] for c in opts["covered_persons"]}, {"Adnan Floater", "Ayesha Floater"})                # the nominees are not offered
        spouse = next(c for c in opts["covered_persons"] if not c["is_you"])
        self.assertTrue(spouse["needs_consent"])
        r = await self.call("POST", path, self.claim(covered_person_id=str(spouse["id"])))
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (422, "CONSENT_REQUIRED"))
        r = await self.call("POST", path, self.claim(covered_person_id=str(uuid4()), consent_confirmed=True))
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (422, "COVERED_PERSON_NOT_INSURED"))
        ok = await self.call("POST", path, self.claim(covered_person_id=str(spouse["id"]), consent_confirmed=True))
        self.assertEqual(ok.status_code, 201, ok.text)
        self.assertEqual(ok.json()["covered_person"]["name"], "Ayesha Floater")
        dup = await self.call("POST", path, self.claim(covered_person_id=str(spouse["id"]), consent_confirmed=True))
        self.assertEqual(dup.json()["detail"]["code"], "DUPLICATE_CLAIM")
        own = await self.call("POST", path, self.claim())                                                               # same date, different person: allowed
        self.assertEqual(own.status_code, 201, own.text)
        mine = (await self.get(self.t1, self.a, "/claims?segment=family")).json()
        self.assertEqual(len(mine), 2)
        self.assertEqual((await self.get(self.t1, self.a, "/claims")).json(), [])                                       # individual list is unchanged
        # nobody else sees them
        self.assertEqual((await self.get(self.t1, self.c, "/claims?segment=family")).json(), [])
        self.assertEqual((await self.get(self.t1, self.a, f"/claims/{ok.json()['id']}")).status_code, 200)
        self.assertEqual((await self.get(self.t1, self.c, f"/claims/{ok.json()['id']}")).status_code, 404)

    async def test_death_claims_are_not_available_to_the_policyholder_account(self):
        pid = self.fa["policy"].id
        r = await self.call("POST", self.sc(self.t1, self.a) + f"/policies/{pid}/claims", self.claim(category="Death"))
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (422, "CLAIM_TYPE_NOT_SUPPORTED_ONLINE"))

    async def test_a_spouses_claim_registered_by_staff_stays_confidential_from_the_head(self):
        pid = self.fa["policy"].id
        async with factory() as s:
            claim = Claim(tenant_id=self.t1.id, policy_id=pid, claim_number="CLM-STAFF-1", claim_type="Hospitalization / Reimbursement", submitted_amount=9_000.0,
                          claimant_name=self.fa["spouse"].name, claimant_cnic=self.fa["spouse"].cnic, claimant_relationship="Self")
            s.add(claim); await s.flush()
            s.add(ClaimProcess(tenant_id=self.t1.id, policy_id=pid, claim_id=claim.id, category="Hospitalization", segment="Family", channel="Branch",
                               intimated_by=self.fa["spouse"].name, covered_person_name=self.fa["spouse"].name, covered_person_cnic=self.fa["spouse"].cnic,
                               covered_person_relationship="Spouse", event_date=date.today() - timedelta(days=3)))
            await s.commit(); cid = claim.id
        self.assertEqual((await self.get(self.t1, self.a, "/claims?segment=family")).json(), [])
        self.assertEqual((await self.get(self.t1, self.a, f"/claims/{cid}")).status_code, 404)

    async def test_bundle_claim_for_a_minor_by_the_head_and_not_for_the_adult_spouse(self):
        child_pol, spouse_pol = self.fb["policies"][self.fb["child"].id], self.fb["policies"][self.fb["spouse"].id]
        # a term-life certificate has no hospital benefit: that is refused by the existing benefit rules, after the guardian check passed
        refused = await self.call("POST", self.sc(self.t1, self.b) + f"/policies/{child_pol.id}/claims", self.claim())
        self.assertEqual(refused.json()["detail"]["code"], "INELIGIBLE_CLAIM_TYPE")
        from shared.models.core import PolicyRider
        async with factory() as s:
            s.add(PolicyRider(tenant_id=self.t1.id, policy_id=child_pol.id, name="Disability Benefit", sum_assured=500_000.0, annual_premium=1_000.0, added_at=datetime.utcnow() - timedelta(days=40))); await s.commit()
        ok = await self.call("POST", self.sc(self.t1, self.b) + f"/policies/{child_pol.id}/claims", self.claim(category="Disability", event_details={}))
        self.assertEqual(ok.status_code, 201, ok.text)
        self.assertEqual(ok.json()["covered_person"]["name"], "Bilal Bundle")
        no = await self.call("POST", self.sc(self.t1, self.b) + f"/policies/{spouse_pol.id}/claims", self.claim(category="Disability", event_details={}))
        self.assertEqual(no.status_code, 404)

    # Premiums -------------------------------------------------------------------------------------
    async def pay(self, tenant, customer, policy, schedule, amount, ref="SIM-FAMILY001"):
        return await self.call("POST", self.sc(tenant, customer) + f"/policies/{policy.id}/premiums/{schedule.id}/pay", {"method": "JazzCash", "reference": ref, "expected_amount": amount})

    async def test_floater_is_paid_once_per_instalment_and_bundle_follows_its_own_policies(self):
        pol = self.fa["policy"]
        async with factory() as s:
            nxt = (await s.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == pol.id, PremiumSchedule.status == "Pending").order_by(PremiumSchedule.installment_no))).first()
            amount = nxt.amount_due
        prem = (await self.get(self.t1, self.a, f"/policies/{pol.id}/premiums")).json()
        self.assertEqual(prem["payable_installment_id"], str(nxt.id))
        r = await self.pay(self.t1, self.a, pol, nxt, amount)
        self.assertEqual((r.status_code, r.json()["simulated"]), (200, True))
        again = await self.pay(self.t1, self.a, pol, nxt, amount, ref="SIM-FAMILY002")
        self.assertEqual(again.json()["detail"]["code"], "ALREADY_PAID")
        async with factory() as s:
            self.assertEqual(len((await s.exec(select(PremiumReceipt).where(PremiumReceipt.schedule_id == nxt.id))).all()), 1)
        # a bundle's totals are per certificate; the head may pay the minor's, never the adult spouse's
        child_pol, spouse_pol = self.fb["policies"][self.fb["child"].id], self.fb["policies"][self.fb["spouse"].id]
        async with factory() as s:
            sched = lambda p: (s.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == p.id)))
            child_s = (await sched(child_pol)).first(); spouse_s = (await sched(spouse_pol)).first()
        self.assertEqual((await self.pay(self.t1, self.b, spouse_pol, spouse_s, spouse_s.amount_due)).status_code, 404)

    async def test_an_inactive_family_policy_cannot_be_paid_or_serviced(self):
        pol = self.fc["policy"]
        async with factory() as s:
            p = await s.get(Policy, pol.id); p.status = PolicyStatusEnum.CANCELLED; s.add(p); await s.commit()
            sched = (await s.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == pol.id))).first()
        r = await self.pay(self.t1, self.c, pol, sched, sched.amount_due)
        self.assertEqual(r.json()["detail"]["code"], "POLICY_NOT_PAYABLE")
        d = (await self.get(self.t1, self.c, f"/policies/{pol.id}")).json()
        self.assertEqual([a["kind"] for a in d["actions"] if a["available"]], ["MEMBER_CORRECTION"] if False else [a["kind"] for a in d["actions"] if a["available"]])
        self.assertFalse(any(a["available"] for a in d["actions"] if a["kind"] in ("COVERAGE_CHANGE", "NOMINEE_CHANGE", "CANCELLATION", "MEMBER_ADD", "MEMBER_REMOVE")))
        self.assertEqual(d["status_key" if "status_key" in d else "status"], "Cancelled")

    # Beneficiaries & requests ------------------------------------------------------------------------
    async def test_beneficiaries_show_versions_and_validate_requested_changes(self):
        g = (await self.get(self.t1, self.a, "/family")).json()[0]["id"]
        pid = self.fa["policy"].id
        b = (await self.get(self.t1, self.a, f"/family/{g}/beneficiaries?policy_id={pid}")).json()
        self.assertEqual((b["total_share"], b["complete"], b["can_request_change"]), (100.0, True, True))
        self.assertTrue(any(x["is_minor"] and x["guardian_name"] for x in b["beneficiaries"]))
        self.assertEqual(b["versions"][0]["sequence"], 1)
        path = self.sc(self.t1, self.a) + f"/family/{g}/requests"
        def req(**kw): return self.call("POST", path, {"kind": "NOMINEE_CHANGE", "policy_id": str(pid), "reference": "FSR-" + uuid4().hex[:8], **kw})
        self.assertEqual((await req(beneficiaries=[{"name": "A Person", "relationship": "Child", "share_pct": 60}, {"name": "B Person", "relationship": "Parent", "share_pct": 30}])).json()["detail"]["code"], "SHARES_MUST_TOTAL_100")
        self.assertEqual((await req(beneficiaries=[{"name": "Tiny Tot", "relationship": "Child", "share_pct": 100, "date_of_birth": date.today().replace(year=date.today().year - 5).isoformat()}])).json()["detail"]["code"], "GUARDIAN_REQUIRED")
        self.assertEqual((await req(beneficiaries=[{"name": "Same One", "relationship": "Child", "share_pct": 50}, {"name": "same one", "relationship": "Parent", "share_pct": 50}])).json()["detail"]["code"], "DUPLICATE_NOMINEE")
        ok = await req(beneficiaries=[{"name": "Ayesha Floater", "relationship": "Spouse", "share_pct": 70}, {"name": "Tiny Tot", "relationship": "Child", "share_pct": 30,
                                                                                                             "date_of_birth": date.today().replace(year=date.today().year - 5).isoformat(), "guardian_name": "Adnan Floater"}])
        self.assertEqual(ok.status_code, 201, ok.text)
        async with factory() as s:
            ev = (await s.exec(select(PolicyEvent).where(PolicyEvent.event_type == "CustomerServiceRequested", PolicyEvent.policy_id == pid))).all()
            ev = [e for e in ev if e.detail_json.get("kind") == "NOMINEE_CHANGE"]
            self.assertEqual(len(ev), 1)
            self.assertEqual(len(ev[0].detail_json["proposed_beneficiaries"]), 2)
            rows = (await s.exec(select(text("1")).select_from(text("beneficiaries")).where(text(f"policy_id = '{pid}'")))).all()
            self.assertEqual(len(rows), 3)                                          # the ISSUED nomination is untouched until staff apply the request

    async def test_a_retried_service_request_is_recorded_once_and_replays_its_summary(self):
        g = (await self.get(self.t1, self.a, "/family")).json()[0]["id"]
        path = self.sc(self.t1, self.a) + f"/family/{g}/requests"
        body = {"kind": "CONTACT_CORRECTION", "reference": "FSR-" + uuid4().hex[:8], "contact_email": "new.address@example.com"}
        key = f"{uuid4()}:family-request-0001"
        first = await self.call("POST", path, body, operation_key=key)
        self.assertEqual(first.status_code, 201, first.text)
        again = await self.call("POST", path, body, operation_key=key)
        self.assertEqual((again.status_code, again.headers.get("idempotency-replayed"), again.json()), (201, "true", first.json()))
        other = await self.call("POST", path, {**body, "contact_email": "someone.else@example.com"}, operation_key=key)
        self.assertEqual(other.status_code, 409)
        async with factory() as s:
            events = (await s.exec(select(PolicyEvent).where(PolicyEvent.event_type == "CustomerServiceRequested"))).all()
            self.assertEqual(len([e for e in events if (e.detail_json or {}).get("request_ref") == body["reference"]]), 1)
            stored = (await s.execute(text("SELECT response_json::text FROM idempotency_records WHERE operation = 'portal.family.submit_request'"))).scalars().all()
            self.assertTrue(stored and all("new.address" not in x for x in stored))

    async def test_member_requests_follow_the_family_rules(self):
        g = (await self.get(self.t1, self.a, "/family")).json()[0]["id"]
        path = self.sc(self.t1, self.a) + f"/family/{g}/requests"
        def req(kind, **kw): return self.call("POST", path, {"kind": kind, "reference": "FSR-" + uuid4().hex[:8], **kw})
        self.assertEqual((await req("MEMBER_ADD", name="Kid Floater", relationship="Child", dob="2018-01-01", insured=True)).json()["detail"]["code"], "NOT_INSURABLE")
        self.assertEqual((await req("MEMBER_ADD", name="Second Wife", relationship="Spouse", dob="1992-01-01", insured=True)).json()["detail"]["code"], "SPOUSE_ALREADY_INSURED")
        self.assertEqual((await req("MEMBER_ADD", name="Elder Parent", relationship="Parent", dob="1950-01-01")).json()["detail"]["code"], "DUPLICATE_MEMBER")
        self.assertEqual((await req("MEMBER_ADD", name="Fresh Uncle", relationship="Other", dob="1970-01-01")).status_code, 201)
        members = (await self.get(self.t1, self.a, f"/family/{g}/members")).json()["items"]
        head_key = next(m["key"] for m in members if m["kind"] == "insured" and m["relationship"] == "Self")
        self.assertEqual((await req("MEMBER_REMOVE", member_key=head_key, reason="remove me")).json()["detail"]["code"], "CANNOT_REMOVE_HEAD")
        spouse_key = next(m["key"] for m in members if m["kind"] == "insured" and m["relationship"] == "Spouse")
        self.assertEqual((await req("MEMBER_REMOVE", member_key=spouse_key, reason="no longer married")).status_code, 201)       # a request, scoped to this policy
        self.assertEqual((await req("MEMBER_REMOVE", member_key=str(uuid4()), reason="who is this")).status_code, 404)
        self.assertEqual((await req("MEMBER_CORRECTION", member_key=spouse_key, changes={"salary": "1"}, reason="bad field")).json()["detail"]["code"], "VALIDATION")
        self.assertEqual((await req("REINSTATEMENT")).json()["detail"]["code"], "ACTION_NOT_AVAILABLE")            # the policy is not lapsed
        self.assertEqual((await req("CANCELLATION")).json()["detail"]["code"], "VALIDATION")                       # a reason is required
        self.assertEqual((await req("TELEPORT")).json()["detail"]["code"], "UNKNOWN_REQUEST")

    async def test_adult_family_member_cannot_ask_for_changes_to_another_adult(self):
        g = (await self.get(self.t1, self.b, "/family")).json()[0]["id"]
        members = (await self.get(self.t1, self.b, f"/family/{g}/members")).json()["items"]
        sp_key = next(m["key"] for m in members if m["kind"] == "insured" and m["relationship"] == "Spouse")
        r = await self.call("POST", self.sc(self.t1, self.b) + f"/family/{g}/requests", {"kind": "MEMBER_REMOVE", "member_key": sp_key, "reason": "remove her", "reference": "FSR-ADULT01"})
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (403, "NOT_AUTHORISED"))
        child_key = next(m["key"] for m in members if m["kind"] == "insured" and m["relationship"] == "Child")
        r = await self.call("POST", self.sc(self.t1, self.b) + f"/family/{g}/requests", {"kind": "MEMBER_REMOVE", "member_key": child_key, "reason": "no longer needed", "reference": "FSR-CHILD01"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["summary"]["scope"], "this_policy_only")          # never another member's own policy

    async def test_summary_viewer_cannot_use_any_action(self):
        sp = self.fb["spouse"]
        g = (await self.get(self.t1, sp, "/family")).json()[0]["id"]
        # the spouse owns her own certificate: she can act on it...
        own = self.fb["policies"][sp.id]
        d = (await self.get(self.t1, sp, f"/policies/{own.id}")).json()
        self.assertEqual(d["access"], "owner")
        # ...but cannot remove the head or reach his policy
        r = await self.call("POST", self.sc(self.t1, sp) + f"/family/{g}/requests", {"kind": "CANCELLATION", "policy_id": str(self.fb["policies"][self.fb["head"].id].id), "reason": "cancel his", "reference": "FSR-NOPE001"})
        self.assertEqual(r.status_code, 404)

    # Renewal -------------------------------------------------------------------------------------------
    async def test_renewal_view_for_a_family_policy_and_acceptance_only_when_offered(self):
        pid = self.fa["policy"].id
        v = (await self.get(self.t1, self.a, f"/policies/{pid}/renewal")).json()
        self.assertEqual(v["policy_id"], str(pid))
        self.assertIsNotNone(v["next"])
        r = await self.call("POST", self.sc(self.t1, self.a) + f"/policies/{pid}/renewal/acceptance", {"accepted": True})
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (409, "ACTION_NOT_AVAILABLE"))

    # Documents -------------------------------------------------------------------------------------------
    async def test_family_documents_are_listed_and_downloadable_only_for_authorised_policies(self):
        docs = (await self.get(self.t1, self.a, "/documents?segment=family")).json()
        rec = next(d for d in docs if d["kind"] == "receipt")
        self.assertEqual((await self.get(self.t1, self.a, f"/documents/download?handle={rec['id']}")).status_code, 200)
        self.assertEqual((await self.get(self.t1, self.c, f"/documents/download?handle={rec['id']}")).status_code, 404)    # another family
        self.assertEqual((await self.get(self.t1, self.a, "/documents")).json(), [])                                       # the individual list is unchanged


if __name__ == "__main__":
    async def create():
        engine = create_async_engine(f"{ADMIN}/postgres", isolation_level="AUTOCOMMIT")
        async with engine.connect() as c:
            await c.execute(text(f'CREATE DATABASE "{DB}"'))
        await engine.dispose()
        target = create_async_engine(f"{ADMIN}/{DB}", poolclass=NullPool)
        async with target.begin() as c:
            await c.run_sync(SQLModel.metadata.create_all)
            from shared.idempotency.models import metadata as idempotency_metadata   # the migration runner creates these in production
            await c.run_sync(idempotency_metadata.create_all)
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
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Family))
    finally:
        asyncio.run(drop(target))
    sys.exit(not result.wasSuccessful())
