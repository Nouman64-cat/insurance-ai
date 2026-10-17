"""Tests for Group Life Phase 5 — claims on group certificates (services/group_claims.py).

Pure rules first (documents, cover limits, eligibility, the payout split and its rule
hook), then the router functions against a live, migrated Postgres like
test_group_issuance.py, cleaning up after themselves.

Run with: docker compose exec tenant-service python test_group_claims.py
"""

import asyncio
from datetime import date
from types import SimpleNamespace
from uuid import UUID

from fastapi import HTTPException
from sqlmodel import delete, select

from database import _session_factory
from routers.group_claims import (
    GroupClaimCreate,
    GroupPayoutRequest,
    SplitOverride,
    SplitRequest,
    default_split,
    group_context,
    group_payout,
    list_scheme_claims,
    open_group_claim,
    preview_split_endpoint,
)
from routers.group_policies import (
    accept_group_quote,
    add_group_dependent,
    generate_group_quote_endpoint,
    issue_master_policy,
    record_group_payment,
    replace_group_beneficiaries,
)
from routers.pre_issuance import BeneficiariesReplace, BeneficiaryIn
from schemas import GroupDependentCreate, GroupPaymentCreate, GroupQuoteDecision
from services.group_claims import (
    ACCIDENTAL_DEATH,
    LIFE,
    SPLIT_RULES,
    Share,
    SplitContext,
    check_eligibility,
    compute_split,
    coverage_schedule,
    missing_documents,
    register_split_rule,
    required_documents,
)
from shared.models.core import (
    Artifact,
    Claim,
    ClaimPayout,
    ClaimStatusEnum,
    ClaimStatusHistory,
    GroupClassCoverage,
    GroupMember,
    GroupMemberDependent,
    Policy,
)
from test_group_census import _add_classes, _census, _cleanup, _enroll, _expect_http, _master_policy, _setup

USER = SimpleNamespace(id=None, full_name="Test Adjuster")
NO_DECISION = GroupQuoteDecision(decided_by="HR Director")


# ═══════════════════════════════════════════════════════════════════════════
# Pure rules
# ═══════════════════════════════════════════════════════════════════════════

def test_required_documents_by_benefit_and_nominee():
    death = required_documents("Death Claim", None)
    assert {"Death Certificate", "CNIC", "Claimant CNIC", "Employer Certificate", "Salary Slip"} <= set(death)
    assert "Succession Certificate" not in death
    assert "Succession Certificate" in required_documents("Death Claim", None, has_nominee=False)
    assert {"Police Report", "Post-Mortem Report"} <= set(required_documents("Accidental Death", None))
    assert "Medical Board Certificate" in required_documents("Disability", None)
    assert "Fee Voucher" in required_documents("Fee Continuation", None)
    assert required_documents("Hospitalization", None)[-1] == "Employer Certificate"        # group files always carry the employer's letter
    assert "Relationship Proof" in required_documents("Death Claim", None, dependent=True)
    assert "Salary Slip" not in required_documents("Death Claim", None, dependent=True)      # a dependant's death isn't about the member's pay


def test_missing_documents_ignores_case_and_extras():
    assert missing_documents(["CNIC", "Salary Slip"], ["cnic", "Random Extra"]) == ["Salary Slip"]
    assert missing_documents(["CNIC"], []) == ["CNIC"]


def test_rider_cover_is_a_capped_percent_of_base():
    cov = [SimpleNamespace(coverage_type="Life", percent_of_base=100, max_amount=None),
           SimpleNamespace(coverage_type="AccidentalDeath", percent_of_base=200, max_amount=15_000_000),
           SimpleNamespace(coverage_type="Disability", percent_of_base=50, max_amount=None)]
    assert coverage_schedule(10_000_000, cov) == {"Life": 10_000_000, "AccidentalDeath": 15_000_000, "Disability": 5_000_000}
    assert coverage_schedule(2_000_000, []) == {"Life": 2_000_000}


