"""
Stage B — Claims Management router (step 8 of the post-issuance journey).

The 7-step claim workflow, driven on top of the EXISTING Claim record so the claims
register, dashboard, reinsurance recovery and group claims keep seeing one truth.
`ClaimProcess` (one row per claim) holds what the workflow adds; every status change
goes through routers.claims.VALID_TRANSITIONS and is written to ClaimStatusHistory.

  1 intimation          POST /claims-management                      register claimant, policy, covered person, event
  2 eligibility         POST /{id}/eligibility/verify, /override     cover on the EVENT date, applicable benefit
  3 documents           POST /{id}/documents/{key}  (+ /waive /reject, GET checklist)
  4 investigation +     POST /{id}/investigation/finding, /complete
    assessment          POST /{id}/assessment                        contractual benefit calculation
  5 decision            POST /{id}/decision                          approve · partial · reject · request info · refer
  6 settlement          POST /{id}/settlement/payees, /authorize, /disburse, /reconcile
  7 closure             POST /{id}/close, GET/POST /{id}/confirmation/...

Claims are INDEPENDENT of reinstatement and renewals: eligibility asks whether cover was in
force on the event date (rebuilt from the policy's audit trail), never what the status is
today — a policy that is lapsed or closed now can still owe a valid claim.

Rules, checklists and benefit formulas are configurable placeholders in
services/insurer_config.py; the pure logic is services/claim_engine.py.
"""

import logging
import os
from datetime import date, datetime
from typing import Literal, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field as PField, field_validator
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import email_utils
from database import get_session
from services.idempotency import notification_operation
from shared.idempotency.http import database_operation
from routers.artifacts import _presign_url, _upload_to_s3
from routers.auth import _role_name, require_roles
from routers.claims import (
    VALID_TRANSITIONS,
    ClaimCreate,
    assert_claim_payable,
    open_claim,
    settle_claim_with_payouts,
)
from routers.policies import _get_policy, _publish_policy_event, _st
from services import claim_engine as eng
from services import claim_authority as ca, document_generator, insurer_config as cfg
from services import renewal_engine
from services.email_templates import claim_closure_email
from shared.models.core import (
    Artifact,
    Beneficiary,
    Case,
    CaseStatusEnum,
    CaseTypeEnum,
    Claim,
    ClaimPayout,
    ClaimProcess,
    ClaimStatusEnum,
    ClaimStatusHistory,
    Customer,
    InsurancePlan,
    Policy,
    PolicyEvent,
    PolicyRider,
    PolicyStatusEnum,
    PremiumSchedule,
    PremiumScheduleStatusEnum,
    Tenant,
)
from shared.services.policy_state_machine import IllegalStateTransition, apply_transition, record_event

log = logging.getLogger(__name__)
router = APIRouter(tags=["Stage B — Claims Management"])

# Who may do what is decided in services/claim_authority.py (roles and the delegated authority matrix). Admin is not
# among them: Admin configures and oversees, claims staff decide, Finance pays.
_CLAIMS_ROLES = ca.PROCESS_ROLES
_DECIDERS = ca.DECIDE_ROLES
_MANAGERS = ca.MANAGER_ROLES
_ALLOWED_EXT = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "tiff": "image/tiff"}
_MAX_BYTES = 15 * 1024 * 1024
_DECIDED = (ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL, ClaimStatusEnum.DECLINED,
            ClaimStatusEnum.SETTLED, ClaimStatusEnum.CLOSED)


# ── request bodies ────────────────────────────────────────────────────────────

class RegisterBody(BaseModel):
    category: Literal["Death", "AccidentalDeath", "Disability", "Hospitalization"]
    event_date: date
    event_end_date: Optional[date] = None
    cause: Optional[str] = None
    event_place: Optional[str] = None
    event_description: Optional[str] = None
    event_details: dict = PField(default_factory=dict)       # hospital, diagnosis, admission/discharge …
    claimed_amount: float = PField(gt=0)
    claimant_name: str
    claimant_cnic: Optional[str] = None
    claimant_relationship: str = "Self"
    claimant_phone: Optional[str] = None
    claimant_email: Optional[str] = None
    covered_person_name: Optional[str] = None
    covered_person_cnic: Optional[str] = None
    covered_person_relationship: str = "Self"
    channel: str = "Branch"
    notes: Optional[str] = None


class AdoptBody(BaseModel):
    category: Literal["Death", "AccidentalDeath", "Disability", "Hospitalization"]
    cause: Optional[str] = None
    covered_person_relationship: str = "Self"


class NoteBody(BaseModel):
    note: str


class DocReasonBody(BaseModel):
    reason: str


class DocWaiveBody(BaseModel):
    reason: Optional[str] = None  # optional: a manager just waives; a reason, if given, goes on the claim file


class DocRequestBody(BaseModel):
    label: str
    required: bool = True
    reason: Optional[str] = None


class FindingBody(BaseModel):
    kind: Literal["Verified", "Adverse", "Neutral"] = "Neutral"
    source: Optional[str] = None
    note: str


class InvestigationCloseBody(BaseModel):
    outcome: Literal["Verified", "Adverse", "Inconclusive"]
    notes: Optional[str] = None


class DeductionIn(BaseModel):
    label: str
    amount: float = PField(ge=0)


class AssessBody(BaseModel):
    disability_pct: Optional[float] = None
    deductions: list[DeductionIn] = PField(default_factory=list)
    copay_pct: Optional[float] = None
    notes: Optional[str] = None


class InfoRequestIn(BaseModel):
    label: str
    reason: Optional[str] = None


class DecisionBody(BaseModel):
    decision: Literal["Approve", "PartialApprove", "Reject", "RequestInfo", "Refer"]
    amount: Optional[float] = None
    reason: Optional[str] = None
    info_requests: list[InfoRequestIn] = PField(default_factory=list)


class PayeeUpdate(BaseModel):
    id: str
    cnic: Optional[str] = None
    bank_name: Optional[str] = None
    account_title: Optional[str] = None
    iban: Optional[str] = None
    method: Optional[str] = None
    note: Optional[str] = None
    verify: bool = False


class PayeesBody(BaseModel):
    payees: list[PayeeUpdate]


class DisburseBody(BaseModel):
    method: str = "Bank Transfer"
    reference_number: Optional[str] = PField(default=None, min_length=3, max_length=100)
    payee_references: Optional[dict[str, str]] = None
    note: Optional[str] = PField(default=None, max_length=1000)

    @field_validator("reference_number", mode="before")
    @classmethod
    def trim_reference(cls, value):
        return value.strip() if isinstance(value, str) else value


class ReconcileBody(BaseModel):
    note: Optional[str] = None


# ── helpers ───────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.utcnow()


def _iso(d) -> Optional[str]:
    return d.isoformat() if d else None


def _actor(user) -> str:
    return getattr(user, "email", None) or getattr(user, "username", None) or str(getattr(user, "id", "ops"))


def _touch(proc: ClaimProcess) -> None:
    proc.updated_at = _now()


def _cstatus(claim: Claim) -> ClaimStatusEnum:
    return claim.status if isinstance(claim.status, ClaimStatusEnum) else ClaimStatusEnum(claim.status)


async def _is_manager(session: AsyncSession, user) -> bool:
    return (await _role_name(user, session)) in _MANAGERS


async def _get_claim(session: AsyncSession, policy_id: UUID, claim_id: UUID) -> tuple[Claim, ClaimProcess]:
    claim = await session.get(Claim, claim_id)
    if not claim or claim.policy_id != policy_id:
        raise HTTPException(404, "Claim not found on this policy")
    proc = (await session.exec(select(ClaimProcess).where(ClaimProcess.claim_id == claim_id))).first()
    if proc is None:
        raise HTTPException(409, "This claim has no workflow record yet — open it in the claims workflow first.")
    return claim, proc


def _assert_not_decided(claim: Claim, what: str) -> None:
    if _cstatus(claim) in _DECIDED:
        raise HTTPException(409, f"{what} is locked — the claim is already {_cstatus(claim).value}.")


async def _move(session: AsyncSession, claim: Claim, to: ClaimStatusEnum, user, notes: str) -> None:
    """Move the Claim through the same state machine the register uses, with history."""
    cur = _cstatus(claim)
    if cur == to:
        return
    if to not in VALID_TRANSITIONS.get(cur, set()):
        raise HTTPException(409, f"The claim cannot move from '{cur.value}' to '{to.value}' at this point.")
    claim.status = to
    if to == ClaimStatusEnum.CLOSED:
        claim.closed_at = _now()
    session.add(claim)
    session.add(ClaimStatusHistory(
        tenant_id=claim.tenant_id, claim_id=claim.id, from_status=cur.value, to_status=to.value,
        actor_id=getattr(user, "id", None), notes=notes))


def _audit(session, policy: Policy, claim: Claim, proc: ClaimProcess, event_type: str, actor: Optional[str],
           detail: Optional[dict] = None) -> PolicyEvent:
    return record_event(session, policy, event_type=event_type, actor=actor or "ops", detail={
        "claim_no": claim.claim_number, "claim_id": str(claim.id), "category": proc.category, **(detail or {})})


async def _publish(request: Optional[Request], policy: Policy, events: list) -> None:
    for ev in events:
        await _publish_policy_event(request, policy, ev)


# ── eligibility context ───────────────────────────────────────────────────────

async def _claimant_is_nominee(session: AsyncSession, policy: Policy, claim: Claim) -> bool:
    if (claim.claimant_relationship or "Self") == "Self":
        return True
    name = (claim.claimant_name or "").strip().lower()
    cnic = eng._norm_cnic(claim.claimant_cnic)
    for b in (await session.exec(select(Beneficiary).where(Beneficiary.policy_id == policy.id))).all():
        if (cnic and eng._norm_cnic(b.cnic) == cnic) or (name and eng.name_similarity(b.name, name) >= 0.8):
            return True
        if b.is_minor and b.guardian_name and name and eng.name_similarity(b.guardian_name, name) >= 0.8:
            return True
    nominee = (policy.nominee_name or "").strip().lower()
    return bool(nominee and name and eng.name_similarity(nominee, name) >= 0.8)


async def _contract_period(session: AsyncSession, policy: Policy, event_date: date) -> Optional[dict]:
    rules = cfg.renewal_rules(policy.product_name)
    if not rules.get("contract_renewable") or not policy.effective_date:
        return None
    end = renewal_engine.current_period_end(policy.effective_date, rules, await renewal_engine.completed_period_ends(session, policy.id))
    ok = bool(end and event_date < end)
    return {"renewable": True, "ok": ok,
            "detail": (f"Inside a contract period that runs to {end.isoformat()}." if ok else
                       f"The contract period ended on {end.isoformat() if end else '—'} and was not renewed before the event.")}


