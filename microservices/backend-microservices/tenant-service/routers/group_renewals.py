"""Annual renewal of an in-force group scheme (GROUP_LIFE_PLAN.md Phase 5).

Thin HTTP layer over services/group_renewal.py. Everything sits under
/tenants/{t}/organizations/{o}/master-policies/{mp}/renewals, plus one admin
endpoint that runs the daily job on demand.
"""

import os
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import _session_factory, get_session
from routers.group_policies import _publish_certificate_events
from routers.users import verify_admin
from schemas import (
    GroupQuoteDecision,
    GroupQuoteRead,
    RenewalCensusRefresh,
    RenewalPayment,
    RenewalRead,
    RenewalStart,
)
from services.group_renewal import (
    RenewalError,
    decide_renewal,
    generate_renewal_quote,
    get_renewal,
    open_renewal,
    record_renewal_payment,
    refresh_census,
    run_renewal_cycle,
    _scheme,
)
from shared.models.core import GroupQuote, GroupRenewal

router = APIRouter(prefix="/tenants", tags=["Group Renewals"])

_BASE = "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/renewals"


def _http(exc: RenewalError) -> HTTPException:
    return HTTPException(exc.status, exc.detail)


async def _detail(session: AsyncSession, r: GroupRenewal) -> Dict[str, Any]:
    quotes = (await session.exec(select(GroupQuote).where(GroupQuote.renewal_id == r.id).order_by(GroupQuote.version.desc()))).all()
    return {**RenewalRead.model_validate(r).model_dump(mode="json"),
            "quotes": [GroupQuoteRead.model_validate(q).model_dump(mode="json") for q in quotes]}


@router.post(_BASE, status_code=status.HTTP_201_CREATED, dependencies=[Depends(verify_admin)])
async def start_renewal(tenant_id: UUID, org_id: UUID, mp_id: UUID, body: RenewalStart,
                        session: AsyncSession = Depends(get_session)) -> Dict[str, Any]:
    try:
        mp = await _scheme(session, tenant_id, org_id, mp_id)
        return await _detail(session, await open_renewal(session, mp, notes=body.notes))
    except RenewalError as exc:
        await session.rollback()
        raise _http(exc) from exc


@router.get(_BASE, response_model=List[RenewalRead], dependencies=[Depends(verify_admin)])
async def list_renewals(tenant_id: UUID, org_id: UUID, mp_id: UUID, session: AsyncSession = Depends(get_session)):
    return list((await session.exec(select(GroupRenewal).where(
        GroupRenewal.master_policy_id == mp_id, GroupRenewal.tenant_id == tenant_id).order_by(GroupRenewal.created_at.desc()))).all())


@router.get(_BASE + "/{renewal_id}", dependencies=[Depends(verify_admin)])
async def renewal_detail(tenant_id: UUID, org_id: UUID, mp_id: UUID, renewal_id: UUID,
                         session: AsyncSession = Depends(get_session)) -> Dict[str, Any]:
    try:
        return await _detail(session, await get_renewal(session, tenant_id, mp_id, renewal_id))
    except RenewalError as exc:
        raise _http(exc) from exc


@router.post(_BASE + "/{renewal_id}/census-refresh", dependencies=[Depends(verify_admin)])
async def census_refresh(tenant_id: UUID, org_id: UUID, mp_id: UUID, renewal_id: UUID, body: RenewalCensusRefresh,
                         session: AsyncSession = Depends(get_session), request: Request = None) -> Dict[str, Any]:  # type: ignore[assignment]
    try:
        renewal = await get_renewal(session, tenant_id, mp_id, renewal_id)
        out = await refresh_census(session, renewal, tenant_id, org_id, body.employees, effective_date=body.effective_date,
                                   remove_missing=body.remove_missing, preview=body.preview, requested_by=body.requested_by)
    except RenewalError as exc:
        await session.rollback()
        raise _http(exc) from exc
    await _publish_certificate_events(request, out.pop("_emitted", []))
    return out


@router.post(_BASE + "/{renewal_id}/quote", response_model=GroupQuoteRead, status_code=status.HTTP_201_CREATED, dependencies=[Depends(verify_admin)])
async def renewal_quote(tenant_id: UUID, org_id: UUID, mp_id: UUID, renewal_id: UUID, session: AsyncSession = Depends(get_session)):
    try:
        renewal = await get_renewal(session, tenant_id, mp_id, renewal_id)
        return await generate_renewal_quote(session, renewal, tenant_id, org_id)
    except RenewalError as exc:
        await session.rollback()
        raise _http(exc) from exc


@router.get(_BASE + "/{renewal_id}/quote/document", dependencies=[Depends(verify_admin)])
async def renewal_quote_document(tenant_id: UUID, org_id: UUID, mp_id: UUID, renewal_id: UUID, session: AsyncSession = Depends(get_session)):
    quote = (await session.exec(select(GroupQuote).where(GroupQuote.renewal_id == renewal_id, GroupQuote.tenant_id == tenant_id)
                                .order_by(GroupQuote.version.desc()))).first()
    if quote is None or not quote.document_path or not os.path.exists(quote.document_path):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No renewal quote document yet.")
    return FileResponse(quote.document_path, media_type="application/pdf", filename=f"renewal-quote-v{quote.version}.pdf")


@router.post(_BASE + "/{renewal_id}/accept", response_model=RenewalRead, dependencies=[Depends(verify_admin)])
async def accept_renewal(tenant_id: UUID, org_id: UUID, mp_id: UUID, renewal_id: UUID, body: GroupQuoteDecision,
                         session: AsyncSession = Depends(get_session)):
    try:
        return await decide_renewal(session, await get_renewal(session, tenant_id, mp_id, renewal_id), True, body.decided_by, body.notes)
    except RenewalError as exc:
        await session.rollback()
        raise _http(exc) from exc


@router.post(_BASE + "/{renewal_id}/decline", response_model=RenewalRead, dependencies=[Depends(verify_admin)])
async def decline_renewal(tenant_id: UUID, org_id: UUID, mp_id: UUID, renewal_id: UUID, body: GroupQuoteDecision,
                          session: AsyncSession = Depends(get_session)):
    try:
        return await decide_renewal(session, await get_renewal(session, tenant_id, mp_id, renewal_id), False, body.decided_by, body.notes)
    except RenewalError as exc:
        await session.rollback()
        raise _http(exc) from exc


@router.post(_BASE + "/{renewal_id}/payments", response_model=RenewalRead, dependencies=[Depends(verify_admin)])
async def renewal_payment(tenant_id: UUID, org_id: UUID, mp_id: UUID, renewal_id: UUID, body: RenewalPayment,
                          session: AsyncSession = Depends(get_session), request: Request = None):  # type: ignore[assignment]
    try:
        renewal = await get_renewal(session, tenant_id, mp_id, renewal_id)
        renewal, emitted = await record_renewal_payment(session, renewal, tenant_id, org_id, body.reference, body.amount)
    except RenewalError as exc:
        await session.rollback()
        raise _http(exc) from exc
    await _publish_certificate_events(request, emitted)
    return renewal


@router.post("/{tenant_id}/group-renewals/run", dependencies=[Depends(verify_admin)])
async def run_cycle(tenant_id: UUID) -> Dict[str, List[str]]:
    """Run the daily renewal job now, for this tenant: open renewals for schemes expiring
    within the lead window, lapse the ones that were never completed."""
    return await run_renewal_cycle(_session_factory, tenant_id=tenant_id)
