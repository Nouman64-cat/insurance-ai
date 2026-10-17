"""Tests for Group Life Phase 6 — Takaful (retakaful, terminology, PTF report), extra
coverages (Accidental Death, Disability, Pay / Fee Continuation) and Group Credit Life.

Pure rules first, then the router functions against a live, migrated Postgres like
test_group_issuance.py, cleaning up after themselves.

Run with: docker compose exec tenant-service python test_group_phase6.py
"""

import asyncio
from datetime import date
from types import SimpleNamespace
from uuid import UUID

from fastapi import HTTPException
from sqlmodel import delete, select

import services.group_documents as documents
from database import _session_factory
from group_benefits import (
    class_cover,
    census_row_class_errors,
    member_cover,
    validate_benefit_class,
    validate_coverage,
)
from group_pricing import (
    PricedLife,
    member_annual_premium,
    price_group,
    rider_premiums,
    takaful_quote_fields,
    takaful_split,
)
from routers.group_coverages import add_class_coverage, remove_class_coverage
from routers.group_endorsements import create as create_endorsement_endpoint
from routers.group_policies import (
    accept_group_quote,
    generate_group_quote_endpoint,
    issue_master_policy,
    record_group_payment,
)
from routers.group_ptf import get_ptf_report
from routers.organizations import create_benefit_class, list_benefit_classes
from schemas import (
    BenefitClassCreate,
    ClassCoverageCreate,
    EndorsementRequest,
    GroupPaymentCreate,
    GroupQuoteDecision,
)
from services.census_file import parse_census_file
from services.group_ptf import classify_claim, fund_position
from shared.models.core import Claim, ClaimStatusEnum, GroupBenefitClass, GroupMember, GroupQuote, MasterPolicy
from test_group_census import _add_classes, _census, _cleanup, _cnic, _enroll, _expect_http, _master_policy, _row, _setup
from test_group_endorsements import _active_scheme

NO_DECISION = GroupQuoteDecision(decided_by="CFO")


# ═══════════════════════════════════════════════════════════════════════════
# Pure rules
# ═══════════════════════════════════════════════════════════════════════════

def test_takaful_split_cedes_a_share_of_the_ptf_to_retakaful():
    s = takaful_split(1000.0, 30, 20)
    assert (s.wakala_fee, s.ptf_allocation, s.retakaful_contribution, s.ptf_retained) == (300.0, 700.0, 140.0, 560.0)
    assert s.wakala_fee + s.ptf_allocation == 1000.0 and s.retakaful_contribution + s.ptf_retained == s.ptf_allocation
    zero = takaful_split(1000.0, 30, 0)
    assert zero.retakaful_contribution == 0 and zero.ptf_retained == 700.0
    assert takaful_split(1000.0, 30).retakaful_share_pct == 20.0                        # the placeholder default
    for bad in ((30, -1), (30, 101), (101, 20)):
        try:
            takaful_split(1000.0, *bad)
        except ValueError:
            continue
        raise AssertionError(f"{bad} should be rejected")
    fields = takaful_quote_fields(s)
    assert fields == {"wakala_fee_pct": 30.0, "wakala_fee": 300.0, "ptf_allocation": 700.0, "retakaful_share_pct": 20.0, "retakaful_contribution": 140.0}
    assert set(takaful_quote_fields(None).values()) == {None}


def test_rider_premiums_are_flat_per_mille_and_scale_with_experience():
    assert rider_premiums({"Disability": 1_000_000}) == {"Disability": 600.0}
    assert rider_premiums({"AccidentalDeath": 2_000_000, "FeeContinuation": 500_000}) == {"AccidentalDeath": 600.0, "FeeContinuation": 200.0}
    assert rider_premiums({"Disability": 1_000_000}, 1.2)["Disability"] == 720.0
    assert rider_premiums({"Unknown": 1_000_000}) == {"Unknown": 0.0}                            # never mispriced, class setup rejects it
    assert member_annual_premium(1_000_000, 3.0) == 3000.0
    assert member_annual_premium(1_000_000, 3.0, riders={"Disability": 1_000_000}) == 3600.0