async def _evaluate(session: AsyncSession, policy: Policy, claim: Claim, proc: ClaimProcess) -> dict:
    facts = await eng.policy_facts(session, policy)
    others = (await session.exec(select(ClaimProcess).where(
        ClaimProcess.policy_id == policy.id, ClaimProcess.category == proc.category,
        ClaimProcess.event_date == proc.event_date, ClaimProcess.claim_id != claim.id))).all()
    prior_death = False
    for o in (await session.exec(select(ClaimProcess).where(
            ClaimProcess.policy_id == policy.id, ClaimProcess.claim_id != claim.id,
            ClaimProcess.category.in_(["Death", "AccidentalDeath"])))).all():   # type: ignore[attr-defined]
        c = await session.get(Claim, o.claim_id)
        if c and (o.closure_outcome == "Settled" or _cstatus(c) == ClaimStatusEnum.SETTLED):
            prior_death = True
    result = eng.evaluate_eligibility_facts(
        category=proc.category, event_date=proc.event_date, reported_date=claim.reported_date, today=date.today(),
        periods=facts["periods"], policy_status=_st(policy), maturity_date=policy.maturity_date,
        insurance_type=policy.insurance_type.value if hasattr(policy.insurance_type, "value") else str(policy.insurance_type),
        coverage_amount=policy.coverage_amount, riders=facts["riders"],
        covered_relationship=proc.covered_person_relationship or "Self", cause=proc.event_cause,
        last_reinstatement_date=facts["last_reinstatement"], free_look_cancelled=facts["free_look_cancelled"],
        prior_death_settled=prior_death, duplicate_count=len(others),
        contract_period=await _contract_period(session, policy, proc.event_date),
        is_floater=(policy.insurance_type.value if hasattr(policy.insurance_type, "value") else str(policy.insurance_type)) == "FAMILY_FLOATER",
        arrears_at_event=await eng.arrears_at(session, policy.id, proc.event_date),
        product_rules=cfg.claim_rules(policy.product_name),
    )
    result["claimant_is_nominee"] = await _claimant_is_nominee(session, policy, claim)
    result["duplicate_count"] = len(others)
    return result


async def _refresh_investigation(session: AsyncSession, policy: Policy, claim: Claim, proc: ClaimProcess, elig: dict) -> None:
    flags = eng.investigation_flags(
        category=proc.category, eligibility=elig, event_date=proc.event_date, reported_date=claim.reported_date,
        cover_start=date.fromisoformat(elig["cover_start"]) if elig.get("cover_start") else None,
        duplicate_flag=bool(claim.duplicate_flag), fraud_probability=float(claim.fraud_probability or 0.0),
        nominee_mismatch=not elig.get("claimant_is_nominee", True), claimed_amount=claim.submitted_amount)
    prior = proc.investigation_json or {}
    proc.investigation_json = {**flags, "findings": prior.get("findings", []), "outcome": prior.get("outcome"),
                               "notes": prior.get("notes"), "evaluated_at": _now().isoformat()}


async def _claims_terms(session: AsyncSession, policy: Policy) -> Optional[dict]:
    """The claims terms of the plan this policy was sold under (insurance_plans.claims_terms). Exact product match
    only — another plan of the same type has its own claim rules — so None means the generic insurer list applies."""
    plan = (await session.exec(select(InsurancePlan).where(
        InsurancePlan.tenant_id == policy.tenant_id, InsurancePlan.label == policy.product_name))).first()
    return plan.claims_terms if plan else None


async def _plan_terms_view(session: AsyncSession, policy: Policy) -> dict:
    """The plan's claim terms as the claim screens and the chat show them: whether the checklist comes from the plan,
    and the exclusions, waiting periods and notification rule the claim is judged against."""
    terms = await _claims_terms(session, policy) or {}
    waiting = terms.get("waiting_periods") or []
    return {"plan": policy.product_name, "from_plan": bool(terms.get("documents")),
            "exclusions": [e["summary"] for e in terms.get("exclusions") or [] if isinstance(e, dict) and e.get("summary")],
            "waiting_periods": [w["summary"] for w in (waiting if isinstance(waiting, list) else [waiting])
                                if isinstance(w, dict) and w.get("summary")],
            "notification": (terms.get("notification") or {}).get("summary")}


async def _run_eligibility(session: AsyncSession, policy: Policy, claim: Claim, proc: ClaimProcess, user) -> dict:
    """Verify cover on the event date, set up the checklist, and triage the claim."""
    elig = await _evaluate(session, policy, claim, proc)
    now = _now()
    proc.eligibility_status, proc.eligibility_json = elig["status"], _json_safe(elig)
    proc.eligibility_verified_at, proc.eligibility_verified_by = now, _actor(user)
    if _cstatus(claim) == ClaimStatusEnum.NEW:
        await _move(session, claim, ClaimStatusEnum.TRIAGED, user, f"Eligibility verified: {elig['status']}. {elig['message']}")
    if elig["status"] != "Ineligible" or proc.eligibility_override_by:
        wanted = eng.build_checklist(category=proc.category, segment=proc.segment, cause=proc.event_cause,
                                     claimant_is_nominee=elig["claimant_is_nominee"], contestable=elig["contestable"], now=now,
                                     product_rules=cfg.claim_rules(policy.product_name),
                                     claims_terms=await _claims_terms(session, policy))
        proc.documents_json = eng.merge_documents(proc.documents_json, wanted)
        proc.checklist_generated_at = proc.checklist_generated_at or now
    await _refresh_investigation(session, policy, claim, proc, elig)
    await _sync_documents(session, claim, proc, user)
    _touch(proc)
    return elig


async def _sync_documents(session: AsyncSession, claim: Claim, proc: ClaimProcess, user) -> None:
    """Keep the claim status and the decision clock in step with the checklist."""
    if not proc.documents_json or _cstatus(claim) in _DECIDED:
        return
    prog = eng.documents_progress(proc.documents_json)
    cur = _cstatus(claim)
    if prog["complete"]:
        if proc.docs_complete_at is None:
            proc.docs_complete_at = _now()
        if cur in (ClaimStatusEnum.TRIAGED, ClaimStatusEnum.PENDING_DOCUMENTS):
            await _move(session, claim, ClaimStatusEnum.UNDER_INVESTIGATION, user, "All required documents received — investigation and assessment can begin.")
    else:
        proc.docs_complete_at = None            # the 5–7 working-day clock only runs on a complete file
        if cur in (ClaimStatusEnum.TRIAGED, ClaimStatusEnum.UNDER_INVESTIGATION):
            await _move(session, claim, ClaimStatusEnum.PENDING_DOCUMENTS, user, f"{prog['outstanding']} required document(s) outstanding.")


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


# ── views ─────────────────────────────────────────────────────────────────────

async def _timeline(session: AsyncSession, policy_id: UUID, claim: Claim) -> list[dict]:
    rows = (await session.exec(select(PolicyEvent).where(PolicyEvent.policy_id == policy_id)
                               .order_by(PolicyEvent.created_at.desc()))).all()  # type: ignore[arg-type]
    out = []
    for e in rows:
        d = e.detail_json or {}
        if d.get("claim_no") != claim.claim_number:
            continue
        out.append({"id": str(e.id), "event_type": e.event_type, "actor": e.actor, "from_status": e.from_status,
                    "to_status": e.to_status, "at": e.created_at.isoformat(),
                    "detail": {k: v for k, v in d.items() if k not in ("claim_no", "claim_id", "category")}})
    return out


async def _payouts(session: AsyncSession, claim: Claim) -> list[dict]:
    rows = (await session.exec(select(ClaimPayout).where(ClaimPayout.claim_id == claim.id)
                               .order_by(ClaimPayout.created_at))).all()  # type: ignore[arg-type]
    return [{"id": str(p.id), "amount": p.amount, "method": p.method, "status": p.status, "reference_number": p.reference_number,
             "payee_name": p.payee_name, "payee_relationship": p.payee_relationship, "share_pct": p.share_pct,
             "completed_at": _iso(p.completed_at)} for p in rows]


def _doc_view(d: dict) -> dict:
    return {k: v for k, v in d.items()}


async def _underwriting(session: AsyncSession, claim: Claim, proc: ClaimProcess) -> dict:
    """Whether the Underwriting department must review this claim before Claims decides it, and where that stands.

    A claim within the contestability period (a death soon after issue or reinstatement) is the classic case: the
    proposal answers must be checked against the medical history before anything is paid. The review runs on a Claim
    UW case (Medical + Financial underwriters, see routers/claims.py re-underwrite → resolve-underwriting); Claims may
    approve only once Underwriting has cleared it. A non-disclosure finding declines the claim from that side.
    state: not_required | not_referred | in_review | cleared | declined"""
    inv_flags = {f.get("code") for f in ((proc.investigation_json or {}).get("flags") or []) if isinstance(f, dict)}
    required = bool((proc.eligibility_json or {}).get("contestable")) or "contestable" in inv_flags
    cases = (await session.exec(select(Case).where(Case.claim_id == claim.id, Case.caseType == CaseTypeEnum.UNDERWRITING)
                                .order_by(Case.createdAt.desc()))).all()  # type: ignore[arg-type]
    latest = cases[0] if cases else None
    if _cstatus(claim) == ClaimStatusEnum.REUNDERWRITING_REQUIRED or (
            latest and latest.caseStatus not in (CaseStatusEnum.APPROVED, CaseStatusEnum.REJECTED, CaseStatusEnum.CLOSED)):
        state, message = "in_review", "Underwriting is reviewing this claim — the decision waits for their outcome."
    elif latest and latest.caseStatus == CaseStatusEnum.REJECTED:
        state, message = "declined", "Underwriting found non-disclosure."
    elif latest:
        state, message = "cleared", "Underwriting has cleared this claim."
    elif required:
        state, message = "not_referred", ("This claim is within the contestability period — refer it to Underwriting to check "
                                          "the proposal against the medical history before deciding.")
    else:
        state, message = "not_required", ""
    return {"required": required, "state": state, "message": message, "case_number": latest.caseNumber if latest else None,
            "referral_reason": claim.underwriting_referral_reason, "notes": claim.underwriting_decision_notes}


async def _assert_underwriting_cleared(session: AsyncSession, claim: Claim, proc: ClaimProcess) -> None:
    """No money moves on a claim Underwriting still has to clear (one approved before this rule, or under review)."""
    uw = await _underwriting(session, claim, proc)
    if uw["state"] in ("not_referred", "in_review"):
        raise HTTPException(409, uw["message"] if uw["state"] == "in_review" else
                            "This claim is within the contestability period and Underwriting has not cleared it — "
                            "refer it to Underwriting before paying.")


def _underwriting_blocks(uw: dict, decision: str) -> Optional[str]:
    """Why Underwriting's involvement stops this decision, or None."""
    if uw["state"] == "in_review" and decision in ("Approve", "PartialApprove", "Reject"):
        return uw["message"]
    if uw["state"] == "not_referred" and decision in ("Approve", "PartialApprove"):
        return uw["message"]
    return None


