"""Family insurance for the signed-in customer (Floater and Life Bundle policies).

Same sign-in as everything else: a family head is simply a customer whose account also has family policies behind it. Which
family, policy, member or claim the caller may see is decided by tenant-service from the account's (tenant, customer) pair —
the `{family_id}` in a path is only ever a request to look at that family, never an entitlement.

Everything read here comes from the adapter; the only thing stored here is the customer's own list of servicing requests."""
import logging
import uuid
from datetime import date
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from app import accounts, db, labels, tenant_client
from app.accounts import Principal
from app.deps import current_customer
from app.errors import ApiError, validation
from app.routers.portal import _idem

log = logging.getLogger("customer-management.family")
router = APIRouter(prefix="/v1", tags=["Family"])


def _up(p: Principal):
    c = tenant_client.get_client()
    return c, c.scope(p.tenant_id, p.customer_id)


def _decorate_group(g: dict) -> dict:
    for a in g.get("arrangements", []) or []:
        for pol in a.get("policies", []) if isinstance(a, dict) else []:
            labels.decorate_policy(pol)
    return g


@router.get("/family")
async def list_families(p: Principal = Depends(current_customer)):
    """The families this customer belongs to. An empty list means "individual customer only" — the portal then keeps its
    original, individual-only experience."""
    c, scope = _up(p)
    items = [_decorate_group(g) for g in await c.get(f"{scope}/family")]
    return {"items": items, "total": len(items)}


@router.get("/family/requests")
async def my_requests(p: Principal = Depends(current_customer)):
    async with db.engine().connect() as conn:
        rows = (await conn.execute(text("SELECT id, family_id, policy_id, policy_number, kind, reference, summary, reason, status, created_at, updated_at "
                                        "FROM service_requests WHERE account_id = :a AND status <> 'SUBMITTING' ORDER BY created_at DESC LIMIT 100"),
                                   {"a": p.account_id})).mappings().all()
    items = [{**dict(r), "id": str(r["id"]), "family_id": str(r["family_id"]), "policy_id": str(r["policy_id"]) if r["policy_id"] else None,
              "created_at": r["created_at"].isoformat(), "updated_at": r["updated_at"].isoformat()} for r in rows]
    return {"items": items, "total": len(items)}