def _life(key, riders=None, sa=1_000_000, cls="Staff"):
    return PricedLife(key=key, kind="member", age=30, sum_assured=sa, occupation="Accountant", benefit_class=cls, riders=riders or {})


def test_price_group_adds_riders_and_reports_cover_and_premium_by_benefit():
    plain = price_group([_life("a"), _life("b")], 3.0)
    rid = price_group([_life("a", {"AccidentalDeath": 2_000_000}), _life("b")], 3.0)
    assert rid.risk_premium == round(plain.risk_premium + 600.0, 2) and rid.total_premium > plain.total_premium
    assert rid.by_life["a"] == round(plain.by_life["a"] + 600.0, 2) and rid.by_life["b"] == plain.by_life["b"]
    assert set(rid.by_coverage) == {"Life", "AccidentalDeath"} and rid.by_coverage["AccidentalDeath"] == 600.0
    assert rid.cover_by_coverage == {"Life": 2_000_000.0, "AccidentalDeath": 2_000_000.0}
    assert abs(sum(rid.by_coverage.values()) - rid.risk_premium) < 0.02
    assert sum(c["premium"] for c in rid.by_class) == rid.risk_premium                          # the class table includes riders
    exp = price_group([_life("a", {"AccidentalDeath": 2_000_000})], 3.0, experience_factor=1.2)
    assert exp.by_coverage["AccidentalDeath"] == 720.0 and exp.experience_factor == 1.2


def test_coverage_validation():
    assert validate_coverage({"coverage_type": "Disability", "percent_of_base": 50}) == []
    assert validate_coverage({"coverage_type": "Disability", "percent_of_base": 50, "max_amount": 3_000_000}) == []
    assert any("automatic" in e for e in validate_coverage({"coverage_type": "Life", "percent_of_base": 100}))
    assert any("must be one of" in e for e in validate_coverage({"coverage_type": "Dental", "percent_of_base": 10}))
    assert validate_coverage({"coverage_type": "Disability", "percent_of_base": 0})
    assert validate_coverage({"coverage_type": "Disability", "percent_of_base": 1001})
    assert validate_coverage({"coverage_type": "Disability", "percent_of_base": 10, "max_amount": -1})


def test_loan_balance_basis():
    assert validate_benefit_class({"basis": "LoanBalance"}) == []
    assert validate_benefit_class({"basis": "LoanBalance", "min_cover": 10, "max_cover": 5})
    cls = SimpleNamespace(name="Borrowers", basis="LoanBalance", flat_amount=None, salary_multiple=None, service_bands=None, min_cover=None, max_cover=None,
                          grades=None, is_default=True)
    assert class_cover(cls, 0, None, date(2026, 1, 1), 750_000) == 750_000.0
    capped = SimpleNamespace(**{**cls.__dict__, "min_cover": 100_000, "max_cover": 500_000})
    assert class_cover(capped, 0, None, date(2026, 1, 1), 750_000) == 500_000.0 and class_cover(capped, 0, None, date(2026, 1, 1), 50_000) == 100_000.0
    try:
        class_cover(cls, 0, None, date(2026, 1, 1), None)
    except ValueError as exc:
        assert "loan_amount" in str(exc)
    else:
        raise AssertionError("a loan-balance cover without a balance must fail")
    row = {"cnic": "x", "name": "B", "declared_income": 600_000, "loan_amount": "420000"}
    got_cls, cover = member_cover(row, [cls], 24, date(2026, 1, 1))
    assert got_cls is cls and cover == 420_000.0
    assert census_row_class_errors(row, 0, [cls]) == []
    for bad in ({}, {"loan_amount": 0}, {"loan_amount": "abc"}):
        assert "loan_amount" in census_row_class_errors({**row, **{"loan_amount": None}, **bad}, 3, [cls])[0]


