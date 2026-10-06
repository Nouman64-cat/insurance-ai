"""Claims on group certificates (GROUP_LIFE_PLAN.md Phase 5).

Thin HTTP layer over services/group_claims.py. Two surfaces:

  /tenants/{t}/organizations/{o}/master-policies/{mp}/claims   — open a claim on a
        member's (or a covered dependant's) certificate; list a scheme's claims
  /tenants/{t}/claims/{claim_id}/group-context | payout-split | group-payout
        — what the group side adds to any claim: checklist, limit, split, payout

Authorisation is the claims desk's, same as routers/claims.py.
"""

from datetime import date
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import oauth2_scheme
from routers.claims import (
    ClaimCreate,
    _assert_claims_role,
    _claim_dict,
    assert_claim_payable,
    open_claim,
    settle_claim_with_payouts,
)
from routers.organizations import _get_master_policy
from services.group_claims import (
    GroupClaimError,
    claim_group_context,
    coverage_for_claim_type,
    eligibility_for,
    split_for_claim,
)
from shared.models.core import (
    Claim,
    Customer,
    GroupMember,
    GroupMemberDependent,
    Policy,
    User,
)

router = APIRouter(tags=["Group Claims"])


async def claims_user(token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)) -> User:
    return await _assert_claims_role(token, session)


def _http(exc: GroupClaimError) -> HTTPException:
    return HTTPException(exc.status, exc.detail)


class GroupClaimCreate(BaseModel):
    member_id: UUID
    dependent_id: Optional[UUID] = None
    claim_type: str = Field(description="Death Claim, Accidental Death, Disability, Pay Continuation, Fee Continuation, Hospitalization …")
    coverage_type: Optional[str] = None
    submitted_amount: float = Field(gt=0)
    incident_date: Optional[date] = None
    notes: Optional[str] = None
    claimant_type: Optional[str] = None
    claimant_name: Optional[str] = None
    claimant_cnic: Optional[str] = None
    claimant_relationship: Optional[str] = None
    claimant_phone: Optional[str] = None


class SplitOverride(BaseModel):
    name: str
    share_pct: float = Field(ge=0, le=100)
    relationship: Optional[str] = None
    cnic: Optional[str] = None
    is_minor: bool = False
    guardian_name: Optional[str] = None


class SplitRequest(BaseModel):
    overrides: Optional[List[SplitOverride]] = None
    override_reason: Optional[str] = Field(default=None, max_length=500)
    amount: Optional[float] = Field(default=None, gt=0)


class GroupPayoutRequest(SplitRequest):
    method: str = "Bank Transfer"
    reference_number: Optional[str] = None
    notes: Optional[str] = None
    confirm_no_nominee: bool = False        # pay the claimant in full although no nominee is on file


_SCHEME = "/tenants/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/claims"


@router.post(_SCHEME, status_code=status.HTTP_201_CREATED)
async def open_group_claim(tenant_id: UUID, org_id: UUID, mp_id: UUID, body: GroupClaimCreate,
                           current_user: User = Depends(claims_user), session: AsyncSession = Depends(get_session)) -> Dict[str, Any]:
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    member = await session.get(GroupMember, body.member_id)
    if member is None or member.master_policy_id != mp.id:
        raise HTTPException(404, "Member not found on this scheme.")
    dependent: Optional[GroupMemberDependent] = None
    if body.dependent_id is not None:
        dependent = await session.get(GroupMemberDependent, body.dependent_id)
        if dependent is None or dependent.group_member_id != member.id:
            raise HTTPException(404, "That dependant isn't listed under this member.")
    if member.policy_id is None:
        raise HTTPException(409, "This member has no certificate yet.")

    coverage = coverage_for_claim_type(body.claim_type, body.coverage_type)
    incident = body.incident_date or date.today()
    errors = await eligibility_for(session, member, dependent, incident=incident, claim_type=body.claim_type,
                                   coverage_type=coverage, amount=body.submitted_amount)
    if errors:
        raise HTTPException(422, {"message": "This claim can't be opened.", "errors": errors})

    customer = await session.get(Customer, member.customer_id)
    data = body.model_dump(exclude={"member_id", "dependent_id", "coverage_type"})
    if dependent is not None:          # the employee files for their dependant's death
        data.update(claimant_name=customer.name, claimant_cnic=customer.cnic, claimant_relationship="Employee", claimant_type="SELF")
        data["notes"] = f"Claim for dependant {dependent.name} ({dependent.relationship}). " + (body.notes or "")
    claim, policy, cust = await open_claim(
        session, tenant_id, current_user, ClaimCreate(policy_id=member.policy_id, **data),
        group_member_id=member.id, group_dependent_id=dependent.id if dependent else None, coverage_type=coverage)
    return {"claim": _claim_dict(claim, policy, cust, current_user, 0), "group": await claim_group_context(session, tenant_id, claim)}


