"""Seeds the evaluation database from the golden dataset's fixtures. Nothing about a tenant, user, customer, plan, policy or claim is
written here: it is all read from the fixture files (and evals/environment/world-extras.json for the second tenant's data).

  * deterministic: every id is uuid5(NAMESPACE, "<kind>:<ref>"), so the same fixture gives the same ids on every run, and the
    runner can translate a case's reference ("pol-declined-omar") into the id the application knows;
  * idempotent: rows are upserted by id, so seeding twice (or seeding over a reset) gives the same database;
  * validated first: the fixtures are checked for the references they make to each other before anything is written;
  * real rows: users get a real role from the application's own role table and a real bcrypt hash; customers, plans, policies,
    payments, counter-offers, beneficiaries and claims are the application's own models, so the real endpoints see them.
It writes only to the database it is given; the caller (evals/tools/runner.py) has already run every guard in safety.py.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

NAMESPACE = uuid.UUID("5a3c7e9e-0d7a-4d0e-9f55-3b2f1c6a8e11")
UPFRONT_PCT = 20.0           # the initial-premium split the platform seeds (and IND-PAY-006 pins)
FIXTURE_FILES = ("tenant-sandbox-v1.json", "plans-individual-v1.json", "personas-individual-v1.json", "policies-claims-v1.json")
# A policy in one of these states has been issued, so it has a number.
_NUMBERED = {"Issued", "Active", "GracePeriod", "Lapsed", "Cancelled", "Matured", "Surrendered", "Expired", "OnHold", "Postponed"}


def sid(kind: str, ref: str) -> uuid.UUID:
    """The id of a seeded record: the same every time for the same kind and reference."""
    return uuid.uuid5(NAMESPACE, f"{kind}:{ref}")


class FixtureError(ValueError):
    """The fixtures refer to something that does not exist, or are missing."""


@dataclass
class World:
    tenants: List[dict]
    users: List[dict]
    plans: List[dict]
    customers: List[dict]            # each with the tenant ref it belongs to
    policies: List[dict]
    claims: List[dict]
    payouts: List[dict] = field(default_factory=list)
    canaries: List[str] = field(default_factory=list)


def _read(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise FixtureError(f"fixture file not found: {path}") from exc


def load_world(fixtures: Path, extras: Optional[Path] = None) -> World:
    """Read the fixtures (a directory with the dataset's fixture files) and, optionally, the environment extras. Validates the
    references between them; raises FixtureError listing every problem."""
    tenant_fx, plans_fx, personas_fx, policies_fx = (_read(fixtures / name) for name in FIXTURE_FILES)
    tag = lambda items, tenant: [{**i, "_tenant": tenant} for i in items]
    customers = tag(personas_fx["customers"], personas_fx["tenant"] if "tenant" in personas_fx else "tenant-a")
    policies = tag(policies_fx["policies"], policies_fx["tenant"])
    claims = tag(policies_fx["claims"], policies_fx["tenant"])
    payouts: List[dict] = []
    canaries: List[str] = []
    if extras is not None:
        x = _read(extras)
        customers += tag(x.get("customers", []), x["tenant"])
        policies += tag(x.get("policies", []), x["tenant"])
        claims += tag(x.get("claims", []), x["tenant"])
        payouts = tag(x.get("payouts", []), x["tenant"])
        canaries = x.get("canaries", [])
    world = World(tenants=tenant_fx["tenants"], users=tenant_fx["users"], plans=plans_fx["plans"], customers=customers,
                  policies=policies, claims=claims, payouts=payouts, canaries=canaries)
    problems = validate(world)
    if problems:
        raise FixtureError("the fixtures are inconsistent:\n  " + "\n  ".join(problems))
    return world


def validate(world: World) -> List[str]:
    problems: List[str] = []
    tenants = {t["ref"] for t in world.tenants}
    users = {u["ref"] for u in world.users}
    plans = {p["code"] for p in world.plans}
    customers = {c["ref"] for c in world.customers}
    policies = {p["ref"] for p in world.policies}
    claims = {c["ref"] for c in world.claims}
    for kind, items in (("user", world.users), ("customer", world.customers), ("policy", world.policies), ("claim", world.claims)):
        refs = [i["ref"] for i in items]
        problems += [f"duplicate {kind} ref {r!r}" for r in sorted({r for r in refs if refs.count(r) > 1})]
    for u in world.users:
        if u.get("tenant") and u["tenant"] not in tenants:
            problems.append(f"user {u['ref']}: unknown tenant {u['tenant']!r}")
    for c in world.customers:
        if c["_tenant"] not in tenants:
            problems.append(f"customer {c['ref']}: unknown tenant {c['_tenant']!r}")
        if c.get("assigned_agent") and c["assigned_agent"] not in users:
            problems.append(f"customer {c['ref']}: unknown agent {c['assigned_agent']!r}")
    for p in world.policies:
        if p["customer"] not in customers:
            problems.append(f"policy {p['ref']}: unknown customer {p['customer']!r}")
        if p["plan"] not in plans:
            problems.append(f"policy {p['ref']}: unknown plan {p['plan']!r}")
    for c in world.claims:
        if c["policy"] not in policies:
            problems.append(f"claim {c['ref']}: unknown policy {c['policy']!r}")
    for p in world.payouts:
        if p["claim"] not in claims:
            problems.append(f"payout {p['ref']}: unknown claim {p['claim']!r}")
    return problems


def date_of_birth(rule: dict, today: date) -> date:
    """The birth date that makes a person exactly `age_years` old today, whose last birthday was `days_past_birthday` days ago."""
    last_birthday = today - timedelta(days=int(rule.get("days_past_birthday", 0)))
    try:
        return last_birthday.replace(year=last_birthday.year - int(rule["age_years"]))
    except ValueError:                                           # a 29 February birthday in a non-leap year
        return last_birthday.replace(year=last_birthday.year - int(rule["age_years"]), day=28)


@dataclass
class SeedReport:
    counts: Dict[str, int] = field(default_factory=dict)
    ids: Dict[str, Dict[str, str]] = field(default_factory=dict)        # kind -> {ref: id}, for the runner's context
    ignored: List[str] = field(default_factory=list)                   # fixture fields the schema has no column for

    def add(self, kind: str, ref: str, obj_id: uuid.UUID) -> None:
        self.counts[kind] = self.counts.get(kind, 0) + 1
        self.ids.setdefault(kind, {})[ref] = str(obj_id)


async def seed(session, world: World, *, password_hash: str, today: Optional[date] = None) -> SeedReport:
    """Write the world. `session` is an AsyncSession on the evaluation database; the caller commits."""
    from sqlmodel import select

    from shared.models import core as m
    from shared.pricing.calculator import calculate_premium

    today = today or date.today()
    now = datetime.utcnow()
    report = SeedReport()
    plan_by_code = {p["code"]: p for p in world.plans}
    customer_by_ref = {c["ref"]: c for c in world.customers}
    policy_by_ref = {p["ref"]: p for p in world.policies}
    tenant_of: Dict[str, uuid.UUID] = {t["ref"]: sid("tenant", t["ref"]) for t in world.tenants}

    async def put(obj):
        await session.merge(obj)
        await session.flush()

    # tenants -------------------------------------------------------------------------------------------------------------
    for t in world.tenants:
        await put(m.Tenant(id=tenant_of[t["ref"]], name=t["name"], code=t["code"], is_active=True))
        report.add("tenant", t["ref"], tenant_of[t["ref"]])

    # roles: the application's own system roles are already there (it seeds them); a fixture role it does not ship is created --
    role_ids = {r.name: r.id for r in (await session.exec(select(m.Role))).all()}
    for name in sorted({u["role"] for u in world.users} - set(role_ids)):
        await put(m.Role(id=sid("role", name), name=name, description="Evaluation fixture role (not one of the built-in roles)"))
        role_ids[name] = sid("role", name)
        report.add("role", name, role_ids[name])

    # users -----------------------------------------------------------------------------------------------------------------
    for u in world.users:
        uid = sid("user", u["ref"])
        await put(m.User(id=uid, tenant_id=tenant_of[u["tenant"]] if u.get("tenant") else None, role_id=role_ids[u["role"]],
                         email=f"{u['ref']}@eval.invalid", username=u["ref"], hashed_password=password_hash,
                         full_name=f"{u['role']} {u['ref']}", is_active=True, is_verified=True))
        report.add("user", u["ref"], uid)

    # plans: the catalog is part of every tenant's world -------------------------------------------------------------------
    for t in world.tenants:
        for p in world.plans:
            pid = sid("plan", f"{t['ref']}/{p['code']}")
            await put(m.InsurancePlan(
                id=pid, tenant_id=tenant_of[t["ref"]], code=p["code"], label=p["label"], insurance_type=m.InsuranceTypeEnum(p["insurance_type"]),
                description=p.get("description") or p["label"], category=p.get("category"), status=p.get("status", "Active"),
                entry_age_min=p["entry_age_min"], entry_age_max=p["entry_age_max"], term_min_years=p["term_min_years"],
                term_max_years=p["term_max_years"], max_maturity_age=p["max_maturity_age"], max_income_multiple=p["max_income_multiple"],
                base_premium_rate=p["base_premium_rate"], smoker_factor=p["smoker_factor"], rate_version=p["rate_version"],
                medical_exam_tiers=p.get("medical_exam_tiers", []), required_documents=p.get("required_documents", [])))
            report.add("plan", f"{t['ref']}/{p['code']}", pid)

    # customers -------------------------------------------------------------------------------------------------------------
    for c in world.customers:
        cid = sid("customer", c["ref"])
        await put(m.Customer(
            id=cid, tenant_id=tenant_of[c["_tenant"]], name=f"{c['first_name']} {c.get('last_name') or ''}".strip(), cnic=c["cnic"],
            dob=date_of_birth(c["dob_rule"], today), gender=c.get("gender"), occupation=c.get("occupation"),
            declared_income=c.get("declared_income"), is_smoker=c.get("is_smoker"), height_cm=c.get("height_cm"), weight_kg=c.get("weight_kg"),
            profile_status=m.ProfileStatusEnum(c["profile_status"]), city=c.get("city"), province=c.get("province"),
            assigned_agent_id=sid("user", c["assigned_agent"]) if c.get("assigned_agent") else None,
            details={"phone": c["phone"]} if c.get("phone") else None))
        report.add("customer", c["ref"], cid)

    # policies, their status history, quote, payment, counter-offer and beneficiaries ------------------------------------
    for p in world.policies:
        plan, cust = plan_by_code[p["plan"]], customer_by_ref[p["customer"]]
        pid, tenant = sid("policy", p["ref"]), tenant_of[p["_tenant"]]
        status = m.PolicyStatusEnum(p["status"])
        age = cust["dob_rule"]["age_years"]
        breakdown = calculate_premium(p["coverage_amount"], plan["base_premium_rate"], plan["smoker_factor"], age,
                                      bool(cust.get("is_smoker")), cust.get("height_cm") or 170.0, cust.get("weight_kg") or 70.0)
        await put(m.Policy(
            id=pid, tenant_id=tenant, customer_id=sid("customer", p["customer"]), product_name=plan["label"],
            insurance_type=m.InsuranceTypeEnum(plan["insurance_type"]), coverage_amount=p["coverage_amount"], term_years=p["term_years"],
            status=status, policy_number=f"EV-{pid.hex[:10].upper()}" if p["status"] in _NUMBERED else None,
            effective_date=date.fromisoformat(p["effective_date"]) if p.get("effective_date") else None))
        report.add("policy", p["ref"], pid)
        previous = None
        for i, e in enumerate(p.get("status_history") or []):
            await put(m.PolicyEvent(id=sid("policy_event", f"{p['ref']}/{i}"), tenant_id=tenant, policy_id=pid, event_type=e["event_type"],
                                    from_status=previous, to_status=e["to_status"], actor="eval-fixture", detail_json=e.get("detail"),
                                    created_at=datetime.fromisoformat(e["at"])))
            previous = e["to_status"]
            report.add("policy_event", f"{p['ref']}/{i}", sid("policy_event", f"{p['ref']}/{i}"))
        qid = sid("quote", p["ref"])
        await put(m.PremiumQuote(id=qid, tenant_id=tenant, policy_id=pid, base_premium=breakdown.base_premium,
                                 loading_applied=breakdown.loading_applied, total_premium=breakdown.total_premium, rate_version=plan["rate_version"]))
        report.add("quote", p["ref"], qid)
        ipp = p.get("ipp") or {}
        if ipp.get("status") in ("Initiated", "Realized"):
            upfront = round(breakdown.total_premium * UPFRONT_PCT / 100, 2)
            await put(m.InitialPremiumPayment(
                id=sid("ipp", p["ref"]), tenant_id=tenant, policy_id=pid, amount=upfront, status=m.IPPStatusEnum(ipp["status"]),
                method=ipp.get("method"), reference=f"EVAL-TXN-{pid.hex[:8].upper()}", initiated_at=now,
                realized_at=now if ipp["status"] == "Realized" else None,
                breakdown_json={"total_premium": breakdown.total_premium,
                                "split": {"upfront_pct": UPFRONT_PCT, "upfront_amount": upfront,
                                          "remaining_amount": round(breakdown.total_premium - upfront, 2)}}))
            report.add("payment", p["ref"], sid("ipp", p["ref"]))
        offer = p.get("counter_offer")
        if offer:
            await put(m.CounterOffer(
                id=sid("counter_offer", p["ref"]), tenant_id=tenant, policy_id=pid, offer_type=m.CounterOfferTypeEnum.LOADING,
                status=m.CounterOfferStatusEnum(offer["status"]), revised_loading_pct=offer.get("revised_loading_pct"),
                original_coverage_amount=p["coverage_amount"], original_premium=breakdown.total_premium,
                reason="Evaluation fixture: revised terms the customer has not answered", created_by="eval-fixture",
                valid_until=today + timedelta(days=30)))
            report.add("counter_offer", p["ref"], sid("counter_offer", p["ref"]))
        for i, b in enumerate(p.get("beneficiaries") or []):
            await put(m.Beneficiary(id=sid("beneficiary", f"{p['ref']}/{i}"), tenant_id=tenant, policy_id=pid, name=b["name"],
                                    relationship=b["relationship"], share_pct=b["share_pct"]))
            report.add("beneficiary", f"{p['ref']}/{i}", sid("beneficiary", f"{p['ref']}/{i}"))

    # claims and payouts --------------------------------------------------------------------------------------------------
    for c in world.claims:
        policy = policy_by_ref[c["policy"]]
        cid, tenant = sid("claim", c["ref"]), tenant_of[c["_tenant"]]
        event = date.fromisoformat(c["event_date"])
        await put(m.Claim(
            id=cid, tenant_id=tenant, policy_id=sid("policy", c["policy"]), claim_number=f"EV-{cid.hex[:8].upper()}", claim_type=c["claim_type"],
            submitted_amount=c["submitted_amount"], status=m.ClaimStatusEnum(c["status"]), claimant_name=c.get("claimant_name"),
            claimant_relationship=c.get("claimant_relationship"), incident_date=event, coverage_type=c.get("category")))
        report.add("claim", c["ref"], cid)
        ws = c.get("workflow_state")
        if ws:
            await put(m.ClaimProcess(
                id=sid("claim_process", c["ref"]), tenant_id=tenant, policy_id=sid("policy", policy["ref"]), claim_id=cid, category=c["category"],
                event_date=event, eligibility_status=ws.get("eligibility"), docs_complete_at=now if ws.get("documents_complete") else None,
                investigation_completed_at=now if ws.get("investigation_complete") else None,
                assessed_at=now if ws.get("assessed_payable") is not None else None,
                assessment_json={"assessed_payable": ws.get("assessed_payable")}))
            report.add("claim_process", c["ref"], sid("claim_process", c["ref"]))
    for x in world.payouts:
        await put(m.ClaimPayout(id=sid("payout", x["ref"]), tenant_id=tenant_of[x["_tenant"]], claim_id=sid("claim", x["claim"]), amount=x["amount"],
                                status=x.get("status"), payee_name=x.get("payee_name"), reference_number=x.get("reference_number"),
                                initiated_at=now, completed_at=now))
        report.add("payout", x["ref"], sid("payout", x["ref"]))
    return report
