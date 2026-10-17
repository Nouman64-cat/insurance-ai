"""Census file upload for Group Life (GROUP_LIFE_PLAN.md Phase 3).

Turns an uploaded CSV/XLSX into the row dicts that census/validate and
census/confirm (routers/organizations.py) already take. Nothing is persisted
here — the caller validates the rows, shows the result, then confirms.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.organizations import _get_master_policy
from routers.users import verify_admin
from services.census_file import MAX_BYTES, CensusFileError, ParsedCensus, parse_census_file

router = APIRouter(prefix="/tenants", tags=["Group Census Upload"])


@router.post(
    "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/census/parse",
    response_model=ParsedCensus,
    dependencies=[Depends(verify_admin)],
)
async def parse_census_upload(
    tenant_id: UUID,
    org_id: UUID,
    mp_id: UUID,
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
):
    await _get_master_policy(tenant_id, org_id, mp_id, session)   # 404s on a foreign/unknown scheme
    data = await file.read(MAX_BYTES + 1)
    try:
        return parse_census_file(file.filename or "", data)
    except CensusFileError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
