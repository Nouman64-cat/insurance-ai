"""Mid-term endorsements for an in-force Group Life / Group Family Takaful scheme
(GROUP_LIFE_PLAN.md Phase 4).

Three kinds, each over any number of members:

  ADD     new employees join. They are underwritten exactly like census members:
          at or under the scheme's Free Cover Limit they are guaranteed-issue and
          their certificate goes live on the effective date; above it they get an
          underwriting case and their line waits (PendingUnderwriting) until a
          decision lands — see resolve_endorsement().
  DELETE  employees leave. The certificate is cancelled and the unexpired part of
          their premium is refunded. Nobody's customer record is ever deleted — the
          person may be an individual policyholder too.
  CHANGE  salary, grade, designation or benefit class changes, re-pricing their
          cover. An increase that takes cover above the Free Cover Limit needs an
          underwriting decision first; anything else applies at once.

Pricing is pro rata and reuses the scheme's own accepted-quote rate through
group_pricing.life_premium, so an endorsement is priced exactly like the quote it
amends:

    pro-rata factor = days of cover left from the effective date / days in the period
    line adjustment = (annual premium after − before) × factor        (refunds negative)
    stamp duty      = risk adjustment × the statutory rate; no new policy fee
    Takaful         = the risk adjustment splits into Wakala fee and PTF at the
                      quote's own Wakala %

The pure arithmetic is at the top of this module; the functions below it do the
database work and commit. Nothing here talks to the risk engine: a member above
the Free Cover Limit gets a case for an underwriter, who can run the assessment
from there.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from group_benefits import basic_monthly_salary, member_cover, optional_text, parse_date, validate_scheme_census
from group_pricing import life_premium, member_annual_premium
from group_underwriting import member_underwriting_outcome, normalize_cnic
from routers.cases import generate_case_number
from routers.group_policies import _ISSUE_PATH, _business_type, _member_rows, _outcome, _plan_for, _st, _tenant_name
from routers.organizations import _benefit_classes, _enrolled_cnics, enroll_census_rows
from services.group_claims import LIFE, coverage_schedule
from services.group_documents import generate_group_endorsement
from shared.models.core import (
    Case,
    CaseStatusEnum,
    CasePriorityEnum,
    CaseTypeEnum,
    Customer,
    GroupBenefitClass,
    GroupClassCoverage,
    GroupEndorsement,
    GroupEndorsementStatus,
    GroupEndorsementType,
    GroupMember,
    GroupMemberDependent,
    GroupMemberStatus,
    GroupQuote,
    GroupQuoteStatus,
    InsurancePlan,
    MasterPolicy,
    Organization,
    Policy,
    PolicyEvent,
    PolicyStatusEnum,
    SourceChannelEnum,
)
from shared.pricing.calculator import STAMP_DUTY_RATE
from shared.services.policy_state_machine import apply_transition

CHANGEABLE_FIELDS = ("basic_monthly_salary", "grade", "designation", "benefit_class", "employee_id", "joining_date", "loan_amount")


class EndorsementError(Exception):
    """A request the engine refuses. `status` is the HTTP code the router answers with."""

    def __init__(self, message: str, status: int = 409, detail: Any = None):
        super().__init__(message)
        self.status, self.detail = status, detail if detail is not None else message


# ═══════════════════════════════════════════════════════════════════════════
# Pure arithmetic
# ═══════════════════════════════════════════════════════════════════════════

def pro_rata(effective: date, start: date, expiry: date) -> Tuple[int, int, float]:
    """(days remaining, days in period, factor). Both ends are inclusive, an
    effective date before the period starts counts the whole period, and one past
    the expiry is rejected."""
    if expiry < start:
        raise ValueError("The scheme has no valid period.")
    if effective > expiry:
        raise ValueError(f"The effective date {effective} is after the scheme expires on {expiry}.")
    period = (expiry - start).days + 1
    remaining = (expiry - max(effective, start)).days + 1
    return remaining, period, round(remaining / period, 6)


def adjustment_totals(lines: List[dict], business_type: str, wakala_fee_pct: Optional[float],
                      retakaful_share_pct: Optional[float] = None) -> Dict[str, Any]:
    """Roll the lines up into the endorsement's money. Stamp duty rides on the risk
    adjustment (negative for a refund); Takaful splits the risk adjustment."""
    risk = round(sum(float(l.get("risk_delta") or 0) for l in lines), 2)
    stamp = round(risk * STAMP_DUTY_RATE, 2)
    out: Dict[str, Any] = {
        "member_count_delta": sum(1 for l in lines if l["action"] == "ADD" and l["status"] == "Applied")
                              - sum(1 for l in lines if l["action"] == "DELETE"),
        "sum_assured_delta": round(sum(
            (float((l.get("after") or {}).get("cover") or 0) - float((l.get("before") or {}).get("cover") or 0))
            for l in lines if l["status"] == "Applied"), 2),
        "risk_delta": risk,
        "stamp_duty_delta": stamp,
        "premium_delta": round(risk + stamp, 2),
        "wakala_fee_delta": None,
        "ptf_delta": None,
        "retakaful_delta": None,
    }
    if business_type == "Takaful" and wakala_fee_pct is not None:
        fee = round(risk * wakala_fee_pct / 100, 2)
        ptf = round(risk - fee, 2)
        out["wakala_fee_delta"], out["ptf_delta"] = fee, ptf
        if retakaful_share_pct is not None:
            out["retakaful_delta"] = round(ptf * retakaful_share_pct / 100, 2)
    return out


def next_certificate_sequence(policy_number: str, existing: List[Optional[str]]) -> int:
    """The next /NNNN suffix under a master policy — one past the highest ever used,
    including certificates of members who have since left, so a number is never reused."""
    prefix = f"{policy_number}/"
    used = [int(c[len(prefix):]) for c in existing if c and c.startswith(prefix) and c[len(prefix):].isdigit()]
    return max(used, default=0) + 1


# ═══════════════════════════════════════════════════════════════════════════
# Loading the scheme
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class Scheme:
    mp: MasterPolicy
    org: Organization
    plan: Optional[InsurancePlan]
    business_type: str
    quote: GroupQuote
    classes: List[GroupBenefitClass]
    rate: float                       # the quote's effective rate per 1,000 sum assured
    wakala_fee_pct: Optional[float]
    start: date
    expiry: date
    tenant_name: str = ""
    emitted: List[Tuple[Policy, PolicyEvent]] = field(default_factory=list)
    coverages: Dict[UUID, List[GroupClassCoverage]] = field(default_factory=dict)

    def annual(self, cover: float, loading_pct: float = 0.0, class_id: Optional[UUID] = None) -> float:
        """A member's whole annual premium at this scheme's rates: life, plus the riders of their class."""
        schedule = coverage_schedule(cover, self.coverages.get(class_id, [])) if class_id else {LIFE: cover}
        riders = {k: v for k, v in schedule.items() if k != LIFE}
        return member_annual_premium(cover, self.rate, loading_pct, riders, self.quote.breakdown.get("experience_factor", 1.0))


async def load_scheme(session: AsyncSession, tenant_id: UUID, org_id: UUID, mp_id: UUID) -> Scheme:
    mp = await session.get(MasterPolicy, mp_id)
    org = await session.get(Organization, org_id)
    if mp is None or mp.tenant_id != tenant_id or mp.organization_id != org_id or org is None:
        raise EndorsementError("Master policy not found.", 404)
    if mp.status != "Active":
        raise EndorsementError(
            f"Endorsements change a scheme that is in force; this one is {mp.status}. "
            "Before cover starts, change the census and re-quote instead.")
    if not mp.policy_number or not mp.expiry_date:
        raise EndorsementError("This scheme has no policy number or expiry date — run the legacy backfill first.")
    quote = (await session.exec(
        select(GroupQuote).where(GroupQuote.master_policy_id == mp.id, GroupQuote.status == GroupQuoteStatus.ACCEPTED.value)
        .order_by(GroupQuote.version.desc())
    )).first()
    if quote is None:
        raise EndorsementError("There is no accepted quote to price the endorsement against.")
    plan = await _plan_for(mp, session)
    business_type = _business_type(plan)
    classes = await _benefit_classes(mp.id, session)
    coverages: Dict[UUID, List[GroupClassCoverage]] = {}
    if classes:
        for row in (await session.exec(select(GroupClassCoverage).where(GroupClassCoverage.benefit_class_id.in_([c.id for c in classes])))).all():
            coverages.setdefault(row.benefit_class_id, []).append(row)
    return Scheme(
        mp=mp, org=org, plan=plan, business_type=business_type, quote=quote,
        classes=classes, coverages=coverages, rate=quote.rate_per_mille,
        wakala_fee_pct=quote.wakala_fee_pct, start=mp.effective_date, expiry=mp.expiry_date,
        tenant_name=await _tenant_name(tenant_id, session),
    )


def _basis(cover_before: Optional[float], cover_after: Optional[float], **extra: Any) -> Dict[str, Any]:
    return {"cover": cover_before, **extra}, {"cover": cover_after}


def _date_arg(raw: Any, name: str) -> date:
    try:
        return raw if isinstance(raw, date) else date.fromisoformat(str(raw))
    except ValueError as exc:
        raise EndorsementError(f"{name} must be a date (YYYY-MM-DD).", 422) from exc


# ═══════════════════════════════════════════════════════════════════════════
# Member lookup
# ═══════════════════════════════════════════════════════════════════════════

async def _roster(scheme: Scheme, session: AsyncSession):
    rows = (await session.exec(
        select(GroupMember, Customer, Policy)
        .join(Customer, Customer.id == GroupMember.customer_id)
        .join(Policy, Policy.id == GroupMember.policy_id, isouter=True)
        .where(GroupMember.master_policy_id == scheme.mp.id)
    )).all()
    return list(rows)


def _find(roster, ref: Dict[str, Any]):
    """The (member, customer, policy) a request line names — by member id, CNIC or employee id."""
    wanted_id = str(ref.get("member_id") or "").strip()
    cnic = normalize_cnic(str(ref.get("cnic") or "")) if ref.get("cnic") else None
    emp = str(ref.get("employee_id") or "").strip().lower()
    for member, customer, policy in roster:
        if wanted_id and str(member.id) == wanted_id:
            return member, customer, policy
        if cnic and customer.cnic == cnic:
            return member, customer, policy
        if emp and (member.employee_id or "").lower() == emp:
            return member, customer, policy
    label = wanted_id or (ref.get("cnic") or "") or (ref.get("employee_id") or "") or "?"
    raise EndorsementError(f"No member of this scheme matches “{label}”.", 404)


async def _dependents_premium(member: GroupMember, scheme: Scheme, session: AsyncSession) -> float:
    deps = (await session.exec(select(GroupMemberDependent).where(
        GroupMemberDependent.group_member_id == member.id, GroupMemberDependent.status != GroupMemberStatus.REMOVED.value))).all()
    return sum(life_premium(d.covered_amount, scheme.rate) for d in deps)


# ═══════════════════════════════════════════════════════════════════════════
# Building the lines
# ═══════════════════════════════════════════════════════════════════════════

async def _add_lines_preview(scheme: Scheme, rows: List[dict], factor: float, session: AsyncSession) -> List[dict]:
    enrolled = await _enrolled_cnics(scheme.mp.id, session)
    verdict = validate_scheme_census(enrolled, rows, scheme.classes, None)
    if not verdict.is_valid:
        raise EndorsementError("The new members have problems and nothing was changed.", 422, verdict.model_dump())
    fcl = scheme.mp.free_cover_limit
    lines = []
    for row in rows:
        cls, cover = member_cover(row, scheme.classes, scheme.mp.sum_assured_multiple, as_of=scheme.mp.effective_date)
        pending = fcl is not None and cover > fcl
        before, after = _basis(None, cover)
        annual = scheme.annual(cover, 0.0, cls.id if cls else None)
        lines.append({
            "action": "ADD", "member_id": None, "name": row["name"], "cnic": normalize_cnic(row["cnic"]) or row["cnic"],
            "certificate_number": None, "status": "PendingUnderwriting" if pending else "Applied",
            "before": before, "after": {**after, "class": cls.name if cls else None},
            "annual_premium_before": 0.0, "annual_premium_after": round(annual, 2),
            "risk_delta": 0.0 if pending else round(annual * factor, 2),
            "note": "Above the Free Cover Limit — needs an underwriting decision before cover starts" if pending else None,
        })
    return lines


async def _delete_lines_preview(scheme: Scheme, refs: List[dict], factor: float, session: AsyncSession) -> List[dict]:
    roster = await _roster(scheme, session)
    active = [r for r in roster if r[0].status == GroupMemberStatus.ACTIVE.value]
    seen, lines = set(), []
    for ref in refs:
        member, customer, policy = _find(roster, ref)
        if member.status != GroupMemberStatus.ACTIVE.value:
            raise EndorsementError(f"{customer.name} is not an active member (currently {member.status}).")
        if member.id in seen:
            continue
        seen.add(member.id)
        annual = float(member.annual_premium or 0)
        lines.append({
            "action": "DELETE", "member_id": str(member.id), "name": customer.name, "cnic": customer.cnic,
            "certificate_number": policy.policy_number if policy else None, "status": "Applied",
            "before": {"cover": member.coverage_amount, "class": None}, "after": {"cover": 0.0},
            "annual_premium_before": round(annual, 2), "annual_premium_after": 0.0,
            "risk_delta": round(-annual * factor, 2), "note": ref.get("reason"),
        })
    if len(seen) >= len(active):
        raise EndorsementError("That would remove every member — cancel the scheme instead of endorsing it empty.")
    return lines


async def _change_lines_preview(scheme: Scheme, refs: List[dict], factor: float, session: AsyncSession) -> List[dict]:
    roster = await _roster(scheme, session)
    fcl = scheme.mp.free_cover_limit
    lines, seen = [], set()
    for ref in refs:
        member, customer, policy = _find(roster, ref)
        if member.status != GroupMemberStatus.ACTIVE.value:
            raise EndorsementError(f"{customer.name} is not an active member (currently {member.status}).")
        if member.id in seen:
            raise EndorsementError(f"{customer.name} appears twice in the same endorsement.", 422)
        seen.add(member.id)
        changes = {k: ref[k] for k in CHANGEABLE_FIELDS if ref.get(k) not in (None, "")}
        if not changes:
            raise EndorsementError(f"Nothing to change for {customer.name} — give a new salary, grade, class or designation.", 422)

        probe = {
            "benefit_class": changes.get("benefit_class") or None,
            "grade": changes.get("grade", member.grade),
            "basic_monthly_salary": changes.get("basic_monthly_salary", member.basic_monthly_salary),
            "joining_date": changes.get("joining_date", member.joining_date),
            "loan_amount": changes.get("loan_amount", member.loan_amount),
            "declared_income": customer.declared_income,
        }
        if "benefit_class" not in changes and "grade" not in changes:
            # Keep the class they are already in rather than re-deriving it from a grade.
            current = next((c for c in scheme.classes if c.id == member.benefit_class_id), None)
            probe["benefit_class"] = current.name if current else None
        try:
            if probe["basic_monthly_salary"] is not None:
                probe["basic_monthly_salary"] = float(probe["basic_monthly_salary"])
            cls, new_cover = member_cover(probe, scheme.classes, scheme.mp.sum_assured_multiple, as_of=scheme.mp.effective_date)
        except (ValueError, TypeError) as exc:
            raise EndorsementError(f"{customer.name}: {exc}", 422) from exc

        old_cover = float(member.coverage_amount)
        outcome = await _outcome(scheme.mp, member, policy, session)
        loading = outcome.loading_pct
        pending = fcl is not None and new_cover > fcl and new_cover > old_cover
        old_annual = scheme.annual(old_cover, loading, member.benefit_class_id)
        new_annual = scheme.annual(new_cover, loading, cls.id if cls else None)
        lines.append({
            "action": "CHANGE", "member_id": str(member.id), "name": customer.name, "cnic": customer.cnic,
            "certificate_number": policy.policy_number if policy else None,
            "status": "PendingUnderwriting" if pending else "Applied",
            "before": {"cover": old_cover, "class": next((c.name for c in scheme.classes if c.id == member.benefit_class_id), None),
                       "grade": member.grade, "basic_monthly_salary": member.basic_monthly_salary},
            "after": {"cover": new_cover, "class": cls.name if cls else None, **{k: v for k, v in changes.items() if k != "benefit_class"}},
            "changes": changes,
            "annual_premium_before": round(old_annual, 2), "annual_premium_after": round(new_annual, 2),
            "risk_delta": 0.0 if pending else round((new_annual - old_annual) * factor, 2),
            "note": "Cover rises above the Free Cover Limit — needs an underwriting decision" if pending
                    else ("No change to cover" if abs(new_cover - old_cover) < 0.005 else None),
        })
    return lines


def _factor(scheme: Scheme, effective: date) -> Tuple[int, int, float]:
    try:
        return pro_rata(effective, scheme.start, scheme.expiry)
    except ValueError as exc:
        raise EndorsementError(str(exc), 422) from exc


def _check_type(kind: str) -> str:
    kind = (kind or "").upper()
    if kind not in {t.value for t in GroupEndorsementType}:
        raise EndorsementError("type must be ADD, DELETE or CHANGE.", 422)
    return kind


async def preview_endorsement(session: AsyncSession, scheme: Scheme, kind: str, effective: date, members: List[dict]) -> Dict[str, Any]:
    """What an endorsement would do and cost — nothing is written."""
    kind = _check_type(kind)
    if not members:
        raise EndorsementError("Name at least one member.", 422)
    days, period, factor = _factor(scheme, effective)
    lines = await {"ADD": _add_lines_preview, "DELETE": _delete_lines_preview, "CHANGE": _change_lines_preview}[kind](
        scheme, members, factor, session)
    return {
        "endorsement_type": kind, "effective_date": effective, "days_remaining": days, "period_days": period,
        "pro_rata_factor": factor, "lines": lines, "business_type": scheme.business_type,
        **adjustment_totals(lines, scheme.business_type, scheme.wakala_fee_pct, scheme.quote.retakaful_share_pct),
    }


# ═══════════════════════════════════════════════════════════════════════════
# Applying
# ═══════════════════════════════════════════════════════════════════════════

async def _activate_certificate(session: AsyncSession, scheme: Scheme, member: GroupMember, policy: Policy,
                                certificate: str, effective: date, cover: float, annual: float, event_type: str,
                                endorsement_number: str, note: Optional[str] = None) -> None:
    """Walk a drafted certificate to Active and set the member's cover record."""
    for step in _ISSUE_PATH.get(_st(policy), []):
        scheme.emitted.append((policy, apply_transition(
            session, policy, step, event_type=event_type, actor="system",
            detail={"endorsement": endorsement_number, "certificate": certificate})))
    scheme.emitted.append((policy, apply_transition(
        session, policy, PolicyStatusEnum.ACTIVE, event_type=event_type, actor="system",
        detail={"endorsement": endorsement_number, "certificate": certificate})))
    policy.policy_number, policy.coverage_amount = certificate, cover
    policy.effective_date, policy.expiry_date, policy.issued_at = effective, scheme.expiry, datetime.utcnow()
    session.add(policy)
    member.coverage_amount, member.annual_premium = cover, round(annual, 2)
    member.cover_start_date, member.cover_end_date = effective, scheme.expiry
    member.status = GroupMemberStatus.ACTIVE.value
    if note:
        member.cover_note = note
    session.add(member)


