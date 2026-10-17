"""Endpoints only Request Management may call (services/request-management-service).

Every call must carry a valid HMAC signature made with REQUEST_MGMT_SERVICE_KEY
(shared/security/service_auth.py). The key is accepted here and nowhere else, and
these endpoints do only two things:

  GET  /internal/request-management/tenants/{tenant_id}/users
       Who may review: users of ONE tenant, with role and active status. Read-only.

  POST /internal/request-management/tenants/{tenant_id}/customers/{customer_id}/profile-corrections
       Apply an approved profile correction. Tenant-service still decides: the fields
       must be on the shared allowlist (shared/requests/customer_corrections.py), the
       approver must be an active Admin/Underwriter of the same tenant and not the
       requester, and the customer's current values must still equal the reviewed
       "before" values (otherwise 409: someone changed the record since review).
       Idempotent on execution_key: a retry after a crash returns the first result
       instead of applying the change again.

Neither endpoint is reachable through the API gateway.
"""

import hashlib
import json
import os
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm.attributes import flag_modified
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from shared.models.core import Customer, Role, User
from shared.models.request_integration import CustomerProfileCorrection
from shared.requests.customer_corrections import FIELDS, CorrectionValueError, current_value, validate_changes
from shared.security.service_auth import CALLER_HEADER, verify

router = APIRouter(prefix="/internal/request-management", tags=["Internal: Request Management"], include_in_schema=False)

# Who may approve a profile correction. Kept in step with request-management-service's
# capability registry (app/permissions.py); this side enforces it independently.
CORRECTION_APPROVER_ROLES = {"Admin", "Underwriter"}


async def signed_by_request_management(request: Request) -> None:
    key = os.environ.get("REQUEST_MGMT_SERVICE_KEY", "")
    path = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    body = await request.body()
    if not key or request.headers.get(CALLER_HEADER) != "request-management" or not verify(key, request.method, path, body, request.headers):
        raise HTTPException(401, detail={"code": "SERVICE_AUTH_FAILED", "message": "Invalid service signature"})


def _status(user: User) -> str:
    return str(getattr(user.status, "value", user.status))


async def _role_names(session: AsyncSession) -> dict[UUID, str]:
    return {r.id: r.name for r in (await session.exec(select(Role))).all()}


@router.get("/tenants/{tenant_id}/users", dependencies=[Depends(signed_by_request_management)])
async def tenant_users(
    tenant_id: UUID,
    ids: Optional[str] = Query(None, description="Comma-separated user ids"),
    roles: Optional[str] = Query(None, description="Comma-separated role names"),
    session: AsyncSession = Depends(get_session),
):
    role_names = await _role_names(session)
    query = select(User).where(User.tenant_id == tenant_id)
    if ids:
        try:
            wanted = [UUID(x) for x in ids.split(",") if x.strip()][:200]
        except ValueError:
            raise HTTPException(422, detail={"code": "VALIDATION", "message": "ids must be UUIDs"})
        query = query.where(User.id.in_(wanted))
    if roles:
        wanted_roles = {r.strip() for r in roles.split(",") if r.strip()}
        query = query.where(User.role_id.in_([rid for rid, name in role_names.items() if name in wanted_roles]))
    users = (await session.exec(query.limit(500))).all()
    return [
        {
            "id": str(u.id),
            "tenant_id": str(u.tenant_id),
            "full_name": u.full_name,
            "email": u.email,
            "role_name": role_names.get(u.role_id, "Viewer"),
            "branch_id": str(u.branch_id) if u.branch_id else None,
            "is_active": bool(u.is_active) and not u.is_deleted and _status(u) == "ACTIVE",
        }
        for u in users
    ]


class FieldChange(BaseModel):
    before: Optional[str] = None
    after: Optional[str] = None


class CorrectionIn(BaseModel):
    execution_key: str = Field(min_length=10, max_length=200)
    request_id: UUID
    revision_no: int = Field(ge=1)
    requested_by: UUID
    approved_by: UUID
    changes: dict[str, FieldChange] = Field(min_length=1, max_length=len(FIELDS))


