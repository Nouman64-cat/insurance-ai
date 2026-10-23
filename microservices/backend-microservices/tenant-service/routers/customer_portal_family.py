"""Family insurance for the customer portal (Customer Management -> tenant-service). Same signed channel, same rules as
routers/customer_portal_internal.py — read that module's docstring first. What is added here is only what a FAMILY needs:

  GET  /family                                   the family groups the caller belongs to, with totals
  GET  /family/{id}                              one group: arrangements (floater / life bundle), policies, members
  GET  /family/{id}/policies                     the policies in the group, each with the caller's access level
  GET  /family/{id}/members[/{key}]              who is insured (and under which policy) and who is only a nominee
  GET  /family/{id}/beneficiaries?policy_id=     a policy's nominee roster, its validity and its version history
  POST /family/{id}/requests                     validate a servicing request and leave it on the policy's audit trail
  GET  /policies/{id}/renewal  (+ /acceptance)   the existing renewal engine, customer-safe

Nothing here prices, underwrites, collects, settles or edits an issued contract. Premium formulas, family discounts and
underwriting stay in the existing engines; the group's own policy records stay authoritative for what is covered.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field as PField
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from family_underwriting import MAX_FAMILY_SIZE, NOMINEE_RELATIONSHIPS, INSURABLE_RELATIONSHIPS, normalize_cnic
from routers.customer_portal_internal import (
    _access_block, _card, _customer, _iso, _owned_policy_access, _portal_actor, _v, mask_cnic, signed_by_customer_management,
    policy_actions,
)
from routers.policies import _st
from services.idempotency import portal_identity, reviewed_operation, step_operation
from routers.renewals import AcceptanceBody, capture_acceptance
from routers.renewals import _overview as renewal_overview
from services import customer_portal_family as fam
from services.customer_portal_family import IN_FORCE, VISIBLE_STATUSES
from shared.models.core import (
    Beneficiary,
    BeneficiaryVersion,
    Claim,
    ClaimProcess,
    ClaimStatusEnum,
    Customer,
    FamilyGroup,
    FamilyPlanTypeEnum,
    FamilyPolicy,
    Policy,
    PolicyEvent,
)
from shared.services.policy_state_machine import record_event

log = logging.getLogger(__name__)
router = APIRouter(prefix="/internal/customer-portal/v1", tags=["Internal: Customer Portal (family)"], include_in_schema=False,
                   dependencies=[Depends(signed_by_customer_management)])

BASE = "/tenants/{tenant_id}/customers/{customer_id}"
PLAN_LABELS = {"Floater": "Family Floater", "LifeBundle": "Family Life Bundle"}


# ── building blocks ───────────────────────────────────────────────────────────

async def _role_for(session: AsyncSession, tenant_id: UUID, customer: Customer, family_id: UUID) -> fam.FamilyRole:
    """The caller's standing in THIS group. A family id the caller is not part of is a plain 404 — it is never trusted."""
    for r in await fam.roles_for(session, tenant_id, customer):
        if r.group.id == family_id:
            return r
    raise HTTPException(404, "Family not found")


async def _arrangements(session: AsyncSession, tenant_id: UUID, customer: Customer, role: fam.FamilyRole
                        ) -> list[tuple[FamilyPolicy, list[tuple[Policy, fam.PolicyAccess]]]]:
    """The group's family policies with only the certificates this caller may see at all (some in summary)."""
    fps = (await session.exec(select(FamilyPolicy).where(
        FamilyPolicy.family_group_id == role.group.id, FamilyPolicy.tenant_id == tenant_id).order_by(FamilyPolicy.created_at))).all()
    out = []
    for fp in fps:
        certs = []
        for p in sorted((await session.exec(select(Policy).where(Policy.family_policy_id == fp.id, Policy.tenant_id == tenant_id))).all(),
                        key=lambda x: x.created_at):
            access = await fam.resolve(session, tenant_id, customer, p)
            if access is not None:
                certs.append((p, access))
        if certs:
            out.append((fp, certs))
    return out