def _member(**kw):
    return {"name": "Ali", "status": "Active", "cover_start": date(2026, 1, 1), "cover_end": date(2026, 12, 31),
            "certificate_status": "Active", **kw}


def test_eligibility_rules():
    ok = dict(incident=date(2026, 6, 1), claim_type="Death Claim", coverage_type=None, amount=1_000_000,
              member=_member(), schedule={LIFE: 2_000_000})
    assert check_eligibility(**ok) == []
    assert any("before" in e for e in check_eligibility(**{**ok, "incident": date(2025, 12, 31)}))
    assert any("after" in e and "ended" in e for e in check_eligibility(**{**ok, "incident": date(2027, 1, 1)}))
    assert any("exceeds" in e for e in check_eligibility(**{**ok, "amount": 2_500_000}))
    assert any("isn't in force" in e for e in check_eligibility(**{**ok, "member": _member(status="Pending")}))
    assert any("no ACCIDENTALDEATH" .lower() in e.lower() or "no AccidentalDeath" in e
               for e in check_eligibility(**{**ok, "claim_type": "Accidental Death"}))
    assert check_eligibility(**{**ok, "member": _member(status="Removed", certificate_status="Cancelled", cover_end=date(2026, 9, 30))}) == []   # a leaver's earlier loss is covered
    dep = {"name": "Sara", "status": "Active", "covered_amount": 500_000, "relationship": "Spouse"}
    assert check_eligibility(**{**ok, "dependent": dep, "amount": 400_000}) == []
    assert any("exceeds" in e for e in check_eligibility(**{**ok, "dependent": dep, "amount": 600_000}))
    assert any("not a covered dependant" in e for e in check_eligibility(**{**ok, "dependent": {**dep, "status": "Removed"}}))
    assert any("life cover only" in e for e in check_eligibility(**{**ok, "dependent": dep, "claim_type": "Disability", "schedule": {LIFE: 1, "Disability": 1}}))


def _ctx(**kw):
    return SplitContext(**{"claim_type": "Death Claim", "coverage_type": None, "business_type": "Conventional", "amount": 1_000_000, **kw})


FALLBACK = {"name": "Claimant", "cnic": "35201-1111111-1", "relationship": "Brother"}


def test_split_follows_nominee_shares_to_the_paisa():
    nominees = [{"name": "Sara", "share_pct": 70, "relationship": "Spouse"}, {"name": "Omar", "share_pct": 30, "relationship": "Child"}]
    r = compute_split(1_000_000.0, _ctx(), nominees, fallback=FALLBACK)
    assert r.source == "nominees" and [s.amount for s in r.shares] == [700_000.0, 300_000.0] and not r.warnings
    thirds = compute_split(100.0, _ctx(), [{"name": n, "share_pct": 100 / 3} for n in "ABC"], fallback=FALLBACK)
    assert sum(s.amount for s in thirds.shares) == 100.0                                    # the odd paisa is placed, never lost


def test_split_minor_goes_to_guardian_and_is_flagged_without_one():
    r = compute_split(100_000.0, _ctx(), [{"name": "Zain", "share_pct": 100, "is_minor": True, "guardian_name": "Hina"}], fallback=FALLBACK)
    assert r.shares[0].payee_name == "Hina" and "guardian" in r.shares[0].notes[0]
    r2 = compute_split(100_000.0, _ctx(), [{"name": "Zain", "share_pct": 100, "is_minor": True}], fallback=FALLBACK)
    assert r2.shares[0].payee_name is None and "no guardian" in r2.shares[0].notes[0]