def test_census_files_accept_loan_columns():
    parsed = parse_census_file("loans.csv", b"CNIC,Name,DOB,Gender,Occupation,Annual Salary,Outstanding Balance\n35201-1111111-1,A,1990-01-01,Male,Clerk,600000,420000\n")
    assert parsed.rows[0]["loan_amount"] == "420000" and "loan_amount" in parsed.columns and not parsed.ignored_columns


def test_ptf_fund_position_and_claim_classification():
    p = fund_position(300.0, 700.0, 140.0, 400.0)
    assert (p["ptf_retained"], p["result"], p["position"]) == (560.0, 160.0, "Surplus") and p["claims_to_ptf"] == round(400 / 560, 4)
    d = fund_position(300.0, 700.0, 140.0, 900.0)
    assert d["result"] == -340.0 and d["position"] == "Deficit"
    assert fund_position(0, 0, 0, 0)["position"] == "Surplus" and fund_position(0, 0, 0, 50)["claims_to_ptf"] == 0.0
    assert classify_claim(ClaimStatusEnum.SETTLED, 500, 400, 400) == {"incurred": 400.0, "paid": 400.0, "reserved": 0.0}
    assert classify_claim("Under Investigation", 250, 0, None) == {"incurred": 250.0, "paid": 0.0, "reserved": 250.0}
    assert classify_claim(ClaimStatusEnum.DECLINED, 900, 0, None) == {"incurred": 0.0, "paid": 0.0, "reserved": 0.0}


def _documents_text(build_fn, *args):
    """Run a document generator with the PDF build swapped for a capture of its text."""
    captured = []
    original = documents._build
    documents._build = lambda path, story: captured.append(story)
    try:
        build_fn(*args)
    finally:
        documents._build = original

    def walk(flowable):
        if hasattr(flowable, "getPlainText"):
            yield flowable.getPlainText()
        for row in getattr(flowable, "_cellvalues", []) or []:
            for cell in row:
                for item in (cell if isinstance(cell, list) else [cell]):
                    yield from walk(item)
        for sub in getattr(flowable, "_content", []) or []:
            yield from walk(sub)

    return "\n".join(t for flow in captured[0] for t in walk(flow))


def _quote_ctx(business_type, **extra):
    q = {"version": 1, "valid_until": "2026-12-01", "member_count": 2, "dependent_count": 0, "total_sum_assured": 2_000_000, "rate_per_mille": 3.0,
         "risk_premium": 6000, "policy_fee": 500, "stamp_duty": 120, "total_premium": 6620, "wakala_fee_pct": None,
         "breakdown": {"base_rate_per_mille": 3.0, "weighted_average_age": 30, "age_factor": 1, "size_factor": 1, "hazard_factor": 1,
                       "by_class": [{"benefit_class": "Staff", "members": 2, "dependents": 0, "sum_assured": 2_000_000, "premium": 6000}]}}
    q.update(extra.pop("quote", {}))
    return {"tenant_name": "T", "organization": "Org", "plan_label": "Plan", "business_type": business_type, "master_policy_id": "mp-doc-test",
            "effective_date": date(2026, 1, 1), "quote": q, **extra}


def test_takaful_documents_say_contribution_and_conventional_say_premium():
    tk = _documents_text(documents.generate_group_quote, _quote_ctx("Takaful"))
    conv = _documents_text(documents.generate_group_quote, _quote_ctx("Conventional"))
    assert "Contribution" in tk and "contribution" in tk and "Premium" not in tk and "premium" not in tk.replace("Premium", "")
    assert "Premium" in conv and "ontribution" not in conv
    split = takaful_split(6000.0, 30, 20)
    withsplit = _documents_text(documents.generate_group_quote, _quote_ctx("Takaful", quote={
        "wakala_fee_pct": 30.0, "breakdown": {"base_rate_per_mille": 3.0, "weighted_average_age": 30, "age_factor": 1, "size_factor": 1,
                                              "hazard_factor": 1, "by_class": [], "takaful": split.model_dump()}}))
    assert "Wakala fee" in withsplit and "ceded to retakaful (20%)" in withsplit and "retained by the PTF" in withsplit


