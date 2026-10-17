"""Claims on group certificates (GROUP_LIFE_PLAN.md Phase 5).

A claim on a group certificate differs from an individual one in four ways, all
handled here so routers/claims.py stays untouched apart from two small extractions
(`open_claim`, the payout helpers):

  1. Documents. A group file also needs the employer's certificate and salary
     slips, and a death claim its death certificate and the CNICs — see
     required_documents().
  2. Who is covered. The employee, or a dependant ONLY when the scheme schedule
     lists them (GroupMemberDependent) — a nominee is never a covered life. The loss
     must fall inside the member's cover dates and within the cover amount.
  3. Who is paid. A death benefit is split between the nominees on the certificate by
     Beneficiary.share_pct. Policy wording or local law can change that, so the split
     runs through a rule hook (SPLIT_RULES / register_split_rule) and an explicit,
     reasoned override; both are recorded on the claim's history.
  4. Which benefit. Life, Accidental Death, Disability, Pay Continuation and Fee
     Continuation each have their own cover amount (a % of the member's base cover,
     from the class's GroupClassCoverage rows) and document list.

Pure functions come first; the database functions below them do the work.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import (
    Artifact,
    Beneficiary,
    Claim,
    ClaimStatusEnum,
    Customer,
    GroupBenefitClass,
    GroupClassCoverage,
    GroupCoverageType,
    GroupMember,
    GroupMemberDependent,
    GroupMemberStatus,
    MasterPolicy,
    Organization,
    Policy,
)

LIFE = GroupCoverageType.LIFE.value
ACCIDENTAL_DEATH = GroupCoverageType.ACCIDENTAL_DEATH.value
DISABILITY = GroupCoverageType.DISABILITY.value
PAY_CONTINUATION = GroupCoverageType.PAY_CONTINUATION.value
FEE_CONTINUATION = GroupCoverageType.FEE_CONTINUATION.value

# What each benefit's claim file must contain. Names are the artifact document_type
# strings the upload dialogs use. "Employer Certificate" and "Salary Slip" are the
# group-specific ones: the employer confirms employment on the loss date and the
# slips fix the salary the cover was priced on.
GROUP_CLAIM_DOCUMENTS: Dict[str, Tuple[str, ...]] = {
    LIFE: ("Death Certificate", "CNIC", "Claimant CNIC", "Employer Certificate", "Salary Slip"),
    ACCIDENTAL_DEATH: ("Death Certificate", "CNIC", "Claimant CNIC", "Employer Certificate", "Salary Slip",
                       "Police Report", "Post-Mortem Report"),
    DISABILITY: ("Medical Board Certificate", "Discharge Summary", "CNIC", "Employer Certificate", "Salary Slip"),
    PAY_CONTINUATION: ("Medical Certificate", "Salary Slip", "Employer Certificate", "CNIC"),
    FEE_CONTINUATION: ("Death Certificate", "Fee Voucher", "Student Enrolment Certificate", "Claimant CNIC"),
}
# Claim types the platform already knows that are health-shaped rather than benefit-shaped.
GROUP_HEALTH_DOCUMENTS = ("Hospital Bill", "Discharge Summary", "CNIC", "Lab Test Report", "Employer Certificate")
DEPENDENT_DEATH_DOCUMENTS = ("Death Certificate", "CNIC", "Relationship Proof", "Employer Certificate")

_TYPE_TO_COVERAGE = {"Death Claim": LIFE, "Accidental Death": ACCIDENTAL_DEATH, "Disability": DISABILITY,
                     "Pay Continuation": PAY_CONTINUATION, "Fee Continuation": FEE_CONTINUATION}


def coverage_for_claim_type(claim_type: str, coverage_type: Optional[str]) -> Optional[str]:
    """The benefit a claim is under: what was asked for, else what the claim type implies."""
    if coverage_type:
        return coverage_type
    return _TYPE_TO_COVERAGE.get(claim_type)


def required_documents(claim_type: str, coverage_type: Optional[str], *, dependent: bool = False,
                       has_nominee: bool = True) -> List[str]:
    docs: Tuple[str, ...]
    cov = coverage_for_claim_type(claim_type, coverage_type)
    if dependent:
        docs = DEPENDENT_DEATH_DOCUMENTS
    elif cov in GROUP_CLAIM_DOCUMENTS:
        docs = GROUP_CLAIM_DOCUMENTS[cov]
    else:
        docs = GROUP_HEALTH_DOCUMENTS
    out = list(docs)
    # Without a nominee on the certificate, the right to the benefit has to be proven.
    if cov in (LIFE, ACCIDENTAL_DEATH) and not dependent and not has_nominee:
        out.append("Succession Certificate")
    return out


def missing_documents(required: Sequence[str], on_file: Sequence[str]) -> List[str]:
    have = {d.strip().lower() for d in on_file}
    return [d for d in required if d.lower() not in have]


def rider_amount(base_cover: float, percent_of_base: float, max_amount: Optional[float]) -> float:
    """A benefit's cover under a class: its % of the member's base (life) cover, capped."""
    amount = base_cover * percent_of_base / 100.0
    return min(amount, float(max_amount)) if max_amount is not None else amount


def coverage_schedule(base_cover: float, coverages: Sequence[Any]) -> Dict[str, float]:
    """{coverage type: cover amount} for one member. Life is always the base cover; the
    others exist only if the member's class lists them."""
    out = {LIFE: base_cover}
    for c in coverages:
        if c.coverage_type != LIFE:
            out[c.coverage_type] = round(rider_amount(base_cover, c.percent_of_base, c.max_amount), 2)
    return out