def test_split_without_nominees_pays_the_claimant_with_a_warning():
    r = compute_split(50_000.0, _ctx(), [], fallback=FALLBACK)
    assert r.source == "claimant" and r.shares[0].name == "Claimant" and r.shares[0].amount == 50_000.0 and r.warnings
    dep = compute_split(50_000.0, _ctx(dependent_claim=True), [{"name": "Sara", "share_pct": 100}],
                        fallback={"name": "Employee Ali", "relationship": "Employee"})
    assert dep.source == "member" and dep.shares[0].name == "Employee Ali"                  # a dependant's death benefit goes to the employee


def test_split_override_needs_a_reason_and_must_total_100():
    over = [{"name": "Court Heir A", "share_pct": 60}, {"name": "Court Heir B", "share_pct": 40}]
    for bad in (dict(overrides=over), dict(overrides=over, override_reason="  ")):
        try:
            compute_split(10.0, _ctx(), [{"name": "X", "share_pct": 100}], fallback=FALLBACK, **bad)
        except ValueError as exc:
            assert "needs a reason" in str(exc)
        else:
            raise AssertionError("an override without a reason must be refused")
    r = compute_split(1000.0, _ctx(), [{"name": "X", "share_pct": 100}], fallback=FALLBACK, overrides=over, override_reason="Court order 12/2026")
    assert r.source == "override" and r.override_reason == "Court order 12/2026" and [s.amount for s in r.shares] == [600.0, 400.0]
    try:
        compute_split(10.0, _ctx(), [{"name": "X", "share_pct": 50}], fallback=FALLBACK)
    except ValueError as exc:
        assert "50%" in str(exc)
    else:
        raise AssertionError("shares that don't total 100% must be refused")


def test_split_rule_hook_lets_policy_wording_change_the_split():
    seen = []

    def takaful_spouse_first(ctx: SplitContext, shares):
        seen.append(ctx.business_type)
        if ctx.business_type == "Takaful":
            for s in shares:
                s.notes.append("Shariah succession review")
        return shares

    register_split_rule(takaful_spouse_first)
    try:
        r = compute_split(100.0, _ctx(business_type="Takaful"), [{"name": "A", "share_pct": 100}], fallback=FALLBACK)
        assert seen == ["Takaful"] and r.shares[0].notes == ["Shariah succession review"]
    finally:
        SPLIT_RULES.remove(takaful_spouse_first)
    assert compute_split(100.0, _ctx(business_type="Takaful"), [{"name": "A", "share_pct": 100}], fallback=FALLBACK).shares[0].notes == []


# ═══════════════════════════════════════════════════════════════════════════
# Integration
# ═══════════════════════════════════════════════════════════════════════════

def _ids(fx, mp_id, session):
    return dict(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, session=session)


async def _cleanup_all(session, fx):
    await session.close()
    async with _session_factory() as s:
        for model in (ClaimPayout, ClaimStatusHistory, Artifact, Claim):
            await s.exec(delete(model).where(model.tenant_id == fx["tenant_id"]))
        await s.commit()
    await _cleanup(session, fx["tenant_id"])


async def _scheme(session, fx, *, with_dependent=True):
    """An in-force scheme with a nominated manager (70/30) who has a covered spouse."""
    mp_id = await _master_policy(session, fx, fcl=1e9)
    await _add_classes(session, fx, mp_id)
    enrolled = await _enroll(session, fx, mp_id, _census(fx))
    ids = _ids(fx, mp_id, session)
    manager = next(o for o in enrolled.employees if o.benefit_class == "Management")
    spouse = None
    if with_dependent:
        spouse = await add_group_dependent(member_id=manager.group_member_id, **ids, body=GroupDependentCreate(
            name="Sara (spouse)", relationship="Spouse", dob=date(1990, 1, 1), covered_amount=2_000_000))
    await replace_group_beneficiaries(member_id=manager.group_member_id, **ids, body=BeneficiariesReplace(beneficiaries=[
        BeneficiaryIn(name="Sara", relationship="Spouse", share_pct=70), BeneficiaryIn(name="Omar", relationship="Child", share_pct=30)]))
    quote = await generate_group_quote_endpoint(**ids)
    await accept_group_quote(quote_id=quote.id, body=NO_DECISION, **ids)
    await issue_master_policy(**ids)
    await record_group_payment(body=GroupPaymentCreate(reference="PAY-0", amount=quote.total_premium), **ids)
    return mp_id, enrolled, manager, spouse, ids