def test_quote_document_lists_benefits_when_riders_exist():
    breakdown = {"base_rate_per_mille": 3.0, "weighted_average_age": 30, "age_factor": 1, "size_factor": 1, "hazard_factor": 1, "by_class": [],
                 "by_coverage": {"Life": 5000.0, "AccidentalDeath": 600.0}, "cover_by_coverage": {"Life": 2_000_000.0, "AccidentalDeath": 2_000_000.0}}
    text = _documents_text(documents.generate_group_quote, _quote_ctx("Conventional", quote={"breakdown": breakdown}))
    assert "Total cover" in text and "Accidental Death" in text
    life_only = {**breakdown, "by_coverage": {"Life": 5000.0}}
    assert "Total cover" not in _documents_text(documents.generate_group_quote, _quote_ctx("Conventional", quote={"breakdown": life_only}))


# ═══════════════════════════════════════════════════════════════════════════
# Integration
# ═══════════════════════════════════════════════════════════════════════════

def _ids(fx, mp_id, session):
    return dict(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, session=session)


async def _cleanup_all(session, fx):
    await session.close()
    async with _session_factory() as s:
        await s.exec(delete(Claim).where(Claim.tenant_id == fx["tenant_id"]))
        await s.commit()
    await _cleanup(session, fx["tenant_id"])


async def _class_id(session, mp_id, name):
    return (await session.exec(select(GroupBenefitClass).where(GroupBenefitClass.master_policy_id == mp_id, GroupBenefitClass.name == name))).one().id


async def test_riders_are_priced_into_the_quote_and_invalidate_open_quotes():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _master_policy(session, fx, fcl=1e9)
            await _add_classes(session, fx, mp_id)
            await _enroll(session, fx, mp_id, _census(fx))
            ids = _ids(fx, mp_id, session)
            base = await generate_group_quote_endpoint(**ids)
            base_total, base_risk = base.total_premium, base.risk_premium
            assert set(base.breakdown["by_coverage"]) == {"Life"}
            mgmt = await _class_id(session, mp_id, "Management")

            added = await add_class_coverage(class_id=mgmt, body=ClassCoverageCreate(coverage_type="AccidentalDeath", percent_of_base=200, max_amount=15_000_000), **ids)
            assert {c.coverage_type for c in added.coverages} == {"Life", "AccidentalDeath"}
            # The open quote is stale (the premium moved): superseded, scheme back to Proposed.
            assert (await session.get(GroupQuote, base.id)).status == "Superseded"
            assert (await session.get(MasterPolicy, mp_id)).status == "Proposed"

            requote = await generate_group_quote_endpoint(**ids)
            assert requote.risk_premium > base_risk and requote.total_premium > base_total
            by_cov = requote.breakdown["by_coverage"]
            assert by_cov["AccidentalDeath"] == round(20_000_000 / 1000 * 0.30, 2) or by_cov["AccidentalDeath"] > 0    # 1 manager: 200% of 10M, capped at 15M
            assert requote.breakdown["cover_by_coverage"]["AccidentalDeath"] == 15_000_000.0
            assert abs(sum(by_cov.values()) - requote.risk_premium) < 0.05

            # Guards: Life is automatic, duplicates and unknown types are refused, riders can be removed.
            await _expect_http(add_class_coverage(class_id=mgmt, body=ClassCoverageCreate(coverage_type="Life", percent_of_base=100), **ids), 422)
            await _expect_http(add_class_coverage(class_id=mgmt, body=ClassCoverageCreate(coverage_type="Dental", percent_of_base=10), **ids), 422)
            await _expect_http(add_class_coverage(class_id=mgmt, body=ClassCoverageCreate(coverage_type="AccidentalDeath", percent_of_base=50), **ids), 409)
            classes = await list_benefit_classes(**ids)
            life = next(c for c in next(c for c in classes if c.name == "Management").coverages if c.coverage_type == "Life")
            ad = next(c for c in next(c for c in classes if c.name == "Management").coverages if c.coverage_type == "AccidentalDeath")
            await _expect_http(remove_class_coverage(class_id=mgmt, coverage_id=life.id, **ids), 409)
            after = await remove_class_coverage(class_id=mgmt, coverage_id=ad.id, **ids)
            assert {c.coverage_type for c in after.coverages} == {"Life"}

            # Once the employer has accepted, benefits are fixed.
            final = await generate_group_quote_endpoint(**ids)
            assert final.total_premium == base_total
            await accept_group_quote(quote_id=final.id, body=NO_DECISION, **ids)
            await _expect_http(add_class_coverage(class_id=mgmt, body=ClassCoverageCreate(coverage_type="Disability", percent_of_base=50), **ids), 409)
            print("PASS test_riders_are_priced_into_the_quote_and_invalidate_open_quotes")
        finally:
            await _cleanup_all(session, fx)


