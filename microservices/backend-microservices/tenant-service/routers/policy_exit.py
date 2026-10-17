"""
Stage B — Policy Maturity & Exit router (step 9 of the post-issuance journey).

The last stage of a policy's life: has cover reached its contractual end, is a maturity or
surrender payment owed, and when can the policy be formally closed? Four exits —

  Maturity          savings / investment-linked policy reaches maturity → settle the proceeds
  Expiry            protection-only term ends → close without a payout
  Surrender         the policyholder leaves early → settle the eligible net surrender value
  CorporateExpiry   a group certificate whose master policy was not renewed → close the cover

(+ DeathClaimClosure: the closure and archive that follow a paid death claim — the benefit itself
is Claims Management's.) An extension is a Renewals matter: while a contract renewal is open the
policy is never closed here.

  1 identify upcoming       GET  /exit                                (and POST /exit/sweep)
  2 renewal / extension     POST /exit/{id}/extension
  3 eligibility + financial POST /exit  (opens), /{id}/eligibility/verify, POST /exit/loans
  4 documents + consent     POST /{id}/documents/{key}, /{id}/consent
  5 final settlement        POST /{id}/settlement/calculate, /accept   (GET /statement)
  6 authorize + disburse    POST /{id}/settlement/payee, /authorize, /disburse, /reconcile
  7 close + archive         POST /{id}/close, GET/POST /{id}/confirmation/...

Fund values, surrender charges and tax are configurable placeholders (insurer_config EXIT_*).
Every status change goes through policy_state_machine (Active/GracePeriod/Lapsed → Matured /
Surrendered / Expired) and every action writes a PolicyEvent carrying the exit_no.
"""

import logging
import os
from datetime import date, datetime, timedelta
from typing import Literal, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field as PField
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import email_utils
from database import get_session
from routers.artifacts import _presign_url, _upload_to_s3
from routers.auth import _role_name, require_roles
from routers.policies import _get_policy, _publish_policy_event, _st
from services import claim_engine, document_generator, exit_engine as eng, insurer_config as cfg, reinstatement_engine, renewal_engine
from services.email_templates import exit_closure_email
from shared.models.core import (
    Artifact,
    Customer,
    Policy,
    PolicyEvent,
    PolicyExit,
    PolicyLoan,
    PolicyRider,
    PolicyStatusEnum,
    PremiumSchedule,
    PremiumScheduleStatusEnum,
    Tenant,
)
from shared.services.policy_state_machine import IllegalStateTransition, apply_transition, record_event

log = logging.getLogger(__name__)
router = APIRouter(tags=["Stage B — Maturity & Exit"])

_EXIT_ROLES = ("ClaimsAdjuster", "ClaimsManager", "Admin", "SuperAdmin", "Underwriter")
_MANAGERS = ("ClaimsManager", "Admin", "SuperAdmin")
_ALLOWED_EXT = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "tiff": "image/tiff"}
_MAX_BYTES = 15 * 1024 * 1024
_FINAL = ("Matured", "Surrendered", "Expired")


# ── request bodies ────────────────────────────────────────────────────────────

class OpenBody(BaseModel):
    exit_type: Optional[Literal["Surrender"]] = None      # a surrender is requested; every other exit is detected
    reason: Optional[str] = None
    requested_by: Optional[str] = None
    relationship: Optional[str] = "Policyholder"
    channel: Optional[str] = "Branch"


class LoanBody(BaseModel):
    principal: float = PField(gt=0)
    annual_interest_pct: float = PField(default=0.0, ge=0, le=100)
    disbursed_on: date
    reference: Optional[str] = None
    note: Optional[str] = None


class ExtensionBody(BaseModel):
    decision: Literal["Declined", "Redirect"]
    note: Optional[str] = None


class NoteBody(BaseModel):
    note: Optional[str] = None  # waiving a document needs no reason; one given goes on the file


class ConsentBody(BaseModel):
    accepted: list[str]
    by: str
    method: str


class RecoverableIn(BaseModel):
    label: str
    amount: float = PField(ge=0)
    note: Optional[str] = None


class CalcBody(BaseModel):
    recoverables: list[RecoverableIn] = PField(default_factory=list)
    notes: Optional[str] = None


class AcceptBody(BaseModel):
    accepted: bool
    by: Optional[str] = None
    method: Optional[str] = None
    note: Optional[str] = None


class PayeeBody(BaseModel):
    cnic: Optional[str] = None
    bank_name: Optional[str] = None
    account_title: Optional[str] = None
    iban: Optional[str] = None
    method: Optional[str] = None
    note: Optional[str] = None
    verify: bool = False


class DisburseBody(BaseModel):
    method: str = "Bank Transfer"


class ReconcileBody(BaseModel):
    note: Optional[str] = None


class CancelBody(BaseModel):
    reason: Optional[str] = None


class SweepBody(BaseModel):
    dry_run: bool = False


# ── helpers ───────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.utcnow()


def _iso(d) -> Optional[str]:
    return d.isoformat() if d else None


def _actor(user) -> str:
    return getattr(user, "email", None) or getattr(user, "username", None) or str(getattr(user, "id", "ops"))


def _touch(case: PolicyExit) -> None:
    case.updated_at = _now()


def _json_safe(obj):
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    if isinstance(obj, UUID):
        return str(obj)
    return obj


async def _next_exit_no(session: AsyncSession, tenant_id: UUID) -> str:
    n = len((await session.exec(select(PolicyExit).where(PolicyExit.tenant_id == tenant_id))).all())
    return f"EX-{_now().year}-{n + 1:05d}"


async def _get_case(session: AsyncSession, policy_id: UUID, case_id: UUID) -> PolicyExit:
    case = await session.get(PolicyExit, case_id)
    if not case or case.policy_id != policy_id:
        raise HTTPException(404, "Exit case not found")
    return case


def _assert_open(case: PolicyExit) -> None:
    if case.status != "Open":
        raise HTTPException(409, f"Exit {case.exit_no} is {case.status.lower()}.")


def _audit(session, policy: Policy, case: PolicyExit, event_type: str, actor: Optional[str], detail: Optional[dict] = None) -> PolicyEvent:
    return record_event(session, policy, event_type=event_type, actor=actor or "ops",
                        detail={"exit_no": case.exit_no, "case_id": str(case.id), "exit_type": case.exit_type, **(detail or {})})


async def _publish(request: Optional[Request], policy: Policy, events: list) -> None:
    for ev in events:
        await _publish_policy_event(request, policy, ev)


async def _is_manager(session: AsyncSession, user) -> bool:
    return (await _role_name(user, session)) in _MANAGERS


def _itype(policy: Policy) -> str:
    return policy.insurance_type.value if hasattr(policy.insurance_type, "value") else str(policy.insurance_type)


# ── facts + eligibility ───────────────────────────────────────────────────────

async def _context(session: AsyncSession, policy: Policy) -> dict:
    rules = cfg.exit_rules(policy.product_name)
    profile = cfg.exit_profile(policy.product_name, _itype(policy))
    ren_rules = cfg.renewal_rules(policy.product_name)
    return {
        "rules": rules, "profile": profile, "extension_allowed": bool(ren_rules.get("contract_renewable")),
        "open_renewal": await renewal_engine.get_open_case(session, policy.id),
        "open_reinstatement": await reinstatement_engine.get_open_case(session, policy.id),
        "master": await eng.master_facts(session, policy), "open_claims": await eng.open_claims_count(session, policy.id),
        "claim_closure": await eng.closed_by_claim(session, policy.id),
    }