async def _next_certificate(session: AsyncSession, scheme: Scheme) -> str:
    existing = (await session.exec(select(Policy.policy_number).where(
        Policy.master_policy_id == scheme.mp.id, Policy.tenant_id == scheme.mp.tenant_id))).all()
    return f"{scheme.mp.policy_number}/{next_certificate_sequence(scheme.mp.policy_number, list(existing)):04d}"


async def _apply_add(session: AsyncSession, scheme: Scheme, rows: List[dict], effective: date, factor: float, number: str) -> List[dict]:
    await _add_lines_preview(scheme, rows, factor, session)       # validate before anything is written
    result = await enroll_census_rows(scheme.mp.tenant_id, scheme.org.id, scheme.mp, rows, scheme.classes, scheme.plan,
                                      session, mark_proposed=False)
    fcl = scheme.mp.free_cover_limit
    lines = []
    for outcome in result.employees:
        member = await session.get(GroupMember, outcome.group_member_id)
        policy = await session.get(Policy, outcome.policy_id)
        customer = await session.get(Customer, member.customer_id)
        cover = float(member.coverage_amount)
        annual = scheme.annual(cover, 0.0, member.benefit_class_id)
        cls_name = next((c.name for c in scheme.classes if c.id == member.benefit_class_id), None)
        line = {"action": "ADD", "member_id": str(member.id), "name": customer.name, "cnic": customer.cnic,
                "before": {"cover": None}, "after": {"cover": cover, "class": cls_name},
                "annual_premium_before": 0.0, "annual_premium_after": round(annual, 2)}
        if fcl is not None and cover > fcl:
            line.update(status="PendingUnderwriting", certificate_number=None, risk_delta=0.0,
                        note="Above the Free Cover Limit — awaiting an underwriting decision")
        else:
            certificate = await _next_certificate(session, scheme)
            await session.flush()
            await _activate_certificate(session, scheme, member, policy, certificate, effective, cover, annual,
                                        "GroupEndorsementAdd", number)
            line.update(status="Applied", certificate_number=certificate, risk_delta=round(annual * factor, 2), note=None)
        await session.flush()
        lines.append(line)
    return lines