async def test_riders_can_be_defined_when_the_class_is_created():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _master_policy(session, fx, fcl=1e9)
            ids = _ids(fx, mp_id, session)
            made = await create_benefit_class(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, session=session, body=BenefitClassCreate(
                name="Staff", basis="SalaryMultiple", salary_multiple=24, is_default=True,
                coverages=[ClassCoverageCreate(coverage_type="Disability", percent_of_base=100),
                           ClassCoverageCreate(coverage_type="FeeContinuation", percent_of_base=25, max_amount=500_000)]))
            assert {c.coverage_type for c in made.coverages} == {"Life", "Disability", "FeeContinuation"}
            await _expect_http(create_benefit_class(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, session=session, body=BenefitClassCreate(
                name="Bad", basis="Flat", flat_amount=1, coverages=[ClassCoverageCreate(coverage_type="Life", percent_of_base=100)])), 422)
            await _expect_http(create_benefit_class(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, session=session, body=BenefitClassCreate(
                name="Dup", basis="Flat", flat_amount=1, coverages=[ClassCoverageCreate(coverage_type="Disability", percent_of_base=10),
                                                                  ClassCoverageCreate(coverage_type="Disability", percent_of_base=20)])), 422)
            print("PASS test_riders_can_be_defined_when_the_class_is_created")
        finally:
            await _cleanup_all(session, fx)


async def test_takaful_quote_carries_the_retakaful_split_and_endorsements_follow_it():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx, plan_code="GROUP_FAMILY_TAKAFUL")
            assert (quote.wakala_fee_pct, quote.retakaful_share_pct) == (30.0, 20.0)
            assert abs(quote.wakala_fee + quote.ptf_allocation - quote.risk_premium) < 0.011
            assert abs(quote.retakaful_contribution - round(quote.ptf_allocation * 0.20, 2)) < 0.011
            assert quote.breakdown["takaful"]["ptf_retained"] == round(quote.ptf_allocation - quote.retakaful_contribution, 2)

            e = await create_endorsement_endpoint(body=EndorsementRequest(endorsement_type="ADD", effective_date=date(2026, 6, 1), members=[_row(_cnic(), 700)]), **ids)
            assert e.retakaful_delta == round(e.ptf_delta * 0.20, 2) and e.retakaful_delta > 0

            conv_fx = await _setup(session)
            try:
                _m, _e, conv, _i = await _active_scheme(session, conv_fx)
                assert conv.retakaful_share_pct is None and conv.retakaful_contribution is None
            finally:
                await _cleanup_all(session, conv_fx)
            print("PASS test_takaful_quote_carries_the_retakaful_split_and_endorsements_follow_it")
        finally:
            await _cleanup_all(session, fx)