def _person_key(cnic: Optional[str], name: str) -> str:
    return (normalize_cnic(cnic) if cnic else "") or (name or "").strip().lower()


async def _members(session: AsyncSession, customer: Customer, arrangements: list) -> list[dict]:
    """One row per (person, policy). Insured rows come from authoritative cover records; nominees from beneficiary rows. The
    roster is never the source of truth for who is covered."""
    rows: list[dict] = []
    insured_keys: dict[str, str] = {}
    for fp, certs in arrangements:
        plan = _v(fp.plan_type)
        for p, access in certs:
            for c in await fam.insured_lives(session, p, plan):
                mine, minor = c.id == customer.id, fam.is_minor(c.dob)
                status = _st(p)
                pool = plan == FamilyPlanTypeEnum.FLOATER.value
                rows.append({
                    "key": str(c.id), "kind": "insured", "name": c.name, "insured": True,
                    "relationship": _v(c.family_relationship) if c.family_relationship else "Self",
                    "age": fam.age_from_dob(c.dob) if c.dob else None,
                    "dob": _iso(c.dob) if (mine or (access.full and minor)) else None,
                    "is_minor": minor, "is_you": mine,
                    "policy_id": str(p.id), "policy_number": p.policy_number, "plan_type": plan, "family_policy_id": str(fp.id), "access": access.level,
                    "coverage": {"kind": "shared_pool" if pool else "own", "amount": p.coverage_amount,
                                 "note": "Shared by every insured person on this policy" if pool else None},
                    "coverage_effective_date": _iso(p.effective_date), "policy_status": status,
                    "eligibility": "covered" if status in IN_FORCE else ("pending" if status in fam.PENDING_ISSUANCE or status == "Issued" else "ended"),
                    "can_manage": access.full and (mine or minor or pool),      # on a shared floater the head runs the whole contract
                })
                insured_keys[_person_key(c.cnic, c.name)] = str(c.id)
    for fp, certs in arrangements:
        for p, access in certs:
            if not access.full:
                continue
            for b in await fam.nominees_of(session, p):
                key = _person_key(b.cnic, b.name)
                rows.append({
                    "key": f"nominee:{b.id}", "kind": "nominee", "name": b.name, "insured": False, "relationship": b.relationship,
                    "age": fam.age_from_dob(b.date_of_birth) if b.date_of_birth else None,
                    "dob": _iso(b.date_of_birth) if (b.is_minor and access.full) else None,
                    "is_minor": b.is_minor, "guardian_name": b.guardian_name, "share_pct": b.share_pct, "is_you": False,
                    "also_insured": key in insured_keys,
                    "policy_id": str(p.id), "policy_number": p.policy_number, "plan_type": _v(fp.plan_type), "family_policy_id": str(fp.id), "access": access.level,
                    "coverage": None, "eligibility": "nominee_only", "policy_status": _st(p), "can_manage": True,
                })
    return rows


def _counts(rows: list[dict]) -> dict:
    """listed = distinct people on the family (a spouse who is both insured and a nominee is one person);
    insured = people covered by a policy that is in force today; nominees = people named only as beneficiaries."""
    insured = {r["key"]: (r["name"] or "").strip().lower() for r in rows if r["kind"] == "insured"}
    nominee_names = {(r["name"] or "").strip().lower() for r in rows if r["kind"] == "nominee"}
    return {
        "listed": len(insured) + len(nominee_names - set(insured.values())),
        "insured": len({r["key"] for r in rows if r["kind"] == "insured" and r["eligibility"] == "covered"}),
        "insured_total": len(insured),
        "nominees": len(nominee_names - set(insured.values())),
    }