async def _attach(session, claim_id, *doc_types):
    claim = await session.get(Claim, UUID(str(claim_id)))
    for d in doc_types:
        session.add(Artifact(tenant_id=claim.tenant_id, claim_id=claim.id, document_type=d, file_name=f"{d}.pdf"))
    await session.commit()


async def _approve(session, claim_id, amount):
    claim = await session.get(Claim, UUID(str(claim_id)))
    claim.status, claim.approved_amount = ClaimStatusEnum.APPROVED, amount
    session.add(claim)
    await session.commit()


def _death(member_id, **kw):
    return GroupClaimCreate(member_id=member_id, claim_type="Death Claim", submitted_amount=4_000_000, incident_date=date(2026, 8, 1),
                            claimant_name="Sara", claimant_cnic="35201-7654321-2", claimant_relationship="Spouse", **kw)


async def test_member_death_claim_checklist_split_and_payout():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, manager, spouse, ids = await _scheme(session, fx)
            made = await open_group_claim(body=_death(manager.group_member_id), current_user=USER, **ids)
            claim_id = made["claim"]["id"]
            g = made["group"]
            assert g["is_group"] and g["coverage_type"] == LIFE and g["cover_amount"] == 10_000_000
            assert g["member"]["certificate_number"].count("/") == 1 and g["nominations"] == 2
            assert set(g["missing_documents"]) == set(g["required_documents"]) and "Employer Certificate" in g["required_documents"]

            # Documents arrive; the checklist follows.
            await _attach(session, claim_id, "Death Certificate", "CNIC", "Claimant CNIC")
            ctx = await group_context(tenant_id=fx["tenant_id"], claim_id=UUID(claim_id), _user=USER, session=session)
            assert set(ctx["missing_documents"]) == {"Employer Certificate", "Salary Slip"}

            # Not payable until adjudicated.
            await _expect_http(group_payout(tenant_id=fx["tenant_id"], claim_id=UUID(claim_id), body=GroupPayoutRequest(),
                                            current_user=USER, session=session), 400)
            await _approve(session, claim_id, 4_000_000.0)

            split = await default_split(tenant_id=fx["tenant_id"], claim_id=UUID(claim_id), _user=USER, session=session)
            assert split["source"] == "nominees" and [(s["name"], s["amount"]) for s in split["shares"]] == [("Sara", 2_800_000.0), ("Omar", 1_200_000.0)]

            # An overriding split needs a reason; previewing it pays nothing.
            over = SplitRequest(overrides=[SplitOverride(name="Court Heir", share_pct=100)])
            await _expect_http(preview_split_endpoint(tenant_id=fx["tenant_id"], claim_id=UUID(claim_id), body=over, _user=USER, session=session), 422)
            assert (await session.exec(select(ClaimPayout))).all() == []

            paid = await group_payout(tenant_id=fx["tenant_id"], claim_id=UUID(claim_id),
                                      body=GroupPayoutRequest(reference_number="BANK-77", notes="Death benefit"), current_user=USER, session=session)
            assert paid["total"] == 4_000_000.0 and paid["source"] == "nominees"
            assert [(p["payee"], p["amount"], p["share_pct"]) for p in paid["payouts"]] == [("Sara", 2_800_000.0, 70.0), ("Omar", 1_200_000.0, 30.0)]
            assert {p["reference_number"] for p in paid["payouts"]} == {"BANK-77-1", "BANK-77-2"}

            session.expunge_all()
            claim = await session.get(Claim, UUID(claim_id))
            assert claim.status == ClaimStatusEnum.SETTLED and claim.settlement_amount == 4_000_000.0
            rows = (await session.exec(select(ClaimPayout).where(ClaimPayout.claim_id == claim.id))).all()
            assert {r.payee_name for r in rows} == {"Sara", "Omar"} and all(r.status == "Settled" for r in rows)
            history = (await session.exec(select(ClaimStatusHistory).where(ClaimStatusHistory.claim_id == claim.id))).all()
            assert any("split between 2 payees" in (h.notes or "") for h in history)
            await _expect_http(group_payout(tenant_id=fx["tenant_id"], claim_id=UUID(claim_id), body=GroupPayoutRequest(),
                                            current_user=USER, session=session), 400)        # already settled
            print("PASS test_member_death_claim_checklist_split_and_payout")
        finally:
            await _cleanup_all(session, fx)