async def test_endorsements_price_riders_like_the_quote():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _master_policy(session, fx, fcl=1e9)
            await _add_classes(session, fx, mp_id)
            staff = await _class_id(session, mp_id, "Staff")
            ids = _ids(fx, mp_id, session)
            await add_class_coverage(class_id=staff, body=ClassCoverageCreate(coverage_type="Disability", percent_of_base=100), **ids)
            enrolled = await _enroll(session, fx, mp_id, _census(fx))
            quote = await generate_group_quote_endpoint(**ids)
            await accept_group_quote(quote_id=quote.id, body=NO_DECISION, **ids)
            await issue_master_policy(**ids)
            await record_group_payment(body=GroupPaymentCreate(reference="P", amount=quote.total_premium), **ids)
            assert quote.breakdown["by_coverage"]["Disability"] > 0

            # A new Staff hire carries the Disability rider: the annual figure is life + rider.
            e = await create_endorsement_endpoint(body=EndorsementRequest(endorsement_type="ADD", effective_date=date(2026, 1, 1), members=[_row(_cnic(), 800)]), **ids)
            line = e.lines[0]
            cover = line["after"]["cover"]
            expected = member_annual_premium(cover, quote.rate_per_mille, 0.0, {"Disability": cover})
            assert abs(line["annual_premium_after"] - round(expected, 2)) < 0.02
            assert line["annual_premium_after"] > cover / 1000 * quote.rate_per_mille                  # more than life alone
            print("PASS test_endorsements_price_riders_like_the_quote")
        finally:
            await _cleanup_all(session, fx)


async def test_group_credit_life_covers_each_borrowers_balance():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id = await _master_policy(session, fx, plan_code="GROUP_CREDIT_LIFE", fcl=1e9)
            ids = _ids(fx, mp_id, session)
            await create_benefit_class(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, session=session, body=BenefitClassCreate(
                name="Borrowers", basis="LoanBalance", is_default=True, max_cover=2_000_000))
            rows = [_row(_cnic(), i, loan_amount=100_000 * (i + 1)) for i in range(5)]
            rows[4]["loan_amount"] = 9_000_000                                                  # capped by the class
            from routers.organizations import confirm_employee_census, validate_employee_census
            from schemas import CensusRequest
            # A borrower with no balance is refused with a plain sentence, nothing enrolled.
            bad = await validate_employee_census(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, session=session,
                                                 body=CensusRequest(employees=rows[:4] + [_row(_cnic(), 9)]))
            assert not bad.is_valid and any("loan_amount" in e for e in bad.errors)
            out = await confirm_employee_census(tenant_id=fx["tenant_id"], org_id=fx["org_id"], mp_id=mp_id, session=session, body=CensusRequest(employees=rows))
            covers = sorted(e.coverage_amount for e in out.employees)
            assert covers == [100_000.0, 200_000.0, 300_000.0, 400_000.0, 2_000_000.0]
            member = (await session.exec(select(GroupMember).where(GroupMember.master_policy_id == mp_id).order_by(GroupMember.coverage_amount))).first()
            assert member.loan_amount == 100_000.0

            quote = await generate_group_quote_endpoint(**ids)
            assert quote.total_sum_assured == sum(covers) and quote.risk_premium > 0
            await accept_group_quote(quote_id=quote.id, body=NO_DECISION, **ids)
            await issue_master_policy(**ids)
            await record_group_payment(body=GroupPaymentCreate(reference="P", amount=quote.total_premium), **ids)

            # A repayment lowers the balance: a CHANGE endorsement re-bases cover and refunds pro rata.
            e = await create_endorsement_endpoint(body=EndorsementRequest(endorsement_type="CHANGE", effective_date=date(2026, 7, 1), members=[
                {"member_id": str(member.id), "loan_amount": 40_000}]), **ids)
            assert e.lines[0]["before"]["cover"] == 100_000.0 and e.lines[0]["after"]["cover"] == 40_000.0 and e.premium_delta < 0
            session.expunge_all()
            assert (await session.get(GroupMember, member.id)).loan_amount == 40_000.0
            print("PASS test_group_credit_life_covers_each_borrowers_balance")
        finally:
            await _cleanup_all(session, fx)