async def _group_view(session: AsyncSession, tenant_id: UUID, customer: Customer, role: fam.FamilyRole, *, detail: bool) -> dict:
    arrangements = await _arrangements(session, tenant_id, customer, role)
    members = await _members(session, customer, arrangements)
    arr_out, coverage, next_due, due_now, remaining = [], 0.0, None, 0.0, 0.0
    open_claims, policies_in_force, renewals_soon = 0, 0, []
    for fp, certs in arrangements:
        plan = _v(fp.plan_type)
        cards = []
        for p, access in certs:
            card = await _card(session, p, access=access)
            card["holder_name"] = (await session.get(Customer, p.customer_id)).name
            card["insured_names"] = [c.name for c in await fam.insured_lives(session, p, plan)]
            cards.append(card)
            if card["in_force"]:
                policies_in_force += 1
                if card["premium"]["next_due_date"] and (next_due is None or card["premium"]["next_due_date"] < next_due["date"]):
                    next_due = {"date": card["premium"]["next_due_date"], "amount": card["premium"]["next_due_amount"], "policy_number": card["policy_number"],
                                "policy_id": card["id"], "can_pay": card["premium"]["can_pay"]}
                due_now += card["premium"]["due_now"] or 0.0
                remaining += card["premium"]["remaining"] or 0.0
                end = card["expiry_date"] or card["maturity_date"]
                if access.full and end and 0 <= (date.fromisoformat(end[:10]) - date.today()).days <= 90:
                    renewals_soon.append({"policy_id": card["id"], "policy_number": card["policy_number"], "date": end})
            if card["claims"]:
                open_claims += card["claims"]["open"]
        # The coverage a family really has: a floater's pool counts ONCE (however many people share it); a bundle is the sum
        # of its certificates' own cover. Only policies in force count.
        if plan == FamilyPlanTypeEnum.FLOATER.value:
            live = [c for c in cards if c["in_force"]]
            coverage += max((c["sum_assured"] or 0.0) for c in live) if live else 0.0
        else:
            coverage += sum(c["sum_assured"] or 0.0 for c in cards if c["in_force"])
        arr_out.append({
            "family_policy_id": str(fp.id), "plan_type": plan, "plan_label": PLAN_LABELS.get(plan, plan), "status": fp.status,
            "term_years": fp.term_years, "effective_date": _iso(fp.effective_date),
            "shared_sum_insured": fp.total_sum_insured if plan == FamilyPlanTypeEnum.FLOATER.value else None,
            "discount_percentage": fp.discount_percentage if plan == FamilyPlanTypeEnum.LIFE_BUNDLE.value else None,
            "policies": cards,
        })
    g = role.group
    out = {
        "id": str(g.id), "name": g.name, "role": role.role,
        "arrangements": [{"family_policy_id": a["family_policy_id"], "plan_type": a["plan_type"], "plan_label": a["plan_label"], "status": a["status"],
                          "policy_count": len(a["policies"])} for a in arr_out],
        "plan_types": sorted({a["plan_type"] for a in arr_out}),
        "members": _counts(members),
        "totals": {"coverage": round(coverage, 2), "policies_in_force": policies_in_force, "policies_total": sum(len(a["policies"]) for a in arr_out),
                   "next_premium": next_due, "outstanding": round(due_now, 2), "remaining": round(remaining, 2), "open_claims": open_claims,
                   "renewals_soon": sorted(renewals_soon, key=lambda r: r["date"])},
    }
    if detail:
        out["arrangements"] = arr_out
        out["members_list"] = members
    return out


# ── groups ────────────────────────────────────────────────────────────────────

async def _service_request_replay(values, kept):
    """The summary the customer saw is read back from the audit event the request left, so the receipt holds no member details."""
    events = (await values["session"].exec(select(PolicyEvent).where(
        PolicyEvent.policy_id == UUID(kept["policy_id"]), PolicyEvent.event_type == "CustomerServiceRequested"
    ).order_by(PolicyEvent.created_at.desc()))).all()
    summary = next(((e.detail_json or {}).get("summary") for e in events if (e.detail_json or {}).get("request_ref") == values["body"].reference), None)
    return {"ok": True, **kept, "summary": summary}


async def _renewal_acceptance_replay(values):
    policy, _access = await _owned_policy_access(values["session"], values["tenant_id"], values["customer_id"], values["policy_id"], family="full")
    return _renewal_view(await renewal_overview(values["session"], policy), policy)