async def test_override_minor_and_no_nominee_guards():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, manager, spouse, ids = await _scheme(session, fx)
            other = next(o for o in enrolled.employees if o.benefit_class == "Staff" and not o.reused_existing_customer)   # no nominee on file

            # No nominee: the claimant is paid in full, but only after explicit confirmation.
            c1 = (await open_group_claim(body=GroupClaimCreate(member_id=other.group_member_id, claim_type="Death Claim", submitted_amount=500_000,
                                                               incident_date=date(2026, 8, 1), claimant_name="Brother", claimant_relationship="Brother"),
                                         current_user=USER, **ids))["claim"]["id"]
            assert "Succession Certificate" in (await group_context(tenant_id=fx["tenant_id"], claim_id=UUID(c1), _user=USER, session=session))["required_documents"]
            await _attach(session, c1, "Death Certificate")
            await _approve(session, c1, 500_000.0)
            blocked = None
            try:
                await group_payout(tenant_id=fx["tenant_id"], claim_id=UUID(c1), body=GroupPayoutRequest(), current_user=USER, session=session)
            except HTTPException as exc:
                blocked = exc
            assert blocked is not None and blocked.status_code == 409 and blocked.detail["needs_confirmation"] == "confirm_no_nominee"
            paid = await group_payout(tenant_id=fx["tenant_id"], claim_id=UUID(c1), body=GroupPayoutRequest(confirm_no_nominee=True),
                                      current_user=USER, session=session)
            assert paid["source"] == "claimant" and paid["payouts"][0]["payee"] == "Brother"

            # An overriding split (with a reason) is recorded; a minor with no guardian can't be paid.
            c2 = (await open_group_claim(body=_death(manager.group_member_id), current_user=USER, **ids))["claim"]["id"]
            await _attach(session, c2, "Death Certificate")
            await _approve(session, c2, 1_000_000.0)
            minor = SplitRequest(overrides=[SplitOverride(name="Zain", share_pct=100, is_minor=True)], override_reason="Will")
            await _expect_http(group_payout(tenant_id=fx["tenant_id"], claim_id=UUID(c2), body=GroupPayoutRequest(**minor.model_dump()),
                                            current_user=USER, session=session), 409)
            heirs = SplitRequest(overrides=[SplitOverride(name="Zain", share_pct=100, is_minor=True, guardian_name="Hina")], override_reason="Court order 44/2026")
            paid = await group_payout(tenant_id=fx["tenant_id"], claim_id=UUID(c2), body=GroupPayoutRequest(**heirs.model_dump()), current_user=USER, session=session)
            assert paid["source"] == "override" and paid["override_reason"] == "Court order 44/2026"
            assert paid["payouts"][0]["payee"] == "Hina"
            row = (await session.exec(select(ClaimPayout).where(ClaimPayout.id == UUID(paid["payouts"][0]["id"])))).one()
            assert "Court order 44/2026" in row.notes and "guardian" in row.notes.lower()
            print("PASS test_override_minor_and_no_nominee_guards")
        finally:
            await _cleanup_all(session, fx)


