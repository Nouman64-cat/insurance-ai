"""Issued family policies for development and for the customer-portal tests.

Builds, directly in the database, what the real flow leaves behind once a family policy has been underwritten, issued and its
first premium paid — so the portal can be exercised without walking a family through the whole staff process:

  * a FLOATER family: one shared Policy (anchored on the head), one coverage pool, an insured spouse (an approved underwriting
    case on the shared policy), and nominees who are NOT insured (beneficiary rows);
  * a LIFE_BUNDLE family: one individually issued Policy per insured member (head, spouse, a minor child), each with its own
    cover, plus nominees on the head's policy.

    docker compose exec tenant-service python -m seeds.family_portal_seed --tenant-code PAG34

Idempotent by family name. It writes ONLY rows the real flow also writes (no portal accounts: those come from the post-issuance
"Provision portal access" step, exactly as for any customer).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from datetime import date, datetime, timedelta
from typing import Optional
from uuid import UUID, uuid4

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import (
    Beneficiary,
    BeneficiaryVersion,
    Case,
    CaseStatusEnum,
    CaseTypeEnum,
    Customer,
    FamilyGroup,
    FamilyPlanTypeEnum,
    FamilyPolicy,
    FamilyRelationshipEnum,
    Gender,
    InsuranceTypeEnum,
    MaritalStatus,
    Policy,
    PolicyEvent,
    PolicyStatusEnum,
    PolicyVersion,
    PremiumReceipt,
    PremiumSchedule,
    ProfileStatusEnum,
    SourceChannelEnum,
    Tenant,
)

log = logging.getLogger("tenant-service.seeds.family_portal")


def _cnic(n: int) -> str:
    return f"3520{n % 10}-{n:07d}-{n % 9}"


async def _customer(session: AsyncSession, tenant_id: UUID, *, name: str, cnic: str, dob: date, gender, relationship, group_id: UUID,
                    phone: Optional[str] = None) -> Customer:
    existing = (await session.exec(select(Customer).where(Customer.tenant_id == tenant_id, Customer.cnic == cnic))).first()
    if existing is not None:
        return existing
    c = Customer(tenant_id=tenant_id, name=name, cnic=cnic, dob=dob, gender=gender, family_group_id=group_id, family_relationship=relationship,
                 marital_status=MaritalStatus.MARRIED if relationship != FamilyRelationshipEnum.CHILD else MaritalStatus.SINGLE,
                 occupation="Family member", declared_income=1_800_000.0, city="Lahore", province="Punjab", profile_status=ProfileStatusEnum.POLICYHOLDER,
                 details={"contact_email": f"{name.split()[0].lower()}@example.test", "contact_phone": phone or "+92 300 0000000"})
    session.add(c)
    await session.flush()
    return c


async def _issue(session: AsyncSession, tenant_id: UUID, *, holder: Customer, fp: FamilyPolicy, product: str, insurance_type, cover: float,
                 annual_premium: float, frequency: str, term_years: int, effective: date, status=PolicyStatusEnum.ACTIVE,
                 insured: list[Customer], number: str, paid_installments: int = 1) -> Policy:
    """A policy as the issuance + first-payment flow leaves it: Active, versioned, scheduled, first instalment paid, audited."""
    from services import document_generator
    p = Policy(tenant_id=tenant_id, customer_id=holder.id, family_policy_id=fp.id, product_name=product, insurance_type=insurance_type, coverage_amount=cover,
               term_years=term_years, status=status, policy_number=number, effective_date=effective,
               expiry_date=date(effective.year + term_years, effective.month, min(effective.day, 28)),
               maturity_date=date(effective.year + term_years, effective.month, min(effective.day, 28)),
               delivery_date=effective, free_look_end_date=effective + timedelta(days=14), issued_at=datetime.combine(effective, datetime.min.time()),
               issued_by="seed")
    session.add(p)
    await session.flush()

    base = round(annual_premium / 1.01 - 500.0, 2)
    v = PolicyVersion(policy_id=p.id, version_number="1.0", effective_from=effective, base_premium=base, loading_amount=0.0, policy_fee=500.0,
                      stamp_duty_amount=round(annual_premium - base - 500.0, 2), tax_amount=0.0, total_premium=annual_premium, event_type="Issuance", created_by="seed")
    session.add(v)
    await session.flush()
    p.current_version_id = v.id
    session.add(p)

    per = {"Annual": 1, "SemiAnnual": 2, "Quarterly": 4}[frequency]
    step = {"Annual": 12, "SemiAnnual": 6, "Quarterly": 3}[frequency]
    amount = round(annual_premium / per, 2)
    for n in range(per):
        month = effective.month - 1 + n * step
        due = date(effective.year + month // 12, month % 12 + 1, min(effective.day, 28))
        paid = n < paid_installments
        sched = PremiumSchedule(policy_id=p.id, policy_version_id=v.id, billing_frequency=frequency, due_date=due, amount_due=amount, installment_no=n + 1,
                                amount_paid=amount if paid else 0.0, status="Paid" if paid else "Pending",
                                paid_at=datetime.combine(due, datetime.min.time()) if paid else None, payment_reference=f"SEED-{number}-{n + 1}" if paid else None)
        session.add(sched)
        await session.flush()
        if paid:
            kit = document_generator.generate_receipt({
                "policy_id": p.id, "tenant_name": (await session.get(Tenant, tenant_id)).name, "customer_name": holder.name, "policy_number": number,
                "installment_no": n + 1, "paid_date": due.isoformat(), "method": "JazzCash", "payment_reference": f"SEED-{number}-{n + 1}",
                "base_amount": amount, "surcharge_amount": 0.0, "total_amount": amount})
            count = len((await session.exec(select(PremiumReceipt).where(PremiumReceipt.tenant_id == tenant_id))).all())
            session.add(PremiumReceipt(tenant_id=tenant_id, policy_id=p.id, schedule_id=sched.id, receipt_no=f"RCPT-SEED-{count + 1:05d}", base_amount=amount,
                                       surcharge_amount=0.0, total_amount=amount, method="JazzCash", payment_reference=f"SEED-{number}-{n + 1}",
                                       document_path=kit["file_path"]))

    at = datetime.combine(effective, datetime.min.time())
    session.add(PolicyEvent(tenant_id=tenant_id, policy_id=p.id, event_type="PolicyIssued", from_status="Approved", to_status="PendingPayment", actor="seed", created_at=at - timedelta(minutes=5)))
    session.add(PolicyEvent(tenant_id=tenant_id, policy_id=p.id, event_type="PaymentConfirmed", from_status="PendingPayment", to_status=status.value, actor="seed", created_at=at))

    for i, life in enumerate(insured):       # every insured life has an approved underwriting case on this policy
        session.add(Case(tenant_id=tenant_id, customer_id=life.id, policy_id=p.id, caseNumber=f"UW-{uuid4().hex[:10].upper()}", caseType=CaseTypeEnum.UNDERWRITING,
                         caseStatus=CaseStatusEnum.CLOSED, sourceChannel=SourceChannelEnum.BRANCH))
    await session.flush()
    return p


async def _nominees(session: AsyncSession, tenant_id: UUID, policy: Policy, rows: list[dict]) -> None:
    for r in rows:
        dob = r.get("dob")
        session.add(Beneficiary(tenant_id=tenant_id, policy_id=policy.id, name=r["name"], relationship=r["relationship"], share_pct=r["share"],
                                date_of_birth=dob, is_minor=bool(dob and (date.today() - dob).days < 365 * 18), guardian_name=r.get("guardian"),
                                cnic=r.get("cnic")))
    session.add(BeneficiaryVersion(tenant_id=tenant_id, policy_id=policy.id, version_sequence=1, total_share=round(sum(r["share"] for r in rows), 2),
                                   changed_by="system", change_reason="Family enrolment",
                                   beneficiaries_json=[{"name": r["name"], "relationship": r["relationship"], "share_pct": r["share"], "cnic": r.get("cnic"),
                                                        "is_minor": bool(r.get("dob") and (date.today() - r["dob"]).days < 365 * 18), "guardian_name": r.get("guardian")} for r in rows]))
    first = max(rows, key=lambda r: r["share"])
    policy.nominee_name, policy.nominee_relationship = first["name"], first["relationship"]
    session.add(policy)


async def _next_number(session: AsyncSession, tenant_id: UUID) -> str:
    from routers.policies import _next_policy_number
    return await _next_policy_number(session, tenant_id)


async def create_floater_family(session: AsyncSession, tenant_id: UUID, *, head: Customer, name: str, spouse_name: str, spouse_cnic: str, pool: float = 10_000_000.0,
                                effective: Optional[date] = None, premium: float = 84_000.0, spouse_insured: bool = True) -> dict:
    """Head (and an insured spouse) on ONE shared policy; a child and a parent are nominees only."""
    effective = effective or date.today() - timedelta(days=60)
    group = FamilyGroup(tenant_id=tenant_id, name=name, contact_person=head.name, primary_member_customer_id=head.id, profile_status=ProfileStatusEnum.POLICYHOLDER,
                        household_declared_income=3_600_000.0, city="Lahore", province="Punjab")
    session.add(group)
    await session.flush()
    head.family_group_id, head.family_relationship = group.id, FamilyRelationshipEnum.SELF
    session.add(head)
    spouse = await _customer(session, tenant_id, name=spouse_name, cnic=spouse_cnic, dob=date(1990, 3, 14), gender=Gender.FEMALE,
                             relationship=FamilyRelationshipEnum.SPOUSE, group_id=group.id)
    fp = FamilyPolicy(tenant_id=tenant_id, family_group_id=group.id, plan_type=FamilyPlanTypeEnum.FLOATER, insurance_type=InsuranceTypeEnum.FAMILY_FLOATER,
                      total_sum_insured=pool, term_years=5, effective_date=effective, status="Active")
    session.add(fp)
    await session.flush()
    p = await _issue(session, tenant_id, holder=head, fp=fp, product="Family Health Floater", insurance_type=InsuranceTypeEnum.FAMILY_FLOATER, cover=pool,
                     annual_premium=premium, frequency="Quarterly", term_years=5, effective=effective, insured=[head] + ([spouse] if spouse_insured else []),
                     number=await _next_number(session, tenant_id))
    kid_dob = date.today() - timedelta(days=365 * 9)
    await _nominees(session, tenant_id, p, [
        {"name": spouse.name, "relationship": "Spouse", "share": 50.0, "cnic": spouse.cnic},
        {"name": f"{head.name.split()[0]} Jr.", "relationship": "Child", "share": 30.0, "dob": kid_dob, "guardian": head.name},
        {"name": "Elder Parent", "relationship": "Parent", "share": 20.0}])
    await session.commit()
    return {"group": group, "family_policy": fp, "policy": p, "head": head, "spouse": spouse}


async def create_bundle_family(session: AsyncSession, tenant_id: UUID, *, head: Customer, name: str, spouse_name: str, spouse_cnic: str, child_name: str,
                               child_cnic: str, effective: Optional[date] = None) -> dict:
    """Each insured member holds their own policy and their own cover; the child is a minor."""
    effective = effective or date.today() - timedelta(days=45)
    group = FamilyGroup(tenant_id=tenant_id, name=name, contact_person=head.name, primary_member_customer_id=head.id, profile_status=ProfileStatusEnum.POLICYHOLDER,
                        city="Lahore", province="Punjab")
    session.add(group)
    await session.flush()
    head.family_group_id, head.family_relationship = group.id, FamilyRelationshipEnum.SELF
    session.add(head)
    spouse = await _customer(session, tenant_id, name=spouse_name, cnic=spouse_cnic, dob=date(1991, 7, 2), gender=Gender.FEMALE,
                             relationship=FamilyRelationshipEnum.SPOUSE, group_id=group.id)
    child = await _customer(session, tenant_id, name=child_name, cnic=child_cnic, dob=date.today() - timedelta(days=365 * 12), gender=Gender.MALE,
                            relationship=FamilyRelationshipEnum.CHILD, group_id=group.id)
    fp = FamilyPolicy(tenant_id=tenant_id, family_group_id=group.id, plan_type=FamilyPlanTypeEnum.LIFE_BUNDLE, total_sum_insured=None, discount_percentage=10.0,
                      term_years=20, effective_date=effective, status="Active")
    session.add(fp)
    await session.flush()
    out = {}
    for who, product, itype, cover, premium in (
            (head, "Term Life 20", InsuranceTypeEnum.TERM_LIFE, 6_000_000.0, 24_000.0),
            (spouse, "Whole Life Protect", InsuranceTypeEnum.WHOLE_LIFE, 3_000_000.0, 36_000.0),
            (child, "Term Life Junior", InsuranceTypeEnum.TERM_LIFE, 1_000_000.0, 6_000.0)):
        out[who.id] = await _issue(session, tenant_id, holder=who, fp=fp, product=product, insurance_type=itype, cover=cover, annual_premium=premium,
                                   frequency="Annual", term_years=20, effective=effective, insured=[who], number=await _next_number(session, tenant_id))
    await _nominees(session, tenant_id, out[head.id], [
        {"name": spouse.name, "relationship": "Spouse", "share": 60.0, "cnic": spouse.cnic},
        {"name": child.name, "relationship": "Child", "share": 40.0, "dob": child.dob, "guardian": spouse.name}])
    await session.commit()
    return {"group": group, "family_policy": fp, "policies": out, "head": head, "spouse": spouse, "child": child}


async def seed(session: AsyncSession, tenant_code: str) -> dict:
    tenant = (await session.exec(select(Tenant).where(Tenant.code == tenant_code))).first()
    if tenant is None:
        raise SystemExit(f"No tenant with code {tenant_code}")
    done: dict = {}
    # Reuse customers who already have a portal sign-in so the SAME login shows individual and family policies.
    for title, ph, builder in (("Butt Floater Family", "PH-2026-000001", "floater"), ("Raza Life Bundle Family", "PH-2026-000002", "bundle"),
                              ("Javed Floater Family", "PH-2026-000003", "floater")):
        if (await session.exec(select(FamilyGroup).where(FamilyGroup.tenant_id == tenant.id, FamilyGroup.name == title))).first():
            log.info("%s already exists", title)
            continue
        head = (await session.exec(select(Customer).where(Customer.tenant_id == tenant.id, Customer.policyholder_id == ph))).first()
        if head is None:
            log.warning("no customer with policyholder id %s; skipping %s (run the post-issuance steps first)", ph, title)
            continue
        if builder == "floater":
            spouse = "Hina Butt" if "Butt" in title else "Maha Javed"
            done[title] = await create_floater_family(session, tenant.id, head=head, name=title, spouse_name=spouse, spouse_cnic=_cnic(8801234 if "Butt" in title else 8803456))
        else:
            done[title] = await create_bundle_family(session, tenant.id, head=head, name=title, spouse_name="Sana Raza", spouse_cnic=_cnic(8805678),
                                                     child_name="Zain Raza", child_cnic=_cnic(8809012))
        log.info("created %s", title)
    return done


async def _main(code: str) -> None:
    from database import _session_factory
    async with _session_factory() as session:
        await seed(session, code)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser()
    ap.add_argument("--tenant-code", required=True)
    asyncio.run(_main(ap.parse_args().tenant_code))