@router.get(BASE + "/family")
async def list_family(tenant_id: UUID, customer_id: UUID, session: AsyncSession = Depends(get_session)):
    """The family groups this customer belongs to and may see. Empty for a customer with only individual policies."""
    customer = await _customer(session, tenant_id, customer_id)
    out = []
    for role in await fam.roles_for(session, tenant_id, customer):
        view = await _group_view(session, tenant_id, customer, role, detail=False)
        if view["totals"]["policies_total"]:       # a group with nothing issued yet is a proposal, not a family policy
            out.append(view)
    return out


@router.get(BASE + "/family/{family_id}")
async def family_overview(tenant_id: UUID, customer_id: UUID, family_id: UUID, session: AsyncSession = Depends(get_session)):
    customer = await _customer(session, tenant_id, customer_id)
    role = await _role_for(session, tenant_id, customer, family_id)
    return await _group_view(session, tenant_id, customer, role, detail=True)


@router.get(BASE + "/family/{family_id}/policies")
async def family_policy_list(tenant_id: UUID, customer_id: UUID, family_id: UUID, session: AsyncSession = Depends(get_session)):
    customer = await _customer(session, tenant_id, customer_id)
    role = await _role_for(session, tenant_id, customer, family_id)
    view = await _group_view(session, tenant_id, customer, role, detail=True)
    return {"family_id": view["id"], "family_name": view["name"], "role": view["role"], "arrangements": view["arrangements"]}


# ── members ───────────────────────────────────────────────────────────────────

@router.get(BASE + "/family/{family_id}/members")
async def family_members(tenant_id: UUID, customer_id: UUID, family_id: UUID, session: AsyncSession = Depends(get_session)):
    customer = await _customer(session, tenant_id, customer_id)
    role = await _role_for(session, tenant_id, customer, family_id)
    rows = await _members(session, customer, await _arrangements(session, tenant_id, customer, role))
    return {"family_id": str(family_id), "role": role.role, "counts": _counts(rows), "items": rows}


@router.get(BASE + "/family/{family_id}/members/{member_key}")
async def family_member(tenant_id: UUID, customer_id: UUID, family_id: UUID, member_key: str, session: AsyncSession = Depends(get_session)):
    """One person's cover under each policy they appear on. Only people the caller may see appear at all."""
    customer = await _customer(session, tenant_id, customer_id)
    role = await _role_for(session, tenant_id, customer, family_id)
    rows = [r for r in await _members(session, customer, await _arrangements(session, tenant_id, customer, role)) if r["key"] == member_key]
    if not rows:
        raise HTTPException(404, "Member not found")
    first = rows[0]
    return {"key": member_key, "name": first["name"], "kind": first["kind"], "relationship": first["relationship"], "age": first["age"], "dob": first["dob"],
            "is_minor": first["is_minor"], "is_you": first["is_you"], "coverages": rows}


# ── beneficiaries ─────────────────────────────────────────────────────────────

def _bene_view(b: Beneficiary) -> dict:
    return {"id": str(b.id), "name": b.name, "relationship": b.relationship, "share_pct": b.share_pct, "is_minor": b.is_minor,
            "guardian_name": b.guardian_name, "cnic_masked": mask_cnic(b.cnic), "date_of_birth": _iso(b.date_of_birth) if b.is_minor else None}