async def _evaluate(session: AsyncSession, policy: Policy, exit_type: str, today: Optional[date] = None, ctx: Optional[dict] = None) -> dict:
    ctx = ctx or await _context(session, policy)
    today = today or date.today()
    m = ctx["master"]
    customer_known = await session.get(Customer, policy.customer_id) is not None
    return eng.evaluate_eligibility_facts(
        exit_type=exit_type, status=_st(policy), today=today, maturity_date=policy.maturity_date, profile=ctx["profile"],
        effective_date=policy.effective_date, free_look_end=policy.free_look_end_date, open_claims=ctx["open_claims"],
        open_renewal_no=ctx["open_renewal"].renewal_no if ctx["open_renewal"] else None,
        open_reinstatement_no=ctx["open_reinstatement"].case_no if ctx["open_reinstatement"] else None,
        extension_allowed=ctx["extension_allowed"], rules=ctx["rules"], master_expiry=m.get("master_expiry"),
        group_renewal_status=m.get("renewal_status"), claim_open_after_closure=ctx["open_claims"], owner_known=customer_known)


async def _require_eligible(session: AsyncSession, policy: Policy, case: PolicyExit) -> dict:
    elig = await _evaluate(session, policy, case.exit_type)
    if elig["blockers"]:
        raise HTTPException(409, f"The policy can no longer leave by this route: {elig['message']}")
    return elig


def _end_date(case: PolicyExit, ctx: dict) -> Optional[date]:
    """The day the contract's term ends (maturity / master expiry); a surrender ends cover when it is processed."""
    if case.exit_type == "CorporateExpiry":
        return (ctx["master"] or {}).get("master_expiry")
    return case.maturity_date


async def _indicative(session: AsyncSession, policy: Policy, ctx: dict, today: date) -> dict:
    """What the policy would pay if it matured, or were surrendered today — with no case open."""
    out = {"maturity": None, "surrender": {"available": False, "reason": None}}
    if ctx["profile"] != "Savings" or _st(policy) not in eng.IN_FORCE:
        out["surrender"]["reason"] = ("A protection-only product has no cash or surrender value." if ctx["profile"] != "Savings"
                                      else "The policy is not in force.")
        return out
    contribs = await eng.contributions(session, policy.id)
    rules = ctx["rules"]
    mat = policy.maturity_date or today
    loans_m = await eng.loans_on(session, policy.id, mat)
    surrender_blocked = (f"The policy reached maturity on {policy.maturity_date.isoformat()} — it is paid as a maturity, not a surrender."
                         if policy.maturity_date and today >= policy.maturity_date else None)
    out["maturity"] = _json_safe(eng.calculate_settlement(
        exit_type="Maturity", valuation_date=mat, contributions=contribs, effective_date=policy.effective_date,
        sum_assured=policy.coverage_amount, rules=rules, loans=loans_m, premium_arrears=await eng.premium_arrears_on(session, policy.id, mat)))
    if surrender_blocked:
        out["surrender"] = {"available": False, "reason": surrender_blocked}
        return out
    try:
        s = eng.calculate_settlement(
            exit_type="Surrender", valuation_date=today, contributions=contribs, effective_date=policy.effective_date,
            sum_assured=policy.coverage_amount, rules=rules, loans=await eng.loans_on(session, policy.id, today),
            premium_arrears=await eng.premium_arrears_on(session, policy.id, today))
        out["surrender"] = {"available": True, "reason": None, "settlement": _json_safe(s)}
    except ValueError as exc:
        out["surrender"] = {"available": False, "reason": str(exc)}
    return out


async def _outlook(session: AsyncSession, policy: Policy, ctx: dict, today: date) -> dict:
    """What the policy returns if no claim is made (it runs to the end) versus leaving early — a projection that
    assumes every scheduled premium is paid on time. Protection-only products return nothing in either case."""
    rows = (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy.id))).all()
    live = [r for r in rows if eng._v(r.status) != PremiumScheduleStatusEnum.WAIVED.value]
    paid = round(sum(float(r.amount_paid or 0) for r in live), 2)
    scheduled = round(sum(float(r.amount_due or 0) for r in live), 2)
    end = policy.maturity_date
    term_years = eng.completed_years(policy.effective_date, end) if (policy.effective_date and end) else None
    base = {"profile": ctx["profile"], "premiums_paid": paid, "premiums_scheduled": scheduled, "term_years": term_years,
            "projection_basis": "Assumes every scheduled premium is paid on time and the placeholder fund growth rate."}
    if ctx["profile"] != "Savings":
        return {**base, "no_claim": {"benefit": 0.0, "note": "Protection only: if no claim is made the cover simply ends at the term date and nothing is paid back."},
                "surrender": {"benefit": 0.0, "note": "A protection-only product has no cash or surrender value, so leaving early returns nothing."},
                "schedule": []}
    projected = sorted(((r.due_date, float(r.amount_due)) for r in live if float(r.amount_due or 0) > 0))
    rules = ctx["rules"]
    mat = eng.calculate_settlement(exit_type="Maturity", valuation_date=end or today, contributions=projected, effective_date=policy.effective_date,
                                   sum_assured=policy.coverage_amount, rules=rules, loans=[])
    schedule = []
    if policy.effective_date and end:
        for y in range(int(rules["surrender_min_years"]), (term_years or 0) + 1):
            try:
                anniv = policy.effective_date.replace(year=policy.effective_date.year + y)
            except ValueError:   # 29 Feb
                anniv = policy.effective_date.replace(year=policy.effective_date.year + y, day=28)
            if anniv >= end:
                break
            paid_by = sum(a for d, a in projected if d <= anniv)
            try:
                sv = eng.calculate_settlement(exit_type="Surrender", valuation_date=anniv, contributions=projected, effective_date=policy.effective_date,
                                              sum_assured=policy.coverage_amount, rules=rules, loans=[])
            except ValueError:
                continue
            schedule.append({"year": y, "date": anniv.isoformat(), "premiums_paid": round(paid_by, 2), "fund": sv["fund"]["value"],
                             "factor": sv["surrender_factor"], "value": sv["net"], "reached": anniv <= today})
    return {**base, "no_claim": {"benefit": mat["net"], "fund": mat["fund"]["value"], "growth": mat["fund"]["growth"],
                                 "note": "If no claim is made the policy runs to its term and pays this at maturity."},
            "surrender": {"benefit": next((x["value"] for x in reversed(schedule) if x["reached"]), None),
                          "note": f"Leaving early pays only a share of the fund, and nothing before {rules['surrender_min_years']} completed years."},
            "schedule": schedule}


# ── views ─────────────────────────────────────────────────────────────────────

async def _timeline(session: AsyncSession, policy_id: UUID, case: PolicyExit) -> list[dict]:
    rows = (await session.exec(select(PolicyEvent).where(PolicyEvent.policy_id == policy_id)
                               .order_by(PolicyEvent.created_at.desc()))).all()  # type: ignore[arg-type]
    out = []
    for e in rows:
        d = e.detail_json or {}
        if d.get("exit_no") != case.exit_no:
            continue
        out.append({"id": str(e.id), "event_type": e.event_type, "actor": e.actor, "from_status": e.from_status, "to_status": e.to_status,
                    "at": e.created_at.isoformat(), "detail": {k: v for k, v in d.items() if k not in ("exit_no", "case_id", "exit_type")}})
    return out


