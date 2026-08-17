"""
Pre-Underwriting — Insurance History Check.

The fifth pre-underwriting clearance gate, sitting alongside the E-Application,
the ACR, the PEP/Sanctions screen and the IPP. Where compliance asks whether the
applicant may be insured, this asks whether they are *already* insured and
whether the totals reconcile: over-insurance against Human Life Value, policy
replacement/churning, and non-disclosure of cover this insurer can already see
on its own books.

The engine is services/insurance_history.py; this router only persists its
verdict onto a single InsuranceHistoryCheck row per case and exposes the same
flag → clear/fail override path an underwriter already has on ComplianceCheck.

Placement note: this is deliberately *pre*-underwriting, not Stage A
pre-issuance. Aggregate exposure changes which tests the medical grid mandates
and how much cover has to be ceded, so it must be settled before the risk
engine runs — not after a decision has already been made on it.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, _role_name, oauth2_scheme
from services import insurance_history as history_engine
from shared.models.core import (
    Case,
    Customer,
    CustomerEApplication,
    InsuranceHistoryCheck,
    InsuranceHistoryStatusEnum,
    Policy,
)

router = APIRouter(tags=["Pre-Underwriting — Insurance History"])

# Overriding an adverse history finding is an underwriting call, not a data-entry
# one — the same split cases.py applies to case decisions.
_OVERRIDE_ROLES = {"Underwriter", "Admin", "SuperAdmin"}


async def _get_case(session: AsyncSession, tenant_id: UUID, case_id: UUID) -> Case:
    case = await session.get(Case, case_id)
    if case is None or case.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


async def _policy_for_case(session: AsyncSession, case: Case) -> Optional[Policy]:
    if case.policy_id is not None:
        policy = await session.get(Policy, case.policy_id)
        if policy is not None:
            return policy
    stmt = (
        select(Policy)
        .where(Policy.tenant_id == case.tenant_id, Policy.customer_id == case.customer_id)
        .order_by(Policy.created_at.desc())  # type: ignore[arg-type]
    )
    return (await session.exec(stmt)).first()


async def _load_check(session: AsyncSession, case_id: UUID) -> Optional[InsuranceHistoryCheck]:
    stmt = select(InsuranceHistoryCheck).where(InsuranceHistoryCheck.case_id == case_id)
    return (await session.exec(stmt)).first()


def _to_dict(check: Optional[InsuranceHistoryCheck]) -> dict:
    if check is None:
        return {
            "status": InsuranceHistoryStatusEnum.NOT_STARTED.value,
            "score": None,
            "checked_at": None,
            "proposed_sum_assured": 0.0,
            "internal_inforce_sum_assured": 0.0,
            "external_declared_sum_assured": 0.0,
            "aggregate_sum_assured": 0.0,
            "hlv_limit": None,
            "hlv_ratio": None,
            "has_prior_decline": False,
            "has_prior_lapse": False,
            "replacement_suspected": False,
            "non_disclosure_suspected": False,
            "internal_policies": [],
            "external_policies": [],
            "findings": [],
            "cleared_by": None,
            "cleared_at": None,
            "clearance_note": None,
        }
    st = check.status.value if hasattr(check.status, "value") else str(check.status)
    return {
        "id": str(check.id),
        "status": st,
        "score": check.score,
        "checked_at": check.checked_at.isoformat() if check.checked_at else None,
        "proposed_sum_assured": check.proposed_sum_assured,
        "internal_inforce_sum_assured": check.internal_inforce_sum_assured,
        "external_declared_sum_assured": check.external_declared_sum_assured,
        "aggregate_sum_assured": check.aggregate_sum_assured,
        "hlv_limit": check.hlv_limit,
        "hlv_ratio": check.hlv_ratio,
        "has_prior_decline": check.has_prior_decline,
        "has_prior_lapse": check.has_prior_lapse,
        "replacement_suspected": check.replacement_suspected,
        "non_disclosure_suspected": check.non_disclosure_suspected,
        "internal_policies": check.internal_policies_json or [],
        "external_policies": check.external_policies_json or [],
        "findings": check.findings_json or [],
        "cleared_by": check.cleared_by,
        "cleared_at": check.cleared_at.isoformat() if check.cleared_at else None,
        "clearance_note": check.clearance_note,
    }


@router.get("/tenants/{tenant_id}/cases/{case_id}/insurance-history")
async def get_insurance_history(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user(token, session)
    await _get_case(session, tenant_id, case_id)
    return _to_dict(await _load_check(session, case_id))


@router.post("/tenants/{tenant_id}/cases/{case_id}/insurance-history/run")
async def run_insurance_history(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """(Re-)run the screen. Idempotent — one row per case, overwritten in place,
    so re-running after the customer submits their E-Application picks up the
    newly declared external cover without leaving a stale verdict behind."""
    await _get_current_user(token, session)
    case = await _get_case(session, tenant_id, case_id)

    customer = await session.get(Customer, case.customer_id)
    if customer is None:
        raise HTTPException(status_code=404, detail="Customer not found")

    policy = await _policy_for_case(session, case)
    if policy is not None and case.policy_id is None:
        case.policy_id = policy.id
        session.add(case)

    e_app = (await session.exec(
        select(CustomerEApplication).where(CustomerEApplication.case_id == case_id)
    )).first()

    result = await history_engine.screen(
        session, tenant_id=tenant_id, customer=customer, policy=policy, e_app=e_app
    )

    now = datetime.utcnow()
    check = await _load_check(session, case_id)
    was_cleared = check is not None and check.cleared_by is not None
    prior_score = check.score if check is not None else None
    prior_finding_codes = (
        {f.get("code") for f in (check.findings_json or [])} if check is not None else set()
    )
    if check is None:
        check = InsuranceHistoryCheck(
            tenant_id=tenant_id, case_id=case_id, customer_id=customer.id
        )

    check.policy_id = policy.id if policy else None
    check.status = InsuranceHistoryStatusEnum(result["status"])
    check.score = result["score"]
    check.proposed_sum_assured = result["proposed_sum_assured"]
    check.internal_inforce_sum_assured = result["internal_inforce_sum_assured"]
    check.external_declared_sum_assured = result["external_declared_sum_assured"]
    check.aggregate_sum_assured = result["aggregate_sum_assured"]
    check.hlv_limit = result["hlv_limit"]
    check.hlv_ratio = result["hlv_ratio"]
    check.has_prior_decline = result["has_prior_decline"]
    check.has_prior_lapse = result["has_prior_lapse"]
    check.replacement_suspected = result["replacement_suspected"]
    check.non_disclosure_suspected = result["non_disclosure_suspected"]
    check.internal_policies_json = result["internal_policies"]
    check.external_policies_json = result["external_policies"]
    check.findings_json = result["findings"]
    check.checked_at = now
    check.updated_at = now

    # Refresh, don't reset: a re-run that surfaces nothing new — same or lower
    # score, no finding codes the underwriter hadn't already seen — is not a
    # risk-affecting change, so the earlier clearance still covers it. Only a
    # materially worse re-screen (score increased, or a finding appeared that
    # wasn't part of what was cleared) requires a fresh look, mirroring how
    # Adamjee's own underwriting treats a risk-affecting change: fresh
    # underwriting via an updated questionnaire, not a blanket reset.
    new_finding_codes = {f.get("code") for f in (result["findings"] or [])}
    materially_worse = (
        prior_score is not None and result["score"] > prior_score
    ) or bool(new_finding_codes - prior_finding_codes - {"CLEAR"})
    if was_cleared:
        if materially_worse:
            check.cleared_by = None
            check.cleared_at = None
            check.clearance_note = None
        else:
            # Nothing worse surfaced — the earlier clearance still covers the
            # fresh findings, so re-apply it the same way clear_insurance_history()
            # does rather than letting the engine's raw re-screen verdict (which
            # can still read FLAGGED on unchanged/lesser findings) override it.
            check.status = InsuranceHistoryStatusEnum.CLEAR

    session.add(check)
    await session.commit()
    await session.refresh(check)

    payload = _to_dict(check)
    # Engine-only context that isn't worth a column but is worth showing.
    payload["hlv_multiple"] = result["hlv_multiple"]
    payload["declaration_flags"] = result["declaration_flags"]
    payload["e_application_available"] = result["e_application_available"]
    return payload


class HistoryOverrideRequest(BaseModel):
    note: Optional[str] = None


async def _assert_override_role(token: str, session: AsyncSession) -> str:
    user = await _get_current_user(token, session)
    role = await _role_name(user, session)
    if role not in _OVERRIDE_ROLES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Overriding an insurance-history finding requires one of: "
                   f"{', '.join(sorted(_OVERRIDE_ROLES))} (you are {role}).",
        )
    return user.email or str(user.id)


@router.post("/tenants/{tenant_id}/cases/{case_id}/insurance-history/clear")
async def clear_insurance_history(
    tenant_id: UUID,
    case_id: UUID,
    body: HistoryOverrideRequest,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Underwriter accepts a flagged history — e.g. the over-insurance is
    justified by evidence held outside the system."""
    actor = await _assert_override_role(token, session)
    await _get_case(session, tenant_id, case_id)

    check = await _load_check(session, case_id)
    if check is None:
        raise HTTPException(status_code=404, detail="No insurance-history screen has been run for this case.")

    now = datetime.utcnow()
    check.status = InsuranceHistoryStatusEnum.CLEAR
    check.cleared_by = actor
    check.cleared_at = now
    check.clearance_note = body.note
    check.updated_at = now
    session.add(check)
    await session.commit()
    await session.refresh(check)
    return _to_dict(check)


@router.post("/tenants/{tenant_id}/cases/{case_id}/insurance-history/fail")
async def fail_insurance_history(
    tenant_id: UUID,
    case_id: UUID,
    body: HistoryOverrideRequest,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    """Underwriter treats the history as adverse — a hard stop the
    pre-underwriting gate honours."""
    actor = await _assert_override_role(token, session)
    await _get_case(session, tenant_id, case_id)

    check = await _load_check(session, case_id)
    if check is None:
        raise HTTPException(status_code=404, detail="No insurance-history screen has been run for this case.")

    now = datetime.utcnow()
    check.status = InsuranceHistoryStatusEnum.FAILED
    check.cleared_by = actor
    check.cleared_at = now
    check.clearance_note = body.note
    check.updated_at = now
    session.add(check)
    await session.commit()
    await session.refresh(check)
    return _to_dict(check)