async def test_dependant_claims_only_when_scheduled_and_paid_to_the_employee():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, manager, spouse, ids = await _scheme(session, fx)
            ok = await open_group_claim(body=GroupClaimCreate(member_id=manager.group_member_id, dependent_id=spouse.id, claim_type="Death Claim",
                                                              submitted_amount=1_500_000, incident_date=date(2026, 8, 1)), current_user=USER, **ids)
            g = ok["group"]
            assert g["dependent"]["name"] == "Sara (spouse)" and g["cover_amount"] == 2_000_000
            assert "Relationship Proof" in g["required_documents"] and "Salary Slip" not in g["required_documents"]
            assert ok["claim"]["claimant_name"] != "Sara (spouse)" and ok["claim"]["claimant_relationship"] == "Employee"
            await _attach(session, ok["claim"]["id"], "Death Certificate")
            await _approve(session, ok["claim"]["id"], 1_500_000.0)
            paid = await group_payout(tenant_id=fx["tenant_id"], claim_id=UUID(ok["claim"]["id"]), body=GroupPayoutRequest(), current_user=USER, session=session)
            assert paid["source"] == "member" and len(paid["payouts"]) == 1 and paid["payouts"][0]["payee"] != "Sara (spouse)"

            async def refused(**kw):
                try:
                    await open_group_claim(current_user=USER, **ids, body=GroupClaimCreate(member_id=manager.group_member_id, claim_type="Death Claim",
                                                                                        incident_date=date(2026, 8, 1), **kw))
                except HTTPException as exc:
                    return exc
                raise AssertionError("expected the claim to be refused")

            over = await refused(dependent_id=spouse.id, submitted_amount=2_500_000)
            assert over.status_code == 422 and any("exceeds" in e for e in over.detail["errors"])
            # A person who is only a nominee (not on the schedule) is not a dependant at all.
            stranger = await refused(dependent_id=UUID(int=1), submitted_amount=1)
            assert stranger.status_code == 404
            # Someone else's dependant, and a removed dependant.
            other = next(o for o in enrolled.employees if o.group_member_id != manager.group_member_id)
            wrong = None
            try:
                await open_group_claim(body=GroupClaimCreate(member_id=other.group_member_id, dependent_id=spouse.id, claim_type="Death Claim",
                                                             submitted_amount=1, incident_date=date(2026, 8, 1)), current_user=USER, **ids)
            except HTTPException as exc:
                wrong = exc
            assert wrong is not None and wrong.status_code == 404
            dep = await session.get(GroupMemberDependent, spouse.id)
            dep.status = "Removed"
            session.add(dep)
            await session.commit()
            removed = await refused(dependent_id=spouse.id, submitted_amount=1_000)
            assert any("not a covered dependant" in e for e in removed.detail["errors"])
            print("PASS test_dependant_claims_only_when_scheduled_and_paid_to_the_employee")
        finally:
            await _cleanup_all(session, fx)