async def _workspace(session: AsyncSession, policy: Policy, case: PolicyExit) -> dict:
    ctx = await _context(session, policy)
    t = case.exit_type
    benefit = t in eng.BENEFIT_TYPES
    stages = eng.project_stages(case)
    st = {x["key"]: x["state"] for x in stages}
    s = case.settlement_json or {}
    docs = claim_engine.documents_progress(case.documents_json)
    open_ = case.status == "Open"
    today = date.today()
    ext_ok = t in ("CorporateExpiry", "DeathClaimClosure") or case.extension_decision in ("NotApplicable", "Declined")
    paperwork = (docs["complete"] or not case.documents_json) and eng.consent_complete(t, case.consent_json)
    ineligible = case.eligibility_status == "Ineligible"
    end = _end_date(case, ctx)
    reached = bool(end and today >= end)
    nil = benefit and case.calculated_at is not None and not s.get("payable")
    valid = bool(case.quote_valid_until and today <= case.quote_valid_until)
    payee = case.payee_json
    return {
        "case": {
            "id": str(case.id), "exit_no": case.exit_no, "exit_type": t, "exit_type_label": eng.TYPE_LABELS[t], "profile": case.profile,
            "status": case.status, "source": case.source, "created_at": case.created_at.isoformat(), "closed_reason": case.closed_reason,
            "requested_by": case.requested_by, "requested_relationship": case.requested_relationship, "channel": case.channel, "reason": case.reason,
            "maturity_date": _iso(case.maturity_date), "effective_date": _iso(case.effective_date), "is_open": open_,
        },
        "extension": {"decision": case.extension_decision, "decided_by": case.extension_decided_by, "decided_at": _iso(case.extension_decided_at),
                      **(case.extension_json or {})},
        "eligibility": {"status": case.eligibility_status, "result": case.eligibility_json, "verified_at": _iso(case.verified_at), "verified_by": case.verified_by},
        "documents": {"items": case.documents_json or [], "progress": docs, "complete_at": _iso(case.docs_complete_at)},
        "consent": {"declarations": eng.declarations_for(t), "state": case.consent_json, "complete": eng.consent_complete(t, case.consent_json),
                    "at": _iso(case.consent_at), "methods": cfg.EXIT_CONSENT_METHODS},
        "settlement": {"result": case.settlement_json, "net": case.net_payable, "calculated_at": _iso(case.calculated_at),
                       "calculated_by": case.calculated_by, "valid_until": _iso(case.quote_valid_until), "quote_valid": valid,
                       "accepted_at": _iso(case.accepted_at), "accepted_by": case.accepted_by, "acceptance_method": case.acceptance_method},
        "disbursement": {
            "payee": payee, "payee_verified_at": _iso(case.payee_verified_at), "authorized_by": case.authorized_by,
            "authorized_at": _iso(case.authorized_at), "payouts": case.payouts_json or [], "disbursed_at": _iso(case.disbursed_at),
            "reconciliation": case.reconciliation_json, "reconciled_at": _iso(case.reconciled_at), "reconciled_by": case.reconciled_by,
            "methods": cfg.EXIT_PAYOUT_METHODS, "dual_control_limit": ctx["rules"]["dual_control_limit"],
        },
        "closure": {"closed_at": _iso(case.closed_at), "closed_by": case.closed_by, "coverage_update": case.coverage_update_json,
                    "confirmation": {"generated_at": _iso(case.confirmation_generated_at), "sent_at": _iso(case.confirmation_sent_at),
                                     "sent_to": case.confirmation_sent_to}},
        "timing": {"term_ends": _iso(end), "term_reached": reached},
        "stages": stages,
        "can": {
            "verify": open_, "extension": open_ and t in ("Maturity", "Expiry", "Surrender") and case.extension_decision is None
                                            and not (case.extension_json or {}).get("open_renewal_no"),
            "documents": open_ and benefit and not ineligible, "consent": open_ and benefit and not ineligible and docs["complete"],
            "calculate": open_ and benefit and paperwork and not ineligible and ext_ok and not case.accepted_at,
            "accept": open_ and benefit and case.calculated_at is not None and not case.accepted_at,
            "verify_payee": open_ and benefit and bool(case.accepted_at) and not nil and not case.authorized_at,
            "authorize": open_ and benefit and bool(case.payee_verified_at) and not case.authorized_at,
            "disburse": open_ and benefit and bool(case.authorized_at) and not case.disbursed_at and (t != "Maturity" or reached),
            "reconcile": open_ and bool(case.disbursed_at) and not case.reconciled_at,
            "close": st["closure"] == "action" and open_ and ext_ok and (t in ("Surrender", "DeathClaimClosure") or reached),
            "cancel": open_ and not case.disbursed_at,
        },
        "timeline": await _timeline(session, policy.id, case),
    }


async def _overview(session: AsyncSession, policy: Policy) -> dict:
    ctx = await _context(session, policy)
    customer = await session.get(Customer, policy.customer_id)
    today = date.today()
    status = _st(policy)
    closed = status in _FINAL
    cases = (await session.exec(select(PolicyExit).where(PolicyExit.policy_id == policy.id)
                                .order_by(PolicyExit.created_at.desc()))).all()  # type: ignore[arg-type]
    open_case = next((c for c in cases if c.status == "Open"), None)
    shown = open_case or (cases[0] if cases else None)

    natural = None
    if not closed and not open_case:
        et = eng.detect_exit_type(profile=ctx["profile"], is_group=bool(policy.master_policy_id), closed_by_claim=bool(status == "Cancelled" and ctx["claim_closure"]))
        end = (ctx["master"] or {}).get("master_expiry") if et == "CorporateExpiry" else policy.maturity_date
        tm = eng.timing(end, today, int(ctx["rules"]["maturity_window_days"]))
        elig = await _evaluate(session, policy, et, today, ctx)
        natural = {"exit_type": et, "label": eng.TYPE_LABELS[et], "term_ends": _iso(end), "timing": {**tm, "window_opens_on": _iso(tm["window_opens_on"])},
                   "eligibility": elig, "can_open": et == "DeathClaimClosure" or tm["state"] in ("InWindow", "Reached")}
    return {
        "policy": {"id": str(policy.id), "policy_number": policy.policy_number, "status": status, "product_name": policy.product_name,
                   "insurance_type": _itype(policy), "sum_assured": policy.coverage_amount, "customer_name": customer.name if customer else None,
                   "customer_cnic": customer.cnic if customer else None, "effective_date": _iso(policy.effective_date),
                   "maturity_date": _iso(policy.maturity_date), "completed_years": eng.completed_years(policy.effective_date, today),
                   "free_look_end_date": _iso(policy.free_look_end_date), "is_group_certificate": bool(policy.master_policy_id)},
        "profile": ctx["profile"], "closed": closed,
        "extension": {"allowed": ctx["extension_allowed"], "open_renewal_no": ctx["open_renewal"].renewal_no if ctx["open_renewal"] else None},
        "natural": natural,
        "indicative": None if (closed or ctx["profile"] == "Group") else await _indicative(session, policy, ctx, today),
        "outlook": None if (closed or ctx["profile"] == "Group") else await _outlook(session, policy, ctx, today),
        "loans": await eng.loans_on(session, policy.id, today),
        "claim_closure": ({"claim_no": ctx["claim_closure"]["claim_no"], "at": _iso(ctx["claim_closure"]["at"]),
                           "benefit_paid": ctx["claim_closure"]["benefit_paid"], "category": ctx["claim_closure"]["category"]}
                          if ctx["claim_closure"] and status == "Cancelled" else None),
        "group_scheme": ({**ctx["master"], "master_expiry": _iso(ctx["master"].get("master_expiry"))} if ctx["master"] else None),
        "case": await _workspace(session, policy, shown) if shown else None,
        "history": [{"id": str(c.id), "exit_no": c.exit_no, "exit_type": c.exit_type, "status": c.status, "created_at": c.created_at.isoformat(),
                     "net_payable": c.net_payable, "closed_at": _iso(c.closed_at), "closed_reason": c.closed_reason} for c in cases],
        "options": {"channels": cfg.CLAIM_CHANNELS, "relationships": ["Policyholder", "Representative", "Legal heir"], "payout_methods": cfg.EXIT_PAYOUT_METHODS,
                    "consent_methods": cfg.EXIT_CONSENT_METHODS},
        "rules": {"maturity_window_days": ctx["rules"]["maturity_window_days"], "surrender_min_years": ctx["rules"]["surrender_min_years"],
                  "dual_control_limit": ctx["rules"]["dual_control_limit"], "quote_valid_days": ctx["rules"]["quote_valid_days"]},
    }