async def _workspace(session: AsyncSession, policy: Policy, claim: Claim, proc: ClaimProcess) -> dict:
    payouts = await _payouts(session, claim)
    paid = round(sum(p["amount"] for p in payouts), 2)
    stages = eng.project_stages(proc, claim, payout_total=paid)
    st = _cstatus(claim)
    prog = eng.documents_progress(proc.documents_json)
    sla = eng.sla_state(docs_complete_at=proc.docs_complete_at, decision_at=proc.decision_at, today=date.today())
    inv = proc.investigation_json or {}
    ineligible = proc.eligibility_status == "Ineligible" and not proc.eligibility_override_by
    investigated = (not inv.get("requires_investigation")) or bool(proc.investigation_completed_at)
    can_assess = st == ClaimStatusEnum.UNDER_INVESTIGATION and prog["complete"] and investigated and not ineligible
    uw = await _underwriting(session, claim, proc)
    # While Underwriting reviews the claim nothing is decided; an un-referred contestable claim may still be
    # rejected, referred to a manager or sent back for information — just not approved (see decide_claim).
    can_decide = (bool(proc.assessed_at) and prog["complete"] and investigated and not ineligible and uw["state"] != "in_review" and
                  st in (ClaimStatusEnum.UNDER_INVESTIGATION, ClaimStatusEnum.REFERRED_TO_MANAGER))
    if uw["state"] in ("not_referred", "in_review") and st not in _DECIDED:
        stages = [({**s, "state": "action", "label": "Awaiting underwriting" if uw["state"] == "in_review" else "Refer to underwriting",
                    "detail": uw["message"]} if s.get("key") == "decision" else s) for s in stages]
    approved = st in (ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL)
    uw_clear = uw["state"] not in ("not_referred", "in_review")
    if approved and not uw_clear and not proc.disbursed_at:
        stages = [({**s, "state": "action", "label": "Awaiting underwriting" if uw["state"] == "in_review" else "Refer to underwriting",
                    "detail": uw["message"]} if s.get("key") == "settlement" else s) for s in stages]
    payees = proc.payees_json or []
    return {
        "claim": {
            "id": str(claim.id), "claim_number": claim.claim_number, "claim_type": claim.claim_type, "status": st.value,
            "claimed_amount": claim.submitted_amount, "approved_amount": claim.approved_amount,
            "settlement_amount": claim.settlement_amount, "reported_date": _iso(claim.reported_date),
            "claimant": {"name": claim.claimant_name, "cnic": claim.claimant_cnic, "relationship": claim.claimant_relationship,
                         "phone": claim.claimant_phone, "email": proc.claimant_email},
            "fraud_probability": claim.fraud_probability, "duplicate_flag": claim.duplicate_flag,
            "created_at": claim.created_at.isoformat(), "closed_at": _iso(claim.closed_at),
        },
        "process": {
            "category": proc.category, "category_label": cfg.CLAIM_CATEGORIES[proc.category]["label"], "segment": proc.segment,
            "channel": proc.channel, "intimated_by": proc.intimated_by,
            "covered_person": {"name": proc.covered_person_name, "cnic": proc.covered_person_cnic,
                               "relationship": proc.covered_person_relationship},
            "event": {"date": proc.event_date.isoformat(), "end_date": _iso(proc.event_end_date), "place": proc.event_place,
                      "cause": proc.event_cause, "description": proc.event_description, "details": proc.event_json or {}},
        },
        "eligibility": {"status": proc.eligibility_status, "result": proc.eligibility_json,
                        "verified_at": _iso(proc.eligibility_verified_at), "verified_by": proc.eligibility_verified_by,
                        "override_by": proc.eligibility_override_by, "override_note": proc.eligibility_override_note},
        "documents": {"items": [_doc_view(d) for d in (proc.documents_json or [])], "progress": prog,
                      "generated_at": _iso(proc.checklist_generated_at), "complete_at": _iso(proc.docs_complete_at)},
        "investigation": {**inv, "completed_at": _iso(proc.investigation_completed_at)},
        "assessment": {"result": proc.assessment_json, "assessed_at": _iso(proc.assessed_at), "assessed_by": proc.assessed_by},
        "decision": {"decision": proc.decision, "amount": proc.decision_amount, "reason": proc.decision_reason,
                     "by": proc.decision_by, "at": _iso(proc.decision_at), "history": proc.decision_history_json or [],
                     "requires_manager": claim.submitted_amount > cfg.CLAIM_MANAGER_LIMIT or st == ClaimStatusEnum.REFERRED_TO_MANAGER,
                     "manager_limit": cfg.CLAIM_MANAGER_LIMIT},
        "sla": {**sla, "due_date": _iso(sla["due_date"])},
        "settlement": {
            "payees": payees, "payees_verified_at": _iso(proc.payees_verified_at),
            "authorized_by": proc.authorized_by, "authorized_at": _iso(proc.authorized_at), "authorized_amount": proc.authorized_amount,
            "disbursed_at": _iso(proc.disbursed_at), "payouts": payouts, "paid_total": paid,
            "reconciliation": proc.reconciliation_json, "reconciled_at": _iso(proc.reconciled_at), "reconciled_by": proc.reconciled_by,
            "methods": cfg.CLAIM_PAYOUT_METHODS,
        },
        "closure": {"outcome": proc.closure_outcome, "closed_by": proc.closed_by, "closed_at": _iso(proc.closed_at),
                    "coverage_update": proc.coverage_update_json,
                    "confirmation": {"generated_at": _iso(proc.confirmation_generated_at), "sent_at": _iso(proc.confirmation_sent_at),
                                     "sent_to": proc.confirmation_sent_to}},
        "stages": stages,
        "underwriting": uw,
        "plan_terms": await _plan_terms_view(session, policy),
        "can": {
            "verify": st not in _DECIDED, "assess": can_assess, "decide": can_decide,
            "approve": can_decide and uw["state"] not in ("not_referred", "in_review"),
            # Also an approved claim not yet paid: one approved before Underwriting cleared it goes back through them.
            "refer_underwriting": proc.eligibility_status is not None and uw["state"] in ("not_referred", "not_required") and (
                st not in _DECIDED or (approved and not proc.disbursed_at)),
            "investigate": st == ClaimStatusEnum.UNDER_INVESTIGATION or st == ClaimStatusEnum.PENDING_DOCUMENTS,
            "edit_documents": st not in _DECIDED and proc.eligibility_status is not None,
            "verify_payees": approved and uw_clear and not proc.authorized_at,
            "authorize": approved and uw_clear and bool(proc.payees_verified_at) and not proc.authorized_at,
            "disburse": approved and uw_clear and bool(proc.authorized_at) and not proc.disbursed_at,
            "reconcile": st == ClaimStatusEnum.SETTLED and not proc.reconciled_at,
            "close": (st == ClaimStatusEnum.SETTLED and bool(proc.reconciled_at)) or st == ClaimStatusEnum.DECLINED,
        },
        "timeline": await _timeline(session, policy.id, claim),
    }


async def _claim_row(session: AsyncSession, claim: Claim, proc: Optional[ClaimProcess]) -> dict:
    row = {"id": str(claim.id), "claim_number": claim.claim_number, "claim_type": claim.claim_type,
           "status": _cstatus(claim).value, "claimed_amount": claim.submitted_amount, "approved_amount": claim.approved_amount,
           "reported_date": _iso(claim.reported_date), "event_date": _iso(claim.incident_date),
           "has_workflow": proc is not None, "category": proc.category if proc else None, "stage": None, "progress": None,
           "sla_state": None, "sla_due": None}
    if proc:
        paid = (await session.exec(select(ClaimPayout).where(ClaimPayout.claim_id == claim.id))).all()
        stages = eng.project_stages(proc, claim, payout_total=sum(p.amount for p in paid))
        uw = await _underwriting(session, claim, proc)
        if uw["state"] in ("not_referred", "in_review") and _cstatus(claim) not in _DECIDED:
            stages = [({**s, "state": "action", "label": "Awaiting underwriting" if uw["state"] == "in_review" else "Refer to underwriting"}
                       if s.get("key") == "decision" else s) for s in stages]
        done = sum(1 for s in stages if s["state"] in ("complete", "skipped"))
        cur = next((s for s in stages if s["state"] not in ("complete", "skipped")), None)
        sla = eng.sla_state(docs_complete_at=proc.docs_complete_at, decision_at=proc.decision_at, today=date.today())
        row.update({"event_date": proc.event_date.isoformat(), "stage": (cur["title"] + " — " + cur["label"]) if cur else "Closed",
                    "progress": {"done": done, "total": len(stages)}, "sla_state": sla["state"], "sla_due": _iso(sla["due_date"])})
    return row


async def _overview(session: AsyncSession, policy: Policy) -> dict:
    facts = await eng.policy_facts(session, policy)
    customer = await session.get(Customer, policy.customer_id)
    claims = (await session.exec(select(Claim).where(Claim.policy_id == policy.id)
                                 .order_by(Claim.created_at.desc()))).all()  # type: ignore[arg-type]
    procs = {p.claim_id: p for p in (await session.exec(select(ClaimProcess).where(ClaimProcess.policy_id == policy.id))).all()}
    today = date.today()
    now_period = eng.covered_on(facts["periods"], today)
    return {
        "policy": {"id": str(policy.id), "policy_number": policy.policy_number, "status": _st(policy),
                   "product_name": policy.product_name, "insurance_type": policy.insurance_type.value if hasattr(policy.insurance_type, "value") else str(policy.insurance_type),
                   "sum_assured": policy.coverage_amount, "segment": facts["segment"],
                   "customer_name": customer.name if customer else None, "customer_cnic": customer.cnic if customer else None,
                   "effective_date": _iso(policy.effective_date), "maturity_date": _iso(policy.maturity_date),
                   "nominee_name": policy.nominee_name, "nominee_relationship": policy.nominee_relationship},
        "coverage": {"periods": eng.serialise_periods(facts["periods"]), "in_force_today": bool(now_period),
                     "note": ("Claims for events that happened while cover was in force remain valid even though the policy is not in force today."
                              if not now_period and facts["periods"] else None)},
        "benefits": eng.benefit_menu(policy, facts["riders"], today),
        "claims": [await _claim_row(session, c, procs.get(c.id)) for c in claims],
        "options": {
            "categories": [{"key": k, "label": v["label"], "applies": v["applies"]} for k, v in cfg.CLAIM_CATEGORIES.items()],
            "causes": cfg.CLAIM_CAUSES, "channels": cfg.CLAIM_CHANNELS, "claimant_relationships": cfg.CLAIM_CLAIMANT_RELATIONSHIPS,
            "covered_relationships": cfg.CLAIM_COVERED_RELATIONSHIPS, "payout_methods": cfg.CLAIM_PAYOUT_METHODS,
        },
        "rules": {"sla_working_days": cfg.CLAIM_DECISION_SLA_WORKING_DAYS, "manager_limit": cfg.CLAIM_MANAGER_LIMIT,
                  "contestable_days": cfg.CLAIM_CONTESTABLE_DAYS,
                  "product": {k: v for k, v in cfg.claim_rules(policy.product_name).items() if k != "extra_documents"}},
    }


