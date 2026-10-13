"""
Stage B — Reinstatement router (step 6 of the post-issuance journey).

Revives a LAPSED policy. A reinstatement is NOT a new issuance: the original
policy number and history are kept and a PolicyReinstatement case — with its own
workflow, requirements, financial record, underwriting decision and audit trail —
is attached to them. Paying the overdue premium never reinstates on its own;
underwriting must approve first.

Workflow (see services/reinstatement_engine.STEPS):
  1 detect lapsed policy        GET  /reinstatement                (live eligibility)
  2 create request              POST /reinstatement
  3 calculate arrears           POST /reinstatement/{id}/arrears/recalculate
  4 collect declaration         POST /reinstatement/{id}/declaration
                                POST /reinstatement/{id}/evidence/{key}
  5 perform underwriting        POST /reinstatement/{id}/assessment
  6 underwriting decision       POST /reinstatement/{id}/decision        (Underwriter/Admin)
                                POST /reinstatement/{id}/terms/respond
  7 verify payment/conditions   POST /reinstatement/{id}/payment
  8 restore coverage            POST /reinstatement/{id}/restore
  9 issue confirmation          GET/POST /reinstatement/{id}/confirmation/...

Funds taken in step 7 are held against the case. The premium ledger (instalments,
receipts, commission) is only touched when cover is actually restored in step 8,
so a withdrawn case is a clean refund with no ledger side effects.

Every status change routes through policy_state_machine.apply_transition and every
action writes a PolicyEvent carrying the case_no, which is the case's audit trail.
"""

import logging
import os
import re
from datetime import date, datetime
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import email_utils
from database import get_session
from routers.auth import require_roles
from routers.policies import _get_policy, _publish_policy_event, _st
from routers.post_issuance import _next_receipt_no
from services import document_generator, insurer_config, payment_gateway, reinstatement_engine as eng
from services.email_templates import reinstatement_email
from services.endorsement_engine import _current_version, _next_version_number
from shared.models.core import (
    Customer,
    Policy,
    PolicyEvent,
    PolicyReinstatement,
    PolicyStatusEnum,
    PolicyVersion,
    PremiumReceipt,
    PremiumSchedule,
    PremiumScheduleStatusEnum,
    Tenant,
)
from shared.services.policy_state_machine import IllegalStateTransition, apply_transition, record_event

log = logging.getLogger(__name__)
router = APIRouter(tags=["Stage B — Reinstatement"])

_EVIDENCE_EXTS = {"pdf", "png", "jpg", "jpeg"}
_MAX_EVIDENCE_BYTES = 10 * 1024 * 1024
_UNDERWRITING_ROLES = ("SuperAdmin", "Admin", "Underwriter")


# ── Request bodies ────────────────────────────────────────────────────────────

class OpenBody(BaseModel):
    applicant_name: Optional[str] = None
    applicant_relationship: str = "Policyholder"
    request_channel: str = "Branch"
    reason: Optional[str] = None
    requested_by: Optional[str] = None


class DeclarationBody(BaseModel):
    answers: dict[str, bool]
    details: dict[str, str] = {}
    signed_by: str
    signature_method: str = "Wet"          # Wet | ESign | Portal
    confirm_signed: bool = False
    actor: Optional[str] = None


class EvidenceAsk(BaseModel):
    label: str
    reason: Optional[str] = None


class DecisionBody(BaseModel):
    decision: Literal["Approve", "ApproveWithTerms", "RequestEvidence", "Decline"]
    notes: Optional[str] = None
    loading_pct: Optional[float] = None
    exclusions: Optional[str] = None
    evidence: list[EvidenceAsk] = []


class TermsResponseBody(BaseModel):
    accepted: bool
    responded_by: Optional[str] = None
    note: Optional[str] = None


class PaymentBody(BaseModel):
    method: Optional[str] = None           # JazzCash | Easypaisa | Card | BankTransfer
    reference: Optional[str] = None
    manual: bool = False                   # over-the-counter / offline payment
    realize: bool = True                   # False simulates a failed gateway settlement
    collected_by: Optional[str] = None


class RestoreBody(BaseModel):
    actor: Optional[str] = None


class WithdrawBody(BaseModel):
    reason: Optional[str] = None
    actor: Optional[str] = None


# ── helpers ───────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.utcnow()


def _touch(case: PolicyReinstatement) -> None:
    case.updated_at = _now()


async def _next_case_no(session: AsyncSession, tenant_id: UUID) -> str:
    year = _now().year
    existing = (await session.exec(
        select(PolicyReinstatement).where(PolicyReinstatement.tenant_id == tenant_id)
    )).all()
    return f"RN-{year}-{len(existing) + 1:05d}"


async def _get_case(session: AsyncSession, policy_id: UUID, case_id: UUID) -> PolicyReinstatement:
    case = await session.get(PolicyReinstatement, case_id)
    if not case or case.policy_id != policy_id:
        raise HTTPException(404, "Reinstatement case not found")
    return case