# ══════════════════════════════════════════════════════════════════════════════
# Overview, loans, opening a case
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/tenants/{tenant_id}/policies/{policy_id}/exit")
async def exit_overview(tenant_id: UUID, policy_id: UUID, session: AsyncSession = Depends(get_session)):
    """What the policy's natural end is and when, what it would pay at maturity or if surrendered
    today, its loans, the current exit case with its seven steps, and the history."""
    policy = await _get_policy(session, tenant_id, policy_id)
    return await _overview(session, policy)


@router.get("/tenants/{tenant_id}/policies/{policy_id}/exit/loans")
async def list_loans(tenant_id: UUID, policy_id: UUID, session: AsyncSession = Depends(get_session)):
    policy = await _get_policy(session, tenant_id, policy_id)
    return await eng.loans_on(session, policy.id, date.today())


@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/loans", status_code=201)
async def record_loan(
    tenant_id: UUID, policy_id: UUID, body: LoanBody,
    user=Depends(require_roles(*_MANAGERS)), session: AsyncSession = Depends(get_session),
):
    """Record money lent against the policy. There is no loan module yet, so this is how the
    'outstanding indebtedness' that is deducted from proceeds gets onto the policy."""
    policy = await _get_policy(session, tenant_id, policy_id)
    if _st(policy) not in eng.IN_FORCE:
        raise HTTPException(409, f"A loan can only be recorded against an in-force policy (current: {_st(policy)}).")
    if body.disbursed_on > date.today():
        raise HTTPException(400, "The loan cannot start in the future.")
    session.add(PolicyLoan(tenant_id=tenant_id, policy_id=policy_id, principal=body.principal, annual_interest_pct=body.annual_interest_pct,
                           disbursed_on=body.disbursed_on, reference=body.reference, note=body.note, recorded_by=_actor(user)))
    await session.commit()
    return await eng.loans_on(session, policy.id, date.today())


async def _verify(session: AsyncSession, policy: Policy, case: PolicyExit, user) -> dict:
    """Step 3: eligibility + financial verification, and the extension check (step 2)."""
    ctx = await _context(session, policy)
    elig = await _evaluate(session, policy, case.exit_type, ctx=ctx)
    today = date.today()
    out = _json_safe(elig)
    if case.exit_type in eng.BENEFIT_TYPES and ctx["profile"] == "Savings":
        valuation = case.maturity_date if (case.exit_type == "Maturity" and case.maturity_date) else today
        try:
            fin = eng.calculate_settlement(
                exit_type=case.exit_type, valuation_date=valuation, contributions=await eng.contributions(session, policy.id),
                effective_date=policy.effective_date, sum_assured=policy.coverage_amount, rules=ctx["rules"],
                loans=await eng.loans_on(session, policy.id, valuation), premium_arrears=await eng.premium_arrears_on(session, policy.id, valuation))
            out["financials"] = _json_safe(fin)
        except ValueError as exc:
            out["financials"] = None
            out["financials_error"] = str(exc)
    case.eligibility_status, case.eligibility_json = elig["status"], out
    case.verified_at, case.verified_by = _now(), _actor(user)
    renewal = ctx["open_renewal"]
    ext = dict(case.extension_json or {})
    ext.update(allowed=ctx["extension_allowed"], open_renewal_no=renewal.renewal_no if renewal else None,
               open_renewal_type=renewal.renewal_type if renewal else None)
    case.extension_json = ext
    if case.exit_type in ("Maturity", "Expiry", "Surrender") and case.extension_decision is None and not ctx["extension_allowed"] and not renewal:
        case.extension_decision, case.extension_decided_by, case.extension_decided_at = "NotApplicable", "system", _now()
    if case.exit_type in eng.BENEFIT_TYPES and not ineligible_now(elig) and not case.documents_json:
        case.documents_json = eng.build_documents(case.exit_type)
    _touch(case)
    return elig


def ineligible_now(elig: dict) -> bool:
    return elig["status"] == "Ineligible"


async def _create_case(session: AsyncSession, policy: Policy, exit_type: str, user, source: str, body: Optional[OpenBody] = None) -> tuple[PolicyExit, list]:
    ctx = await _context(session, policy)
    now = _now()
    case = PolicyExit(
        tenant_id=policy.tenant_id, policy_id=policy.id, exit_no=await _next_exit_no(session, policy.tenant_id), exit_type=exit_type,
        profile=ctx["profile"], status="Open", source=source, requested_by=(body.requested_by if body else None) or _actor(user),
        requested_relationship=(body.relationship if body else None), channel=(body.channel if body else None), reason=(body.reason if body else None),
        maturity_date=policy.maturity_date, rules_json=_json_safe(ctx["rules"]))
    session.add(case)
    await session.flush()
    events = [_audit(session, policy, case, "SurrenderRequested" if exit_type == "Surrender" else "ExitOpened", _actor(user),
                     {"source": source, "maturity_date": _iso(policy.maturity_date), "reason": case.reason})]
    elig = await _verify(session, policy, case, user)
    events.append(_audit(session, policy, case, "ExitEligibilityVerified", "system", {"status": elig["status"], "message": elig["message"]}))
    return case, events


