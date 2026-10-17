"""Who may see what of a family's insurance, for the customer portal (Customer Management -> tenant-service adapter).

The portal NEVER trusts a family id, member id or policy id from the browser: every request names the signed-in customer, and
this module decides — from the authoritative records — what that customer may see or do.

Two shapes of family policy exist (FamilyPolicy.plan_type):

  FLOATER      one shared Policy (anchored on the head) and one coverage pool. The insured lives are the people with an
               underwriting Case on that policy (the head and, if chosen, a fully insured spouse). Everyone else on the
               roster is a NOMINEE (a Beneficiary row) — never insured.
  LIFE_BUNDLE  one individually underwritten Policy per insured member, grouped only for a shared discount. The insured
               life of a certificate is its own customer.

Access to ONE policy is a level, never "everything in the family":

  owner      the customer is the policyholder of that policy (or the head of a floater): full access.
  guardian   the customer is the family head and the certificate's life is a MINOR: full access, on the child's behalf.
  summary    the family head looking at another ADULT's certificate, or an insured spouse looking at the floater:
             status, cover, premium position and dates only — no claims, documents, beneficiaries, receipts or payments.
  (none)     anyone else: the policy does not exist as far as this customer is concerned (404).

A head therefore cannot read a spouse's claims or papers just because they share a family, and a family member who has their own
sign-in sees only their own certificates.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any, Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from group_underwriting import age_from_dob
from shared.models.core import (
    Beneficiary,
    Case,
    Customer,
    FamilyGroup,
    FamilyPlanTypeEnum,
    FamilyPolicy,
    Policy,
)

# Statuses a customer sees as "their policy". Earlier statuses are proposals/quotes, not policies.
PENDING_ISSUANCE = ("Approved", "AcceptedWithLoadings", "PendingPayment")
VISIBLE_STATUSES = frozenset(PENDING_ISSUANCE + ("Issued", "Active", "GracePeriod", "Lapsed", "Cancelled",
                                                  "Matured", "Surrendered", "Expired"))
IN_FORCE = frozenset({"Active", "GracePeriod"})

FULL_LEVELS = ("owner", "guardian")


def _v(x: Any) -> str:
    return x.value if hasattr(x, "value") else str(x)


def is_minor(dob: Optional[date]) -> bool:
    return bool(dob and age_from_dob(dob) < 18)


@dataclass
class PolicyAccess:
    segment: str                         # "individual" | "family"
    level: str                           # owner | guardian | summary
    family_id: Optional[UUID] = None
    family_name: Optional[str] = None
    family_policy_id: Optional[UUID] = None
    plan_type: Optional[str] = None      # "Floater" | "LifeBundle"
    role: Optional[str] = None           # "head" | "member"
    owner_customer_id: Optional[UUID] = None
    owner_is_minor: bool = False
    extra: dict = field(default_factory=dict)

    @property
    def full(self) -> bool:
        return self.level in FULL_LEVELS


@dataclass
class FamilyRole:
    group: FamilyGroup
    role: str                            # head | member


async def roles_for(session: AsyncSession, tenant_id: UUID, customer: Customer) -> list[FamilyRole]:
    """The family groups this customer legitimately belongs to — as head (the group's primary member) or as a member who
    has their own record in it. Membership of a group is NOT access to its other members' information."""
    out: dict[UUID, FamilyRole] = {}
    heads = (await session.exec(select(FamilyGroup).where(
        FamilyGroup.tenant_id == tenant_id, FamilyGroup.primary_member_customer_id == customer.id))).all()
    for g in heads:
        out[g.id] = FamilyRole(g, "head")
    if customer.family_group_id and customer.family_group_id not in out:
        g = await session.get(FamilyGroup, customer.family_group_id)
        if g is not None and g.tenant_id == tenant_id:
            out[g.id] = FamilyRole(g, "member")
    return list(out.values())


async def insured_lives(session: AsyncSession, policy: Policy, plan_type: Optional[str]) -> list[Customer]:
    """The people actually covered by this policy, from authoritative records.

    Floater: everyone with an underwriting case on the shared policy (plus the holder). Bundle certificate: its own customer.
    Never derived from the family roster — a nominee on the roster is not an insured life."""
    ids: list[UUID] = [policy.customer_id]
    if plan_type == FamilyPlanTypeEnum.FLOATER.value:
        for cid in (await session.exec(select(Case.customer_id).where(Case.policy_id == policy.id))).all():
            if cid not in ids:
                ids.append(cid)
    rows = [await session.get(Customer, i) for i in ids]
    return [c for c in rows if c is not None]


async def resolve(session: AsyncSession, tenant_id: UUID, customer: Customer, policy: Policy) -> Optional[PolicyAccess]:
    """The caller's access level on one policy, or None. This is the single gate every family-capable endpoint uses."""
    if policy.tenant_id != tenant_id or policy.master_policy_id or _v(policy.status) not in VISIBLE_STATUSES:
        return None
    if not policy.family_policy_id:
        return PolicyAccess("individual", "owner", owner_customer_id=policy.customer_id) if policy.customer_id == customer.id else None

    fp = await session.get(FamilyPolicy, policy.family_policy_id)
    group = await session.get(FamilyGroup, fp.family_group_id) if fp else None
    if fp is None or group is None or fp.tenant_id != tenant_id or group.tenant_id != tenant_id:
        return None
    plan = _v(fp.plan_type)
    is_head = group.primary_member_customer_id == customer.id
    is_member = customer.family_group_id == group.id or policy.customer_id == customer.id
    if not (is_head or is_member):
        return None

    base = dict(segment="family", family_id=group.id, family_name=group.name, family_policy_id=fp.id, plan_type=plan,
                role="head" if is_head else "member", owner_customer_id=policy.customer_id)
    if policy.customer_id == customer.id:
        return PolicyAccess(level="owner", **base)
    if plan == FamilyPlanTypeEnum.FLOATER.value:
        if is_head:
            return PolicyAccess(level="owner", **base)               # the head runs the shared contract
        lives = await insured_lives(session, policy, plan)
        return PolicyAccess(level="summary", **base) if any(c.id == customer.id for c in lives) else None
    # Bundle certificate belonging to someone else.
    if is_head:
        owner = await session.get(Customer, policy.customer_id)
        minor = bool(owner and is_minor(owner.dob))
        return PolicyAccess(level="guardian" if minor else "summary", owner_is_minor=minor, **base)
    return None


async def family_policies_for(session: AsyncSession, tenant_id: UUID, customer: Customer, *, full_only: bool = False
                              ) -> list[tuple[Policy, PolicyAccess]]:
    """Every family policy this customer may see, newest first."""
    out: list[tuple[Policy, PolicyAccess]] = []
    seen: set[UUID] = set()
    groups = [r.group for r in await roles_for(session, tenant_id, customer)]
    for g in groups:
        fps = (await session.exec(select(FamilyPolicy).where(FamilyPolicy.family_group_id == g.id, FamilyPolicy.tenant_id == tenant_id))).all()
        for fp in fps:
            for p in (await session.exec(select(Policy).where(Policy.family_policy_id == fp.id, Policy.tenant_id == tenant_id))).all():
                if p.id in seen:
                    continue
                access = await resolve(session, tenant_id, customer, p)
                if access is None or (full_only and not access.full):
                    continue
                seen.add(p.id)
                out.append((p, access))
    return sorted(out, key=lambda t: t[0].created_at, reverse=True)


# ── nominees ──────────────────────────────────────────────────────────────────

def head_policy_of(policies: list[Policy], group: FamilyGroup) -> Optional[Policy]:
    """The policy that carries the family's nominees: the head's (a floater has only one)."""
    return next((p for p in policies if p.customer_id == group.primary_member_customer_id), policies[0] if policies else None)


async def nominees_of(session: AsyncSession, policy: Policy) -> list[Beneficiary]:
    return list((await session.exec(select(Beneficiary).where(Beneficiary.policy_id == policy.id).order_by(Beneficiary.created_at))).all())


# ── what a customer may ask for ───────────────────────────────────────────────

REQUEST_KINDS = ("MEMBER_ADD", "MEMBER_REMOVE", "MEMBER_CORRECTION", "COVERAGE_CHANGE", "NOMINEE_CHANGE",
                 "CONTACT_CORRECTION", "CANCELLATION", "REINSTATEMENT")


def available_actions(policy: Policy, access: PolicyAccess, *, reinstatement_eligible: bool = False, free_look_open: bool = False) -> list[dict]:
    """Which servicing actions to OFFER on a policy right now. The portal shows only the ones with `available: true`; the
    submit endpoint re-checks the same rules, so a hidden button is never the only protection."""
    status = _v(policy.status)
    in_force = status in IN_FORCE
    full = access.full
    head_of_floater = access.plan_type == FamilyPlanTypeEnum.FLOATER.value and access.role == "head"
    out: list[dict] = []

    def add(kind: str, ok: bool, reason: Optional[str] = None) -> None:
        out.append({"kind": kind, "available": bool(ok), "reason": None if ok else reason})

    if not full:
        return [{"kind": k, "available": False, "reason": "NOT_YOUR_POLICY"} for k in REQUEST_KINDS]
    why = None if in_force else "POLICY_NOT_IN_FORCE"
    add("COVERAGE_CHANGE", in_force, why)
    add("NOMINEE_CHANGE", in_force, why)
    add("CANCELLATION", in_force, why)
    add("REINSTATEMENT", status == "Lapsed" and reinstatement_eligible, "NOT_ELIGIBLE" if status == "Lapsed" else "POLICY_NOT_LAPSED")
    # Roster changes are the head's, on the family arrangement.
    add("MEMBER_ADD", in_force and access.role == "head", "HEAD_ONLY" if access.role != "head" else why)
    add("MEMBER_REMOVE", in_force and access.role == "head", "HEAD_ONLY" if access.role != "head" else why)
    add("MEMBER_CORRECTION", in_force or status in ("Lapsed",), "POLICY_CLOSED")
    add("CONTACT_CORRECTION", access.role == "head", "HEAD_ONLY")
    return out