@router.get(_SCHEME)
async def list_scheme_claims(tenant_id: UUID, org_id: UUID, mp_id: UUID, _user: User = Depends(claims_user),
                             session: AsyncSession = Depends(get_session)) -> Dict[str, Any]:
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    claims = (await session.exec(
        select(Claim).join(Policy, Policy.id == Claim.policy_id)
        .where(Policy.master_policy_id == mp.id, Claim.tenant_id == tenant_id).order_by(Claim.created_at.desc()).limit(200)
    )).all()
    items: List[Dict[str, Any]] = []
    for c in claims:
        ctx = await claim_group_context(session, tenant_id, c)
        items.append({
            "id": str(c.id), "claim_number": c.claim_number, "claim_type": c.claim_type, "coverage_type": ctx.get("coverage_type"),
            "status": c.status.value if hasattr(c.status, "value") else str(c.status),
            "submitted_amount": c.submitted_amount, "approved_amount": c.approved_amount, "settlement_amount": c.settlement_amount,
            "incident_date": c.incident_date.isoformat() if c.incident_date else None, "created_at": c.created_at.isoformat(),
            "member": (ctx.get("member") or {}).get("name"), "dependent": (ctx.get("dependent") or {}).get("name"),
            "certificate_number": (ctx.get("member") or {}).get("certificate_number"),
            "required_documents": ctx.get("required_documents"), "missing_documents": ctx.get("missing_documents"),
            "documents_on_file": ctx.get("documents_on_file"),
        })
    open_status = {"Settled", "Declined", "Closed"}
    return {
        "claims": items,
        "summary": {
            "count": len(items),
            "open": sum(1 for i in items if i["status"] not in open_status),
            "submitted": round(sum(i["submitted_amount"] for i in items), 2),
            "approved": round(sum(i["approved_amount"] or 0 for i in items), 2),
            "paid": round(sum(i["settlement_amount"] or 0 for i in items), 2),
        },
    }


# ── what the group side adds to a claim ─────────────────────────────────────

_CLAIM = "/tenants/{tenant_id}/claims/{claim_id}"


async def _claim(session: AsyncSession, tenant_id: UUID, claim_id: UUID) -> Claim:
    claim = await session.get(Claim, claim_id)
    if claim is None or claim.tenant_id != tenant_id:
        raise HTTPException(404, "Claim not found")
    return claim


@router.get(_CLAIM + "/group-context")
async def group_context(tenant_id: UUID, claim_id: UUID, _user: User = Depends(claims_user),
                        session: AsyncSession = Depends(get_session)) -> Dict[str, Any]:
    return await claim_group_context(session, tenant_id, await _claim(session, tenant_id, claim_id))


def _override_rows(body: SplitRequest) -> Optional[List[Dict[str, Any]]]:
    return [o.model_dump() for o in body.overrides] if body.overrides else None


@router.get(_CLAIM + "/payout-split")
async def default_split(tenant_id: UUID, claim_id: UUID, _user: User = Depends(claims_user),
                        session: AsyncSession = Depends(get_session)) -> Dict[str, Any]:
    try:
        return await split_for_claim(session, tenant_id, await _claim(session, tenant_id, claim_id))
    except GroupClaimError as exc:
        raise _http(exc) from exc


@router.post(_CLAIM + "/payout-split")
async def preview_split_endpoint(tenant_id: UUID, claim_id: UUID, body: SplitRequest, _user: User = Depends(claims_user),
                                 session: AsyncSession = Depends(get_session)) -> Dict[str, Any]:
    """What a payout would look like with this amount / override — nothing is paid."""
    try:
        return await split_for_claim(session, tenant_id, await _claim(session, tenant_id, claim_id), body.amount,
                                     _override_rows(body), body.override_reason)
    except GroupClaimError as exc:
        raise _http(exc) from exc


@router.post(_CLAIM + "/group-payout", status_code=status.HTTP_201_CREATED)
async def group_payout(tenant_id: UUID, claim_id: UUID, body: GroupPayoutRequest, current_user: User = Depends(claims_user),
                       session: AsyncSession = Depends(get_session)) -> Dict[str, Any]:
    """Disburse an approved claim to its payees — the nominees by their shares (or an
    overriding split), one payout row each — and settle the claim."""
    claim = await _claim(session, tenant_id, claim_id)
    amount = body.amount or (claim.approved_amount if claim.approved_amount > 0 else claim.submitted_amount)
    await assert_claim_payable(session, tenant_id, claim, amount)
    try:
        split = await split_for_claim(session, tenant_id, claim, amount, _override_rows(body), body.override_reason)
    except GroupClaimError as exc:
        raise _http(exc) from exc

    blocked = [s["name"] for s in split["shares"] if s["is_minor"] and not s["guardian_name"]]
    if blocked:
        raise HTTPException(409, f"{', '.join(blocked)} is a minor with no guardian on file — add one before paying.")
    if split["source"] == "claimant" and not body.confirm_no_nominee:
        raise HTTPException(409, {"message": split["warnings"][0], "needs_confirmation": "confirm_no_nominee"})

    base_ref = body.reference_number
    payouts = []
    for i, s in enumerate(split["shares"], start=1):
        payouts.append({
            "amount": s["amount"], "method": body.method,
            "reference_number": f"{base_ref}-{i}" if base_ref and len(split["shares"]) > 1 else base_ref,
            "notes": "; ".join(filter(None, [body.notes, *s["notes"],
                                             f"Split overridden: {split['override_reason']}" if split["source"] == "override" else None])) or None,
            "payee_name": s["payee_name"], "payee_cnic": s["cnic"], "payee_relationship": s["relationship"], "share_pct": s["share_pct"],
        })
    rows = await settle_claim_with_payouts(session, tenant_id, claim, current_user, payouts)
    await session.commit()
    return {
        "claim_id": str(claim.id), "claim_number": claim.claim_number, "total": round(sum(p["amount"] for p in payouts), 2),
        "source": split["source"], "override_reason": split["override_reason"],
        "payouts": [{"id": str(r.id), "payee": r.payee_name, "relationship": r.payee_relationship, "share_pct": r.share_pct,
                     "amount": r.amount, "reference_number": r.reference_number} for r in rows],
    }