@router.get(BASE + "/family/{family_id}/beneficiaries")
async def family_beneficiaries(tenant_id: UUID, customer_id: UUID, family_id: UUID, policy_id: UUID,
                               session: AsyncSession = Depends(get_session)):
    """A policy's nominees: who gets what, whether the nomination is complete (Σ share = 100), and every earlier version.
    Nominees are not insured persons; an insured spouse may also appear here."""
    customer = await _customer(session, tenant_id, customer_id)
    role = await _role_for(session, tenant_id, customer, family_id)
    policy, access = await _owned_policy_access(session, tenant_id, customer_id, policy_id, family="full")
    if access.family_id != role.group.id:
        raise HTTPException(404, "Policy not found")
    roster = await fam.nominees_of(session, policy)
    total = round(sum(b.share_pct for b in roster), 2)
    versions = (await session.exec(select(BeneficiaryVersion).where(BeneficiaryVersion.policy_id == policy.id)
                                   .order_by(BeneficiaryVersion.version_sequence.desc()))).all()  # type: ignore[attr-defined]
    actions = {a["kind"]: a for a in await policy_actions(session, policy, access)}
    return {
        "policy_id": str(policy.id), "policy_number": policy.policy_number, "plan_type": access.plan_type,
        "beneficiaries": [_bene_view(b) for b in roster], "total_share": total, "complete": abs(total - 100.0) <= 0.01 and bool(roster),
        "can_request_change": actions.get("NOMINEE_CHANGE", {}).get("available", False), "change_blocked_reason": actions.get("NOMINEE_CHANGE", {}).get("reason"),
        "versions": [{"sequence": v.version_sequence, "at": v.created_at.isoformat(), "total_share": v.total_share, "reason": v.change_reason,
                      "changed_by": "insurer" if (v.changed_by or "system") != "customer" else "you",
                      "beneficiaries": [{"name": b.get("name"), "relationship": b.get("relationship"), "share_pct": b.get("share_pct"),
                                         "is_minor": bool(b.get("is_minor"))} for b in (v.beneficiaries_json or [])]} for v in versions],
    }


# ── servicing requests ────────────────────────────────────────────────────────

class NomineeRow(BaseModel):
    name: str = PField(min_length=2, max_length=255)
    relationship: str = PField(min_length=2, max_length=100)
    share_pct: float = PField(gt=0, le=100)
    date_of_birth: Optional[date] = None
    cnic: Optional[str] = PField(default=None, max_length=20)
    guardian_name: Optional[str] = PField(default=None, max_length=255)


class ServiceRequestIn(BaseModel):
    kind: str
    policy_id: Optional[UUID] = None
    reference: str = PField(min_length=6, max_length=40)       # Customer Management's request reference
    reason: Optional[str] = PField(default=None, max_length=2000)
    # MEMBER_ADD / MEMBER_CORRECTION
    name: Optional[str] = PField(default=None, max_length=255)
    relationship: Optional[str] = PField(default=None, max_length=50)
    dob: Optional[date] = None
    cnic: Optional[str] = PField(default=None, max_length=20)
    insured: bool = False
    # MEMBER_REMOVE / MEMBER_CORRECTION
    member_key: Optional[str] = PField(default=None, max_length=80)
    changes: dict = PField(default_factory=dict)
    # COVERAGE_CHANGE
    new_sum_assured: Optional[float] = PField(default=None, gt=0, le=1_000_000_000)
    rider_note: Optional[str] = PField(default=None, max_length=500)
    # NOMINEE_CHANGE
    beneficiaries: list[NomineeRow] = PField(default_factory=list, max_length=12)
    # CONTACT_CORRECTION
    contact_email: Optional[str] = PField(default=None, max_length=255)
    contact_phone: Optional[str] = PField(default=None, max_length=30)


def _bad(code: str, message: str, status: int = 422, **extra: Any) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message, **extra})


CORRECTABLE = {"name", "dob", "cnic", "phone", "email", "relationship"}


def validate_nominations(rows: list[NomineeRow]) -> list[dict]:
    """The same rules the issuance and endorsement code enforce: at least one nominee, shares total exactly 100%, no duplicates,
    and a minor needs a guardian. Returns the normalised roster."""
    if not rows:
        raise _bad("NOMINEES_REQUIRED", "At least one nominee is required.")
    total = round(sum(r.share_pct for r in rows), 2)
    if abs(total - 100.0) > 0.01:
        raise _bad("SHARES_MUST_TOTAL_100", f"Nominee shares must add up to 100% (they add up to {total}%).", total=total)
    seen, out = set(), []
    for r in rows:
        key = _person_key(r.cnic, r.name)
        if key in seen:
            raise _bad("DUPLICATE_NOMINEE", f"{r.name} appears more than once.")
        seen.add(key)
        minor = fam.is_minor(r.date_of_birth)
        if minor and not (r.guardian_name or "").strip():
            raise _bad("GUARDIAN_REQUIRED", f"{r.name} is a minor: give the name of the guardian who will receive the share.")
        out.append({"name": r.name.strip(), "relationship": r.relationship.strip(), "share_pct": r.share_pct, "is_minor": minor,
                    "date_of_birth": _iso(r.date_of_birth), "guardian_name": (r.guardian_name or "").strip() or None,
                    "cnic": normalize_cnic(r.cnic) if r.cnic else None})
    return out