async def _apply_delete(session: AsyncSession, scheme: Scheme, refs: List[dict], effective: date, factor: float, number: str) -> List[dict]:
    lines = await _delete_lines_preview(scheme, refs, factor, session)
    for line in lines:
        member = await session.get(GroupMember, UUID(line["member_id"]))
        policy = await session.get(Policy, member.policy_id) if member.policy_id else None
        if policy is not None and _st(policy) == PolicyStatusEnum.ACTIVE.value:
            scheme.emitted.append((policy, apply_transition(
                session, policy, PolicyStatusEnum.CANCELLED, event_type="GroupEndorsementDelete", actor="system",
                detail={"endorsement": number, "certificate": policy.policy_number, "effective_date": effective.isoformat()})))
        member.status, member.cover_end_date = GroupMemberStatus.REMOVED.value, effective
        session.add(member)
        for dep in (await session.exec(select(GroupMemberDependent).where(GroupMemberDependent.group_member_id == member.id))).all():
            dep.status = GroupMemberStatus.REMOVED.value
            session.add(dep)
    return lines


async def _open_case(session: AsyncSession, scheme: Scheme, member: GroupMember, policy: Optional[Policy]) -> Case:
    case = Case(
        tenant_id=scheme.mp.tenant_id, customer_id=member.customer_id, policy_id=policy.id if policy else None,
        caseNumber=generate_case_number(), caseType=CaseTypeEnum.UNDERWRITING, caseStatus=CaseStatusEnum.NEW,
        priorityLevel=CasePriorityEnum.NORMAL, sourceChannel=SourceChannelEnum.BRANCH,
    )
    session.add(case)
    await session.flush()
    return case