def check_eligibility(
    *, incident: date, claim_type: str, coverage_type: Optional[str], amount: float,
    member: Dict[str, Any], schedule: Dict[str, float], dependent: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """Why a claim can't be opened, as readable sentences ([] = it can).

    member: {name, status, cover_start, cover_end, certificate_status}
    dependent: {name, status, covered_amount, relationship} when the loss is theirs."""
    errors: List[str] = []
    cov = coverage_for_claim_type(claim_type, coverage_type) or LIFE
    who = (dependent or member)["name"]

    if member["status"] not in (GroupMemberStatus.ACTIVE.value, GroupMemberStatus.REMOVED.value):
        errors.append(f"{member['name']}'s cover isn't in force (status {member['status']}).")
    start, end = member.get("cover_start"), member.get("cover_end")
    if start and incident < start:
        errors.append(f"The loss on {incident} is before {member['name']}'s cover started on {start}.")
    if end and incident > end:
        errors.append(f"The loss on {incident} is after {member['name']}'s cover ended on {end}.")
    if member.get("certificate_status") not in ("Active", "Cancelled", "Lapsed"):
        errors.append(f"The certificate is {member.get('certificate_status') or 'not issued'}, so no claim can be made on it yet.")

    if dependent is not None:
        if dependent["status"] != GroupMemberStatus.ACTIVE.value:
            errors.append(f"{who} is not a covered dependant (status {dependent['status']}).")
        if cov != LIFE:
            errors.append("Dependants are covered for life cover only.")
        limit = float(dependent["covered_amount"])
    else:
        if cov not in schedule:
            errors.append(f"{member['name']}'s class has no {cov} cover.")
        limit = float(schedule.get(cov, 0.0))
    if not errors and amount > limit + 0.005:
        errors.append(f"The claim of PKR {amount:,.0f} exceeds {who}'s {cov} cover of PKR {limit:,.0f}.")
    return errors


# ═══════════════════════════════════════════════════════════════════════════
# Payout split
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class Share:
    name: str
    share_pct: float
    relationship: Optional[str] = None
    cnic: Optional[str] = None
    is_minor: bool = False
    guardian_name: Optional[str] = None
    payee_name: Optional[str] = None          # who the money goes to (the guardian, for a minor)
    amount: float = 0.0
    notes: List[str] = field(default_factory=list)


@dataclass
class SplitContext:
    claim_type: str
    coverage_type: Optional[str]
    business_type: str
    amount: float
    dependent_claim: bool = False


@dataclass
class SplitResult:
    shares: List[Share]
    source: str                              # nominees | claimant | member | override
    warnings: List[str] = field(default_factory=list)
    override_reason: Optional[str] = None

    def as_dicts(self) -> List[Dict[str, Any]]:
        return [{"name": s.name, "payee_name": s.payee_name or s.name, "relationship": s.relationship, "cnic": s.cnic,
                 "share_pct": s.share_pct, "amount": s.amount, "is_minor": s.is_minor, "guardian_name": s.guardian_name,
                 "notes": s.notes} for s in self.shares]


SplitRule = Callable[[SplitContext, List[Share]], List[Share]]


def guardian_for_minors(ctx: SplitContext, shares: List[Share]) -> List[Share]:
    """A minor can't receive money: it is paid to their named guardian. No guardian on
    file is flagged on the share (the adjuster must resolve it before paying)."""
    for s in shares:
        if s.is_minor:
            if s.guardian_name:
                s.payee_name = s.guardian_name
                s.notes.append(f"Minor — paid to guardian {s.guardian_name}")
            else:
                s.notes.append("Minor with no guardian on file — name one before paying")
    return shares


# Rules applied, in order, to every split. Policy wording or local law (for example,
# Shariah succession shares under a Takaful scheme) plugs in here with register_split_rule.
SPLIT_RULES: List[SplitRule] = [guardian_for_minors]


def register_split_rule(rule: SplitRule) -> SplitRule:
    SPLIT_RULES.append(rule)
    return rule


def allocate(amount: float, shares: List[Share]) -> List[Share]:
    """Amounts to the paisa, summing to exactly `amount` (the remainder lands on the largest share)."""
    for s in shares:
        s.amount = round(amount * s.share_pct / 100.0, 2)
    diff = round(amount - sum(s.amount for s in shares), 2)
    if diff and shares:
        max(shares, key=lambda s: s.share_pct).amount = round(max(shares, key=lambda s: s.share_pct).amount + diff, 2)
    return shares


def compute_split(
    amount: float, ctx: SplitContext, nominees: Sequence[Dict[str, Any]], *, fallback: Dict[str, Any],
    overrides: Optional[Sequence[Dict[str, Any]]] = None, override_reason: Optional[str] = None,
    rules: Optional[Sequence[SplitRule]] = None,
) -> SplitResult:
    """Who gets what.

    nominees: [{name, cnic, relationship, share_pct, is_minor, guardian_name}] — the certificate's Beneficiary rows.
    fallback: {name, cnic, relationship} — paid in full when there is no nominee (the claimant, or the
              employee for a dependant's death).
    overrides: replaces the nominees entirely; needs a reason, which is kept on the claim.
    """
    warnings: List[str] = []
    if overrides:
        if not (override_reason or "").strip():
            raise ValueError("A payout split that differs from the nominations needs a reason (court order, will, policy wording…).")
        rows, source = list(overrides), "override"
    elif ctx.dependent_claim:
        rows, source = [{**fallback, "share_pct": 100.0, "relationship": fallback.get("relationship") or "Employee"}], "member"
    elif nominees:
        rows, source = list(nominees), "nominees"
    else:
        rows, source = [{**fallback, "share_pct": 100.0}], "claimant"
        warnings.append("There is no nominee on the certificate — the benefit goes to the claimant in full. "
                        "Confirm entitlement (succession certificate) before paying.")
    total = round(sum(float(r.get("share_pct") or 0) for r in rows), 4)
    if abs(total - 100.0) > 0.01:
        raise ValueError(f"The shares add up to {total:g}%, not 100%.")
    shares = [Share(name=r["name"], share_pct=float(r["share_pct"]), relationship=r.get("relationship"), cnic=r.get("cnic"),
                    is_minor=bool(r.get("is_minor")), guardian_name=r.get("guardian_name")) for r in rows]
    for rule in (SPLIT_RULES if rules is None else rules):
        shares = rule(ctx, shares)
    return SplitResult(allocate(amount, shares), source, warnings, override_reason if source == "override" else None)


# ═══════════════════════════════════════════════════════════════════════════
# Database
# ═══════════════════════════════════════════════════════════════════════════

class GroupClaimError(Exception):
    def __init__(self, message: str, status: int = 409, detail: Any = None):
        super().__init__(message)
        self.status, self.detail = status, detail if detail is not None else message


async def _classes_and_coverages(session: AsyncSession, mp_id: UUID) -> Tuple[Dict[UUID, GroupBenefitClass], Dict[UUID, List[GroupClassCoverage]]]:
    classes = {c.id: c for c in (await session.exec(select(GroupBenefitClass).where(GroupBenefitClass.master_policy_id == mp_id))).all()}
    cov: Dict[UUID, List[GroupClassCoverage]] = {}
    if classes:
        for row in (await session.exec(select(GroupClassCoverage).where(GroupClassCoverage.benefit_class_id.in_(list(classes))))).all():
            cov.setdefault(row.benefit_class_id, []).append(row)
    return classes, cov


async def member_schedule(session: AsyncSession, member: GroupMember) -> Dict[str, float]:
    rows = (await session.exec(select(GroupClassCoverage).where(
        GroupClassCoverage.benefit_class_id == member.benefit_class_id))).all() if member.benefit_class_id else []
    return coverage_schedule(float(member.coverage_amount), rows)


async def _on_file(session: AsyncSession, claim: Claim) -> List[str]:
    stmt = select(Artifact.document_type).where(Artifact.claim_id == claim.id)
    if claim.case_id:
        stmt = select(Artifact.document_type).where((Artifact.claim_id == claim.id) | (Artifact.case_id == claim.case_id))
    return [d for d in (await session.exec(stmt)).all() if d]


async def _nominees(session: AsyncSession, policy_id: Optional[UUID]) -> List[Dict[str, Any]]:
    if policy_id is None:
        return []
    rows = (await session.exec(select(Beneficiary).where(Beneficiary.policy_id == policy_id))).all()
    return [{"name": b.name, "cnic": b.cnic, "relationship": b.relationship, "share_pct": b.share_pct,
             "is_minor": b.is_minor, "guardian_name": b.guardian_name} for b in rows]


async def claim_group_context(session: AsyncSession, tenant_id: UUID, claim: Claim) -> Dict[str, Any]:
    """Everything the group side of a claim adds: who, which benefit and limit, the
    document checklist and (once approved) the default payout split."""
    policy = await session.get(Policy, claim.policy_id)
    if policy is None or policy.master_policy_id is None:
        return {"is_group": False}
    mp = await session.get(MasterPolicy, policy.master_policy_id)
    org = await session.get(Organization, mp.organization_id) if mp else None
    member = await session.get(GroupMember, claim.group_member_id) if claim.group_member_id else None
    if member is None:
        member = (await session.exec(select(GroupMember).where(GroupMember.policy_id == policy.id))).first()
    dependent = await session.get(GroupMemberDependent, claim.group_dependent_id) if claim.group_dependent_id else None
    customer = await session.get(Customer, member.customer_id) if member else None
    nominees = await _nominees(session, policy.id)

    cov = coverage_for_claim_type(claim.claim_type, claim.coverage_type)
    schedule = await member_schedule(session, member) if member else {}
    required = required_documents(claim.claim_type, claim.coverage_type, dependent=dependent is not None, has_nominee=bool(nominees))
    on_file = await _on_file(session, claim)
    business = "Conventional"
    if mp and mp.plan_id:
        from shared.models.core import InsurancePlan
        plan = await session.get(InsurancePlan, mp.plan_id)
        business = plan.product_category.value if plan is not None and hasattr(plan.product_category, "value") else "Conventional"

    out: Dict[str, Any] = {
        "is_group": True,
        "master_policy_id": str(mp.id) if mp else None,
        "organization_id": str(mp.organization_id) if mp else None,
        "organization_name": org.name if org else None,
        "master_policy_number": mp.policy_number if mp else None,
        "business_type": business,
        "member": {"id": str(member.id), "name": customer.name if customer else None, "cnic": customer.cnic if customer else None,
                   "status": member.status, "coverage_amount": member.coverage_amount, "certificate_number": policy.policy_number,
                   "cover_start": member.cover_start_date.isoformat() if member.cover_start_date else None,
                   "cover_end": member.cover_end_date.isoformat() if member.cover_end_date else None} if member else None,
        "dependent": {"id": str(dependent.id), "name": dependent.name, "relationship": dependent.relationship,
                      "covered_amount": dependent.covered_amount, "status": dependent.status} if dependent else None,
        "coverage_type": cov,
        "cover_amount": dependent.covered_amount if dependent else (schedule.get(cov or LIFE) if schedule else None),
        "coverage_schedule": schedule,
        "nominations": len(nominees),
        "required_documents": required,
        "documents_on_file": on_file,
        "missing_documents": missing_documents(required, on_file),
    }
    payable = claim.status in (ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL)
    amount = claim.approved_amount if claim.approved_amount > 0 else claim.submitted_amount
    if payable or claim.status == ClaimStatusEnum.SETTLED:
        out["payout_split"] = await preview_split(session, claim, amount, out, nominees, customer)
    return out


def _fallback_payee(claim: Claim, customer: Optional[Customer], dependent: Optional[GroupMemberDependent]) -> Dict[str, Any]:
    if dependent is not None:       # a dependant's death benefit goes to the employee
        return {"name": customer.name if customer else (claim.claimant_name or "Employee"), "cnic": customer.cnic if customer else None,
                "relationship": "Employee"}
    return {"name": claim.claimant_name or (customer.name if customer else "Claimant"), "cnic": claim.claimant_cnic,
            "relationship": claim.claimant_relationship}


async def preview_split(session: AsyncSession, claim: Claim, amount: float, ctx_dict: Dict[str, Any],
                        nominees: List[Dict[str, Any]], customer: Optional[Customer],
                        overrides: Optional[Sequence[Dict[str, Any]]] = None, override_reason: Optional[str] = None) -> Dict[str, Any]:
    dependent = await session.get(GroupMemberDependent, claim.group_dependent_id) if claim.group_dependent_id else None
    ctx = SplitContext(claim.claim_type, claim.coverage_type, ctx_dict.get("business_type") or "Conventional", amount,
                       dependent_claim=dependent is not None)
    result = compute_split(amount, ctx, nominees, fallback=_fallback_payee(claim, customer, dependent),
                           overrides=overrides, override_reason=override_reason)
    return {"amount": amount, "source": result.source, "shares": result.as_dicts(), "warnings": result.warnings,
            "override_reason": result.override_reason}


async def split_for_claim(session: AsyncSession, tenant_id: UUID, claim: Claim, amount: Optional[float] = None,
                          overrides: Optional[Sequence[Dict[str, Any]]] = None, override_reason: Optional[str] = None) -> Dict[str, Any]:
    ctx = await claim_group_context(session, tenant_id, claim)
    if not ctx["is_group"]:
        raise GroupClaimError("This claim isn't on a group certificate.", 404)
    policy = await session.get(Policy, claim.policy_id)
    member = await session.get(GroupMember, claim.group_member_id) if claim.group_member_id else None
    customer = await session.get(Customer, member.customer_id) if member else await session.get(Customer, policy.customer_id)
    pay = amount if amount is not None else (claim.approved_amount if claim.approved_amount > 0 else claim.submitted_amount)
    try:
        return await preview_split(session, claim, pay, ctx, await _nominees(session, policy.id), customer, overrides, override_reason)
    except ValueError as exc:
        raise GroupClaimError(str(exc), 422) from exc


async def eligibility_for(session: AsyncSession, member: GroupMember, dependent: Optional[GroupMemberDependent], *, incident: date,
                          claim_type: str, coverage_type: Optional[str], amount: float) -> List[str]:
    policy = await session.get(Policy, member.policy_id) if member.policy_id else None
    customer = await session.get(Customer, member.customer_id)
    cert = policy.status.value if policy is not None and hasattr(policy.status, "value") else (str(policy.status) if policy else None)
    return check_eligibility(
        incident=incident, claim_type=claim_type, coverage_type=coverage_type, amount=amount,
        member={"name": customer.name, "status": member.status, "cover_start": member.cover_start_date,
                "cover_end": member.cover_end_date, "certificate_status": cert},
        schedule=await member_schedule(session, member),
        dependent={"name": dependent.name, "status": dependent.status, "covered_amount": dependent.covered_amount,
                   "relationship": dependent.relationship} if dependent is not None else None,
    )