@router.post(BASE + "/family/{family_id}/requests", status_code=201)
@step_operation("portal.family.submit_request", _service_request_replay, ids=("customer_id", "family_id"), fields=("kind", "policy_id", "policy_number"),
                keep=lambda p: {"kind": p["kind"], "policy_id": p["policy_id"], "policy_number": p["policy_number"]}, status_code=201,
                authorize=portal_identity, resource_type="policy")
async def submit_family_request(tenant_id: UUID, customer_id: UUID, family_id: UUID, body: ServiceRequestIn, request: Request,
                                session: AsyncSession = Depends(get_session)):
    """Check a customer's servicing request against the SAME state and ownership rules the portal shows, then leave it on the
    policy's audit trail for the insurer's staff to action through the existing endorsement / underwriting / reinstatement
    screens. Nothing on the issued contract changes here: member, coverage and nominee changes need approval and repricing."""
    customer = await _customer(session, tenant_id, customer_id)
    role = await _role_for(session, tenant_id, customer, family_id)
    if body.kind not in fam.REQUEST_KINDS:
        raise _bad("UNKNOWN_REQUEST", "That kind of request is not available.")
    arrangements = await _arrangements(session, tenant_id, customer, role)
    full = [(p, a) for _, certs in arrangements for p, a in certs if a.full]
    if not full:
        raise HTTPException(404, "Family not found")

    # Which policy the request concerns. Group-level requests (members, contact) attach to the caller's own full-access policy.
    if body.policy_id:
        policy, access = await _owned_policy_access(session, tenant_id, customer_id, body.policy_id, family="full")
        if access.family_id != role.group.id:
            raise HTTPException(404, "Policy not found")
    else:
        policy, access = next(((p, a) for p, a in full if a.role == "head" and p.customer_id == customer.id), full[0])

    actions = {a["kind"]: a for a in await policy_actions(session, policy, access)}
    state = actions.get(body.kind, {"available": False, "reason": "NOT_AVAILABLE"})
    if not state["available"]:
        raise _bad("ACTION_NOT_AVAILABLE", "This action is not available for the policy right now.", 409, reason=state["reason"])

    summary: dict[str, Any] = {"kind": body.kind}
    members = await _members(session, customer, arrangements)
    if body.kind == "MEMBER_ADD":
        if not (body.name and body.relationship and body.dob):
            raise _bad("VALIDATION", "Name, relationship and date of birth are required.")
        if body.relationship not in (INSURABLE_RELATIONSHIPS | NOMINEE_RELATIONSHIPS) - {"Self"}:
            raise _bad("INVALID_RELATIONSHIP", "Choose Spouse, Child, Parent, Sibling or Other.")
        if body.insured and body.relationship not in INSURABLE_RELATIONSHIPS:
            raise _bad("NOT_INSURABLE", "Only the policyholder and their spouse can be insured; other family members can be named as nominees.")
        if body.insured and any(r["kind"] == "insured" and r["relationship"] == "Spouse" and r["policy_id"] == str(policy.id) for r in members):
            raise _bad("SPOUSE_ALREADY_INSURED", "A spouse is already insured on this policy.", 409)
        key = _person_key(body.cnic, body.name)
        if any(_person_key(None, r["name"]) == key or (body.cnic and key and r["kind"] == "nominee" and key == _person_key(None, r["name"])) for r in members):
            raise _bad("DUPLICATE_MEMBER", "This person is already on the family.", 409)
        if _counts(members)["listed"] >= MAX_FAMILY_SIZE:
            raise _bad("FAMILY_FULL", f"A family can list at most {MAX_FAMILY_SIZE} people.", 409)
        summary.update(name=body.name, relationship=body.relationship, insured=body.insured)
    elif body.kind in ("MEMBER_REMOVE", "MEMBER_CORRECTION"):
        row = next((r for r in members if r["key"] == body.member_key), None)
        if row is None:
            raise HTTPException(404, "Member not found")
        if not row["can_manage"]:
            raise _bad("NOT_AUTHORISED", "You can only change yourself, your nominees and children under 18. Another adult must ask for their own changes.", 403)
        if body.kind == "MEMBER_REMOVE":
            if row["relationship"] == "Self" and row["kind"] == "insured":
                raise _bad("CANNOT_REMOVE_HEAD", "The policyholder cannot be removed. To end the policy, ask to cancel it.", 409)
            summary.update(member=row["name"], member_kind=row["kind"], scope="this_policy_only")      # never another member's own policy
        else:
            changes = {k: v for k, v in (body.changes or {}).items() if v not in (None, "")}
            if not changes or set(changes) - CORRECTABLE:
                raise _bad("VALIDATION", f"Choose what to correct: {', '.join(sorted(CORRECTABLE))}.")
            summary.update(member=row["name"], fields=sorted(changes))
    elif body.kind == "COVERAGE_CHANGE":
        if not body.new_sum_assured and not (body.rider_note or "").strip():
            raise _bad("VALIDATION", "Say the new cover amount or the benefit you want to add or remove.")
        if body.new_sum_assured and abs(body.new_sum_assured - policy.coverage_amount) < 1:
            raise _bad("NO_CHANGE", "That is the cover you already have.", 409)
        summary.update(current=policy.coverage_amount, requested=body.new_sum_assured)
    elif body.kind == "NOMINEE_CHANGE":
        roster = validate_nominations(body.beneficiaries)
        summary.update(beneficiaries=len(roster))
    elif body.kind == "CONTACT_CORRECTION":
        if not (body.contact_email or body.contact_phone):
            raise _bad("VALIDATION", "Give the new email address or phone number.")
        summary.update(fields=[k for k, v in (("email", body.contact_email), ("phone", body.contact_phone)) if v])
    elif body.kind in ("CANCELLATION", "REINSTATEMENT"):
        if body.kind == "CANCELLATION" and not (body.reason or "").strip():
            raise _bad("VALIDATION", "Please tell us why you want to cancel.")

    detail = {"request_ref": body.reference, "kind": body.kind, "summary": summary, "reason": (body.reason or "")[:500] or None,
              "family": role.group.name, "plan_type": access.plan_type}
    # Staff-facing proposals the audit trail must carry in full (they apply them); everything else is summarised above.
    if body.kind == "NOMINEE_CHANGE":
        detail["proposed_beneficiaries"] = roster
    if body.kind in ("MEMBER_ADD", "MEMBER_CORRECTION", "MEMBER_REMOVE"):
        detail["proposal"] = {"name": body.name, "relationship": body.relationship, "dob": _iso(body.dob), "insured": body.insured,
                              "member_key": body.member_key, "changes": body.changes}
    if body.kind == "COVERAGE_CHANGE":
        detail["proposal"] = {"new_sum_assured": body.new_sum_assured, "note": body.rider_note}
    if body.kind == "CONTACT_CORRECTION":
        detail["proposal"] = {"email": body.contact_email, "phone": body.contact_phone}
    record_event(session, policy, event_type="CustomerServiceRequested", actor=f"customer:{customer.policyholder_id or str(customer.id)[:8]}", detail=detail)
    await session.commit()
    return {"ok": True, "kind": body.kind, "policy_id": str(policy.id), "policy_number": policy.policy_number, "summary": summary}


