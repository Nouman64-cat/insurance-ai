"""Adding members to a floater that already has members (the "Add Family Members" form on a
family that was enrolled earlier) — the batch has no "Self" row, which used to crash confirm
with a 500 (StopIteration) because it assumed Self was always in the batch.

Run with: docker compose exec tenant-service python test_family_addon.py
"""

import asyncio
import random
from datetime import date
from uuid import UUID, uuid4

import httpx
from sqlalchemy import update
from sqlmodel import select

from database import _session_factory
from seeds.insurance_plans_seed import seed_insurance_plans
from shared.models.core import Customer, FamilyGroup, FamilyPolicy, Policy, Tenant
from test_group_census import _cleanup


def _cnic() -> str:
    return f"{random.randint(10000, 99999)}-{random.randint(1000000, 9999999)}-{random.randint(1, 9)}"


def _member(relationship, dob, **extra):
    return {"cnic": _cnic(), "name": f"{relationship} Test", "dob": dob, "gender": "Male", "relationship": relationship,
            "occupation": "Engineer", "declared_income": 1_200_000, "is_smoker": False, "height_cm": 170, "weight_kg": 70, **extra}


async def test_a_later_batch_adds_to_the_existing_floater_pool():
    import main as app_module
    from routers.users import verify_admin

    async with _session_factory() as session:
        tenant = Tenant(name=f"Family Addon {uuid4().hex[:6]}", code=f"FA{uuid4().hex[:6].upper()}")
        session.add(tenant)
        await session.flush()
        await seed_insurance_plans(session, tenant.id)
        await session.commit()
        tid = tenant.id
        app_module.app.dependency_overrides[verify_admin] = lambda: None
        try:
            transport = httpx.ASGITransport(app=app_module.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
                r = await c.post(f"/tenants/{tid}/families", json={"name": "Addon Family"})
                assert r.status_code == 201, r.text
                fam = r.json()["id"]
                r = await c.post(f"/tenants/{tid}/families/{fam}/floater-policies",
                                 json={"total_sum_insured": 5_000_000, "term_years": 1, "effective_date": date.today().isoformat()})
                assert r.status_code == 201, r.text
                fp = r.json()["id"]
                url = f"/tenants/{tid}/families/{fam}/floater-policies/{fp}/members"

                first = await c.post(f"{url}/confirm", json={"members": [_member("Self", "1990-01-01"), _member("Spouse", "1992-02-02")]})
                assert first.status_code == 201, first.text

                # A later batch: one child, no Self row — used to be a 500.
                child = _member("Child", "2015-03-03")
                later = await c.post(f"{url}/confirm", json={"members": [child]})
                assert later.status_code == 201, later.text
                out = later.json()["members"]
                assert len(out) == 1 and out[0]["case_number"]

                shared = (await session.exec(select(Policy).where(Policy.family_policy_id == fp))).all()
                assert len(shared) == 1, "the pool keeps ONE shared policy — the later batch must not create another"
                assert out[0]["policy_id"] == str(shared[0].id)

                # A second Self is still refused (validation, not a crash); an eldest-age change reprices.
                r = await c.post(f"{url}/confirm", json={"members": [_member("Self", "1990-01-01")]})
                assert r.status_code == 422, r.text
            print("PASS test_a_later_batch_adds_to_the_existing_floater_pool")
        finally:
            app_module.app.dependency_overrides.pop(verify_admin, None)
            await session.close()
            from sqlalchemy import delete
            async with _session_factory() as s2:
                # Unhook the family rows from everything that points at them, drop them, then the usual cleanup.
                await s2.exec(update(Customer).where(Customer.tenant_id == tid).values(family_group_id=None))
                await s2.exec(update(Policy).where(Policy.tenant_id == tid).values(family_policy_id=None))
                await s2.exec(update(FamilyGroup).where(FamilyGroup.tenant_id == tid).values(primary_member_customer_id=None))
                await s2.exec(delete(FamilyPolicy).where(FamilyPolicy.tenant_id == tid))
                await s2.exec(delete(FamilyGroup).where(FamilyGroup.tenant_id == tid))
                await s2.commit()
            await _cleanup(session, tid)




# ── Nominee model: only the head and an allowed spouse are insured ───────────────

def test_validation_rules_for_the_nominee_model():
    from family_underwriting import validate_family_members, validate_life_bundle_members

    head = _member("Self", "1985-01-01", is_insured=True)
    spouse = _member("Spouse", "1988-01-01", is_insured=False, share_pct=50)
    kid = {"relationship": "Child", "name": "Kid One", "is_insured": False, "share_pct": 50}   # no CNIC / DOB / income needed
    assert validate_family_members(set(), [head, spouse, kid]).is_valid

    def errors(rows, **kw):
        r = validate_family_members(set(), rows, **kw)
        return r.errors + r.missing_fields

    assert any("total 100%" in e for e in errors([head, {**spouse, "share_pct": 40}, kid]))
    assert any("can only be a nominee" in e for e in errors([head, {**kid, "is_insured": True}, spouse]))
    assert any("missing share_pct" in e for e in errors([head, {k: v for k, v in kid.items() if k != "share_pct"}, spouse]))
    assert any("always insured" in e for e in errors([{**head, "is_insured": False}, spouse]))
    # An insured spouse needs the full underwriting fields; a nominee-only spouse does not.
    assert any("occupation" in e for e in errors([head, {**spouse, "is_insured": True, "occupation": None}, kid]))
    assert not errors([head, {"relationship": "Spouse", "name": "Nominee Spouse", "is_insured": False, "share_pct": 100}])
    # Later batches count what is already recorded.
    assert not errors([kid | {"share_pct": 30}], existing_count=2, has_existing_self=True, existing_share_total=70)
    assert any("total 100%" in e for e in errors([kid | {"share_pct": 40}], existing_count=2, has_existing_self=True, existing_share_total=70))
    # Life bundle: coverage + plan only for insured rows.
    bundle = validate_life_bundle_members(set(), [{**head, "coverage_amount": 5_000_000, "plan_code": "TERM"}, spouse, kid])
    assert bundle.is_valid, bundle
    # Legacy rows (no is_insured / share_pct) still mean "everyone insured", no shares required.
    assert validate_family_members(set(), [_member("Self", "1985-01-01"), _member("Child", "2010-01-01")]).is_valid
    print("PASS test_validation_rules_for_the_nominee_model")


async def test_only_insured_members_get_cases_and_nominees_get_shares():
    import main as app_module
    from routers.users import verify_admin
    from shared.models.core import Beneficiary, Case

    async with _session_factory() as session:
        tenant = Tenant(name=f"Family Nom {uuid4().hex[:6]}", code=f"FN{uuid4().hex[:6].upper()}")
        session.add(tenant)
        await session.flush()
        await seed_insurance_plans(session, tenant.id)
        await session.commit()
        tid = tenant.id
        app_module.app.dependency_overrides[verify_admin] = lambda: None
        try:
            transport = httpx.ASGITransport(app=app_module.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
                fam = (await c.post(f"/tenants/{tid}/families", json={"name": "Share Family"})).json()["id"]
                fp = (await c.post(f"/tenants/{tid}/families/{fam}/floater-policies",
                                   json={"total_sum_insured": 4_000_000, "term_years": 1, "effective_date": date.today().isoformat()})).json()["id"]
                url = f"/tenants/{tid}/families/{fam}/floater-policies/{fp}/members"
                rows = [
                    _member("Self", "1985-01-01", is_insured=True),
                    _member("Spouse", "1988-05-05", is_insured=True, share_pct=50),
                    {"relationship": "Child", "name": "Kid A", "dob": "2015-01-01", "is_insured": False, "share_pct": 25},
                    {"relationship": "Parent", "name": "Parent B", "cnic": "35202-1234567-1", "is_insured": False, "share_pct": 25},
                ]
                bad = await c.post(f"{url}/confirm", json={"members": [{**rows[0]}, {**rows[1], "share_pct": 40}, *rows[2:]]})
                assert bad.status_code == 422 and "total 100%" in bad.text, bad.text

                ok = await c.post(f"{url}/confirm", json={"members": rows})
                assert ok.status_code == 201, ok.text
                data = ok.json()
                assert len(data["members"]) == 2, "only the head and the insured spouse get an underwriting case"
                shares = {n["name"]: (n["share_pct"], n["amount"]) for n in data["nominees"]}
                assert shares["Spouse Test"] == (50.0, 2_000_000.0) and shares["Kid A"] == (25.0, 1_000_000.0)
                kid = next(n for n in data["nominees"] if n["name"] == "Kid A")
                assert kid["is_minor"] and kid["guardian_name"] == "Self Test"

                cases = (await session.exec(select(Case).where(Case.tenant_id == tid))).all()
                assert len(cases) == 2
                got = (await c.get(f"/tenants/{tid}/families/{fam}/family-policies/{fp}/nominees")).json()
                assert got["total_share"] == 100.0 and got["base_amount"] == 4_000_000.0 and len(got["nominees"]) == 3
                # Nominee-only people are not customers.
                members = (await c.get(f"/tenants/{tid}/families/{fam}/members")).json()
                assert sorted(m["name"] for m in members) == ["Self Test", "Spouse Test"]
            print("PASS test_only_insured_members_get_cases_and_nominees_get_shares")
        finally:
            app_module.app.dependency_overrides.pop(verify_admin, None)
            await _drop_family_tenant(session, tid)


async def test_life_bundle_nominees_sit_on_the_heads_policy():
    import main as app_module
    from routers.users import verify_admin
    from seeds.insurance_plans_seed import INSURANCE_PLAN_SEED_DATA
    from shared.models.core import Case

    plan = next(p["code"] for p in INSURANCE_PLAN_SEED_DATA if p.get("insurance_type") in ("TERM_LIFE", "TermLife") or "TERM" in str(p.get("insurance_type")))
    async with _session_factory() as session:
        tenant = Tenant(name=f"Family Bundle {uuid4().hex[:6]}", code=f"FB{uuid4().hex[:6].upper()}")
        session.add(tenant)
        await session.flush()
        await seed_insurance_plans(session, tenant.id)
        await session.commit()
        tid = tenant.id
        app_module.app.dependency_overrides[verify_admin] = lambda: None
        try:
            transport = httpx.ASGITransport(app=app_module.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
                fam = (await c.post(f"/tenants/{tid}/families", json={"name": "Bundle Family"})).json()["id"]
                r = await c.post(f"/tenants/{tid}/families/{fam}/life-bundle-policies",
                                 json={"term_years": 10, "effective_date": date.today().isoformat(), "discount_percentage": 10})
                assert r.status_code == 201, r.text
                fp = r.json()["id"]
                url = f"/tenants/{tid}/families/{fam}/life-bundle-policies/{fp}/members"
                rows = [
                    _member("Self", "1985-01-01", is_insured=True, coverage_amount=6_000_000, plan_code=plan),
                    {"relationship": "Spouse", "name": "Spouse Nominee", "is_insured": False, "share_pct": 60},          # not insured: no cover, no plan
                    {"relationship": "Child", "name": "Kid", "dob": "2016-01-01", "is_insured": False, "share_pct": 40},
                ]
                ok = await c.post(f"{url}/confirm", json={"members": rows})
                assert ok.status_code == 201, ok.text
                data = ok.json()
                assert len(data["members"]) == 1, "only the head is insured and underwritten"
                assert {n["name"]: n["amount"] for n in data["nominees"]} == {"Spouse Nominee": 3_600_000.0, "Kid": 2_400_000.0}
                # The spouse can be insured later, as an add-on, with their own cover — and shares must still total 100%.
                add = await c.post(f"{url}/confirm", json={"members": [_member("Spouse", "1988-05-05", is_insured=True, share_pct=10, coverage_amount=3_000_000, plan_code=plan)]})
                assert add.status_code == 422 and "total 100%" in add.text
            print("PASS test_life_bundle_nominees_sit_on_the_heads_policy")
        finally:
            app_module.app.dependency_overrides.pop(verify_admin, None)
            await _drop_family_tenant(session, tid)


async def test_the_floater_waits_for_the_insured_spouse_before_it_is_approved():
    """Approving the head's case must not approve the family policy while the insured spouse is still being underwritten."""
    import main as app_module
    from routers import cases as cases_router
    from routers.users import verify_admin
    from schemas import CaseStatusUpdate
    from shared.models.core import Case, CaseStatusEnum, Policy

    async with _session_factory() as session:
        tenant = Tenant(name=f"Family Gate {uuid4().hex[:6]}", code=f"FG{uuid4().hex[:6].upper()}")
        session.add(tenant)
        await session.flush()
        await seed_insurance_plans(session, tenant.id)
        await session.commit()
        tid = tenant.id
        app_module.app.dependency_overrides[verify_admin] = lambda: None
        saved = (cases_router._get_current_user, cases_router._role_name)
        try:
            transport = httpx.ASGITransport(app=app_module.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
                fam = (await c.post(f"/tenants/{tid}/families", json={"name": "Gate Family"})).json()["id"]
                fp = (await c.post(f"/tenants/{tid}/families/{fam}/floater-policies",
                                   json={"total_sum_insured": 5_000_000, "term_years": 1, "effective_date": date.today().isoformat()})).json()["id"]
                rows = [_member("Self", "1985-01-01", is_insured=True),
                        _member("Spouse", "1988-05-05", is_insured=True, share_pct=60),
                        {"relationship": "Child", "name": "Kid", "dob": "2016-01-01", "is_insured": False, "share_pct": 40}]
                r = await c.post(f"/tenants/{tid}/families/{fam}/floater-policies/{fp}/members/confirm", json={"members": rows})
                assert r.status_code == 201, r.text
                case_ids = [m["case_id"] for m in r.json()["members"]]
                assert len(case_ids) == 2

                from shared.models.core import Role, User
                async with _session_factory() as s1:
                    role = Role(name=f"GateRole{uuid4().hex[:6]}")
                    s1.add(role)
                    await s1.flush()
                    underwriter = User(tenant_id=tid, role_id=role.id, email=f"{uuid4().hex[:8]}@t.test", username=uuid4().hex[:10],
                                       hashed_password="x", full_name="Gate Underwriter")
                    s1.add(underwriter)
                    await s1.commit()
                    underwriter_id = underwriter.id

                async def _user(token, db):
                    return await db.get(User, underwriter_id)
                async def _role(user, db):
                    return "Admin"
                cases_router._get_current_user, cases_router._role_name = _user, _role

                async def approve(case_id):
                    async with _session_factory() as s2:      # one session per request, like the real thing
                        await cases_router.update_case_status(tid, UUID(case_id), CaseStatusUpdate(status=CaseStatusEnum.APPROVED), s2, "t")

                async def policy_status():
                    async with _session_factory() as s3:
                        p = (await s3.exec(select(Policy).where(Policy.family_policy_id == fp))).first()
                        return getattr(p.status, "value", p.status)

                async with _session_factory() as s4:
                    await s4.exec(update(Policy).where(Policy.family_policy_id == fp).values(status="UnderReview"))
                    await s4.commit()
                await approve(case_ids[0])                                   # the head
                assert await policy_status() == "UnderReview", "the policy must wait for the spouse"
                detail = (await c.get(f"/tenants/{tid}/cases/{case_ids[0]}/detail")).json()
                assert [p["relationship"] for p in detail["family_underwriting_pending"]] == ["Spouse"]
                await approve(case_ids[1])                                   # the spouse
                assert await policy_status() == "Approved"
                done = (await c.get(f"/tenants/{tid}/cases/{case_ids[0]}/detail")).json()
                assert done["family_underwriting_pending"] == []
                # The policy is issued to the head, on the head's case — the spouse's case points there.
                assert done["family_head_case"] is None
                spouse_view = (await c.get(f"/tenants/{tid}/cases/{case_ids[1]}/detail")).json()
                assert spouse_view["family_head_case"]["case_id"] == case_ids[0] and spouse_view["family_head_case"]["name"] == "Self Test"
                # The workspace shows one tab per insured member (head first), each with their relationship.
                tabs = {m["name"]: str(m["relationship"]).lower() for m in spouse_view["family_members"]}
                assert tabs == {"Self Test": "self", "Spouse Test": "spouse"}
            print("PASS test_the_floater_waits_for_the_insured_spouse_before_it_is_approved")
        finally:
            cases_router._get_current_user, cases_router._role_name = saved
            app_module.app.dependency_overrides.pop(verify_admin, None)
            from sqlalchemy import delete as _del
            from shared.models.core import CaseHistory, Role as _Role, User as _User
            await session.close()
            async with _session_factory() as s5:
                await s5.exec(_del(CaseHistory).where(CaseHistory.caseld.in_(select(Case.caseld).where(Case.tenant_id == tid))))
                await s5.exec(_del(_User).where(_User.tenant_id == tid))
                await s5.exec(_del(_Role).where(_Role.name.like("GateRole%")))
                await s5.commit()
            await _drop_family_tenant(session, tid)


async def _drop_family_tenant(session, tid):
    from sqlalchemy import delete
    await session.close()
    async with _session_factory() as s2:
        await s2.exec(update(Customer).where(Customer.tenant_id == tid).values(family_group_id=None))
        await s2.exec(update(Policy).where(Policy.tenant_id == tid).values(family_policy_id=None))
        await s2.exec(update(FamilyGroup).where(FamilyGroup.tenant_id == tid).values(primary_member_customer_id=None))
        await s2.exec(delete(FamilyPolicy).where(FamilyPolicy.tenant_id == tid))
        await s2.exec(delete(FamilyGroup).where(FamilyGroup.tenant_id == tid))
        await s2.commit()
    await _cleanup(session, tid)


async def main():
    test_validation_rules_for_the_nominee_model()
    await test_a_later_batch_adds_to_the_existing_floater_pool()
    await test_only_insured_members_get_cases_and_nominees_get_shares()
    await test_life_bundle_nominees_sit_on_the_heads_policy()
    await test_the_floater_waits_for_the_insured_spouse_before_it_is_approved()


if __name__ == "__main__":
    asyncio.run(main())