def _assert_open(case: PolicyReinstatement) -> None:
    if case.status not in eng.OPEN_STATUSES:
        raise HTTPException(409, f"Case {case.case_no} is closed ({case.status}).")


def _audit(session, policy: Policy, case: PolicyReinstatement, event_type: str,
           actor: Optional[str], detail: Optional[dict] = None) -> PolicyEvent:
    return record_event(session, policy, event_type=event_type, actor=actor or "ops",
                        detail={"case_no": case.case_no, "case_id": str(case.id), **(detail or {})})


async def _publish(request: Request, policy: Policy, events: list) -> None:
    for ev in events:
        await _publish_policy_event(request, policy, ev)


async def _lock_policy(session: AsyncSession, policy: Policy) -> None:
    await session.refresh(policy, with_for_update=True)


async def _require_eligible(session: AsyncSession, policy: Policy, case: PolicyReinstatement) -> dict:
    """Fresh eligibility pass for an existing case (its own open status is ignored)."""
    elig = await eng.evaluate_eligibility(session, policy, ignore_case_id=case.id)
    if elig["blockers"] or _st(policy) != PolicyStatusEnum.LAPSED.value:
        raise HTTPException(409, f"Policy is no longer eligible for reinstatement: {elig['message']}")
    return elig


def _set_json(case: PolicyReinstatement, field: str, value) -> None:
    """Assign a fresh object so SQLAlchemy notices the JSON column changed."""
    setattr(case, field, value)


def _as_dict(obj) -> dict:
    return dict(obj) if obj else {}


async def _timeline(session: AsyncSession, policy_id: UUID, case: PolicyReinstatement) -> list[dict]:
    rows = (await session.exec(
        select(PolicyEvent).where(PolicyEvent.policy_id == policy_id)
        .order_by(PolicyEvent.created_at.desc())  # type: ignore[arg-type]
    )).all()
    out = []
    for e in rows:
        d = e.detail_json or {}
        if d.get("case_no") != case.case_no:
            continue
        out.append({
            "id": str(e.id), "event_type": e.event_type, "actor": e.actor,
            "from_status": e.from_status, "to_status": e.to_status,
            "at": e.created_at.isoformat(),
            "detail": {k: v for k, v in d.items() if k not in ("case_no", "case_id")},
        })
    return out


async def _overview(session: AsyncSession, policy: Policy, resumed: bool = False) -> dict:
    customer = await session.get(Customer, policy.customer_id)
    elig = await eng.evaluate_eligibility(session, policy)
    cases = (await session.exec(
        select(PolicyReinstatement).where(PolicyReinstatement.policy_id == policy.id)
        .order_by(PolicyReinstatement.created_at.desc())  # type: ignore[arg-type]
    )).all()
    current = next((c for c in cases if c.status in eng.OPEN_STATUSES), None) or (cases[0] if cases else None)

    view = None
    if current:
        view = eng.case_view(current)
        view["timeline"] = await _timeline(session, policy.id, current)
        # Restore needs every gate AND a still-clean eligibility pass.
        gates = view["conditions"]
        fresh = await eng.evaluate_eligibility(session, policy, ignore_case_id=current.id)
        view["can_restore"] = (current.status == "Approved" and all(gates.values())
                               and _st(policy) == PolicyStatusEnum.LAPSED.value and not fresh["blockers"])
        view["restore_blockers"] = [c["detail"] for c in fresh["blockers"]]

    return {
        "policy": {
            "id": str(policy.id), "policy_number": policy.policy_number, "status": _st(policy),
            "product_name": policy.product_name, "sum_assured": policy.coverage_amount,
            "customer_name": customer.name if customer else None,
        },
        "eligibility": elig,
        "case": view,
        "resumed": resumed,
        "history": [eng.case_summary(c) for c in cases],
        "declaration_questions": eng.declaration_questions(),
        "options": {
            "channels": insurer_config.REINSTATEMENT_REQUEST_CHANNELS,
            "relationships": insurer_config.REINSTATEMENT_APPLICANT_RELATIONSHIPS,
        },
    }