class WithdrawIn(BaseModel):
    reference: str = PField(min_length=6, max_length=40)
    policy_id: Optional[UUID] = None


@router.post(BASE + "/family/{family_id}/requests/withdraw")
@reviewed_operation("portal.family.withdraw_request", ("ok",), authorize=portal_identity, resource_type="policy")
async def withdraw_family_request(tenant_id: UUID, customer_id: UUID, family_id: UUID, body: WithdrawIn,
                                  session: AsyncSession = Depends(get_session)):
    """Tell the insurer's staff a request was withdrawn, so they do not act on it."""
    customer = await _customer(session, tenant_id, customer_id)
    role = await _role_for(session, tenant_id, customer, family_id)
    if body.policy_id is None:
        return {"ok": True}
    policy, access = await _owned_policy_access(session, tenant_id, customer_id, body.policy_id, family="full")
    if access.family_id != role.group.id:
        raise HTTPException(404, "Policy not found")
    record_event(session, policy, event_type="CustomerServiceRequestWithdrawn", actor=f"customer:{customer.policyholder_id or str(customer.id)[:8]}",
                 detail={"request_ref": body.reference})
    await session.commit()
    return {"ok": True}


# ── renewals (existing engine, customer-safe) ─────────────────────────────────

def _renewal_view(ov: dict, policy: Policy) -> dict:
    case = ov.get("case")
    nxt = ov.get("next")
    elig = ov.get("eligibility") or {}
    return {
        "policy_id": str(policy.id), "policy_number": policy.policy_number, "status": ov["policy"]["status"],
        "contract_renewable": ov.get("contract_renewable"), "annual_premium": ov.get("annual_premium"),
        "next": ({k: nxt.get(k) for k in ("due_date", "amount", "surcharge", "payable", "renewal_type_label", "frequency", "in_ledger", "installment_no",
                                           "window_opens_on", "days_until", "state", "period_end")} if nxt else None),
        "eligible": elig.get("eligible"), "eligibility_message": elig.get("message"),
        "case": ({"id": case["id"], "status": case["status"], "renewal_type_label": case["renewal_type_label"], "due_date": case["due_date"],
                  "quoted_amount": case["quoted_amount"], "acceptance": {"required": case["acceptance"]["required"], "accepted_at": case["acceptance"]["accepted_at"]},
                  "closed_reason": case["closed_reason"], "can": {"accept": case["can"]["accept"], "pay": case["can"]["pay"]}} if case else None),
    }


