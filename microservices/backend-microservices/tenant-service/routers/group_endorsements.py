"""Mid-term endorsements on an in-force group scheme (GROUP_LIFE_PLAN.md Phase 4).

Thin HTTP layer over services/group_endorsement_engine.py, which does the
pricing and the database work. All endpoints sit under
/tenants/{t}/organizations/{o}/master-policies/{mp}/endorsements.
"""

import os
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.group_policies import _publish_certificate_events
from routers.users import verify_admin
from schemas import EndorsementRead, EndorsementRequest, EndorsementSettle
from services.group_endorsement_engine import (
    EndorsementError,
    create_endorsement,
    load_scheme,
    preview_endorsement,
    resolve_endorsement,
    settle_endorsement,
)
from shared.models.core import GroupEndorsement

router = APIRouter(prefix="/tenants", tags=["Group Endorsements"])

_BASE = "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/endorsements"


def _http(exc: EndorsementError) -> HTTPException:
    return HTTPException(exc.status, exc.detail)


async def _get(session: AsyncSession, tenant_id: UUID, mp_id: UUID, endorsement_id: UUID) -> GroupEndorsement:
    e = await session.get(GroupEndorsement, endorsement_id)
    if e is None or e.tenant_id != tenant_id or e.master_policy_id != mp_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Endorsement not found.")
    return e


@router.post(_BASE + "/preview", dependencies=[Depends(verify_admin)])
async def preview(tenant_id: UUID, org_id: UUID, mp_id: UUID, body: EndorsementRequest,
                  session: AsyncSession = Depends(get_session)) -> Dict[str, Any]:
    """What the endorsement would do and cost. Nothing is written."""
    try:
        scheme = await load_scheme(session, tenant_id, org_id, mp_id)
        return await preview_endorsement(session, scheme, body.endorsement_type, body.effective_date, body.members)
    except EndorsementError as exc:
        raise _http(exc) from exc


@router.post(_BASE, response_model=EndorsementRead, status_code=status.HTTP_201_CREATED, dependencies=[Depends(verify_admin)])
async def create(tenant_id: UUID, org_id: UUID, mp_id: UUID, body: EndorsementRequest,
                 session: AsyncSession = Depends(get_session), request: Request = None):  # type: ignore[assignment]
    try:
        scheme = await load_scheme(session, tenant_id, org_id, mp_id)
        e = await create_endorsement(session, scheme, body.endorsement_type, body.effective_date, body.members,
                                     body.reason, body.requested_by)
    except EndorsementError as exc:
        await session.rollback()
        raise _http(exc) from exc
    await _publish_certificate_events(request, scheme.emitted)
    return e


@router.get(_BASE, response_model=List[EndorsementRead], dependencies=[Depends(verify_admin)])
async def list_endorsements(tenant_id: UUID, org_id: UUID, mp_id: UUID, session: AsyncSession = Depends(get_session)):
    return list((await session.exec(
        select(GroupEndorsement).where(GroupEndorsement.master_policy_id == mp_id, GroupEndorsement.tenant_id == tenant_id)
        .order_by(GroupEndorsement.created_at.desc()))).all())


@router.get(_BASE + "/{endorsement_id}", response_model=EndorsementRead, dependencies=[Depends(verify_admin)])
async def get_endorsement(tenant_id: UUID, org_id: UUID, mp_id: UUID, endorsement_id: UUID,
                          session: AsyncSession = Depends(get_session)):
    return await _get(session, tenant_id, mp_id, endorsement_id)


@router.post(_BASE + "/{endorsement_id}/resolve", response_model=EndorsementRead, dependencies=[Depends(verify_admin)])
async def resolve(tenant_id: UUID, org_id: UUID, mp_id: UUID, endorsement_id: UUID,
                  session: AsyncSession = Depends(get_session), request: Request = None):  # type: ignore[assignment]
    """Apply the lines that were waiting on an underwriting decision, now that one may exist."""
    e = await _get(session, tenant_id, mp_id, endorsement_id)
    try:
        scheme = await load_scheme(session, tenant_id, org_id, mp_id)
        e = await resolve_endorsement(session, scheme, e)
    except EndorsementError as exc:
        await session.rollback()
        raise _http(exc) from exc
    await _publish_certificate_events(request, scheme.emitted)
    return e


@router.post(_BASE + "/{endorsement_id}/settle", response_model=EndorsementRead, dependencies=[Depends(verify_admin)])
async def settle(tenant_id: UUID, org_id: UUID, mp_id: UUID, endorsement_id: UUID, body: EndorsementSettle,
                 session: AsyncSession = Depends(get_session)):
    e = await _get(session, tenant_id, mp_id, endorsement_id)
    try:
        return await settle_endorsement(session, e, body.reference, body.amount)
    except EndorsementError as exc:
        raise _http(exc) from exc


@router.get(_BASE + "/{endorsement_id}/document", dependencies=[Depends(verify_admin)])
async def download(tenant_id: UUID, org_id: UUID, mp_id: UUID, endorsement_id: UUID,
                   session: AsyncSession = Depends(get_session)):
    e = await _get(session, tenant_id, mp_id, endorsement_id)
    if not e.document_path or not os.path.exists(e.document_path):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "The document hasn't been generated.")
    return FileResponse(e.document_path, media_type="application/pdf", filename=f"{e.number}.pdf")