# ══════════════════════════════════════════════════════════════════════════════
# Steps 1–2 — eligibility + create the request
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/tenants/{tenant_id}/policies/{policy_id}/reinstatement")
async def reinstatement_overview(
    tenant_id: UUID, policy_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    """Live eligibility, the current (open or latest) case with its 9-step workflow
    and audit timeline, and the policy's reinstatement history."""
    policy = await _get_policy(session, tenant_id, policy_id)
    return await _overview(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinstatement")
async def open_reinstatement(
    tenant_id: UUID, policy_id: UUID,
    body: OpenBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Register a reinstatement request. Re-validates eligibility server-side; an
    already-open case is resumed rather than duplicated."""
    policy = await _get_policy(session, tenant_id, policy_id)
    await _lock_policy(session, policy)

    if body.applicant_relationship not in insurer_config.REINSTATEMENT_APPLICANT_RELATIONSHIPS:
        raise HTTPException(400, f"Unknown applicant relationship '{body.applicant_relationship}'")
    if body.request_channel not in insurer_config.REINSTATEMENT_REQUEST_CHANNELS:
        raise HTTPException(400, f"Unknown request channel '{body.request_channel}'")

    elig = await eng.evaluate_eligibility(session, policy)
    if elig["outcome"] == "resume":
        return await _overview(session, policy, resumed=True)
    if not elig["eligible"]:
        raise HTTPException(409, elig["message"])

    customer = await session.get(Customer, policy.customer_id)
    rules = elig["rules"]
    lapse = date.fromisoformat(elig["lapse_date"]) if elig["lapse_date"] else None
    window_end = date.fromisoformat(elig["window_ends_on"]) if elig["window_ends_on"] else None
    arrears = await eng.compute_arrears(session, policy, rules)
    now = _now()

    case = PolicyReinstatement(
        tenant_id=tenant_id, policy_id=policy_id,
        case_no=await _next_case_no(session, tenant_id), status="Open",
        applicant_name=(body.applicant_name or (customer.name if customer else None)),
        applicant_relationship=body.applicant_relationship, request_channel=body.request_channel,
        reason=body.reason, requested_by=body.requested_by or "ops",
        lapse_date=lapse, window_ends_on=window_end,
        eligibility_json={"checks": elig["checks"], "days_lapsed": elig["days_lapsed"], "evaluated_at": now.isoformat()},
        rules_json=rules,
        arrears_json=arrears, arrears_calculated_at=now, total_payable=arrears["total"],
    )
    session.add(case)
    events = [
        _audit(session, policy, case, "ReinstatementRequested", body.requested_by,
               {"applicant": case.applicant_name, "relationship": case.applicant_relationship,
                "channel": case.request_channel, "lapse_date": elig["lapse_date"]}),
        _audit(session, policy, case, "ReinstatementArrearsCalculated", "system",
               {"total": arrears["total"], "premiums": arrears["premiums"], "installments": len(arrears["lines"])}),
    ]
    await session.commit()
    await _publish(request, policy, events)
    log.info("Reinstatement %s opened for policy %s", case.case_no, policy.policy_number)
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Step 3 — arrears
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinstatement/{case_id}/arrears/recalculate")
async def recalculate_arrears(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Re-price the arrears as of today. Only before funds are taken — afterwards the
    figure is frozen because payment settled exactly those lines."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if case.payment_realized_at:
        raise HTTPException(409, "Payment has already been received against this arrears figure.")

    arrears = await eng.compute_arrears(session, policy, case.rules_json or insurer_config.reinstatement_rules(policy.product_name))
    previous = case.total_payable
    _set_json(case, "arrears_json", arrears)
    case.arrears_calculated_at = _now()
    case.total_payable = arrears["total"]
    _touch(case)
    ev = _audit(session, policy, case, "ReinstatementArrearsCalculated", "ops",
                {"total": arrears["total"], "previous_total": previous, "installments": len(arrears["lines"])})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Steps 4–5 — health declaration, supporting documents, assessment
# ══════════════════════════════════════════════════════════════════════════════

async def _run_assessment(session: AsyncSession, policy: Policy, case: PolicyReinstatement) -> dict:
    age = await eng.applicant_age(session, policy)
    lapse_days = (date.today() - case.lapse_date).days if case.lapse_date else None
    result = eng.assess(
        declaration=case.declaration_json, lapse_days=lapse_days, age=age,
        sum_assured=policy.coverage_amount,
        rules=case.rules_json or insurer_config.reinstatement_rules(policy.product_name),
    )
    _set_json(case, "assessment_json", result)
    case.assessed_at = _now()
    _set_json(case, "evidence_json", eng.merge_evidence(case.evidence_json, result["evidence"]))
    if case.status == "EvidenceRequested" and not eng.required_evidence_outstanding(case.evidence_json):
        case.status = "Open"
    _touch(case)
    return result


@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinstatement/{case_id}/declaration")
async def submit_declaration(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    body: DeclarationBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Record the signed Declaration of Good Health / Risk Evaluation Form, then run
    the underwriting assessment on it (which may raise evidence requirements)."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if case.status in ("TermsOffered", "Approved"):
        raise HTTPException(409, "The declaration is locked once an underwriting decision has been made.")
    if not body.confirm_signed or not body.signed_by.strip():
        raise HTTPException(400, "The declaration must be signed — confirm the signature and who signed.")

    questions = eng.declaration_questions()
    missing = [q["key"] for q in questions if q["key"] not in body.answers]
    if missing:
        raise HTTPException(400, f"Every declaration question must be answered (missing: {', '.join(missing)})")
    for q in questions:
        if body.answers[q["key"]] == q["adverse_if"] and q["needs_details"] and not (body.details.get(q["key"]) or "").strip():
            raise HTTPException(400, f"Please give details for: {q['text']}")

    now = _now()
    _set_json(case, "declaration_json", {
        "answers": body.answers, "details": {k: v for k, v in body.details.items() if v and v.strip()},
        "signature_method": body.signature_method, "signed_on": now.date().isoformat(),
    })
    case.declaration_signed_at = now
    case.declaration_signed_by = body.signed_by.strip()
    result = await _run_assessment(session, policy, case)
    events = [
        _audit(session, policy, case, "ReinstatementDeclarationReceived", body.actor,
               {"signed_by": case.declaration_signed_by, "method": body.signature_method,
                "adverse_answers": eng.adverse_answers(case.declaration_json)}),
        _audit(session, policy, case, "ReinstatementAssessed", "system",
               {"recommendation": result["recommendation"],
                "flags": [f["code"] for f in result["flags"]],
                "evidence_required": [e["key"] for e in result["evidence"] if e.get("required")]}),
    ]
    await session.commit()
    await _publish(request, policy, events)
    return await _overview(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinstatement/{case_id}/assessment")
async def rerun_assessment(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Re-run the underwriting assessment (e.g. after the lapse duration moved)."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if not case.declaration_signed_at:
        raise HTTPException(409, "Collect the signed declaration before assessing.")
    if case.status in ("TermsOffered", "Approved"):
        raise HTTPException(409, "The assessment is locked once an underwriting decision has been made.")
    result = await _run_assessment(session, policy, case)
    ev = _audit(session, policy, case, "ReinstatementAssessed", "ops",
                {"recommendation": result["recommendation"], "rerun": True})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


def _evidence_dir(policy_id: UUID, case_no: str) -> str:
    path = os.path.join(document_generator.MEDIA_ROOT, str(policy_id), "reinstatement", case_no)
    os.makedirs(path, exist_ok=True)
    return path


def _find_evidence(case: PolicyReinstatement, key: str) -> dict:
    for e in (case.evidence_json or []):
        if e["key"] == key:
            return e
    raise HTTPException(404, "Evidence request not found")


@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinstatement/{case_id}/evidence/{key}")
async def receive_evidence(
    tenant_id: UUID, policy_id: UUID, case_id: UUID, key: str,
    request: Request,
    note: Optional[str] = Form(None),
    actor: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    session: AsyncSession = Depends(get_session),
):
    """Mark a requested supporting document as received — with the scanned file
    attached, or just a note when it was verified in person."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if case.status in ("TermsOffered", "Approved"):
        raise HTTPException(409, "Evidence can no longer be changed once an underwriting decision has been made.")
    _find_evidence(case, key)
    if file is None and not (note or "").strip():
        raise HTTPException(400, "Attach the document or add a note describing how it was verified.")

    stored_name, stored_path = None, None
    if file is not None and file.filename:
        ext = file.filename.lower().rsplit(".", 1)[-1]
        if ext not in _EVIDENCE_EXTS:
            raise HTTPException(400, f"Unsupported file type '.{ext}'. Allowed: {', '.join(sorted(_EVIDENCE_EXTS))}")
        data = await file.read()
        if len(data) > _MAX_EVIDENCE_BYTES:
            raise HTTPException(413, "File is larger than 10 MB")
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(file.filename))
        stored_name = safe
        stored_path = os.path.join(_evidence_dir(policy_id, case.case_no), f"{re.sub(r'[^A-Za-z0-9_-]', '_', key)}_{safe}")
        with open(stored_path, "wb") as fh:
            fh.write(data)

    now = _now()
    updated = []
    for e in (case.evidence_json or []):
        e = dict(e)
        if e["key"] == key:
            e.update(status="Received", received_at=now.isoformat(), note=(note or "").strip() or None,
                     file_name=stored_name or e.get("file_name"), file_path=stored_path or e.get("file_path"))
        updated.append(e)
    _set_json(case, "evidence_json", updated)
    if case.status == "EvidenceRequested" and not eng.required_evidence_outstanding(updated):
        case.status = "Open"
    _touch(case)
    ev = _audit(session, policy, case, "ReinstatementEvidenceReceived", actor,
                {"evidence": key, "file": stored_name, "note": (note or "").strip() or None})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


@router.get("/tenants/{tenant_id}/policies/{policy_id}/reinstatement/{case_id}/evidence/{key}/download")
async def download_evidence(
    tenant_id: UUID, policy_id: UUID, case_id: UUID, key: str,
    session: AsyncSession = Depends(get_session),
):
    await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    item = _find_evidence(case, key)
    path = item.get("file_path")
    if not path or not os.path.exists(path):
        raise HTTPException(404, "No file attached to this evidence item")
    return FileResponse(path, filename=item.get("file_name") or os.path.basename(path))


# ══════════════════════════════════════════════════════════════════════════════
# Step 6 — underwriting decision (+ customer response to revised terms)
# ══════════════════════════════════════════════════════════════════════════════

def _terms_from_body(body: DecisionBody, rules: dict, current: Optional[PolicyVersion], actor: str) -> dict:
    pct = float(body.loading_pct or 0.0)
    exclusions = (body.exclusions or "").strip()
    if pct <= 0 and not exclusions:
        raise HTTPException(400, "Revised terms need a premium loading and/or an exclusion.")
    if pct < 0 or pct > float(rules["max_loading_pct"]):
        raise HTTPException(400, f"Loading must be between 0 and {rules['max_loading_pct']:g}%.")
    base = current.base_premium if current else 0.0
    extra = round(base * pct / 100.0, 2)
    return {
        "loading_pct": pct, "exclusions": exclusions or None,
        "additional_annual_premium": extra,
        "current_annual_premium": round(current.total_premium, 2) if current else None,
        "new_annual_premium": round((current.total_premium if current else 0.0) + extra, 2),
        "offered_by": actor, "offered_at": _now().isoformat(),
    }


def _validate_approval(case: PolicyReinstatement, notes: str) -> None:
    if not case.declaration_signed_at or not case.assessed_at:
        raise HTTPException(409, "A signed declaration and underwriting assessment are required before approval.")
    outstanding = eng.required_evidence_outstanding(case.evidence_json)
    if outstanding:
        raise HTTPException(409, "Required evidence is still outstanding: " + ", ".join(e["label"] for e in outstanding))
    if (case.assessment_json or {}).get("recommendation") == "Refer" and not notes:
        raise HTTPException(400, "The assessment recommends referral — record your rationale in the notes to approve.")


@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinstatement/{case_id}/decision")
async def record_decision(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    body: DecisionBody,
    request: Request,
    user=Depends(require_roles(*_UNDERWRITING_ROLES)),
    session: AsyncSession = Depends(get_session),
):
    """Capture the underwriting decision: approve, offer revised terms, request more
    evidence, or decline. Restricted to Underwriter / Admin."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if case.payment_realized_at:
        raise HTTPException(409, "Funds have already been received — the decision can no longer be changed.")
    actor = getattr(user, "email", None) or getattr(user, "username", None) or "underwriter"
    notes = (body.notes or "").strip()
    now = _now()
    rules = case.rules_json or insurer_config.reinstatement_rules(policy.product_name)
    terms = None

    if body.decision in eng.APPROVING_DECISIONS:
        _validate_approval(case, notes)
        await _require_eligible(session, policy, case)
        if body.decision == "ApproveWithTerms":
            if not notes:
                raise HTTPException(400, "Explain the revised terms in the notes.")
            terms = _terms_from_body(body, rules, await _current_version(session, policy), actor)
        case.status = "TermsOffered" if terms else "Approved"
    elif body.decision == "RequestEvidence":
        asks = [a for a in body.evidence if a.label.strip()]
        if not asks or not notes:
            raise HTTPException(400, "List the evidence needed and explain why in the notes.")
        have = sum(1 for e in (case.evidence_json or []) if e.get("source") == "underwriter")
        wanted = [{"key": f"uw-{have + i + 1}", "label": a.label.strip(), "reason": a.reason or notes,
                   "required": True, "source": "underwriter"} for i, a in enumerate(asks)]
        _set_json(case, "evidence_json", eng.merge_evidence(case.evidence_json, wanted, now))
        case.status = "EvidenceRequested"
    else:  # Decline
        if not notes:
            raise HTTPException(400, "A reason is required to decline a reinstatement.")
        case.status = "Declined"
        case.closed_reason = notes

    case.decision, case.decision_notes, case.decided_by, case.decided_at = body.decision, notes or None, actor, now
    case.terms_response, case.terms_responded_at, case.terms_responded_by = None, None, None
    _set_json(case, "terms_json", terms)
    _set_json(case, "decision_history_json", [*(case.decision_history_json or []), {
        "decision": body.decision, "notes": notes or None, "by": actor, "at": now.isoformat(), "terms": terms,
        "evidence": [a.label for a in body.evidence] if body.decision == "RequestEvidence" else None,
    }])
    _touch(case)
    ev = _audit(session, policy, case, "ReinstatementDecision", actor,
                {"decision": body.decision, "notes": notes or None,
                 "loading_pct": (terms or {}).get("loading_pct"), "exclusions": (terms or {}).get("exclusions")})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinstatement/{case_id}/terms/respond")
async def respond_to_terms(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    body: TermsResponseBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Record the customer's acceptance or rejection of the revised terms."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if case.status != "TermsOffered":
        raise HTTPException(409, "There are no revised terms awaiting a response on this case.")

    now = _now()
    case.terms_response = "Accepted" if body.accepted else "Rejected"
    case.terms_responded_at, case.terms_responded_by = now, body.responded_by or case.applicant_name
    if body.accepted:
        case.status = "Approved"
    else:
        case.status = "Withdrawn"
        case.closed_reason = (body.note or "Revised terms rejected by the customer").strip()
    _touch(case)
    ev = _audit(session, policy, case, "ReinstatementTermsAccepted" if body.accepted else "ReinstatementTermsRejected",
                body.responded_by, {"note": body.note})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Step 7 — payment (funds held against the case)
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinstatement/{case_id}/payment")
async def collect_reinstatement_payment(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    body: PaymentBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Collect the arrears + authorised charges. Only after approval (and acceptance
    of any revised terms). The arrears are re-priced to today first, and the funds
    are held against the case — nothing is posted to the premium ledger until cover
    is restored."""
    policy = await _get_policy(session, tenant_id, policy_id)
    await _lock_policy(session, policy)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)
    if case.payment_realized_at:
        raise HTTPException(409, "Payment has already been received for this case.")
    if case.status == "TermsOffered":
        raise HTTPException(409, "The customer must accept the revised terms before payment.")
    if case.status != "Approved":
        raise HTTPException(409, "Payment is taken only after underwriting approves the reinstatement.")
    await _require_eligible(session, policy, case)

    events = []
    arrears = await eng.compute_arrears(session, policy, case.rules_json or insurer_config.reinstatement_rules(policy.product_name))
    if arrears["as_of"] != (case.arrears_json or {}).get("as_of") or abs(arrears["total"] - case.total_payable) > 0.005:
        events.append(_audit(session, policy, case, "ReinstatementArrearsCalculated", "system",
                             {"total": arrears["total"], "previous_total": case.total_payable, "at_payment": True}))
        _set_json(case, "arrears_json", arrears)
        case.arrears_calculated_at = _now()
        case.total_payable = arrears["total"]
    total = case.total_payable

    if total <= 0:
        reference, method = f"NIL-{case.case_no}", "None"
    elif body.manual:
        reference, method = body.reference or f"MANUAL-{case.id.hex[:8].upper()}", body.method or "Manual"
    else:
        reference = body.reference or payment_gateway.generate_reference(payment_gateway.PaymentMethodEnum.JAZZCASH)
        try:
            intent = payment_gateway.confirm_payment(reference, total, body.method, realize=body.realize)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if intent.status != payment_gateway.PaymentStatusEnum.REALIZED:
            events.append(_audit(session, policy, case, "ReinstatementPaymentFailed", "gateway",
                                 {"amount": total, "reference": reference}))
            await session.commit()
            await _publish(request, policy, events)
            raise HTTPException(402, "Payment was not realized — the reinstatement remains unpaid")
        reference, method = intent.reference, intent.method.value

    case.payment_amount, case.payment_method, case.payment_reference = total, method, reference
    case.payment_realized_at = _now()
    _touch(case)
    events.append(_audit(session, policy, case, "ReinstatementPaymentReceived",
                         body.collected_by or ("manual" if body.manual else "gateway"),
                         {"amount": total, "method": method, "reference": reference}))
    await session.commit()
    await _publish(request, policy, events)
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Step 8 — restore coverage
# ══════════════════════════════════════════════════════════════════════════════

async def _post_arrears_receipts(session: AsyncSession, policy: Policy, case: PolicyReinstatement) -> list[dict]:
    """Settle the frozen arrears lines: mark each instalment PAID and issue its receipt
    (with commission accrual) exactly like an ordinary collection."""
    from services.commission_engine import accrue_receipt
    customer = await session.get(Customer, policy.customer_id)
    tenant = await session.get(Tenant, policy.tenant_id)
    posted = []
    for line in (case.arrears_json or {}).get("lines", []):
        sched = await session.get(PremiumSchedule, UUID(line["schedule_id"]))
        if not sched or sched.policy_id != policy.id:
            raise HTTPException(409, f"Instalment {line['installment_no']} is missing from the premium ledger.")
        if sched.status not in (PremiumScheduleStatusEnum.PENDING, PremiumScheduleStatusEnum.OVERDUE):
            raise HTTPException(409, f"Instalment {line['installment_no']} is no longer unpaid — recalculate the arrears.")

        sched.amount_paid = sched.amount_due
        sched.status = PremiumScheduleStatusEnum.PAID
        sched.paid_at = _now()
        sched.payment_reference = case.payment_reference
        session.add(sched)

        surcharge = round(line["surcharge"] + line["interest"], 2)   # interest is excluded from the commission base, like surcharge
        receipt_no = await _next_receipt_no(session, policy.tenant_id)
        doc = document_generator.generate_receipt({
            "policy_id": policy.id, "tenant_name": tenant.name if tenant else "Insurer",
            "customer_name": customer.name if customer else "—",
            "policy_number": policy.policy_number, "installment_no": sched.installment_no,
            "paid_date": date.today().isoformat(), "method": case.payment_method,
            "payment_reference": case.payment_reference,
            "base_amount": line["premium"], "surcharge_amount": surcharge, "total_amount": line["total"],
        })
        receipt = PremiumReceipt(
            tenant_id=policy.tenant_id, policy_id=policy.id, schedule_id=sched.id, receipt_no=receipt_no,
            base_amount=line["premium"], surcharge_amount=surcharge, total_amount=line["total"],
            method=case.payment_method, payment_reference=case.payment_reference, document_path=doc["file_path"],
        )
        session.add(receipt)
        await accrue_receipt(session, receipt)
        posted.append({"receipt_no": receipt_no, "installment_no": sched.installment_no, "total": line["total"]})
    return posted


async def _new_reinstatement_version(
    session: AsyncSession, policy: Policy, case: PolicyReinstatement, actor: str,
) -> PolicyVersion:
    """Append the reinstatement transaction to the policy's version history (carrying
    any accepted loading / exclusion) and re-price the instalments still to come."""
    current = await _current_version(session, policy)
    today = date.today()
    terms = case.terms_json or {}
    extra = float(terms.get("additional_annual_premium") or 0.0) if case.terms_response == "Accepted" else 0.0

    base = dict(base_premium=0.0, loading_amount=0.0, policy_fee=0.0, tax_amount=0.0, total_premium=0.0)
    loadings, exclusions = None, None
    if current is not None:
        base = dict(base_premium=current.base_premium, loading_amount=current.loading_amount,
                    policy_fee=current.policy_fee, tax_amount=current.tax_amount, total_premium=current.total_premium)
        loadings, exclusions = _as_dict(current.loadings_json) or None, _as_dict(current.exclusions_json) or None
        if current.effective_to is None:
            current.effective_to = today
            session.add(current)

    old_total = base["total_premium"]
    if extra:
        base["loading_amount"] = round(base["loading_amount"] + extra, 2)
        base["total_premium"] = round(base["total_premium"] + extra, 2)
        loadings = {**(loadings or {}), "reinstatement": {
            "case_no": case.case_no, "loading_pct": terms.get("loading_pct"), "additional_annual_premium": extra}}
    if terms.get("exclusions") and case.terms_response == "Accepted":
        exclusions = {**(exclusions or {}), "reinstatement": [terms["exclusions"]]}

    version = PolicyVersion(
        policy_id=policy.id, version_number=_next_version_number(current),
        effective_from=today, effective_to=None, loadings_json=loadings, exclusions_json=exclusions,
        created_by=actor, event_type="Reinstatement", **base,
    )
    session.add(version)
    await session.flush()
    policy.current_version_id = version.id
    session.add(policy)

    if extra and old_total > 0:
        ratio = base["total_premium"] / old_total
        future = (await session.exec(select(PremiumSchedule).where(
            PremiumSchedule.policy_id == policy.id,
            PremiumSchedule.status == PremiumScheduleStatusEnum.PENDING,
            PremiumSchedule.due_date > today,
        ))).all()
        for s in future:
            s.amount_due = round(s.amount_due * ratio, 2)
            session.add(s)
    return version


async def _render_confirmation(session: AsyncSession, policy: Policy, case: PolicyReinstatement,
                               version: Optional[PolicyVersion]) -> str:
    customer = await session.get(Customer, policy.customer_id)
    tenant = await session.get(Tenant, policy.tenant_id)
    arrears = case.arrears_json or {}
    doc = document_generator.generate_reinstatement_confirmation({
        "policy_id": policy.id, "tenant_name": tenant.name if tenant else "Insurer",
        "customer_name": customer.name if customer else "Policyholder",
        "policy_number": policy.policy_number, "product_name": policy.product_name,
        "sum_assured": policy.coverage_amount, "case_no": case.case_no,
        "lapse_date": case.lapse_date.isoformat() if case.lapse_date else None,
        "effective_date": case.effective_date.isoformat() if case.effective_date else None,
        "version_number": version.version_number if version else None,
        "premiums": arrears.get("premiums"), "surcharges": arrears.get("surcharges"),
        "interest": arrears.get("interest"), "fee": arrears.get("fee"), "total": case.payment_amount,
        "payment_reference": case.payment_reference,
        "terms": case.terms_json if case.terms_response == "Accepted" else None,
    })
    case.confirmation_path = doc["file_path"]
    case.confirmation_generated_at = _now()
    return doc["file_path"]


@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinstatement/{case_id}/restore")
async def restore_coverage(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    body: RestoreBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Execute the authorised LAPSED → ACTIVE transition. Verifies every gate again
    (approval, accepted terms, realised funds, evidence, a fresh eligibility pass),
    settles the arrears in the premium ledger, appends a new PolicyVersion and
    generates the confirmation. Cover is effective from today — there is no cover
    for the lapse period."""
    policy = await _get_policy(session, tenant_id, policy_id)
    await _lock_policy(session, policy)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)

    gates = eng.conditions(case)
    labels = {"declaration": "signed declaration", "evidence": "required evidence", "decision": "underwriting approval",
              "terms": "customer acceptance of revised terms", "payment": "realised payment"}
    unmet = [labels[k] for k, ok in gates.items() if not ok]
    if case.status != "Approved" or unmet:
        raise HTTPException(409, "Cannot restore cover yet — outstanding: " + (", ".join(unmet) or "case is not approved"))
    await _require_eligible(session, policy, case)

    actor = body.actor or "ops"
    try:
        receipts = await _post_arrears_receipts(session, policy, case)
        version = await _new_reinstatement_version(session, policy, case, actor)
        today = date.today()
        transition = apply_transition(
            session, policy, PolicyStatusEnum.ACTIVE, event_type="PolicyReinstated", actor=actor,
            detail={"case_no": case.case_no, "case_id": str(case.id),
                    "lapse_date": case.lapse_date.isoformat() if case.lapse_date else None,
                    "effective_date": today.isoformat(), "version": version.version_number,
                    "amount_received": case.payment_amount, "payment_reference": case.payment_reference,
                    "receipts": [r["receipt_no"] for r in receipts],
                    "revised_terms": bool(case.terms_response == "Accepted" and case.terms_json)},
        )
        case.status, case.reinstated_at, case.effective_date = "Reinstated", _now(), today
        case.new_version_id = version.id
        _set_json(case, "receipts_json", receipts)
        await _render_confirmation(session, policy, case, version)
        _touch(case)
        events = [transition, _audit(session, policy, case, "ReinstatementConfirmationIssued", "system",
                                     {"document": f"Reinstatement {case.case_no}"})]
        await session.commit()
    except IllegalStateTransition as exc:
        await session.rollback()
        raise HTTPException(409, str(exc)) from exc
    except HTTPException:
        await session.rollback()
        raise
    except Exception as exc:
        await session.rollback()
        log.exception("Reinstatement %s failed to restore policy %s — rolled back", case.case_no, policy_id)
        raise HTTPException(500, f"Restoring cover failed and was rolled back: {exc}") from exc

    await _publish(request, policy, events)
    log.info("Reinstatement %s: policy %s restored", case.case_no, policy.policy_number)
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Withdraw (before restoration; refunds any funds held)
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinstatement/{case_id}/withdraw")
async def withdraw_reinstatement(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    body: WithdrawBody,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Close an unfinished case. Funds already received are refunded in full — no
    ledger entries exist yet because the arrears post only on restoration."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    _assert_open(case)

    refund_ref = None
    if case.payment_realized_at and case.payment_amount > 0:
        refund = payment_gateway.refund_payment(case.payment_amount)
        refund_ref = refund.reference
        case.refund_reference = refund_ref
    case.status = "Withdrawn"
    case.closed_reason = (body.reason or "Withdrawn by the applicant").strip()
    _touch(case)
    ev = _audit(session, policy, case, "ReinstatementWithdrawn", body.actor,
                {"reason": case.closed_reason, "refund_reference": refund_ref,
                 "refunded": case.payment_amount if refund_ref else 0.0})
    await session.commit()
    await _publish(request, policy, [ev])
    return await _overview(session, policy)


# ══════════════════════════════════════════════════════════════════════════════
# Step 9 — confirmation
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/tenants/{tenant_id}/policies/{policy_id}/reinstatement/{case_id}/confirmation/download")
async def download_confirmation(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    if case.status != "Reinstated":
        raise HTTPException(409, "The confirmation is issued once cover has been restored.")
    if not case.confirmation_path or not os.path.exists(case.confirmation_path):
        version = await session.get(PolicyVersion, case.new_version_id) if case.new_version_id else None
        await _render_confirmation(session, policy, case, version)
        await session.commit()
    return FileResponse(case.confirmation_path, media_type="application/pdf",
                        filename=f"reinstatement_{case.case_no}.pdf")


@router.post("/tenants/{tenant_id}/policies/{policy_id}/reinstatement/{case_id}/confirmation/send")
async def send_confirmation(
    tenant_id: UUID, policy_id: UUID, case_id: UUID,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Email the reinstatement confirmation to the policyholder (best-effort, like the
    other customer emails — `delivered` reports whether the mail provider accepted it)."""
    policy = await _get_policy(session, tenant_id, policy_id)
    case = await _get_case(session, policy_id, case_id)
    if case.status != "Reinstated":
        raise HTTPException(409, "The confirmation can be sent once cover has been restored.")
    customer = await session.get(Customer, policy.customer_id)
    details = (customer.details if customer else None) or {}
    email = details.get("contact_email") or details.get("email")
    if not email:
        raise HTTPException(400, "No email on record — add a contact before sending the confirmation")

    tenant = await session.get(Tenant, policy.tenant_id)
    terms = case.terms_json if case.terms_response == "Accepted" else None
    revised = None
    if terms:
        bits = ([f"{terms['loading_pct']:g}% premium loading"] if terms.get("loading_pct") else []) + \
               ([f"exclusion: {terms['exclusions']}"] if terms.get("exclusions") else [])
        revised = "; ".join(bits)
    subject, text, html = reinstatement_email(
        customer_name=customer.name if customer else "Policyholder",
        tenant_name=tenant.name if tenant else "Your Insurer",
        policy_number=policy.policy_number or "—", case_no=case.case_no,
        lapse_date=case.lapse_date.isoformat() if case.lapse_date else None,
        effective_date=case.effective_date.isoformat() if case.effective_date else "—",
        total_paid=case.payment_amount, revised_terms=revised,
        tenant_phone=tenant.contact_phone if tenant else None,
        tenant_email=tenant.contact_email if tenant else None,
    )
    attachments = [case.confirmation_path] if case.confirmation_path and os.path.exists(case.confirmation_path) else None
    ok = await email_utils.send_email(email, subject, text, html, attachments)
    if ok:
        case.confirmation_sent_at, case.confirmation_sent_to = _now(), email
        _touch(case)
    ev = _audit(session, policy, case, "ReinstatementConfirmationSent", "ops", {"to": email, "delivered": ok})
    await session.commit()
    await _publish(request, policy, [ev])
    return {"sent_to": email, "sent_at": _now().isoformat(), "delivered": ok, "subject": subject}