@router.get(BASE + "/policies/{policy_id}/renewal")
async def renewal_status(tenant_id: UUID, customer_id: UUID, policy_id: UUID, session: AsyncSession = Depends(get_session)):
    policy, _access = await _owned_policy_access(session, tenant_id, customer_id, policy_id, family="full")
    return _renewal_view(await renewal_overview(session, policy), policy)


class RenewalAcceptance(BaseModel):
    accepted: bool
    note: Optional[str] = PField(default=None, max_length=500)


@router.post(BASE + "/policies/{policy_id}/renewal/acceptance")
@step_operation("portal.renewal.acceptance", _renewal_acceptance_replay, ids=("customer_id", "policy_id"), atomic=False, authorize=portal_identity, resource_type="policy")
async def renewal_acceptance(tenant_id: UUID, customer_id: UUID, policy_id: UUID, body: RenewalAcceptance, request: Request,
                             session: AsyncSession = Depends(get_session)):
    """Accept (or decline) renewed terms. Offered only when the renewal engine itself says acceptance is the next step."""
    customer = await _customer(session, tenant_id, customer_id)
    policy, access = await _owned_policy_access(session, tenant_id, customer_id, policy_id, family="full")
    ov = await renewal_overview(session, policy)
    case = ov.get("case")
    if not case or not case["can"]["accept"]:
        raise _bad("ACTION_NOT_AVAILABLE", "There are no renewed terms waiting for your acceptance.", 409)
    if access.segment == "family" and access.role != "head" and policy.customer_id != customer.id:
        raise _bad("NOT_AUTHORISED", "Only the policyholder can accept renewed terms.", 403)
    await capture_acceptance(tenant_id, policy.id, UUID(case["id"]),
                             AcceptanceBody(accepted=body.accepted, accepted_by=f"customer:{customer.policyholder_id or str(customer.id)[:8]}",
                                            method="Portal", note=body.note), request, session)
    return _renewal_view(await renewal_overview(session, policy), policy)