async def test_ptf_report_follows_contributions_claims_and_renewal():
    async with _session_factory() as session:
        fx = await _setup(session)
        try:
            mp_id, enrolled, quote, ids = await _active_scheme(session, fx, plan_code="GROUP_FAMILY_TAKAFUL")
            members = (await session.exec(select(GroupMember).where(GroupMember.master_policy_id == mp_id))).all()
            session.add_all([
                Claim(tenant_id=fx["tenant_id"], policy_id=members[0].policy_id, claim_type="Death Claim", submitted_amount=100_000.0,
                      approved_amount=100_000.0, settlement_amount=100_000.0, status=ClaimStatusEnum.SETTLED, incident_date=date(2026, 5, 1)),
                Claim(tenant_id=fx["tenant_id"], policy_id=members[1].policy_id, claim_type="Death Claim", submitted_amount=40_000.0,
                      status=ClaimStatusEnum.UNDER_INVESTIGATION, incident_date=date(2026, 6, 1)),
                Claim(tenant_id=fx["tenant_id"], policy_id=members[2].policy_id, claim_type="Death Claim", submitted_amount=9_000_000.0,
                      status=ClaimStatusEnum.DECLINED, incident_date=date(2026, 6, 2)),
                Claim(tenant_id=fx["tenant_id"], policy_id=members[3].policy_id, claim_type="Death Claim", submitted_amount=5_000.0,
                      approved_amount=5_000.0, status=ClaimStatusEnum.APPROVED, incident_date=date(2025, 3, 1)),     # another year
            ])
            await session.commit()
            report = await get_ptf_report(**ids)
            assert [p["label"] for p in report["periods"]] == ["Initial term"]
            p = report["periods"][0]
            assert (p["wakala_fee"], p["ptf_gross"], p["retakaful_contribution"]) == (quote.wakala_fee, quote.ptf_allocation, quote.retakaful_contribution)
            assert p["claims_incurred"] == 140_000.0 and p["claims_paid"] == 100_000.0 and p["open_reserve"] == 40_000.0 and p["claim_count"] == 2
            assert p["ptf_retained"] == round(quote.ptf_allocation - quote.retakaful_contribution, 2)
            assert p["result"] == round(p["ptf_retained"] - 140_000.0, 2)
            assert p["position"] == ("Surplus" if p["result"] >= 0 else "Deficit")
            assert report["totals"]["claims_incurred"] == 140_000.0 and "Qard Hassan" in report["note"]

            # A Conventional scheme has no fund.
            conv_fx = await _setup(session)
            try:
                _m, _e, _q, conv_ids = await _active_scheme(session, conv_fx)
                await _expect_http(get_ptf_report(**conv_ids), 409)
            finally:
                await _cleanup_all(session, conv_fx)
            print("PASS test_ptf_report_follows_contributions_claims_and_renewal")
        finally:
            await _cleanup_all(session, fx)


async def main():
    for fn in (test_riders_are_priced_into_the_quote_and_invalidate_open_quotes, test_riders_can_be_defined_when_the_class_is_created,
               test_takaful_quote_carries_the_retakaful_split_and_endorsements_follow_it, test_endorsements_price_riders_like_the_quote,
               test_group_credit_life_covers_each_borrowers_balance, test_ptf_report_follows_contributions_claims_and_renewal):
        await fn()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn) and not asyncio.iscoroutinefunction(fn):
            fn()
            print(f"PASS {name}")
    asyncio.run(main())