def _apply_change_fields(member: GroupMember, changes: Dict[str, Any], class_id: Optional[UUID], cover: float) -> None:
    if "basic_monthly_salary" in changes:
        member.basic_monthly_salary = float(changes["basic_monthly_salary"])
    if "grade" in changes:
        member.grade = optional_text(changes["grade"])
    if "designation" in changes:
        member.designation = optional_text(changes["designation"])
    if "employee_id" in changes:
        member.employee_id = optional_text(changes["employee_id"])
    if "joining_date" in changes:
        member.joining_date = parse_date(changes["joining_date"])
    if "loan_amount" in changes:
        member.loan_amount = float(changes["loan_amount"])
    member.benefit_class_id = class_id
    member.coverage_amount = cover


async def _apply_change(session: AsyncSession, scheme: Scheme, refs: List[dict], effective: date, factor: float, number: str) -> List[dict]:
    lines = await _change_lines_preview(scheme, refs, factor, session)
    for line in lines:
        member = await session.get(GroupMember, UUID(line["member_id"]))
        policy = await session.get(Policy, member.policy_id) if member.policy_id else None
        cls = next((c for c in scheme.classes if c.name == line["after"].get("class")), None)
        if line["status"] == "PendingUnderwriting":
            case = await _open_case(session, scheme, member, policy)
            line["case_id"], line["case_number"] = str(case.caseld), case.caseNumber
            continue
        _apply_change_fields(member, line["changes"], cls.id if cls else None, line["after"]["cover"])
        member.annual_premium = round(float(member.annual_premium or 0) + (line["annual_premium_after"] - line["annual_premium_before"]), 2)
        session.add(member)
        if policy is not None:
            policy.coverage_amount = line["after"]["cover"]
            session.add(policy)
            scheme.emitted.append((policy, _record_change(session, policy, number, line)))
    return lines