# ══════════════════════════════════════════════════════════════════════════════
# Overview + step 1 — intimation
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/tenants/{tenant_id}/policies/{policy_id}/claims-management")
async def claims_overview(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    """The policy's claims, the cover periods they will be tested against, the benefits
    each claim type would pay, and the options for registering a new one."""
    policy = await _get_policy(session, tenant_id, policy_id)
    return await _overview(session, policy)


@router.get("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}")
async def claim_workspace(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    return await _workspace(session, policy, claim, proc)


def _validate_register(body: RegisterBody) -> None:
    if body.event_date > date.today():
        raise HTTPException(400, "The event date cannot be in the future.")
    if body.event_end_date and body.event_end_date < body.event_date:
        raise HTTPException(400, "The end date cannot be before the event date.")
    if body.claimant_relationship not in cfg.CLAIM_CLAIMANT_RELATIONSHIPS:
        raise HTTPException(400, f"Unknown claimant relationship '{body.claimant_relationship}'")
    if body.covered_person_relationship not in cfg.CLAIM_COVERED_RELATIONSHIPS:
        raise HTTPException(400, f"Unknown covered-person relationship '{body.covered_person_relationship}'")
    if body.channel not in cfg.CLAIM_CHANNELS:
        raise HTTPException(400, f"Unknown channel '{body.channel}'")
    if body.cause is not None and body.cause not in cfg.CLAIM_CAUSES:
        raise HTTPException(400, f"Unknown cause '{body.cause}'")
    if body.category in ("Death", "AccidentalDeath") and not body.cause:
        raise HTTPException(400, "State the cause of death — it decides which documents are needed.")
    if not body.claimant_name.strip():
        raise HTTPException(400, "The claimant's name is required.")


# ── idempotent claim steps ──────────────────────────────────────────────────────────────────────────────────────────────────────
# The response of every claim step is the claim workspace (claimant, medical and bank details included). The receipt keeps only the claim id;
# an authorized replay rebuilds the workspace from the claim itself, so the body is current and no personal data is copied into the receipt.

async def _replay_workspace(values, receipt):
    policy = await _get_policy(values["session"], values["tenant_id"], values["policy_id"])
    claim, proc = await _get_claim(values["session"], values["policy_id"], UUID(receipt["claim_id"]))
    return await _workspace(values["session"], policy, claim, proc)


def _claim_step(operation, *, created=False, status_code=200):
    """Atomic idempotency for a claim step (database-only). `created=True` for the call that registers the claim."""
    if created:
        view = lambda values, payload: {"claim_id": payload["claim"]["id"]}
    else:
        view = lambda values: {"claim_id": str(values["claim_id"])}
    return database_operation(operation, response_fields=None, status_code=status_code, resource_type="claim", receipt_fields=("claim_id",),
                              view_receipt=view, replay_response=_replay_workspace)



@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management", status_code=201)
@_claim_step("tenant.claim.register", created=True, status_code=201)
async def register_claim(
    tenant_id: UUID, policy_id: UUID,
    body: RegisterBody,
    request: Request,
    user=Depends(require_roles(*_CLAIMS_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Step 1 — register the claimant, policy, covered person and event, then run the
    eligibility check on the event date. A claim is ALWAYS registered, even for a policy
    that is lapsed or cancelled today: whether it is payable is decided in step 2, not at
    the counter."""
    policy = await _get_policy(session, tenant_id, policy_id)
    _validate_register(body)

    claimant_type = {"Self": "SELF", "Legal heir": "LEGAL_HEIR", "Representative": "GUARDIAN"}.get(body.claimant_relationship, "NOMINEE_BENEFICIARY")
    claim, policy, customer = await open_claim(session, tenant_id, user, ClaimCreate(
        policy_id=policy_id, claim_type=cfg.CLAIM_CATEGORIES[body.category]["claim_type"], submitted_amount=body.claimed_amount,
        incident_date=body.event_date, notes=body.notes or f"Intimated via {body.channel}.", claimant_type=claimant_type,
        claimant_name=body.claimant_name.strip(), claimant_cnic=body.claimant_cnic,
        claimant_relationship=body.claimant_relationship, claimant_phone=body.claimant_phone),
        covered_person_relationship=body.covered_person_relationship,
        covered_person_name=body.covered_person_name, covered_person_cnic=body.covered_person_cnic,
        commit=False)

    segment = eng._segment(policy)
    covered_name = (body.covered_person_name or "").strip() or (customer.name if customer and body.covered_person_relationship == "Self" else None)
    proc = ClaimProcess(
        tenant_id=tenant_id, policy_id=policy_id, claim_id=claim.id, category=body.category, segment=segment,
        channel=body.channel, intimated_by=body.claimant_name.strip(), claimant_email=body.claimant_email,
        covered_person_name=covered_name, covered_person_cnic=body.covered_person_cnic or (customer.cnic if customer and body.covered_person_relationship == "Self" else None),
        covered_person_relationship=body.covered_person_relationship, event_date=body.event_date,
        event_end_date=body.event_end_date, event_place=body.event_place, event_cause=body.cause,
        event_description=body.event_description, event_json=_json_safe(body.event_details or None))
    session.add(proc)
    await session.flush()

    events = [_audit(session, policy, claim, proc, "ClaimRegistered", _actor(user), {
        "event_date": body.event_date.isoformat(), "claimed_amount": body.claimed_amount, "claimant": body.claimant_name,
        "relationship": body.claimant_relationship, "channel": body.channel})]
    elig = await _run_eligibility(session, policy, claim, proc, user)
    # open_claim's intake heuristic calls any claim with the same type and amount as an earlier
    # one on the policy a duplicate (85% fraud score) — even if the earlier one was rejected, or
    # the event was on a different date. In this workflow a duplicate means another claim of the
    # same type for the same event date, so the flag is recomputed from that.
    if bool(claim.duplicate_flag) != bool(elig["duplicate_count"]):
        claim.duplicate_flag = bool(elig["duplicate_count"])
        if not claim.duplicate_flag and claim.ai_recommendation == "DUPLICATE_FLAGGED":
            claim.fraud_probability = 0.02
            claim.ai_recommendation = "AUTO_APPROVE" if claim.submitted_amount <= 200000 else "REFER_TO_ADJUSTER"
        elif claim.duplicate_flag:
            claim.fraud_probability = max(claim.fraud_probability or 0.0, 0.85)
        session.add(claim)
        await _refresh_investigation(session, policy, claim, proc, elig)
    events.append(_audit(session, policy, claim, proc, "ClaimEligibilityVerified", "system", {
        "status": elig["status"], "message": elig["message"], "failed": [c["key"] for c in elig["checks"] if not c["passed"] and c["severity"] != "info"]}))
    await session.commit()
    await _publish(request, policy, events)
    log.info("Claim %s registered on policy %s (%s, %s)", claim.claim_number, policy.policy_number, body.category, elig["status"])
    return await _workspace(session, policy, claim, proc)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/adopt")
@_claim_step("tenant.claim.adopt")
async def adopt_claim(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    body: AdoptBody,
    request: Request,
    user=Depends(require_roles(*_CLAIMS_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Bring a claim that was registered elsewhere (the claims register) into this
    workflow. The claim itself is untouched; its event date is its incident date."""
    policy = await _get_policy(session, tenant_id, policy_id)
    claim = await session.get(Claim, claim_id)
    if not claim or claim.policy_id != policy_id:
        raise HTTPException(404, "Claim not found on this policy")
    if (await session.exec(select(ClaimProcess).where(ClaimProcess.claim_id == claim_id))).first():
        raise HTTPException(409, "This claim is already in the workflow.")
    if body.cause is not None and body.cause not in cfg.CLAIM_CAUSES:
        raise HTTPException(400, f"Unknown cause '{body.cause}'")
    customer = await session.get(Customer, policy.customer_id)
    proc = ClaimProcess(
        tenant_id=tenant_id, policy_id=policy_id, claim_id=claim.id, category=body.category, segment=eng._segment(policy),
        channel="Branch", intimated_by=claim.claimant_name, covered_person_name=customer.name if customer else None,
        covered_person_cnic=customer.cnic if customer else None, covered_person_relationship=body.covered_person_relationship,
        event_date=claim.incident_date or claim.reported_date, event_cause=body.cause)
    session.add(proc)
    await session.flush()
    events = [_audit(session, policy, claim, proc, "ClaimAdopted", _actor(user), {"event_date": proc.event_date.isoformat()})]
    await _run_eligibility(session, policy, claim, proc, user)
    await session.commit()
    await _publish(request, policy, events)
    return await _workspace(session, policy, claim, proc)


# ══════════════════════════════════════════════════════════════════════════════
# Step 2 — eligibility
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/eligibility/verify")
@_claim_step("tenant.claim.reverify_eligibility")
async def reverify_eligibility(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    request: Request,
    user=Depends(require_roles(*_CLAIMS_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Re-run the check (e.g. after a rider endorsement was corrected)."""
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    _assert_not_decided(claim, "Eligibility")
    elig = await _run_eligibility(session, policy, claim, proc, user)
    ev = _audit(session, policy, claim, proc, "ClaimEligibilityVerified", _actor(user), {"status": elig["status"], "rerun": True})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _workspace(session, policy, claim, proc)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/eligibility/override")
@_claim_step("tenant.claim.override_eligibility")
async def override_eligibility(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    body: NoteBody,
    request: Request,
    user=Depends(require_roles(*_MANAGERS)),
    session: AsyncSession = Depends(get_session),
):
    """A claims manager may let an ineligible claim proceed (an ex-gratia or contested-
    cover decision). The reason is mandatory and permanent."""
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    _assert_not_decided(claim, "Eligibility")
    if proc.eligibility_status != "Ineligible":
        raise HTTPException(409, "Only an ineligible claim needs an override.")
    if len(body.note.strip()) < 15:
        raise HTTPException(400, "Explain the override (at least 15 characters).")
    proc.eligibility_override_by, proc.eligibility_override_note = _actor(user), body.note.strip()
    wanted = eng.build_checklist(category=proc.category, segment=proc.segment, cause=proc.event_cause,
                                 claimant_is_nominee=(proc.eligibility_json or {}).get("claimant_is_nominee", True),
                                 contestable=bool((proc.eligibility_json or {}).get("contestable")),
                                 product_rules=cfg.claim_rules(policy.product_name),
                                 claims_terms=await _claims_terms(session, policy))
    proc.documents_json = eng.merge_documents(proc.documents_json, wanted)
    proc.checklist_generated_at = proc.checklist_generated_at or _now()
    await _sync_documents(session, claim, proc, user)
    _touch(proc)
    ev = _audit(session, policy, claim, proc, "ClaimEligibilityOverridden", _actor(user), {"note": proc.eligibility_override_note})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _workspace(session, policy, claim, proc)


# ══════════════════════════════════════════════════════════════════════════════
# Step 3 — documents
# ══════════════════════════════════════════════════════════════════════════════

def _find_doc(proc: ClaimProcess, key: str) -> dict:
    for d in (proc.documents_json or []):
        if d["key"] == key:
            return d
    raise HTTPException(404, "Checklist item not found")


def _update_doc(proc: ClaimProcess, key: str, **changes) -> None:
    proc.documents_json = [({**d, **changes} if d["key"] == key else d) for d in (proc.documents_json or [])]


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/documents/{key}")
@_claim_step("tenant.claim.receive_document")
async def receive_document(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID, key: str,
    request: Request,
    note: Optional[str] = Form(None),
    file: UploadFile = File(...),
    user=Depends(require_roles(*_CLAIMS_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Receive a checklist document. The file is stored as a claim Artifact — the same
    store the claims register reads — so the existing document gates see it too."""
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    _assert_not_decided(claim, "The document checklist")
    item = _find_doc(proc, key)
    if proc.eligibility_status is None or (proc.eligibility_status == "Ineligible" and not proc.eligibility_override_by):
        raise HTTPException(409, "Documents are collected once the claim is eligible.")

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
    storage_key = f"{tenant_id}/claims/{claim.id}/{artifact_id}/{safe}"
    storage_url = _upload_to_s3(data, storage_key, _ALLOWED_EXT[ext])
    session.add(Artifact(
        id=artifact_id, tenant_id=tenant_id, customer_id=policy.customer_id, claim_id=claim.id, case_id=claim.case_id,
        uploaded_by=getattr(user, "id", None), document_type=item["label"], file_name=safe, file_size=len(data),
        file_type=_ALLOWED_EXT[ext], storage_url=storage_url, status="Uploaded"))
    _update_doc(proc, key, status="Received", received_at=_now().isoformat(), artifact_id=str(artifact_id), file_name=safe,
                note=(note or "").strip() or None)
    was_complete = proc.docs_complete_at is not None
    await _sync_documents(session, claim, proc, user)
    _touch(proc)
    events = [_audit(session, policy, claim, proc, "ClaimDocumentReceived", _actor(user), {"document": item["label"], "file": safe})]
    if proc.docs_complete_at is not None and not was_complete:
        events.append(_audit(session, policy, claim, proc, "ClaimDocumentsComplete", "system", {
            "decision_due": _iso(eng.sla_state(docs_complete_at=proc.docs_complete_at, decision_at=None, today=date.today())["due_date"])}))
    await session.commit()
    await _publish(request, policy, events)
    return await _workspace(session, policy, claim, proc)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/documents/{key}/waive")
@_claim_step("tenant.claim.waive_document")
async def waive_document(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID, key: str,
    body: DocWaiveBody,
    request: Request,
    user=Depends(require_roles(*_MANAGERS)),
    session: AsyncSession = Depends(get_session),
):
    """A claims manager may waive a document that cannot be produced (e.g. no FIR for a
    natural death). No reason is needed; one given is recorded."""
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    _assert_not_decided(claim, "The document checklist")
    item = _find_doc(proc, key)
    reason = (body.reason or "").strip() or None
    _update_doc(proc, key, status="Waived", note=reason, received_at=_now().isoformat())
    await _sync_documents(session, claim, proc, user)
    _touch(proc)
    ev = _audit(session, policy, claim, proc, "ClaimDocumentWaived", _actor(user), {"document": item["label"], "reason": reason})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _workspace(session, policy, claim, proc)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/documents/{key}/reject")
@_claim_step("tenant.claim.return_document")
async def reject_document(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID, key: str,
    body: DocReasonBody,
    request: Request,
    user=Depends(require_roles(*_CLAIMS_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Reject a received document (illegible, wrong person…) and ask for it again. This
    stops the decision clock until the set is complete once more."""
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    _assert_not_decided(claim, "The document checklist")
    item = _find_doc(proc, key)
    if not body.reason.strip():
        raise HTTPException(400, "Say why the document is being sent back.")
    _update_doc(proc, key, status="Requested", note=f"Returned: {body.reason.strip()}", received_at=None)
    await _sync_documents(session, claim, proc, user)
    _touch(proc)
    ev = _audit(session, policy, claim, proc, "ClaimDocumentReturned", _actor(user), {"document": item["label"], "reason": body.reason.strip()})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _workspace(session, policy, claim, proc)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/documents")
@_claim_step("tenant.claim.request_documents")
async def request_more_documents(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    body: DocRequestBody,
    request: Request,
    user=Depends(require_roles(*_CLAIMS_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Ask the claimant for an extra document. A required one stops the decision clock."""
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    _assert_not_decided(claim, "The document checklist")
    if not body.label.strip():
        raise HTTPException(400, "Name the document.")
    n = sum(1 for d in (proc.documents_json or []) if d["key"].startswith("extra-")) + 1
    proc.documents_json = eng.merge_documents(proc.documents_json, [{
        "key": f"extra-{n}", "label": body.label.strip(), "required": body.required, "when": "always", "reason": body.reason or "Requested by the claims officer",
        "status": "Requested", "requested_at": _now().isoformat(), "received_at": None, "artifact_id": None, "file_name": None, "note": None}])
    await _sync_documents(session, claim, proc, user)
    _touch(proc)
    ev = _audit(session, policy, claim, proc, "ClaimDocumentRequested", _actor(user), {"document": body.label.strip(), "required": body.required})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _workspace(session, policy, claim, proc)


@router.get("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/documents/{key}/download")
async def download_claim_document(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID, key: str,
    session: AsyncSession = Depends(get_session),
):
    await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    item = _find_doc(proc, key)
    if not item.get("artifact_id"):
        raise HTTPException(404, "No file is attached to this item")
    art = await session.get(Artifact, UUID(item["artifact_id"]))
    if not art or art.tenant_id != tenant_id:
        raise HTTPException(404, "File not found")
    if art.storage_url and art.storage_url.startswith("local://"):
        path = os.path.join("/app/shared/storage", art.storage_url.replace("local://", ""))
        if os.path.isfile(path):
            return FileResponse(path, media_type=art.file_type or "application/octet-stream", filename=art.file_name)
        raise HTTPException(404, "The stored file is missing")
    presigned = _presign_url(art.storage_url.split(".amazonaws.com/", 1)[-1]) if art.storage_url else ""
    if presigned:
        return RedirectResponse(presigned, status_code=307)
    raise HTTPException(404, "The stored file is unavailable")


async def _render_checklist(session: AsyncSession, policy: Policy, claim: Claim, proc: ClaimProcess) -> str:
    tenant = await session.get(Tenant, policy.tenant_id)
    doc = document_generator.generate_claim_checklist({
        "policy_id": policy.id, "tenant_name": tenant.name if tenant else "Insurer", "claim_number": claim.claim_number,
        "policy_number": policy.policy_number, "claimant_name": claim.claimant_name, "event_date": proc.event_date.isoformat(),
        "claim_label": cfg.CLAIM_CATEGORIES[proc.category]["label"], "sla_days": cfg.CLAIM_DECISION_SLA_WORKING_DAYS,
        "documents": proc.documents_json or []})
    return doc["file_path"]


@router.get("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/checklist/download")
async def download_checklist(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    """The claimant's checklist (PDF) — always rendered fresh so it shows what has arrived."""
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    if not proc.documents_json:
        raise HTTPException(409, "There is no checklist yet — the claim has not passed eligibility.")
    path = await _render_checklist(session, policy, claim, proc)
    return FileResponse(path, media_type="application/pdf", filename=f"claim_checklist_{claim.claim_number}.pdf")


# ══════════════════════════════════════════════════════════════════════════════
# Step 4 — investigation + assessment
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/investigation/finding")
@_claim_step("tenant.claim.add_finding")
async def add_finding(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    body: FindingBody,
    request: Request,
    user=Depends(require_roles(*_CLAIMS_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    _assert_not_decided(claim, "The investigation")
    if not body.note.strip():
        raise HTTPException(400, "Record what was found.")
    inv = dict(proc.investigation_json or {})
    inv["findings"] = [*inv.get("findings", []), {"kind": body.kind, "source": body.source, "note": body.note.strip(),
                                                  "by": _actor(user), "at": _now().isoformat()}]
    proc.investigation_json = inv
    _touch(proc)
    ev = _audit(session, policy, claim, proc, "ClaimInvestigationFinding", _actor(user), {"kind": body.kind, "source": body.source})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _workspace(session, policy, claim, proc)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/investigation/complete")
@_claim_step("tenant.claim.complete_investigation")
async def complete_investigation(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    body: InvestigationCloseBody,
    request: Request,
    user=Depends(require_roles(*_CLAIMS_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    _assert_not_decided(claim, "The investigation")
    inv = dict(proc.investigation_json or {})
    if body.outcome != "Verified" and not (body.notes or "").strip():
        raise HTTPException(400, "Explain an adverse or inconclusive outcome.")
    if inv.get("requires_investigation") and not inv.get("findings"):
        raise HTTPException(409, "Record at least one finding before completing a required investigation.")
    inv.update(outcome=body.outcome, notes=(body.notes or "").strip() or None, completed_by=_actor(user))
    proc.investigation_json = inv
    proc.investigation_completed_at = _now()
    _touch(proc)
    ev = _audit(session, policy, claim, proc, "ClaimInvestigationCompleted", _actor(user), {"outcome": body.outcome})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _workspace(session, policy, claim, proc)


def _policy_year_start(effective: Optional[date], on: date) -> date:
    if not effective:
        return date(on.year, 1, 1)
    start = effective
    while renewal_engine.add_years(start, 1) <= on:
        start = renewal_engine.add_years(start, 1)
    return start


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/assessment")
@_claim_step("tenant.claim.assess")
async def assess_claim(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    body: AssessBody,
    request: Request,
    user=Depends(require_roles(*_CLAIMS_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Calculate the contractual benefit for this claim (not the amount claimed): sum
    assured less premium unpaid at the event date, a disability percentage of the rider,
    or admissible hospital expenses within the remaining annual limit."""
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    _assert_not_decided(claim, "The assessment")
    if _cstatus(claim) != ClaimStatusEnum.UNDER_INVESTIGATION:
        raise HTTPException(409, f"Assessment starts once all required documents are in (claim is '{_cstatus(claim).value}').")
    if proc.eligibility_status == "Ineligible" and not proc.eligibility_override_by:
        raise HTTPException(409, "The claim is not eligible — reject it, or ask a manager to override.")
    inv = proc.investigation_json or {}
    if inv.get("requires_investigation") and not proc.investigation_completed_at:
        raise HTTPException(409, "Red flags were raised — complete the investigation before assessing.")

    facts = await eng.policy_facts(session, policy)
    benefit = eng.find_benefit(category=proc.category, insurance_type=policy.insurance_type.value if hasattr(policy.insurance_type, "value") else str(policy.insurance_type),
                               coverage_amount=policy.coverage_amount, riders=facts["riders"], event_date=proc.event_date)
    remaining = None
    if proc.category == "Hospitalization":
        used = await eng.paid_hospital_benefits(session, policy, _policy_year_start(policy.effective_date, proc.event_date))
        remaining = max(policy.coverage_amount - used, 0.0)
    try:
        result = eng.assess_benefit(
            category=proc.category, claimed_amount=claim.submitted_amount, benefit=benefit,
            arrears_at_event=await eng.arrears_at(session, policy.id, proc.event_date) if proc.category in ("Death", "AccidentalDeath") else 0.0,
            disability_pct=body.disability_pct, deductions=[d.model_dump() for d in body.deductions],
            copay_pct=body.copay_pct, remaining_limit=remaining)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    result["notes"] = (body.notes or "").strip() or None
    result["rider_id"] = benefit.get("rider_id")
    proc.assessment_json, proc.assessed_at, proc.assessed_by = _json_safe(result), _now(), _actor(user)
    _touch(proc)
    ev = _audit(session, policy, claim, proc, "ClaimAssessed", _actor(user), {"payable": result["payable"], "claimed": claim.submitted_amount, "basis": result["basis"]})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _workspace(session, policy, claim, proc)


# ══════════════════════════════════════════════════════════════════════════════
# Step 5 — decision
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/decision")
@_claim_step("tenant.claim.decide")
async def decide_claim(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    body: DecisionBody,
    request: Request,
    user=Depends(require_roles(*_DECIDERS)),
    session: AsyncSession = Depends(get_session),
):
    """Step 5 — the claims officer approves, partially approves, rejects, asks for more
    information, or refers to a manager. Anything above the manager limit (or already
    referred) needs a claims manager."""
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    cur = _cstatus(claim)
    if cur in _DECIDED:
        raise HTTPException(409, f"The claim is already {cur.value}.")
    actor = _actor(user)
    reason = (body.reason or "").strip()
    manager = await _is_manager(session, user)
    needs_manager = claim.submitted_amount > cfg.CLAIM_MANAGER_LIMIT or cur == ClaimStatusEnum.REFERRED_TO_MANAGER
    now = _now()
    approved_amount = 0.0
    note = ""

    blocked = _underwriting_blocks(await _underwriting(session, claim, proc), body.decision)
    if blocked:
        raise HTTPException(409, blocked)

    if body.decision in ("Approve", "PartialApprove"):
        a = proc.assessment_json or {}
        inv = proc.investigation_json or {}
        if not proc.assessed_at:
            raise HTTPException(409, "Assess the benefit before approving.")
        if eng.outstanding_documents(proc.documents_json):
            raise HTTPException(409, "Required documents are still outstanding.")
        if inv.get("requires_investigation") and not proc.investigation_completed_at:
            raise HTTPException(409, "Complete the investigation before approving.")
        if proc.eligibility_status == "Ineligible" and not proc.eligibility_override_by:
            raise HTTPException(409, "The claim is not eligible — reject it, or ask a manager to override.")
        await ca.assert_can_decide(session, tenant_id, await _role_name(user, session), claim.submitted_amount,
                                   referred_up=cur == ClaimStatusEnum.REFERRED_TO_MANAGER)
        if claim.duplicate_flag and len(reason) < 15:
            raise HTTPException(400, "This claim is flagged as a possible duplicate — record your rationale (at least 15 characters).")
        if a.get("payable", 0) <= 0:
            raise HTTPException(400, "The assessed benefit is nil — there is nothing to approve.")
        payable = float(a.get("payable", 0))
        if body.decision == "Approve":
            approved_amount = payable
        else:
            if body.amount is None or not (0 < body.amount < payable):
                raise HTTPException(400, f"A partial approval must be above 0 and below the assessed benefit of PKR {payable:,.2f}.")
            if not reason:
                raise HTTPException(400, "Explain why the claim is only partly approved.")
            approved_amount = round(float(body.amount), 2)
        target = ClaimStatusEnum.APPROVED if body.decision == "Approve" else ClaimStatusEnum.PARTIAL_APPROVAL
        note = f"{'Approved' if body.decision == 'Approve' else 'Partially approved'}: PKR {approved_amount:,.2f}. {reason}".strip()
        await _move(session, claim, target, user, note)
        claim.approved_amount = approved_amount
        session.add(claim)
        # Who is entitled to be paid — derived now so settlement can begin, rebuilt if the amount changes.
        proc.payees_json = await _derive_payees(session, policy, claim, proc, approved_amount)
        proc.payees_verified_at, proc.authorized_at, proc.authorized_by, proc.authorized_amount = None, None, None, 0.0
    elif body.decision == "Reject":
        if not reason:
            raise HTTPException(400, "A reason is required to reject a claim.")
        await ca.assert_can_decide(session, tenant_id, await _role_name(user, session), claim.submitted_amount,
                                   referred_up=cur == ClaimStatusEnum.REFERRED_TO_MANAGER)
        note = f"Rejected: {reason}"
        await _move(session, claim, ClaimStatusEnum.DECLINED, user, note)
        claim.approved_amount = 0.0
        session.add(claim)
    elif body.decision == "RequestInfo":
        asks = [a for a in body.info_requests if a.label.strip()]
        if not asks or not reason:
            raise HTTPException(400, "List the information or documents needed and say why.")
        n = sum(1 for d in (proc.documents_json or []) if d["key"].startswith("info-"))
        proc.documents_json = eng.merge_documents(proc.documents_json, [{
            "key": f"info-{n + i + 1}", "label": a.label.strip(), "required": True, "when": "always", "reason": a.reason or reason,
            "status": "Requested", "requested_at": now.isoformat(), "received_at": None, "artifact_id": None, "file_name": None, "note": None}
            for i, a in enumerate(asks)])
        note = f"Further information requested: {', '.join(a.label.strip() for a in asks)}. {reason}"
        await _move(session, claim, ClaimStatusEnum.PENDING_DOCUMENTS, user, note)
        proc.docs_complete_at = None
    else:  # Refer
        if not reason:
            raise HTTPException(400, "Say why the claim is being referred.")
        if cur == ClaimStatusEnum.REFERRED_TO_MANAGER:
            raise HTTPException(409, "The claim is already with a manager.")
        note = f"Referred to a claims manager: {reason}"
        await _move(session, claim, ClaimStatusEnum.REFERRED_TO_MANAGER, user, note)

    final = body.decision in ("Approve", "PartialApprove", "Reject")
    proc.decision, proc.decision_reason, proc.decision_by, proc.decision_at = body.decision, reason or None, actor, now
    proc.decision_amount = approved_amount
    proc.decision_history_json = [*(proc.decision_history_json or []), {
        "decision": body.decision, "amount": approved_amount, "reason": reason or None, "by": actor, "at": now.isoformat()}]
    if not final:
        proc.decision_at = None if body.decision == "RequestInfo" else proc.decision_at
    _touch(proc)
    ev = _audit(session, policy, claim, proc, "ClaimDecision", actor, {"decision": body.decision, "amount": approved_amount, "reason": reason or None})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _workspace(session, policy, claim, proc)


async def _derive_payees(session: AsyncSession, policy: Policy, claim: Claim, proc: ClaimProcess, amount: float) -> list[dict]:
    bens = (await session.exec(select(Beneficiary).where(Beneficiary.policy_id == policy.id))).all()
    payees = eng.derive_payees(
        category=proc.category, approved_amount=amount,
        beneficiaries=[{"name": b.name, "cnic": b.cnic, "relationship": b.relationship, "share_pct": b.share_pct,
                        "is_minor": b.is_minor, "guardian_name": b.guardian_name} for b in bens],
        nominee_name=policy.nominee_name, nominee_relationship=policy.nominee_relationship,
        claimant={"name": claim.claimant_name, "cnic": claim.claimant_cnic, "relationship": claim.claimant_relationship},
        covered_person_name=proc.covered_person_name)
    for p in payees:
        p["recorded_cnic"] = p.get("cnic")
    return payees


# ══════════════════════════════════════════════════════════════════════════════
# Step 6 — settlement
# ══════════════════════════════════════════════════════════════════════════════

# Workspace responses contain medical/bank/customer fields. Persist only a safe
# financial outcome and rehydrate the authorized resource on replay.
_WORKSPACE_FIELDS = ('claim', 'process', 'eligibility', 'documents', 'investigation', 'assessment', 'decision', 'sla', 'settlement', 'closure', 'stages', 'underwriting', 'plan_terms', 'can', 'timeline')


def _settlement_receipt(payload):
    return {"claim_id": payload["claim"]["id"],
            "claim": {k: payload["claim"][k] for k in ("status", "approved_amount", "settlement_amount")},
            "settlement": {k: payload["settlement"][k] for k in (
                "authorized_at", "authorized_amount", "disbursed_at", "paid_total", "reconciled_at")}}


async def _settlement_identity(values, request):
    user = values["user"]  # require_roles runs on every HTTP call, including replay
    if not user.is_active or user.tenant_id != values["tenant_id"]:
        raise HTTPException(403, "Work settlement only in your own organization using an active account.")
    await _get_policy(values["session"], values["tenant_id"], values["policy_id"])
    claim = await values["session"].get(Claim, values["claim_id"])
    if claim is None or claim.tenant_id != values["tenant_id"] or claim.policy_id != values["policy_id"]:
        raise HTTPException(404, "Claim not found on this policy.")
    return user


async def _authorization_identity(values, request):
    user = await _settlement_identity(values, request)
    claim = await values["session"].get(Claim, values["claim_id"])
    await ca.assert_can_authorize(values["session"], values["tenant_id"],
                                  await _role_name(user, values["session"]), claim.approved_amount)
    return user


async def _replay_settlement(values, receipt):
    if receipt["claim_id"] != str(values["claim_id"]):
        raise HTTPException(409, "Settlement receipt does not match the claim")
    policy = await _get_policy(values["session"], values["tenant_id"], values["policy_id"])
    claim, proc = await _get_claim(values["session"], values["policy_id"], values["claim_id"])
    workspace = await _workspace(values["session"], policy, claim, proc)
    workspace["claim"].update(receipt["claim"])
    workspace["settlement"].update(receipt["settlement"])
    return workspace


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/settlement/prepare")
@database_operation("tenant.claim.prepare_claim_settlement", response_fields=_WORKSPACE_FIELDS,
                    receipt_fields=("claim_id", "claim", "settlement"), receipt_builder=_settlement_receipt,
                    replay_response=_replay_settlement, authorize=_settlement_identity)
async def prepare_claim_settlement(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID, request: Request,
    user=Depends(require_roles(*ca.AUTHORIZE_ROLES)), session: AsyncSession = Depends(get_session),
):
    """Prepare verified-source payees for an already-approved register/workflow claim.
    Does not approve a claim, verify a payee or authorise payment."""
    if not user.is_active or user.tenant_id != tenant_id:
        raise HTTPException(403, "Prepare settlement only in your own organization.")
    policy = await _get_policy(session, tenant_id, policy_id)
    claim = (await session.exec(select(Claim).where(Claim.id == claim_id).with_for_update().execution_options(populate_existing=True))).first()
    if not claim or claim.policy_id != policy_id or claim.tenant_id != tenant_id:
        raise HTTPException(404, "Claim not found on this policy.")
    if _cstatus(claim) not in (ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL) or claim.approved_amount <= 0:
        raise HTTPException(409, "Prepare settlement only for an approved unpaid claim.")
    proc = (await session.exec(select(ClaimProcess).where(ClaimProcess.claim_id == claim_id))).first()
    if proc is None:
        category = next((key for key, item in cfg.CLAIM_CATEGORIES.items() if item['claim_type'] == claim.claim_type), None)
        if not category:
            raise HTTPException(409, "Open this claim in the claims workflow and select its category first.")
        customer = await session.get(Customer, policy.customer_id)
        proc = ClaimProcess(tenant_id=tenant_id, policy_id=policy_id, claim_id=claim_id,
            category=category, segment=eng._segment(policy), event_date=claim.incident_date or (claim.reported_date.date() if hasattr(claim.reported_date, "date") else claim.reported_date),
            covered_person_name=customer.name if customer else None, covered_person_relationship="Self")
        session.add(proc)
        await session.flush()
    await _assert_underwriting_cleared(session, claim, proc)
    events = []
    if proc.authorized_at or proc.disbursed_at:
        return await _workspace(session, policy, claim, proc)
    if not proc.payees_json:
        proc.payees_json = await _derive_payees(session, policy, claim, proc, claim.approved_amount)
        _touch(proc)
        events.append(_audit(session, policy, claim, proc, "ClaimSettlementPrepared", _actor(user), {"amount": claim.approved_amount}))
    await session.commit()
    await _publish(request, policy, events)
    return await _workspace(session, policy, claim, proc)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/settlement/payees")
@database_operation("tenant.claim.verify_payees", response_fields=_WORKSPACE_FIELDS,
                    receipt_fields=("claim_id", "claim", "settlement"), receipt_builder=_settlement_receipt,
                    replay_response=_replay_settlement, authorize=_settlement_identity)
async def verify_payees(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    body: PayeesBody,
    request: Request,
    user=Depends(require_roles(*_CLAIMS_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Verify the rightful payee(s): identity (CNIC, matched to the nominee on record) and
    bank details (IBAN format, account title). A payee is verified only when every
    blocking check passes; a mismatching account title needs a note."""
    if not user.is_active or user.tenant_id != tenant_id:
        raise HTTPException(403, "Work settlement only in your own organization using an active account.")
    policy = await _get_policy(session, tenant_id, policy_id)
    await session.exec(select(Claim).where(Claim.id == claim_id).with_for_update())
    claim, proc = await _get_claim(session, policy_id, claim_id)
    await session.refresh(claim)
    await session.refresh(proc)
    if _cstatus(claim) not in (ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL):
        raise HTTPException(409, "Payees are verified once the claim is approved and before it is paid.")
    await _assert_underwriting_cleared(session, claim, proc)
    if proc.authorized_at:
        raise HTTPException(409, "Disbursement is already authorised — payees can no longer change.")
    payees = [dict(p) for p in (proc.payees_json or [])]
    by_id = {p["id"]: p for p in payees}
    events = []
    for upd in body.payees:
        p = by_id.get(upd.id)
        if p is None:
            raise HTTPException(404, f"Unknown payee '{upd.id}'")
        for f in ("cnic", "bank_name", "account_title", "iban", "method", "note"):
            v = getattr(upd, f)
            if v is not None:
                p[f] = v.strip() if f != "iban" else v.replace(" ", "").upper()
        res = eng.payee_checks(p, recorded_cnic=p.get("recorded_cnic"))
        p["checks"] = res["checks"]
        if upd.verify:
            if res["blockers"]:
                raise HTTPException(400, f"{p['name']}: " + "; ".join(c["detail"] for c in res["blockers"]))
            if res["reviews"] and not (p.get("note") or "").strip():
                raise HTTPException(400, f"{p['name']}: " + "; ".join(c["detail"] for c in res["reviews"]) + " Add a note to verify anyway.")
            if not (p.get("method") or "").strip():
                raise HTTPException(400, f"{p['name']}: say how identity was verified.")
            p["verified"], p["verified_by"], p["verified_at"] = True, _actor(user), _now().isoformat()
            events.append(_audit(session, policy, claim, proc, "ClaimPayeeVerified", _actor(user), {"payee": p["name"], "amount": p["amount"], "method": p.get("method")}))
        else:
            p["verified"], p["verified_by"], p["verified_at"] = False, None, None
    proc.payees_json = payees
    proc.payees_verified_at = _now() if payees and all(p["verified"] for p in payees) else None
    _touch(proc)
    await session.commit()
    await _publish(request, policy, events)
    return await _workspace(session, policy, claim, proc)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/settlement/authorize")
@database_operation("tenant.claim.authorize_disbursement", response_fields=_WORKSPACE_FIELDS,
                    receipt_fields=("claim_id", "claim", "settlement"), receipt_builder=_settlement_receipt,
                    replay_response=_replay_settlement, authorize=_authorization_identity)
async def authorize_disbursement(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    request: Request,
    user=Depends(require_roles(*ca.AUTHORIZE_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Authorise the disbursement of the approved amount to the verified payees: the settlement approval, within the
    manager's delegated authorisation limit. Finance then executes the payment."""
    if not user.is_active or user.tenant_id != tenant_id:
        raise HTTPException(403, "Work settlement only in your own organization using an active account.")
    policy = await _get_policy(session, tenant_id, policy_id)
    await session.exec(select(Claim).where(Claim.id == claim_id).with_for_update())
    claim, proc = await _get_claim(session, policy_id, claim_id)
    await session.refresh(claim)
    await session.refresh(proc)
    if _cstatus(claim) not in (ClaimStatusEnum.APPROVED, ClaimStatusEnum.PARTIAL_APPROVAL):
        raise HTTPException(409, "Only an approved claim can be authorised for payment.")
    await _assert_underwriting_cleared(session, claim, proc)
    if not proc.payees_verified_at:
        raise HTTPException(409, "Verify every payee before authorising the disbursement.")
    if proc.authorized_at:
        raise HTTPException(409, "Disbursement is already authorised.")
    await ca.assert_can_authorize(session, tenant_id, await _role_name(user, session), claim.approved_amount)
    total = round(sum(p["amount"] for p in (proc.payees_json or [])), 2)
    if abs(total - claim.approved_amount) >= 0.01:
        raise HTTPException(409, f"The payee amounts (PKR {total:,.2f}) do not add up to the approved amount (PKR {claim.approved_amount:,.2f}).")
    proc.authorized_by, proc.authorized_at, proc.authorized_amount = _actor(user), _now(), claim.approved_amount
    _touch(proc)
    ev = _audit(session, policy, claim, proc, "ClaimDisbursementAuthorized", _actor(user), {"amount": claim.approved_amount, "payees": len(proc.payees_json or [])})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _workspace(session, policy, claim, proc)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/settlement/disburse")
@database_operation("tenant.claim.disburse_claim", response_fields=_WORKSPACE_FIELDS,
                    receipt_fields=("claim_id", "claim", "settlement"), receipt_builder=_settlement_receipt,
                    replay_response=_replay_settlement, authorize=_settlement_identity)
async def disburse_claim(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    body: DisburseBody,
    request: Request,
    user=Depends(require_roles(*ca.DISBURSE_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Execute the payment of the authorised amount. Finance only: the person who approved the claim does not also
    release the money. Pay the authorised amount — one payout per payee, through the register's own
    settlement routine, which marks the claim Settled. Records external payment; no bank transfer is sent."""
    if not user.is_active or user.tenant_id != tenant_id:
        raise HTTPException(403, "Record payments only in your own organization using an active Finance account.")
    policy = await _get_policy(session, tenant_id, policy_id)
    await session.exec(select(Claim).where(Claim.id == claim_id).with_for_update())
    claim, proc = await _get_claim(session, policy_id, claim_id)
    await session.refresh(claim)
    await session.refresh(proc)
    if not proc.authorized_at:
        raise HTTPException(409, "Authorise the disbursement first.")
    await _assert_underwriting_cleared(session, claim, proc)
    if proc.disbursed_at or _cstatus(claim) == ClaimStatusEnum.SETTLED:
        raise HTTPException(409, "This claim has already been paid.")
    if body.method not in cfg.CLAIM_PAYOUT_METHODS:
        raise HTTPException(400, f"Unknown payout method '{body.method}'")
    payees = proc.payees_json or []
    references = {k: v.strip() for k, v in (body.payee_references or {}).items()}
    if references:
        if set(references) != {p['id'] for p in payees} or any(not 3 <= len(r) <= 100 for r in references.values()) or len(set(references.values())) != len(references):
            raise HTTPException(422, "Provide one distinct bank reference (3–100 characters) for every authorised payee.")
    elif body.reference_number and len(payees) > 1:
        raise HTTPException(422, "Record the bank reference separately for each authorised payee.")
    await assert_claim_payable(session, tenant_id, claim, claim.approved_amount)
    payouts = [{"amount": p["amount"], "method": body.method, "payee_name": p["name"], "payee_cnic": eng._norm_cnic(p.get("cnic")) or None,
                "payee_relationship": p.get("relationship"), "share_pct": p.get("share_pct"),
                "reference_number": references.get(p["id"]) or (body.reference_number.strip() if body.reference_number else None),
                "notes": " · ".join(filter(None, [f"{p.get('bank_name')} · {p.get('iban')} · {p.get('account_title')}",
                    body.note.strip() if body.note else None]))} for p in payees]
    rows = await settle_claim_with_payouts(session, tenant_id, claim, user, payouts)
    proc.disbursed_at = _now()
    _touch(proc)
    ev = _audit(session, policy, claim, proc, "ClaimSettled", _actor(user), {
        "amount": claim.approved_amount, "payees": len(rows), "method": body.method, "references": [r.reference_number for r in rows]})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _workspace(session, policy, claim, proc)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/settlement/reconcile")
@database_operation("tenant.claim.reconcile_settlement", response_fields=_WORKSPACE_FIELDS,
                    receipt_fields=("claim_id", "claim", "settlement"), receipt_builder=_settlement_receipt,
                    replay_response=_replay_settlement, authorize=_settlement_identity)
async def reconcile_settlement(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    body: ReconcileBody,
    request: Request,
    user=Depends(require_roles(*ca.RECONCILE_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Reconcile what was disbursed against what was approved and owed. A failed blocking
    check is an Exception and can only be signed off with a note."""
    policy = await _get_policy(session, tenant_id, policy_id)
    await session.exec(select(Claim).where(Claim.id == claim_id).with_for_update())
    claim, proc = await _get_claim(session, policy_id, claim_id)
    await session.refresh(claim)
    await session.refresh(proc)
    if _cstatus(claim) != ClaimStatusEnum.SETTLED:
        raise HTTPException(409, "There is no payment to reconcile yet.")
    payouts = await _payouts(session, claim)
    result = eng.reconcile_settlement(approved_amount=claim.approved_amount, payees=proc.payees_json or [], payouts=payouts,
                                      claim_status=_cstatus(claim).value, settlement_amount=claim.settlement_amount)
    note = (body.note or "").strip()
    proc.reconciliation_json = _json_safe(result)
    if result["status"] == "Exception" and not note:
        _touch(proc)
        ev = _audit(session, policy, claim, proc, "ClaimReconciliationException", _actor(user), {"variance": result["variance"]})
        await session.commit()
        await _publish(request, policy, [ev])
        return await _workspace(session, policy, claim, proc)
    proc.reconciled_at, proc.reconciled_by = _now(), _actor(user)
    _touch(proc)
    ev = _audit(session, policy, claim, proc, "ClaimReconciled", _actor(user), {"status": result["status"], "disbursed": result["disbursed"], "note": note or None})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _workspace(session, policy, claim, proc)


# ══════════════════════════════════════════════════════════════════════════════
# Step 7 — closure
# ══════════════════════════════════════════════════════════════════════════════

async def _apply_coverage_update(session: AsyncSession, policy: Policy, claim: Claim, proc: ClaimProcess, user) -> tuple[dict, list]:
    """Update the coverage records for the outcome: a paid death benefit ends the policy,
    a paid rider benefit uses the rider up, a hospital benefit reduces the annual limit.
    Returns (summary, audit events)."""
    events: list = []
    spec = cfg.CLAIM_CATEGORIES[proc.category]
    paid = claim.settlement_amount or 0.0
    update: dict = {"category": proc.category, "benefit_paid": paid}

    if proc.category == "Hospitalization":
        used = await eng.paid_hospital_benefits(session, policy, _policy_year_start(policy.effective_date, proc.event_date))
        update.update(annual_limit=policy.coverage_amount, used_this_year=used, remaining_limit=max(policy.coverage_amount - used, 0.0),
                      note="Annual limit reduced by the benefit paid; the policy continues.")
    elif proc.category == "Disability":
        rid = (proc.assessment_json or {}).get("rider_id")
        rider = await session.get(PolicyRider, UUID(rid)) if rid else None
        if rider is not None:
            before = rider.sum_assured
            rider.sum_assured = max(round(before - paid, 2), 0.0)
            if rider.sum_assured <= 0:
                rider.status = "Claimed"
            session.add(rider)
            update.update(rider=rider.name, rider_sum_before=before, rider_sum_after=rider.sum_assured, rider_status=rider.status,
                          note="Rider benefit reduced by the amount paid." if rider.status != "Claimed" else "Rider benefit exhausted.")
    elif proc.category == "AccidentalDeath":
        rid = (proc.assessment_json or {}).get("rider_id")
        rider = await session.get(PolicyRider, UUID(rid)) if rid else None
        if rider is not None:
            rider.status = "Claimed"
            session.add(rider)
            update.update(rider=rider.name, rider_status="Claimed")

    if spec["terminates_policy"] and (claim.settlement_amount or 0) > 0:
        cur = _st(policy)
        if cur in (PolicyStatusEnum.ACTIVE.value, PolicyStatusEnum.GRACE_PERIOD.value, PolicyStatusEnum.LAPSED.value):
            try:
                events.append(apply_transition(session, policy, PolicyStatusEnum.CANCELLED, event_type="PolicyTerminatedByClaim",
                                               actor=_actor(user), detail={"claim_no": claim.claim_number, "claim_id": str(claim.id),
                                                                           "category": proc.category, "benefit_paid": paid,
                                                                           "event_date": proc.event_date.isoformat()}))
                update["policy_status"] = "Cancelled"
            except IllegalStateTransition as exc:
                update["policy_status_error"] = str(exc)
        waived = 0
        for r in (await session.exec(select(PremiumSchedule).where(PremiumSchedule.policy_id == policy.id))).all():
            if r.status in (PremiumScheduleStatusEnum.PENDING, PremiumScheduleStatusEnum.OVERDUE):
                r.status = PremiumScheduleStatusEnum.WAIVED
                r.payment_reference = f"CLAIM-{claim.claim_number}"
                session.add(r)
                waived += 1
        update.update(instalments_waived=waived, note="The death benefit ended the policy; unpaid instalments were waived (any due before the event were deducted from the benefit).")
    return update, events


async def _render_letter(session: AsyncSession, policy: Policy, claim: Claim, proc: ClaimProcess) -> str:
    tenant = await session.get(Tenant, policy.tenant_id)
    payouts = await _payouts(session, claim)
    a = proc.assessment_json or {}
    doc = document_generator.generate_claim_letter({
        "policy_id": policy.id, "tenant_name": tenant.name if tenant else "Insurer", "claim_number": claim.claim_number,
        "policy_number": policy.policy_number, "claimant_name": claim.claimant_name, "outcome": proc.closure_outcome,
        "claim_label": cfg.CLAIM_CATEGORIES[proc.category]["label"], "event_date": proc.event_date.isoformat(),
        "covered_person": proc.covered_person_name, "claimed_amount": claim.submitted_amount, "approved_amount": claim.approved_amount,
        "paid_amount": claim.settlement_amount, "payouts": payouts, "deductions": a.get("deductions"),
        "coverage_note": (proc.coverage_update_json or {}).get("note"), "reason": proc.decision_reason})
    proc.confirmation_path, proc.confirmation_generated_at = doc["file_path"], _now()
    return doc["file_path"]


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/close")
@_claim_step("tenant.claim.close")
async def close_claim(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    request: Request,
    user=Depends(require_roles(*_CLAIMS_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Step 7 — close the claim: record the outcome, update the coverage records (a paid
    death benefit ends the policy), issue the confirmation letter and close the Claim."""
    policy = await _get_policy(session, tenant_id, policy_id)
    await session.refresh(policy, with_for_update=True)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    st = _cstatus(claim)
    if st == ClaimStatusEnum.CLOSED:
        raise HTTPException(409, "The claim is already closed.")
    if st == ClaimStatusEnum.SETTLED:
        if not proc.reconciled_at:
            raise HTTPException(409, "Reconcile the payment before closing the claim.")
        outcome = "Settled"
    elif st == ClaimStatusEnum.DECLINED:
        outcome = "Rejected"
    else:
        raise HTTPException(409, f"A claim can be closed once it is settled or rejected (it is '{st.value}').")
    try:
        events: list = []
        proc.closure_outcome = outcome
        if outcome == "Settled":
            proc.coverage_update_json, evs = await _apply_coverage_update(session, policy, claim, proc, user)
            events += evs
        else:
            proc.coverage_update_json = {"category": proc.category, "benefit_paid": 0.0, "note": "No benefit paid; cover is unchanged."}
        await _move(session, claim, ClaimStatusEnum.CLOSED, user, f"Claim closed — {outcome}.")
        proc.closed_by, proc.closed_at = _actor(user), _now()
        await _render_letter(session, policy, claim, proc)
        _touch(proc)
        events.append(_audit(session, policy, claim, proc, "ClaimClosed", _actor(user), {
            "outcome": outcome, "paid": claim.settlement_amount or 0.0, "coverage_update": _json_safe(proc.coverage_update_json)}))
        await session.commit()
    except IllegalStateTransition as exc:
        await session.rollback()
        raise HTTPException(409, str(exc)) from exc
    except HTTPException:
        await session.rollback()
        raise
    except Exception as exc:
        await session.rollback()
        log.exception("Closing claim %s failed — rolled back", claim_id)
        raise HTTPException(500, f"Closing the claim failed and was rolled back: {exc}") from exc
    await _publish(request, policy, events)
    return await _workspace(session, policy, claim, proc)


@router.get("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/confirmation/download")
async def download_claim_letter(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    if not proc.closure_outcome:
        raise HTTPException(409, "The letter is issued when the claim is closed.")
    if not proc.confirmation_path or not os.path.exists(proc.confirmation_path):
        await _render_letter(session, policy, claim, proc)
        await session.commit()
    return FileResponse(proc.confirmation_path, media_type="application/pdf", filename=f"claim_{claim.claim_number}.pdf")


@router.post("/tenants/{tenant_id}/policies/{policy_id}/claims-management/{claim_id}/confirmation/send")
@notification_operation("tenant.claim.send_letter")
async def send_claim_letter(
    tenant_id: UUID, policy_id: UUID, claim_id: UUID,
    request: Request,
    user=Depends(require_roles(*_CLAIMS_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Email the closing letter to the claimant (best-effort; `delivered` reports whether
    the mail provider accepted it)."""
    policy = await _get_policy(session, tenant_id, policy_id)
    claim, proc = await _get_claim(session, policy_id, claim_id)
    if not proc.closure_outcome:
        raise HTTPException(409, "The letter can be sent once the claim is closed.")
    customer = await session.get(Customer, policy.customer_id)
    details = (customer.details if customer else None) or {}
    email = proc.claimant_email or details.get("contact_email") or details.get("email")
    if not email:
        raise HTTPException(400, "No email on record for the claimant — add one before sending the letter.")
    tenant = await session.get(Tenant, policy.tenant_id)
    subject, text, html = claim_closure_email(
        customer_name=claim.claimant_name or "Claimant", tenant_name=tenant.name if tenant else "Your Insurer",
        policy_number=policy.policy_number or "—", claim_number=claim.claim_number or "—",
        claim_label=cfg.CLAIM_CATEGORIES[proc.category]["label"], outcome=proc.closure_outcome,
        approved_amount=claim.settlement_amount or 0.0, reason=proc.decision_reason,
        tenant_phone=tenant.contact_phone if tenant else None, tenant_email=tenant.contact_email if tenant else None)
    attachments = [proc.confirmation_path] if proc.confirmation_path and os.path.exists(proc.confirmation_path) else None
    ok = await email_utils.send_email(email, subject, text, html, attachments)
    if ok:
        proc.confirmation_sent_at, proc.confirmation_sent_to = _now(), email
        _touch(proc)
    ev = _audit(session, policy, claim, proc, "ClaimLetterSent", _actor(user), {"to": email, "delivered": ok})
    await session.commit()
    await _publish(request, policy, [ev])
    return {"sent_to": email, "sent_at": _now().isoformat(), "delivered": ok, "subject": subject}