@router.get("/family/{family_id}")
async def family_overview(family_id: UUID, p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    return _decorate_group(await c.get(f"{scope}/family/{family_id}"))


@router.get("/family/{family_id}/policies")
async def family_policies(family_id: UUID, p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    return _decorate_group(await c.get(f"{scope}/family/{family_id}/policies"))


@router.get("/family/{family_id}/members")
async def family_members(family_id: UUID, p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    return await c.get(f"{scope}/family/{family_id}/members")


@router.get("/family/{family_id}/members/{member_key}")
async def family_member(family_id: UUID, member_key: str, p: Principal = Depends(current_customer)):
    if not (1 <= len(member_key) <= 80) or not all(ch.isalnum() or ch in "-:_" for ch in member_key):
        raise ApiError(404, "NOT_FOUND", "Record not found")
    c, scope = _up(p)
    return await c.get(f"{scope}/family/{family_id}/members/{member_key}")


@router.get("/family/{family_id}/beneficiaries")
async def family_beneficiaries(family_id: UUID, policy_id: UUID = Query(...), p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    return await c.get(f"{scope}/family/{family_id}/beneficiaries", policy_id=str(policy_id))


# ── servicing requests ────────────────────────────────────────────────────────

KINDS = ("MEMBER_ADD", "MEMBER_REMOVE", "MEMBER_CORRECTION", "COVERAGE_CHANGE", "NOMINEE_CHANGE", "CONTACT_CORRECTION", "CANCELLATION", "REINSTATEMENT")


class Nominee(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=2, max_length=255)
    relationship: str = Field(min_length=2, max_length=100)
    share_pct: float = Field(gt=0, le=100)
    date_of_birth: Optional[date] = None
    cnic: Optional[str] = Field(default=None, max_length=20)
    guardian_name: Optional[str] = Field(default=None, max_length=255)


class RequestIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    kind: str
    policy_id: Optional[UUID] = None
    reason: Optional[str] = Field(default=None, max_length=2000)
    name: Optional[str] = Field(default=None, max_length=255)
    relationship: Optional[str] = Field(default=None, max_length=50)
    dob: Optional[date] = None
    cnic: Optional[str] = Field(default=None, max_length=20)
    insured: bool = False
    member_key: Optional[str] = Field(default=None, max_length=80)
    changes: dict[str, str] = Field(default_factory=dict, max_length=8)
    new_sum_assured: Optional[float] = Field(default=None, gt=0, le=1_000_000_000)
    rider_note: Optional[str] = Field(default=None, max_length=500)
    beneficiaries: list[Nominee] = Field(default_factory=list, max_length=12)
    contact_email: Optional[str] = Field(default=None, max_length=255)
    contact_phone: Optional[str] = Field(default=None, max_length=30)


@router.post("/family/{family_id}/requests", status_code=201)
async def submit_request(family_id: UUID, body: RequestIn, p: Principal = Depends(current_customer), idempotency_key: Optional[str] = Header(None)):
    """Ask the insurer for a change to a family policy. Nothing on an issued contract changes by itself: tenant-service checks
    the request against ownership and the policy's current state and records it for the insurer's staff to action."""
    key = _idem(idempotency_key)
    if body.kind not in KINDS:
        raise validation("Unknown request type", kinds=list(KINDS))
    rid, ref = uuid.uuid4(), "FSR-" + uuid.uuid4().hex[:8].upper()
    async with db.transaction() as conn:
        claimed = (await conn.execute(text(
            """INSERT INTO service_requests (id, account_id, tenant_id, family_id, policy_id, kind, reference, reason, idempotency_key)
               VALUES (:id, :a, :t, :f, :p, :k, :ref, :r, :key) ON CONFLICT (account_id, idempotency_key) DO NOTHING RETURNING id"""),
            {"id": rid, "a": p.account_id, "t": p.tenant_id, "f": family_id, "p": body.policy_id, "k": body.kind, "ref": ref, "r": body.reason, "key": key})).first()
        existing = None if claimed else (await conn.execute(text("SELECT * FROM service_requests WHERE account_id = :a AND idempotency_key = :key"),
                                                            {"a": p.account_id, "key": key})).mappings().first()
    if existing:
        if existing["kind"] != body.kind or existing["family_id"] != family_id:
            raise ApiError(409, "IDEMPOTENCY_CONFLICT", "That request key was already used for a different request.")
        if existing["status"] == "SUBMITTING":
            raise ApiError(409, "REQUEST_IN_PROGRESS", "This request is still being processed.")
        return {"id": str(existing["id"]), "reference": existing["reference"], "kind": existing["kind"], "status": existing["status"], "summary": existing["summary"], "duplicate": True}
    c, scope = _up(p)
    payload = body.model_dump(mode="json", exclude_none=True) | {"reference": ref}
    try:
        result = await c.post(f"{scope}/family/{family_id}/requests", payload)
    except BaseException:
        async with db.transaction() as conn:
            await conn.execute(text("DELETE FROM service_requests WHERE id = :id"), {"id": rid})     # refused or unknown: the key is free again
        raise
    async with db.transaction() as conn:
        await conn.execute(text("UPDATE service_requests SET status = 'SUBMITTED', policy_id = CAST(:p AS uuid), policy_number = :n, summary = CAST(:s AS jsonb), updated_at = now() WHERE id = :id"),
                           {"p": result.get("policy_id"), "n": result.get("policy_number"), "s": __import__("json").dumps(result.get("summary") or {}), "id": rid})
        await accounts.audit(conn, "FAMILY_REQUEST_SUBMITTED", account_id=p.account_id, tenant_id=p.tenant_id, request_kind=body.kind, reference=ref)
    return {"id": str(rid), "reference": ref, "kind": body.kind, "status": "SUBMITTED", "policy_number": result.get("policy_number"), "summary": result.get("summary"), "duplicate": False}


@router.post("/family/requests/{request_id}/withdraw")
async def withdraw_request(request_id: UUID, p: Principal = Depends(current_customer)):
    async with db.transaction() as conn:
        row = (await conn.execute(text("SELECT * FROM service_requests WHERE id = :id AND account_id = :a FOR UPDATE"), {"id": request_id, "a": p.account_id})).mappings().first()
        if row is None:
            raise ApiError(404, "NOT_FOUND", "Record not found")
        if row["status"] != "SUBMITTED":
            raise ApiError(409, "ACTION_NOT_AVAILABLE", "Only a request that is still with the insurer can be withdrawn.")
        c, scope = _up(p)
        await c.post(f"{scope}/family/{row['family_id']}/requests/withdraw", {"reference": row["reference"], "policy_id": str(row["policy_id"]) if row["policy_id"] else None})
        await conn.execute(text("UPDATE service_requests SET status = 'WITHDRAWN', updated_at = now() WHERE id = :id"), {"id": request_id})
        await accounts.audit(conn, "FAMILY_REQUEST_WITHDRAWN", account_id=p.account_id, tenant_id=p.tenant_id, reference=row["reference"])
    return {"id": str(request_id), "status": "WITHDRAWN"}