def _record_change(session: AsyncSession, policy: Policy, number: str, line: dict) -> PolicyEvent:
    from shared.services.policy_state_machine import record_event
    return record_event(session, policy, event_type="GroupEndorsementChange", from_status=PolicyStatusEnum.ACTIVE,
                        to_status=PolicyStatusEnum.ACTIVE, actor="system",
                        detail={"endorsement": number, "from_cover": line["before"]["cover"], "to_cover": line["after"]["cover"]})


async def _next_number(session: AsyncSession, scheme: Scheme) -> str:
    existing = (await session.exec(select(GroupEndorsement.number).where(GroupEndorsement.master_policy_id == scheme.mp.id))).all()
    prefix = f"END-{scheme.mp.policy_number}-"
    used = [int(n[len(prefix):]) for n in existing if n.startswith(prefix) and n[len(prefix):].isdigit()]
    return f"{prefix}{max(used, default=0) + 1:03d}"


def _status_for(lines: List[dict]) -> str:
    return (GroupEndorsementStatus.PENDING_UNDERWRITING.value if any(l["status"] == "PendingUnderwriting" for l in lines)
            else GroupEndorsementStatus.APPLIED.value)


def _settlement_for(premium_delta: float, was_settled_for: Optional[float] = None) -> str:
    if abs(premium_delta) < 0.01:
        return "NotDue"
    if was_settled_for is not None and abs(premium_delta - was_settled_for) < 0.01:
        return "Settled"
    return "Due"