async def test_cover_dates_and_riders_gate_the_claim():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, manager, spouse, ids = await _scheme(session, fx, with_dependent=False)

            async def refused(**kw):
                try:
                    await open_group_claim(current_user=USER, **ids, body=GroupClaimCreate(member_id=manager.group_member_id, **kw))
                except HTTPException as exc:
                    return exc
                raise AssertionError("expected the claim to be refused")

            before = await refused(claim_type="Death Claim", submitted_amount=1000, incident_date=date(2025, 12, 1))
            assert any("before" in e for e in before.detail["errors"])
            member = await session.get(GroupMember, manager.group_member_id)
            policy_id = member.policy_id

            # No accidental-death rider on the class yet → refused; add one (200% capped at 15M) → limited by it.
            none = await refused(claim_type="Accidental Death", submitted_amount=1000, incident_date=date(2026, 8, 1))
            assert any("no AccidentalDeath cover" in e for e in none.detail["errors"])
            session.add(GroupClassCoverage(tenant_id=fx["tenant_id"], benefit_class_id=member.benefit_class_id, coverage_type=ACCIDENTAL_DEATH,
                                           percent_of_base=200, max_amount=15_000_000))
            await session.commit()
            over = await refused(claim_type="Accidental Death", submitted_amount=16_000_000, incident_date=date(2026, 8, 1))
            assert any("exceeds" in e and "15,000,000" in e for e in over.detail["errors"])
            ok = await open_group_claim(body=GroupClaimCreate(member_id=manager.group_member_id, claim_type="Accidental Death", submitted_amount=15_000_000,
                                                              incident_date=date(2026, 8, 1)), current_user=USER, **ids)
            assert ok["group"]["coverage_type"] == ACCIDENTAL_DEATH and ok["group"]["cover_amount"] == 15_000_000
            assert {"Police Report", "Post-Mortem Report"} <= set(ok["group"]["required_documents"])

            # A leaver is covered for losses before they left, not after.
            member.status, member.cover_end_date = "Removed", date(2026, 9, 30)
            session.add(member)
            policy = await session.get(Policy, policy_id)
            policy.status = "Cancelled"
            session.add(policy)
            await session.commit()
            after = await refused(claim_type="Death Claim", submitted_amount=1000, incident_date=date(2026, 10, 15))
            assert any("ended" in e for e in after.detail["errors"])
            earlier = await open_group_claim(body=GroupClaimCreate(member_id=manager.group_member_id, claim_type="Death Claim", submitted_amount=1000,
                                                                   incident_date=date(2026, 9, 1)), current_user=USER, **ids)
            assert earlier["claim"]["claim_type"] == "Death Claim"
            print("PASS test_cover_dates_and_riders_gate_the_claim")
        finally:
            await _cleanup_all(session, fx)


async def test_scheme_claims_list_and_summary():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, manager, spouse, ids = await _scheme(session, fx)
            first = (await open_group_claim(body=_death(manager.group_member_id), current_user=USER, **ids))["claim"]["id"]
            await open_group_claim(body=GroupClaimCreate(member_id=manager.group_member_id, dependent_id=spouse.id, claim_type="Death Claim",
                                                         submitted_amount=1_000_000, incident_date=date(2026, 8, 2)), current_user=USER, **ids)
            await _attach(session, first, "Death Certificate")
            await _approve(session, first, 3_000_000.0)
            await group_payout(tenant_id=fx["tenant_id"], claim_id=UUID(first), body=GroupPayoutRequest(), current_user=USER, session=session)
            listing = await list_scheme_claims(_user=USER, **ids)
            assert listing["summary"]["count"] == 2 and listing["summary"]["open"] == 1 and listing["summary"]["paid"] == 3_000_000.0
            by_number = {c["id"]: c for c in listing["claims"]}
            assert by_number[first]["status"] == "Settled" and "Employer Certificate" in by_number[first]["missing_documents"]
            assert any(c["dependent"] == "Sara (spouse)" for c in listing["claims"])
            print("PASS test_scheme_claims_list_and_summary")
        finally:
            await _cleanup_all(session, fx)