@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit", status_code=201)
async def open_exit(
    tenant_id: UUID, policy_id: UUID, body: OpenBody, request: Request,
    user=Depends(require_roles(*_EXIT_ROLES)), session: AsyncSession = Depends(get_session),
):
    """Open the policy's exit: its natural end (maturity / expiry / corporate expiry / closure after
    a death claim) or — with exit_type 'Surrender' — an early surrender requested by the policyholder."""
    policy = await _get_policy(session, tenant_id, policy_id)
    await session.refresh(policy, with_for_update=True)
    status = _st(policy)
    if status in _FINAL:
        raise HTTPException(409, f"The policy is already {status.lower()}.")
    if await eng.get_open_case(session, policy.id):
        raise HTTPException(409, "An exit is already open on this policy — resume it.")
    ctx = await _context(session, policy)
    today = date.today()
    if body.exit_type == "Surrender":
        et = "Surrender"
        if not (body.reason or "").strip():
            raise HTTPException(400, "Record the policyholder's reason for surrendering.")
    else:
        et = eng.detect_exit_type(profile=ctx["profile"], is_group=bool(policy.master_policy_id), closed_by_claim=bool(status == "Cancelled" and ctx["claim_closure"]))
        end = (ctx["master"] or {}).get("master_expiry") if et == "CorporateExpiry" else policy.maturity_date
        if et != "DeathClaimClosure" and eng.timing(end, today, int(ctx["rules"]["maturity_window_days"]))["state"] == "Upcoming":
            raise HTTPException(409, f"The exit opens {ctx['rules']['maturity_window_days']} days before the term ends ({end.isoformat() if end else '—'}). "
                                     "To leave earlier, request a surrender.")
    elig0 = await _evaluate(session, policy, et, today, ctx)
    if elig0["blockers"]:
        raise HTTPException(409, elig0["message"])
    case, events = await _create_case(session, policy, et, user, "Manual", body)
    await session.commit()
    await _publish(request, policy, events)
    log.info("Exit %s (%s) opened on policy %s", case.exit_no, et, policy.policy_number)
    return await _overview(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/eligibility/verify")
async def reverify(tenant_id: UUID, policy_id: UUID, case_id: UUID, request: Request,
                   user=Depends(require_roles(*_EXIT_ROLES)), session: AsyncSession = Depends(get_session)):
    """Re-run the eligibility and financial checks (e.g. after a claim was closed or a loan recorded)."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    elig = await _verify(session, policy, case, user)
    ev = _audit(session, policy, case, "ExitEligibilityVerified", _actor(user), {"status": elig["status"], "rerun": True})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Step 2 — renewal / extension
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/extension")
async def decide_extension(tenant_id: UUID, policy_id: UUID, case_id: UUID, body: ExtensionBody, request: Request,
                           user=Depends(require_roles(*_EXIT_ROLES)), session: AsyncSession = Depends(get_session)):
    """Where the product permits an extension: record that the policyholder declines it and the exit
    proceeds, or send the case to Renewals (Module 7), which owns every extension."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if case.exit_type not in ("Maturity", "Expiry", "Surrender"):
        raise HTTPException(409, "There is no extension check for this kind of exit.")
    if (case.extension_json or {}).get("open_renewal_no"):
        raise HTTPException(409, f"Contract renewal {(case.extension_json or {})['open_renewal_no']} is open — finish it in Renewals first.")
    if case.extension_decision == "NotApplicable":
        raise HTTPException(409, "The product has no extension option, so nothing needs to be decided.")
    note = (body.note or "").strip()
    if body.decision == "Declined":
        case.extension_decision = "Declined"
        ev_type = "ExitExtensionDeclined"
    else:
        if not note:
            raise HTTPException(400, "Say why the case is being redirected.")
        case.extension_decision, case.status = "Redirected", "Cancelled"
        case.closed_reason = f"Redirected to Renewals: {note}"
        ev_type = "ExitRedirectedToRenewals"
    case.extension_json = {**(case.extension_json or {}), "note": note or None}
    case.extension_decided_by, case.extension_decided_at = _actor(user), _now()
    _touch(case)
    ev = _audit(session, policy, case, ev_type, _actor(user), {"note": note or None})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Step 4 — documents + consent
# ══════════════════════════════════════════════════════════════════════════════

def _find_doc(case: PolicyExit, key: str) -> dict:
    for d in (case.documents_json or []):
        if d["key"] == key:
            return d
    raise HTTPException(404, "Checklist item not found")


def _update_doc(case: PolicyExit, key: str, **changes) -> None:
    case.documents_json = [({**d, **changes} if d["key"] == key else d) for d in (case.documents_json or [])]


def _sync_docs(case: PolicyExit) -> None:
    prog = claim_engine.documents_progress(case.documents_json)
    case.docs_complete_at = (case.docs_complete_at or _now()) if prog["complete"] else None


@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/documents/{key}")
async def receive_document(
    tenant_id: UUID, policy_id: UUID, case_id: UUID, key: str, request: Request,
    note: Optional[str] = Form(None), file: UploadFile = File(...),
    user=Depends(require_roles(*_EXIT_ROLES)), session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    item = _find_doc(case, key)
    if case.eligibility_status == "Ineligible":
        raise HTTPException(409, "The exit is not eligible — documents are collected once it is.")
    if case.accepted_at:
        raise HTTPException(409, "The settlement has been accepted — documents are locked.")
    ext = (file.filename or "").lower().rsplit(".", 1)[-1]
    if ext not in _ALLOWED_EXT:
        raise HTTPException(400, f"Unsupported file type '.{ext}'. Allowed: {', '.join(sorted(_ALLOWED_EXT))}")
    data = await file.read()
    if not data:
        raise HTTPException(400, "The file is empty.")
    if len(data) > _MAX_BYTES:
        raise HTTPException(413, "File is larger than 15 MB")
    artifact_id = uuid4()
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in os.path.basename(file.filename or "document"))
    storage_url = _upload_to_s3(data, f"{tenant_id}/exits/{policy_id}/{artifact_id}/{safe}", _ALLOWED_EXT[ext])
    session.add(Artifact(id=artifact_id, tenant_id=tenant_id, customer_id=policy.customer_id, uploaded_by=getattr(user, "id", None),
                         document_type=item["label"], file_name=safe, file_size=len(data), file_type=_ALLOWED_EXT[ext], storage_url=storage_url, status="Uploaded"))
    _update_doc(case, key, status="Received", received_at=_now().isoformat(), artifact_id=str(artifact_id), file_name=safe, note=(note or "").strip() or None)
    _sync_docs(case)
    _touch(case)
    ev = _audit(session, policy, case, "ExitDocumentReceived", _actor(user), {"document": item["label"], "file": safe})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/documents/{key}/waive")
async def waive_document(tenant_id: UUID, policy_id: UUID, case_id: UUID, key: str, body: NoteBody, request: Request,
                         user=Depends(require_roles(*_MANAGERS)), session: AsyncSession = Depends(get_session)):
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    item = _find_doc(case, key)
    if case.accepted_at:
        raise HTTPException(409, "The settlement has been accepted — documents are locked.")
    note = (body.note or "").strip() or None
    _update_doc(case, key, status="Waived", note=note, received_at=_now().isoformat())
    _sync_docs(case)
    _touch(case)
    ev = _audit(session, policy, case, "ExitDocumentWaived", _actor(user), {"document": item["label"], "reason": note})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


@router.get("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/documents/{key}/download")
async def download_document(tenant_id: UUID, policy_id: UUID, case_id: UUID, key: str, session: AsyncSession = Depends(get_session)):
    await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    item = _find_doc(case, key)
    art = await session.get(Artifact, UUID(item["artifact_id"])) if item.get("artifact_id") else None
    if not art or art.tenant_id != tenant_id:
        raise HTTPException(404, "No file is attached to this item")
    if art.storage_url and art.storage_url.startswith("local://"):
        path = os.path.join("/app/shared/storage", art.storage_url.replace("local://", ""))
        if os.path.isfile(path):
            return FileResponse(path, media_type=art.file_type or "application/octet-stream", filename=art.file_name)
        raise HTTPException(404, "The stored file is missing")
    presigned = _presign_url(art.storage_url.split(".amazonaws.com/", 1)[-1]) if art.storage_url else ""
    if presigned:
        return RedirectResponse(presigned, status_code=307)
    raise HTTPException(404, "The stored file is unavailable")


@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/consent")
async def record_consent(tenant_id: UUID, policy_id: UUID, case_id: UUID, body: ConsentBody, request: Request,
                         user=Depends(require_roles(*_EXIT_ROLES)), session: AsyncSession = Depends(get_session)):
    """Record the policyholder's declarations (one by one, all required) and who gave them and how."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    wanted = eng.declarations_for(case.exit_type)
    if not wanted:
        raise HTTPException(409, "No declaration is needed for this kind of exit.")
    if case.accepted_at:
        raise HTTPException(409, "The settlement has been accepted — the consent is locked.")
    if body.method not in cfg.EXIT_CONSENT_METHODS:
        raise HTTPException(400, f"Unknown consent method '{body.method}'")
    if not body.by.strip():
        raise HTTPException(400, "Record who gave the consent.")
    unknown = [k for k in body.accepted if k not in {d["key"] for d in wanted}]
    if unknown:
        raise HTTPException(400, f"Unknown declaration(s): {', '.join(unknown)}")
    case.consent_json = {"declarations": [{"key": d["key"], "text": d["text"], "accepted": d["key"] in body.accepted} for d in wanted],
                         "by": body.by.strip(), "method": body.method, "at": _now().isoformat()}
    case.consent_at = _now() if eng.consent_complete(case.exit_type, case.consent_json) else None
    _touch(case)
    ev = _audit(session, policy, case, "ExitConsentRecorded", _actor(user), {"by": body.by.strip(), "method": body.method,
                                                                             "complete": eng.consent_complete(case.exit_type, case.consent_json)})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Step 5 — final settlement + acceptance
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/settlement/calculate")
async def calculate(tenant_id: UUID, policy_id: UUID, case_id: UUID, body: CalcBody, request: Request,
                    user=Depends(require_roles(*_EXIT_ROLES)), session: AsyncSession = Depends(get_session)):
    """Calculate the contractually payable amount — value less loans, premium unpaid, other
    recoverable amounts and tax — and present it for the policyholder's acceptance."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if case.exit_type not in eng.BENEFIT_TYPES:
        raise HTTPException(409, "No benefit is payable for this kind of exit.")
    if case.accepted_at:
        raise HTTPException(409, "The settlement has already been accepted.")
    if case.eligibility_status == "Ineligible":
        raise HTTPException(409, "The exit is not eligible — there is nothing to settle.")
    if case.extension_decision not in ("NotApplicable", "Declined"):
        raise HTTPException(409, "Resolve the renewal / extension check first.")
    docs = claim_engine.documents_progress(case.documents_json)
    if (case.documents_json and not docs["complete"]) or not eng.consent_complete(case.exit_type, case.consent_json):
        raise HTTPException(409, "Collect every required document and the policyholder's consent first.")
    await _require_eligible(session, policy, case)
    ctx = await _context(session, policy)
    rules = ctx["rules"]
    today = date.today()
    valuation = case.maturity_date if (case.exit_type == "Maturity" and case.maturity_date) else today
    try:
        result = eng.calculate_settlement(
            exit_type=case.exit_type, valuation_date=valuation, contributions=await eng.contributions(session, policy.id),
            effective_date=policy.effective_date, sum_assured=policy.coverage_amount, rules=rules,
            loans=await eng.loans_on(session, policy.id, valuation), premium_arrears=await eng.premium_arrears_on(session, policy.id, valuation),
            recoverables=[r.model_dump() for r in body.recoverables])
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    result["notes"] = (body.notes or "").strip() or None
    case.settlement_json, case.net_payable = _json_safe(result), result["net"]
    case.calculated_at, case.calculated_by = _now(), _actor(user)
    case.quote_valid_until = max(today, valuation) + timedelta(days=int(rules["quote_valid_days"]))
    case.accepted_at = case.accepted_by = case.acceptance_method = None
    case.payee_json = case.payee_verified_at = case.authorized_at = case.authorized_by = None
    _touch(case)
    ev = _audit(session, policy, case, "ExitSettlementCalculated", _actor(user), {
        "gross": result["gross"], "deductions": result["total_deductions"], "tax": result["tax"], "net": result["net"], "valuation_date": result["valuation_date"]})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


@router.get("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/settlement/statement")
async def settlement_statement(tenant_id: UUID, policy_id: UUID, case_id: UUID, session: AsyncSession = Depends(get_session)):
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    if not case.settlement_json:
        raise HTTPException(409, "The settlement has not been calculated yet.")
    customer = await session.get(Customer, policy.customer_id)
    tenant = await session.get(Tenant, policy.tenant_id)
    doc = document_generator.generate_exit_statement({
        "policy_id": policy.id, "tenant_name": tenant.name if tenant else "Insurer", "exit_no": case.exit_no, "exit_type": case.exit_type,
        "policy_number": policy.policy_number, "product_name": policy.product_name, "customer_name": customer.name if customer else None,
        "settlement": case.settlement_json, "valid_until": _iso(case.quote_valid_until)})
    case.statement_path = doc["file_path"]
    await session.commit()
    return FileResponse(doc["file_path"], media_type="application/pdf", filename=f"settlement_statement_{case.exit_no}.pdf")


@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/settlement/accept")
async def accept_settlement(tenant_id: UUID, policy_id: UUID, case_id: UUID, body: AcceptBody, request: Request,
                            user=Depends(require_roles(*_EXIT_ROLES)), session: AsyncSession = Depends(get_session)):
    """Record the policyholder's acceptance of the calculated amount — or their refusal, which ends the
    exit and leaves the policy as it is."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if not case.calculated_at:
        raise HTTPException(409, "Calculate the settlement before it is presented for acceptance.")
    if case.accepted_at:
        raise HTTPException(409, "The settlement has already been accepted.")
    if body.accepted:
        if not case.quote_valid_until or date.today() > case.quote_valid_until:
            raise HTTPException(409, "The settlement figure has expired — recalculate it.")
        if body.method not in cfg.EXIT_CONSENT_METHODS or not (body.by or "").strip():
            raise HTTPException(400, "Record who accepted and how.")
        case.accepted_at, case.accepted_by, case.acceptance_method = _now(), body.by.strip(), body.method
        ev_type = "ExitSettlementAccepted"
    else:
        case.status, case.closed_reason = "Declined", (body.note or "The policyholder declined the settlement.").strip()
        ev_type = "ExitSettlementDeclined"
    _touch(case)
    ev = _audit(session, policy, case, ev_type, _actor(user), {"net": case.net_payable, "by": body.by, "method": body.method, "note": body.note})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Step 6 — payee, authorise, disburse, reconcile
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/settlement/payee")
async def verify_payee(tenant_id: UUID, policy_id: UUID, case_id: UUID, body: PayeeBody, request: Request,
                       user=Depends(require_roles(*_EXIT_ROLES)), session: AsyncSession = Depends(get_session)):
    """The only valid payee of a maturity or surrender is the policyholder. Verify the CNIC against
    the one on record and the bank account (IBAN, account title) before any money moves."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if not case.accepted_at:
        raise HTTPException(409, "The policyholder must accept the settlement first.")
    if case.net_payable <= 0:
        raise HTTPException(409, "Nothing is payable, so there is no payee to verify.")
    if case.authorized_at:
        raise HTTPException(409, "The payment is already authorised — the payee can no longer change.")
    customer = await session.get(Customer, policy.customer_id)
    p = dict(case.payee_json or {"id": "payee-1", "name": customer.name if customer else "Policyholder", "beneficiary_name": customer.name if customer else None,
                                 "cnic": customer.cnic if customer else None, "relationship": "Policyholder", "share_pct": 100.0,
                                 "amount": case.net_payable, "is_minor": False, "guardian_name": None, "verified": False})
    for f in ("cnic", "bank_name", "account_title", "iban", "method", "note"):
        v = getattr(body, f)
        if v is not None:
            p[f] = v.strip() if f != "iban" else v.replace(" ", "").upper()
    p["amount"] = case.net_payable
    res = claim_engine.payee_checks(p, recorded_cnic=customer.cnic if customer else None)
    p["checks"] = res["checks"]
    events = []
    if body.verify:
        if res["blockers"]:
            raise HTTPException(400, "; ".join(c["detail"] for c in res["blockers"]))
        if res["reviews"] and not (p.get("note") or "").strip():
            raise HTTPException(400, "; ".join(c["detail"] for c in res["reviews"]) + " Add a note to verify anyway.")
        if not (p.get("method") or "").strip():
            raise HTTPException(400, "Say how the payee's identity was verified.")
        p["verified"], p["verified_by"], p["verified_at"] = True, _actor(user), _now().isoformat()
        case.payee_verified_at = _now()
        events.append(_audit(session, policy, case, "ExitPayeeVerified", _actor(user), {"payee": p["name"], "method": p.get("method"), "amount": case.net_payable}))
    else:
        p["verified"], p["verified_by"], p["verified_at"] = False, None, None
        case.payee_verified_at = None
    case.payee_json = p
    _touch(case)
    await session.commit()
    await _publish(request, policy, events)
    return await _overview(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/settlement/authorize")
async def authorize(tenant_id: UUID, policy_id: UUID, case_id: UUID, request: Request,
                    user=Depends(require_roles(*_MANAGERS)), session: AsyncSession = Depends(get_session)):
    """Authorise the payment. A manager only; and above the dual-control limit the authoriser must be
    a different person from whoever calculated the settlement (a SuperAdmin acts above that rule)."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if not case.payee_verified_at:
        raise HTTPException(409, "Verify the payee before authorising the payment.")
    if case.authorized_at:
        raise HTTPException(409, "The payment is already authorised.")
    ctx = await _context(session, policy)
    role = await _role_name(user, session)
    if eng.needs_dual_control(case.net_payable, ctx["rules"], role) and _actor(user) == case.calculated_by:
        raise HTTPException(403, f"Payments above PKR {ctx['rules']['dual_control_limit']:,.0f} need dual control — someone other than "
                                 f"{case.calculated_by}, who calculated the settlement, must authorise it.")
    if not case.quote_valid_until or date.today() > case.quote_valid_until:
        raise HTTPException(409, "The settlement figure has expired — recalculate and have it accepted again.")
    await _require_eligible(session, policy, case)
    case.authorized_by, case.authorized_at = _actor(user), _now()
    _touch(case)
    ev = _audit(session, policy, case, "ExitPaymentAuthorized", _actor(user), {"net": case.net_payable})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


async def _apply_loans(session: AsyncSession, case: PolicyExit, applied_to_loans: float) -> list[dict]:
    """Record the recovery of loans from the proceeds: loans are repaid first, in order."""
    out, remaining = [], applied_to_loans
    for d in (case.settlement_json or {}).get("deductions", []):
        if d.get("kind") != "loan" or not d.get("loan_id"):
            continue
        loan = await session.get(PolicyLoan, UUID(d["loan_id"]))
        if loan is None or loan.status != "Outstanding":
            continue
        take = min(d["amount"], max(remaining, 0.0))
        remaining = round(remaining - take, 2)
        loan.repaid_amount = round(loan.repaid_amount + take, 2)
        loan.status = "RecoveredFromExit" if take + 0.005 >= d["amount"] else "WrittenOff"
        session.add(loan)
        out.append({"loan_id": d["loan_id"], "balance": d["amount"], "recovered": take, "status": loan.status})
    return out


@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/settlement/disburse")
async def disburse(tenant_id: UUID, policy_id: UUID, case_id: UUID, body: DisburseBody, request: Request,
                   user=Depends(require_roles(*_EXIT_ROLES)), session: AsyncSession = Depends(get_session)):
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if not case.authorized_at:
        raise HTTPException(409, "Authorise the payment first.")
    if case.disbursed_at:
        raise HTTPException(409, "The payment has already been made.")
    if body.method not in cfg.EXIT_PAYOUT_METHODS:
        raise HTTPException(400, f"Unknown payout method '{body.method}'")
    today = date.today()
    if case.exit_type == "Maturity" and case.maturity_date and today < case.maturity_date:
        raise HTTPException(409, f"Maturity proceeds are paid on or after the maturity date ({case.maturity_date.isoformat()}).")
    if not case.quote_valid_until or today > case.quote_valid_until:
        raise HTTPException(409, "The settlement figure has expired — recalculate and have it accepted again.")
    await _require_eligible(session, policy, case)
    payee = case.payee_json or {}
    ref = f"{'SUR' if case.exit_type == 'Surrender' else 'MAT'}-{today.strftime('%Y%m%d')}-{uuid4().hex[:6].upper()}"
    case.payouts_json = [{"amount": case.net_payable, "method": body.method, "payee_name": payee.get("name"), "reference": ref, "status": "Settled",
                          "at": _now().isoformat(), "account": f"{payee.get('bank_name')} · {payee.get('iban')}"}]
    case.disbursed_at = _now()
    s = case.settlement_json or {}
    loans = await _apply_loans(session, case, min(sum(d["amount"] for d in s.get("deductions", []) if d.get("kind") == "loan"), s.get("gross", 0.0)))
    case.settlement_json = {**s, "loans_applied": loans}
    _touch(case)
    ev = _audit(session, policy, case, "ExitPaymentMade", _actor(user), {"amount": case.net_payable, "method": body.method, "reference": ref})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/settlement/reconcile")
async def reconcile(tenant_id: UUID, policy_id: UUID, case_id: UUID, body: ReconcileBody, request: Request,
                    user=Depends(require_roles(*_EXIT_ROLES)), session: AsyncSession = Depends(get_session)):
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if not case.disbursed_at:
        raise HTTPException(409, "There is no payment to reconcile yet.")
    result = eng.reconcile_exit(net=case.net_payable, payee_name=(case.payee_json or {}).get("name") or "", payouts=case.payouts_json or [])
    note = (body.note or "").strip()
    case.reconciliation_json = _json_safe(result)
    _touch(case)
    if result["status"] == "Exception" and not note:
        ev = _audit(session, policy, case, "ExitReconciliationException", _actor(user), {"variance": result["variance"]})
    else:
        case.reconciled_at, case.reconciled_by = _now(), _actor(user)
        ev = _audit(session, policy, case, "ExitReconciled", _actor(user), {"status": result["status"], "paid": result["paid"], "note": note or None})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Step 7 — close + archive
# ══════════════════════════════════════════════════════════════════════════════

async def _close_effects(session: AsyncSession, policy: Policy, case: PolicyExit, user, coverage_ended: date) -> tuple[dict, list]:
    """What closing does to the policy's records: the final status, billing stopped, riders ended,
    loans settled. Returns the summary stored on the case and the audit events."""
    events: list = []
    summary: dict = {"exit_type": case.exit_type, "coverage_ended": coverage_ended.isoformat(), "benefit_paid": case.net_payable if case.disbursed_at else 0.0}
    t = case.exit_type
    if t in eng.FINAL_STATUS:
        final = PolicyStatusEnum(eng.FINAL_STATUS[t])
        events.append(apply_transition(session, policy, final, event_type=eng.FINAL_EVENT[t], actor=_actor(user), detail={
            "exit_no": case.exit_no, "case_id": str(case.id), "exit_type": t, "coverage_ended": coverage_ended.isoformat(),
            "benefit_paid": summary["benefit_paid"], "payout_references": [p["reference"] for p in (case.payouts_json or [])]}))
        summary["policy_status"] = final.value
    else:
        events.append(_audit(session, policy, case, "PolicyClosureArchived", _actor(user), {"policy_status": _st(policy)}))
        summary["policy_status"] = _st(policy)

    waived = 0
    for r in (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy.id))).all():
        if r.status in (PremiumScheduleStatusEnum.PENDING, PremiumScheduleStatusEnum.OVERDUE):
            r.status = PremiumScheduleStatusEnum.WAIVED
            r.payment_reference = f"EXIT-{case.exit_no}"
            session.add(r)
            waived += 1
    policy.autopay_enabled = False
    session.add(policy)
    riders = 0
    for rd in (await session.exec(select(PolicyRider).where(PolicyRider.policy_id == policy.id))).all():
        if rd.status == "Active":
            rd.status, rd.removed_at = "Removed", _now()
            session.add(rd)
            riders += 1
    summary.update(instalments_waived=waived, riders_closed=riders, billing_stopped=True)
    s = case.settlement_json or {}
    if case.exit_type in eng.BENEFIT_TYPES and not case.disbursed_at and "loans_applied" not in s:
        # Nothing was paid out (deductions took the whole value) — the loans are still recovered from it.
        s = {**s, "loans_applied": await _apply_loans(session, case, s.get("gross", 0.0))}
        case.settlement_json = s
    summary["loans"] = s.get("loans_applied", [])
    return summary, events


async def _render_letter(session: AsyncSession, policy: Policy, case: PolicyExit) -> str:
    customer = await session.get(Customer, policy.customer_id)
    tenant = await session.get(Tenant, policy.tenant_id)
    cu = case.coverage_update_json or {}
    s = case.settlement_json or {}
    doc = document_generator.generate_exit_letter({
        "policy_id": policy.id, "tenant_name": tenant.name if tenant else "Insurer", "exit_no": case.exit_no, "exit_type": case.exit_type,
        "policy_number": policy.policy_number, "product_name": policy.product_name, "customer_name": customer.name if customer else None,
        "final_status": cu.get("policy_status") or _st(policy), "coverage_ended": cu.get("coverage_ended") or _iso(case.effective_date),
        "payouts": case.payouts_json or [], "gross": s.get("gross"), "deductions": s.get("total_deductions"), "tax": s.get("tax"), "net": case.net_payable,
        "instalments_waived": cu.get("instalments_waived"), "riders_closed": cu.get("riders_closed")})
    case.confirmation_path, case.confirmation_generated_at = doc["file_path"], _now()
    return doc["file_path"]


@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/close")
async def close_exit(tenant_id: UUID, policy_id: UUID, case_id: UUID, request: Request,
                     user=Depends(require_roles(*_EXIT_ROLES)), session: AsyncSession = Depends(get_session)):
    """Step 7 — record the final coverage end, stop future billing, end riders, settle loans, move the
    policy to its final status and issue the closure confirmation. Refused while a claim or an
    extension (a contract renewal) is open."""
    policy = await _get_policy(session, tenant_id, policy_id)
    await session.refresh(policy, with_for_update=True)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    t = case.exit_type
    ctx = await _context(session, policy)
    elig = await _evaluate(session, policy, t, ctx=ctx)
    if elig["blockers"]:
        raise HTTPException(409, f"The policy cannot be closed: {elig['message']}")
    if t in ("Maturity", "Expiry", "Surrender") and case.extension_decision not in ("NotApplicable", "Declined"):
        raise HTTPException(409, "Resolve the renewal / extension check before closing the policy.")
    today = date.today()
    end = _end_date(case, ctx)
    if t in ("Maturity", "Expiry", "CorporateExpiry") and not (end and today >= end):
        raise HTTPException(409, f"The policy's term runs until {end.isoformat() if end else '—'}; it can be closed on or after that date.")
    if t in eng.BENEFIT_TYPES:
        s = case.settlement_json or {}
        if not case.accepted_at:
            raise HTTPException(409, "The policyholder has not accepted a settlement.")
        if s.get("payable") and not case.reconciled_at:
            raise HTTPException(409, "Pay and reconcile the settlement before closing the policy.")
    coverage_ended = end if t != "Surrender" and end else today
    try:
        summary, events = await _close_effects(session, policy, case, user, coverage_ended)
        case.coverage_update_json = summary
        case.effective_date, case.status, case.closed_at, case.closed_by = coverage_ended, "Completed", _now(), _actor(user)
        await _render_letter(session, policy, case)
        _touch(case)
        events.append(_audit(session, policy, case, "ExitClosed", _actor(user), {"final_status": summary["policy_status"], "coverage_ended": coverage_ended.isoformat(),
                                                                                  "benefit_paid": summary["benefit_paid"]}))
        await session.commit()
    except IllegalStateTransition as exc:
        await session.rollback()
        raise HTTPException(409, str(exc)) from exc
    except HTTPException:
        await session.rollback()
        raise
    except Exception as exc:
        await session.rollback()
        log.exception("Closing exit %s failed — rolled back", case_id)
        raise HTTPException(500, f"Closing the policy failed and was rolled back: {exc}") from exc
    await _publish(request, policy, events)
    log.info("Exit %s closed — policy %s is now %s", case.exit_no, policy.policy_number, summary["policy_status"])
    return await _overview(session, policy)


@router.get("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/confirmation/download")
async def download_letter(tenant_id: UUID, policy_id: UUID, case_id: UUID, session: AsyncSession = Depends(get_session)):
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    if case.status != "Completed":
        raise HTTPException(409, "The closure confirmation is issued when the policy is closed.")
    if not case.confirmation_path or not os.path.exists(case.confirmation_path):
        await _render_letter(session, policy, case)
        await session.commit()
    return FileResponse(case.confirmation_path, media_type="application/pdf", filename=f"policy_closure_{case.exit_no}.pdf")


@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/confirmation/send")
async def send_letter(tenant_id: UUID, policy_id: UUID, case_id: UUID, request: Request,
                      user=Depends(require_roles(*_EXIT_ROLES)), session: AsyncSession = Depends(get_session)):
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    if case.status != "Completed":
        raise HTTPException(409, "The closure confirmation can be sent once the policy is closed.")
    customer = await session.get(Customer, policy.customer_id)
    details = (customer.details if customer else None) or {}
    email = details.get("contact_email") or details.get("email")
    if not email:
        raise HTTPException(400, "No email on record — add a contact before sending the confirmation.")
    tenant = await session.get(Tenant, policy.tenant_id)
    subject, text, html = exit_closure_email(
        customer_name=customer.name if customer else "Policyholder", tenant_name=tenant.name if tenant else "Your Insurer",
        policy_number=policy.policy_number or "—", exit_no=case.exit_no, exit_type=case.exit_type,
        final_status=(case.coverage_update_json or {}).get("policy_status") or _st(policy), amount_paid=case.net_payable if case.disbursed_at else 0.0,
        tenant_phone=tenant.contact_phone if tenant else None, tenant_email=tenant.contact_email if tenant else None)
    attachments = [case.confirmation_path] if case.confirmation_path and os.path.exists(case.confirmation_path) else None
    ok = await email_utils.send_email(email, subject, text, html, attachments)
    if ok:
        case.confirmation_sent_at, case.confirmation_sent_to = _now(), email
        _touch(case)
    ev = _audit(session, policy, case, "ExitLetterSent", _actor(user), {"to": email, "delivered": ok})
    await session.commit()
    await _publish(request, policy, [ev])
    return {"sent_to": email, "sent_at": _now().isoformat(), "delivered": ok, "subject": subject}


@router.post("/tenants/{tenant_id}/policies/{policy_id}/exit/{case_id}/cancel")
async def cancel_exit(tenant_id: UUID, policy_id: UUID, case_id: UUID, body: CancelBody, request: Request,
                      user=Depends(require_roles(*_EXIT_ROLES)), session: AsyncSession = Depends(get_session)):
    """Withdraw an exit before any money has moved; the policy carries on exactly as it was."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if case.disbursed_at:
        raise HTTPException(409, "The payment has already been made — complete and close the exit instead.")
    case.status, case.closed_reason = "Cancelled", (body.reason or "Withdrawn by the policyholder").strip()
    _touch(case)
    ev = _audit(session, policy, case, "ExitCancelled", _actor(user), {"reason": case.closed_reason})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Step 1 — portfolio sweep
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/exits/sweep")
async def sweep_exits(tenant_id: UUID, body: SweepBody, request: Request,
                      user=Depends(require_roles("SuperAdmin", "Admin")), session: AsyncSession = Depends(get_session)):
    """Find every policy that is within its maturity window (or past it) and open its exit — the
    on-demand 'identify upcoming maturity' step. A policy whose exit is blocked (open claim, open
    renewal …) is reported, not opened. `dry_run` changes nothing."""
    rows = (await session.exec(select(Policy.id, Policy.policy_number).where(Policy.tenant_id == tenant_id))).all()
    report = {"scanned": 0, "opened": [], "skipped": [], "dry_run": body.dry_run}
    for pid, number in rows:
        policy = await session.get(Policy, pid)
        if policy is None or _st(policy) not in (*eng.IN_FORCE, "Lapsed"):
            continue
        report["scanned"] += 1
        try:
            await session.refresh(policy, with_for_update=True)
            if await eng.get_open_case(session, policy.id):
                report["skipped"].append({"policy_number": number, "reason": "An exit is already open"})
                await session.rollback()
                continue
            ctx = await _context(session, policy)
            et = eng.detect_exit_type(profile=ctx["profile"], is_group=bool(policy.master_policy_id), closed_by_claim=False)
            end = (ctx["master"] or {}).get("master_expiry") if et == "CorporateExpiry" else policy.maturity_date
            tm = eng.timing(end, date.today(), int(ctx["rules"]["maturity_window_days"]))
            if tm["state"] not in ("InWindow", "Reached"):
                await session.rollback()
                continue
            elig = await _evaluate(session, policy, et, ctx=ctx)
            entry = {"policy_number": number, "exit_type": et, "term_ends": _iso(end), "days_until": tm["days_until"]}
            if elig["blockers"]:
                report["skipped"].append({**entry, "reason": elig["message"]})
                await session.rollback()
                continue
            if body.dry_run:
                report["opened"].append(entry)
                await session.rollback()
                continue
            case, events = await _create_case(session, policy, et, user, "Sweep")
            await session.commit()
            await _publish(request, policy, events)
            report["opened"].append({**entry, "exit_no": case.exit_no})
        except Exception as exc:   # one bad policy must not stop the sweep
            await session.rollback()
            log.exception("Exit sweep failed for policy %s", pid)
            report["skipped"].append({"policy_number": number, "reason": f"error: {exc}"})
    return report