def _write_document(scheme: Scheme, e: GroupEndorsement) -> None:
    e.document_path = generate_group_endorsement({
        "tenant_name": scheme.tenant_name, "organization": scheme.org.name,
        "plan_label": scheme.plan.label if scheme.plan is not None else "Group Life",
        "business_type": scheme.business_type, "master_policy_id": str(scheme.mp.id),
        "policy_number": scheme.mp.policy_number,
        "endorsement": {
            "number": e.number, "endorsement_type": e.endorsement_type, "status": e.status,
            "effective_date": e.effective_date, "reason": e.reason, "days_remaining": e.days_remaining,
            "period_days": e.period_days, "pro_rata_factor": e.pro_rata_factor,
            "member_count_delta": e.member_count_delta, "sum_assured_delta": e.sum_assured_delta,
            "risk_delta": e.risk_delta, "stamp_duty_delta": e.stamp_duty_delta, "premium_delta": e.premium_delta,
            "wakala_fee_delta": e.wakala_fee_delta, "ptf_delta": e.ptf_delta, "retakaful_delta": e.retakaful_delta, "lines": e.lines,
        },
    })


async def create_endorsement(session: AsyncSession, scheme: Scheme, kind: str, effective: date, members: List[dict],
                             reason: Optional[str], requested_by: Optional[str]) -> GroupEndorsement:
    """Apply an endorsement and commit. The caller publishes `scheme.emitted`
    to Kafka afterwards."""
    kind = _check_type(kind)
    if not members:
        raise EndorsementError("Name at least one member.", 422)
    days, period, factor = _factor(scheme, effective)
    number = await _next_number(session, scheme)
    applier = {"ADD": _apply_add, "DELETE": _apply_delete, "CHANGE": _apply_change}[kind]
    lines = await applier(session, scheme, members, effective, factor, number)

    totals = adjustment_totals(lines, scheme.business_type, scheme.wakala_fee_pct, scheme.quote.retakaful_share_pct)
    e = GroupEndorsement(
        tenant_id=scheme.mp.tenant_id, master_policy_id=scheme.mp.id, number=number, endorsement_type=kind,
        status=_status_for(lines), effective_date=effective, reason=reason, requested_by=requested_by, lines=lines,
        days_remaining=days, period_days=period, pro_rata_factor=factor, settlement_status=_settlement_for(totals["premium_delta"]),
        applied_at=datetime.utcnow(), **totals,
    )
    session.add(e)
    await session.flush()
    _write_document(scheme, e)
    session.add(e)
    await session.commit()
    await session.refresh(e)
    return e