async def test_individual_claims_are_unchanged_by_the_refactor():
    """routers/claims.py now delegates to open_claim / the payout helpers — an
    ordinary (non-group) claim must behave exactly as before."""
    from routers.claims import ClaimCreate, ClaimPayoutCreate, create_claim_payout, open_claim, assert_claim_payable
    from shared.models.core import Customer, InsuranceTypeEnum, PolicyStatusEnum
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            policy = await session.get(Policy, fx["individual_policy"])
            claim, pol, cust = await open_claim(session, fx["tenant_id"], USER, ClaimCreate(
                policy_id=policy.id, claim_type="Hospitalization", submitted_amount=150_000, incident_date=date(2026, 8, 1)))
            assert claim.claim_number.startswith("CLM-") and claim.group_member_id is None and claim.ai_recommendation == "AUTO_APPROVE"
            dup, _, _ = await open_claim(session, fx["tenant_id"], USER, ClaimCreate(
                policy_id=policy.id, claim_type="Hospitalization", submitted_amount=150_000))
            assert dup.duplicate_flag and dup.ai_recommendation == "DUPLICATE_FLAGGED"
            await _expect_http(assert_claim_payable(session, fx["tenant_id"], claim, 1000), 400)        # not approved yet
            claim.status, claim.approved_amount = ClaimStatusEnum.APPROVED, 150_000.0
            session.add(claim)
            await session.commit()
            await _expect_http(assert_claim_payable(session, fx["tenant_id"], claim, 1000), 400)        # no document yet
            session.add(Artifact(tenant_id=claim.tenant_id, claim_id=claim.id, document_type="Hospital Bill"))
            await session.commit()
            await _expect_http(assert_claim_payable(session, fx["tenant_id"], claim, 999_999), 400)      # above approved
            await assert_claim_payable(session, fx["tenant_id"], claim, 150_000)
            print("PASS test_individual_claims_are_unchanged_by_the_refactor")
        finally:
            await _cleanup_all(session, fx)


async def test_http_flow():
    import httpx
    import main as app_module
    from routers.group_claims import claims_user
    from routers.users import verify_admin

    async with _session_factory() as session:
        fx = await _setup(session)
        app_module.app.dependency_overrides[claims_user] = lambda: USER
        app_module.app.dependency_overrides[verify_admin] = lambda: None
        try:
            mp_id, enrolled, manager, spouse, ids = await _scheme(session, fx)
            base = f"/tenants/{fx['tenant_id']}"
            transport = httpx.ASGITransport(app=app_module.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
                url = f"{base}/organizations/{fx['org_id']}/master-policies/{mp_id}/claims"
                r = await c.post(url, json={"member_id": str(manager.group_member_id), "claim_type": "Death Claim", "submitted_amount": 2_000_000,
                                            "incident_date": "2026-08-01", "claimant_name": "Sara"})
                assert r.status_code == 201, r.text
                cid = r.json()["claim"]["id"]
                bad = await c.post(url, json={"member_id": str(manager.group_member_id), "claim_type": "Death Claim", "submitted_amount": 99_000_000,
                                              "incident_date": "2026-08-01"})
                assert bad.status_code == 422 and bad.json()["detail"]["errors"]
                assert (await c.get(f"{base}/claims/{cid}/group-context")).json()["is_group"] is True
                assert (await c.get(url)).json()["summary"]["count"] == 1
                r = await c.post(f"{base}/claims/{cid}/payout-split", json={"overrides": [{"name": "X", "share_pct": 100}]})
                assert r.status_code == 422 and "reason" in r.text
                # An ordinary claim route still answers (the refactored create path).
                r = await c.post(f"{base}/claims", json={"policy_id": str(fx["individual_policy"]), "claim_type": "Hospitalization", "submitted_amount": 1000})
                assert r.status_code in (201, 401, 403, 422), r.text
            print("PASS test_http_flow")
        finally:
            app_module.app.dependency_overrides.pop(claims_user, None)
            app_module.app.dependency_overrides.pop(verify_admin, None)
            await _cleanup_all(session, fx)


async def main():
    for fn in (test_member_death_claim_checklist_split_and_payout, test_override_minor_and_no_nominee_guards,
               test_dependant_claims_only_when_scheduled_and_paid_to_the_employee, test_cover_dates_and_riders_gate_the_claim,
               test_scheme_claims_list_and_summary, test_individual_claims_are_unchanged_by_the_refactor, test_http_flow):
        await fn()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn) and not asyncio.iscoroutinefunction(fn):
            fn()
            print(f"PASS {name}")
    asyncio.run(main())