def _payload_hash(body: CorrectionIn, customer_id: UUID) -> str:
    data = {"customer_id": str(customer_id), "request_id": str(body.request_id), "revision_no": body.revision_no,
            "changes": {k: v.model_dump() for k, v in sorted(body.changes.items())}}
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def _apply(customer: Customer, key: str, value: Any) -> None:
    field = FIELDS[key]
    if field.column:
        setattr(customer, field.column, value)
        return
    section, name = field.details_path  # type: ignore[misc]
    details = dict(customer.details or {})
    part = dict(details.get(section) or {})
    part[name] = value
    details[section] = part
    customer.details = details
    flag_modified(customer, "details")


@router.post("/tenants/{tenant_id}/customers/{customer_id}/profile-corrections", dependencies=[Depends(signed_by_request_management)])
async def apply_profile_correction(tenant_id: UUID, customer_id: UUID, body: CorrectionIn, session: AsyncSession = Depends(get_session)):
    payload_hash = _payload_hash(body, customer_id)

    # Already applied under this execution key: report the original outcome, never apply twice.
    done = (await session.exec(select(CustomerProfileCorrection).where(
        CustomerProfileCorrection.execution_key == body.execution_key))).first()
    if done:
        if done.tenant_id != tenant_id or done.customer_id != customer_id or done.payload_hash != payload_hash:
            raise HTTPException(409, detail={"code": "IDEMPOTENCY_MISMATCH", "message": "This execution key was used for a different correction"})
        return {"status": "ALREADY_APPLIED", "correction_id": str(done.id), "applied_at": done.applied_at.isoformat()}

    try:
        proposed = validate_changes({k: v.after for k, v in body.changes.items()})
    except CorrectionValueError as exc:
        raise HTTPException(422, detail={"code": "VALIDATION", "message": str(exc)})

    if body.approved_by == body.requested_by:
        raise HTTPException(403, detail={"code": "SELF_APPROVAL", "message": "The requester can't approve their own correction"})
    role_names = await _role_names(session)
    approver = await session.get(User, body.approved_by)
    if (not approver or approver.tenant_id != tenant_id or approver.is_deleted or not approver.is_active
            or _status(approver) != "ACTIVE" or role_names.get(approver.role_id) not in CORRECTION_APPROVER_ROLES):
        raise HTTPException(403, detail={"code": "APPROVER_NOT_AUTHORIZED", "message": "The approver can't authorize customer corrections for this tenant"})
    requester = await session.get(User, body.requested_by)
    if not requester or requester.tenant_id != tenant_id:
        raise HTTPException(403, detail={"code": "REQUESTER_NOT_IN_TENANT", "message": "The requester doesn't belong to this tenant"})

    customer = (await session.exec(select(Customer).where(Customer.id == customer_id).with_for_update())).first()
    if not customer or customer.tenant_id != tenant_id:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Customer not found"})

    # Changed since it was reviewed? Then the reviewer approved something that no longer describes the record.
    record = {"details": customer.details, **{f.column: getattr(customer, f.column) for f in FIELDS.values() if f.column}}
    conflicts = [
        {"field": key, "reviewed_before": change.before, "current": current_value(record, key)}
        for key, change in body.changes.items()
        if current_value(record, key) != (change.before.strip() if isinstance(change.before, str) and change.before.strip() else None)
    ]
    if conflicts:
        raise HTTPException(409, detail={"code": "CONFLICT", "message": "The customer record changed after the request was reviewed", "fields": conflicts})

    applied = {}
    for key, value in proposed.items():
        before = current_value(record, key)
        _apply(customer, key, value)
        applied[key] = {"before": before, "after": value}

    correction = CustomerProfileCorrection(
        tenant_id=tenant_id, customer_id=customer_id, execution_key=body.execution_key,
        request_id=body.request_id, revision_no=body.revision_no, requested_by=body.requested_by,
        approved_by=body.approved_by, changes=applied, payload_hash=payload_hash,
    )
    session.add(customer)
    session.add(correction)
    await session.commit()   # the change and its idempotency record commit together
    return {"status": "APPLIED", "correction_id": str(correction.id), "applied_at": correction.applied_at.isoformat(), "changes": applied}