# ═══════════════════════════════════════════════════════════════════════════
# Resolving lines that waited on underwriting
# ═══════════════════════════════════════════════════════════════════════════

async def resolve_endorsement(session: AsyncSession, scheme: Scheme, e: GroupEndorsement) -> GroupEndorsement:
    """Settle the lines that were waiting on an above-FCL decision, now that
    underwriters may have made it. Lines still undecided stay pending."""
    if e.status != GroupEndorsementStatus.PENDING_UNDERWRITING.value:
        return e
    fcl = scheme.mp.free_cover_limit
    factor = e.pro_rata_factor
    lines = [dict(l) for l in e.lines]
    for line in lines:
        if line["status"] != "PendingUnderwriting":
            continue
        member = await session.get(GroupMember, UUID(line["member_id"]))
        policy = await session.get(Policy, member.policy_id) if member.policy_id else None

        if line["action"] == "ADD":
            outcome = member_underwriting_outcome(
                member.coverage_amount, fcl, _st(policy) if policy else "Quoted",
                (await _latest_loading(session, policy.id)) if policy else None)
            if outcome.basis == "Pending":
                continue
            cover = outcome.covered_amount
            annual = scheme.annual(cover, outcome.loading_pct, member.benefit_class_id)
            certificate = await _next_certificate(session, scheme)
            await _activate_certificate(session, scheme, member, policy, certificate, e.effective_date, cover, annual,
                                        "GroupEndorsementAdd", e.number, note=outcome.note)
            line.update(status="Applied", certificate_number=certificate, risk_delta=round(annual * factor, 2),
                        annual_premium_after=round(annual, 2), note=outcome.note or f"Cover started after underwriting ({outcome.basis})")
            line["after"] = {**line["after"], "cover": cover}
            line["underwriting_basis"] = outcome.basis
        else:  # CHANGE — decided on the case opened for it
            case = await session.get(Case, UUID(line["case_id"])) if line.get("case_id") else None
            status = case.caseStatus.value if case is not None and hasattr(case.caseStatus, "value") else None
            if status == CaseStatusEnum.REJECTED.value:
                line.update(status="Declined", risk_delta=0.0, note="Underwriting declined the increase — cover is unchanged")
                continue
            if status != CaseStatusEnum.APPROVED.value:
                continue
            cls = next((c for c in scheme.classes if c.name == line["after"].get("class")), None)
            _apply_change_fields(member, line["changes"], cls.id if cls else None, line["after"]["cover"])
            member.annual_premium = round(float(member.annual_premium or 0) + (line["annual_premium_after"] - line["annual_premium_before"]), 2)
            session.add(member)
            if policy is not None:
                policy.coverage_amount = line["after"]["cover"]
                session.add(policy)
                scheme.emitted.append((policy, _record_change(session, policy, e.number, line)))
            line.update(status="Applied", risk_delta=round((line["annual_premium_after"] - line["annual_premium_before"]) * factor, 2),
                        note="Increase applied after underwriting approval")

    totals = adjustment_totals(lines, scheme.business_type, scheme.wakala_fee_pct, scheme.quote.retakaful_share_pct)
    settled_for = e.premium_delta if e.settlement_status == "Settled" else None
    e.lines = lines
    for k, v in totals.items():
        setattr(e, k, v)
    e.status = _status_for(lines)
    e.settlement_status = _settlement_for(e.premium_delta, settled_for)
    _write_document(scheme, e)
    session.add(e)
    await session.commit()
    await session.refresh(e)
    return e


async def _latest_loading(session: AsyncSession, policy_id: UUID) -> Optional[float]:
    from shared.models.core import RiskAssessment
    ra = (await session.exec(select(RiskAssessment).where(RiskAssessment.policy_id == policy_id)
                             .order_by(RiskAssessment.created_at.desc()))).first()
    return ra.suggested_loading if ra is not None else None


# ═══════════════════════════════════════════════════════════════════════════
# Settlement
# ═══════════════════════════════════════════════════════════════════════════

async def settle_endorsement(session: AsyncSession, e: GroupEndorsement, reference: str, amount: float) -> GroupEndorsement:
    """Record the adjustment as collected (premium due) or refunded (premium returned)."""
    if e.settlement_status == "NotDue":
        raise EndorsementError("This endorsement has no money to settle.")
    if e.settlement_status == "Settled":
        raise EndorsementError("This endorsement is already settled.")
    if abs(amount - abs(e.premium_delta)) > 0.01:
        raise EndorsementError(
            f"Settle the exact adjustment: PKR {abs(e.premium_delta):,.2f} "
            f"{'to collect' if e.premium_delta > 0 else 'to refund'} (got PKR {amount:,.2f}).", 422)
    e.settlement_status, e.settlement_reference, e.settled_at = "Settled", reference, datetime.utcnow()
    session.add(e)
    await session.commit()
    await session.refresh(e)
    return e
