"""Customer-facing data: dashboard, policies, premiums & payments, claims, documents, profile, notifications.

Everything here is read from — or done through — tenant-service's customer-portal adapter, which owns the insurance
rules. This router only: (1) identifies the customer from the session, (2) names (tenant_id, customer_id) FROM THE
ACCOUNT in every upstream call, (3) shapes the answer for the portal, (4) degrades gracefully when a part is down."""
import asyncio
import hashlib
import json
import logging
import os
import uuid
from datetime import date
from typing import Any, Awaitable, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Header, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from app import accounts, db, labels, notices, security, tenant_client
from app.accounts import Principal
from app.config import settings
from app.deps import current_customer
from app.errors import ApiError, not_found, validation

log = logging.getLogger("customer-management.portal")
router = APIRouter(prefix="/v1", tags=["Customer portal"])

PAY_METHODS = ("JazzCash", "Easypaisa", "Card", "BankTransfer")
OPEN_CLAIM_FINAL = ("closed", "settled", "declined")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


def _up(p: Principal) -> tuple[Any, str]:
    c = tenant_client.get_client()
    return c, c.scope(p.tenant_id, p.customer_id)


async def _safe(coro: Awaitable[Any]) -> tuple[bool, Any]:
    """(ok, value): a failing upstream section must not take the whole page down."""
    try:
        return True, await coro
    except ApiError as exc:
        log.warning("section unavailable: %s", exc.code)
        return False, None


SEGMENTS = ("individual", "family", "all")


def _segment(value: str) -> str:
    if value not in SEGMENTS:
        raise validation("Unknown segment", segments=list(SEGMENTS))
    return value


def _policies(items: list[dict]) -> list[dict]:
    return [labels.decorate_policy(p) for p in items]


def _family_summary(g: dict) -> dict:
    """What the dashboard's Family section shows per family. The floater pool is counted once and the bundle's certificates
    each by their own cover — tenant-service did that arithmetic; this only passes it on."""
    return {"id": g["id"], "name": g["name"], "role": g["role"], "plan_types": g["plan_types"], "arrangements": g["arrangements"],
            "members": g["members"], "totals": g["totals"]}


# ── dashboard ─────────────────────────────────────────────────────────────────

@router.get("/dashboard")
async def dashboard(p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    (ok_prof, profile), (ok_pol, policies), (ok_clm, claims), (ok_fam, families) = await asyncio.gather(
        _safe(c.get(f"{scope}/profile")), _safe(c.get(f"{scope}/policies")), _safe(c.get(f"{scope}/claims")), _safe(c.get(f"{scope}/family")))
    policies = _policies(policies or [])
    claims = claims or []
    in_force = [x for x in policies if x["in_force"]]
    summary: dict[str, Any] = {"total_policies": None, "active_policies": None, "in_force_policies": None, "coverage_total": None,
                               "next_premium": None, "outstanding_amount": None, "remaining_amount": None, "open_claims": None, "upcoming_expiry": []}
    if ok_pol:
        due = [x for x in in_force if x["premium"].get("next_due_date")]
        nxt = min(due, key=lambda x: x["premium"]["next_due_date"], default=None)
        summary.update(
            total_policies=len(policies), active_policies=sum(1 for x in policies if x["status"] == "Active"), in_force_policies=len(in_force),
            # Cover that is actually in force today (Active or in the grace period) — not every policy ever written.
            coverage_total=round(sum(x["sum_assured"] or 0 for x in in_force), 2),
            next_premium=({"policy_id": nxt["id"], "policy_number": nxt["policy_number"], "date": nxt["premium"]["next_due_date"],
                           "amount": nxt["premium"]["next_due_amount"], "state": nxt["premium"]["next_due_state"]} if nxt else None),
            # Payable today (due or overdue) — not the instalments that are still to fall due.
            outstanding_amount=round(sum(x["premium"].get("due_now") or 0 for x in in_force), 2),
            remaining_amount=round(sum(x["premium"].get("remaining") or 0 for x in in_force), 2),
            upcoming_expiry=sorted(
                [{"policy_id": x["id"], "policy_number": x["policy_number"], "date": x["expiry_date"] or x["maturity_date"]}
                 for x in in_force if (x["expiry_date"] or x["maturity_date"]) and 0 <= (date.fromisoformat((x["expiry_date"] or x["maturity_date"])[:10]) - date.today()).days <= 120],
                key=lambda e: e["date"]))
    if ok_clm:
        summary["open_claims"] = sum(1 for x in claims if x["status_key"] not in OPEN_CLAIM_FINAL)
    elif ok_pol:
        summary["open_claims"] = sum((x.get("claims") or {}).get("open", 0) for x in policies)  # fall back to the per-policy counts
    all_notices = notices.build(policies, claims) if ok_pol or ok_clm else []
    async with db.engine().connect() as conn:
        read = {r[0] for r in (await conn.execute(text("SELECT notice_key FROM notification_state WHERE account_id = :a"), {"a": p.account_id})).all()}
    return {
        "customer": {"name": (profile or {}).get("name") or p.display_name, "policyholder_id": (profile or {}).get("policyholder_id") or p.username,
                     "company": ((profile or {}).get("tenant") or {}).get("name")},
        "summary": summary,
        "policies": policies[:5], "claims": claims[:3],
        "notices": [dict(n, read=n["key"] in read) for n in all_notices[:6]],
        "unread_notices": sum(1 for n in all_notices if n["key"] not in read),
        # Present only for customers who belong to a family with issued policies; otherwise the dashboard is exactly as before.
        "family": [_family_summary(g) for g in (families or [])] or None,
        "sections": {"profile": ok_prof, "policies": ok_pol, "claims": ok_clm, "family": ok_fam},
    }


# ── policies ──────────────────────────────────────────────────────────────────

@router.get("/policies")
async def list_policies(segment: str = Query("individual"), p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    items = _policies(await c.get(f"{scope}/policies", segment=_segment(segment)))
    return {"items": items, "total": len(items)}


@router.get("/policies/{policy_id}")
async def policy_detail(policy_id: UUID, p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    return labels.decorate_policy(await c.get(f"{scope}/policies/{policy_id}"))


# ── premiums & payments ───────────────────────────────────────────────────────

@router.get("/payments")
async def payments_overview(segment: str = Query("individual"), p: Principal = Depends(current_customer)):
    """Every policy's premium position in one view, plus the combined payment history. segment=family shows the family
    policies the caller may pay (a floater once; each life-bundle certificate on its own policy)."""
    c, scope = _up(p)
    policies = _policies(await c.get(f"{scope}/policies", segment=_segment(segment)))
    results = await asyncio.gather(*[_safe(c.get(f"{scope}/policies/{x['id']}/premiums")) for x in policies])
    rows, history, failed = [], [], 0
    for pol, (ok, prem) in zip(policies, results):
        if not ok:
            failed += 1
            rows.append({"policy": pol, "premiums": None})
            continue
        rows.append({"policy": pol, "premiums": prem})
        history += [dict(r, policy_id=pol["id"], policy_number=pol["policy_number"]) for r in prem["receipts"]]
    live = [r for r in rows if r["premiums"] and r["policy"]["in_force"]]
    due = [r for r in live if r["premiums"]["summary"]["next_due_date"]]
    nxt = min(due, key=lambda r: r["premiums"]["summary"]["next_due_date"], default=None)
    return {
        "simulated_payments": True, "payments_enabled": settings.payments_enabled,
        "totals": {"total_paid": round(sum(r["premiums"]["summary"]["total_paid"] for r in rows if r["premiums"]), 2),
                   "outstanding": round(sum(r["premiums"]["summary"]["due_now"] for r in live), 2),
                   "remaining": round(sum(r["premiums"]["summary"]["remaining"] for r in live), 2),
                   "overdue": round(sum(r["premiums"]["summary"]["overdue_amount"] for r in live), 2),
                   "next_due": ({"policy_number": nxt["policy"]["policy_number"], "date": nxt["premiums"]["summary"]["next_due_date"],
                                 "amount": nxt["premiums"]["summary"]["next_due_amount"]} if nxt else None)},
        "policies": rows,
        "history": sorted(history, key=lambda r: r["paid_at"], reverse=True),
        "partial": failed > 0,
    }


@router.get("/policies/{policy_id}/premiums")
async def policy_premiums(policy_id: UUID, p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    return {**await c.get(f"{scope}/policies/{policy_id}/premiums"), "simulated_payments": True, "payments_enabled": settings.payments_enabled}


class PayIn(Strict):
    method: str = "JazzCash"
    expected_amount: float = Field(gt=0, le=1_000_000_000)


def _idem(key: Optional[str]) -> str:
    if not key or not (8 <= len(key) <= 64) or not all(ch.isalnum() or ch in "-_" for ch in key):
        raise validation("An Idempotency-Key header (8-64 letters, digits, - or _) is required")
    return key


@router.post("/policies/{policy_id}/premiums/{schedule_id}/pay")
async def pay(policy_id: UUID, schedule_id: UUID, body: PayIn, p: Principal = Depends(current_customer),
              idempotency_key: Optional[str] = Header(None)):
    """Start a SIMULATED premium payment through the platform's mock gateway. No money moves. Safe to retry: the same
    Idempotency-Key never charges twice, and the amount is checked against what the ledger says is payable now."""
    if not settings.payments_enabled:
        raise ApiError(503, "PAYMENTS_DISABLED", "Online premium payment is not available right now.")
    key = _idem(idempotency_key)
    if body.method not in PAY_METHODS:
        raise validation("Choose a supported payment method", methods=list(PAY_METHODS))
    reference = "SIM-" + hashlib.sha256(f"{p.account_id}:{key}".encode()).hexdigest()[:16].upper()
    attempt_id = uuid.uuid4()
    async with db.transaction() as conn:
        # Another attempt on the same installment that is still running blocks this one (double click, two tabs).
        busy = (await conn.execute(text("SELECT 1 FROM payment_attempts WHERE schedule_id = :s AND status = 'PENDING' AND created_at > now() - interval '2 minutes' "
                                        "AND NOT (account_id = :a AND idempotency_key = :k)"), {"s": schedule_id, "a": p.account_id, "k": key})).first()
        inserted = None if busy else (await conn.execute(text(
            """INSERT INTO payment_attempts (id, account_id, tenant_id, policy_id, schedule_id, amount, method, status, gateway_reference, idempotency_key)
               VALUES (:id, :a, :t, :p, :s, :amt, :m, 'PENDING', :ref, :k) ON CONFLICT (account_id, idempotency_key) DO NOTHING RETURNING id"""),
            {"id": attempt_id, "a": p.account_id, "t": p.tenant_id, "p": policy_id, "s": schedule_id, "amt": body.expected_amount, "m": body.method,
             "ref": reference, "k": key})).first()
        existing = None if (busy or inserted) else (await conn.execute(text("SELECT * FROM payment_attempts WHERE account_id = :a AND idempotency_key = :k"),
                                                                     {"a": p.account_id, "k": key})).mappings().first()
    if busy:
        raise ApiError(409, "PAYMENT_IN_PROGRESS", "A payment for this installment is already being processed.")
    if existing:
        if existing["schedule_id"] != schedule_id or existing["policy_id"] != policy_id:
            raise ApiError(409, "IDEMPOTENCY_CONFLICT", "That request key was already used for a different payment.")
        if existing["status"] == "SUCCEEDED":
            return {"status": "PAID", "simulated": True, "duplicate": True, "attempt_id": str(existing["id"]), "receipt": {"receipt_no": existing["receipt_no"]}}
        if existing["status"] == "PENDING":
            raise ApiError(409, "PAYMENT_IN_PROGRESS", "This payment is still being processed.")
        raise ApiError(402, existing["failure_code"] or "PAYMENT_DECLINED", "This payment attempt did not go through. Nothing was charged.")

    c, scope = _up(p)
    try:
        result = await c.post(f"{scope}/policies/{policy_id}/premiums/{schedule_id}/pay",
                              {"method": body.method, "reference": reference, "expected_amount": body.expected_amount, "account_ref": p.username})
    except ApiError as exc:
        # ALREADY_PAID from a concurrent staff/other-tab payment is a definitive "no charge"; unavailable stays retryable.
        final = exc.code != "DOMAIN_UNAVAILABLE"
        async with db.transaction() as conn:
            if final:
                await conn.execute(text("UPDATE payment_attempts SET status = 'FAILED', failure_code = :c, updated_at = now() WHERE id = :id"), {"c": exc.code, "id": attempt_id})
            else:
                await conn.execute(text("DELETE FROM payment_attempts WHERE id = :id"), {"id": attempt_id})  # unknown outcome upstream: allow a clean retry
        raise
    async with db.transaction() as conn:
        await conn.execute(text("UPDATE payment_attempts SET status = 'SUCCEEDED', receipt_no = :r, updated_at = now() WHERE id = :id"),
                           {"r": (result.get("receipt") or {}).get("receipt_no"), "id": attempt_id})
        await accounts.audit(conn, "PREMIUM_PAID_SIMULATED", account_id=p.account_id, tenant_id=p.tenant_id, policy_id=str(policy_id), amount=body.expected_amount)
    return {**result, "attempt_id": str(attempt_id), "duplicate": False}


# ── claims ────────────────────────────────────────────────────────────────────

def _claim_decorate(c: dict) -> dict:
    return c


@router.get("/claims")
async def list_claims(segment: str = Query("individual"), p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    items = await c.get(f"{scope}/claims", segment=_segment(segment))
    return {"items": items, "total": len(items)}


@router.get("/claims/{claim_id}")
async def claim_detail(claim_id: UUID, p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    return await c.get(f"{scope}/claims/{claim_id}")


@router.get("/policies/{policy_id}/claims/options")
async def claim_options(policy_id: UUID, p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    return await c.get(f"{scope}/policies/{policy_id}/claims/options")


class ClaimIn(Strict):
    category: str = Field(min_length=3, max_length=40)  # the adapter refuses anything but the self-claim categories
    event_date: date
    event_end_date: Optional[date] = None
    cause: Optional[str] = Field(default=None, max_length=100)
    event_place: Optional[str] = Field(default=None, max_length=255)
    description: str = Field(min_length=10, max_length=4000)
    claimed_amount: float = Field(gt=0, le=1_000_000_000)
    event_details: dict = Field(default_factory=dict)
    # Family policies: who the claim is for (defaults to the caller) and, for another adult, that they agreed to it.
    covered_person_id: Optional[UUID] = None
    consent_confirmed: bool = False


async def _idempotent(p: Principal, scope: str, key: str, payload: dict, run) -> Any:
    """Run `run()` at most once per (account, scope, key). A replay returns the first answer; a different body under the
    same key is refused; a failed first attempt frees the key for a retry."""
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    async with db.transaction() as conn:
        claimed = (await conn.execute(text("INSERT INTO idempotency_keys (account_id, scope, key, request_hash) VALUES (:a, :s, :k, :h) "
                                           "ON CONFLICT DO NOTHING RETURNING 1"), {"a": p.account_id, "s": scope, "k": key, "h": digest})).first()
        row = None if claimed else (await conn.execute(text("SELECT request_hash, status_code, response FROM idempotency_keys WHERE account_id = :a AND scope = :s AND key = :k"),
                                                       {"a": p.account_id, "s": scope, "k": key})).mappings().first()
    if row:
        if row["request_hash"] != digest:
            raise ApiError(409, "IDEMPOTENCY_CONFLICT", "That request key was already used for a different request.")
        if row["response"] is None:
            raise ApiError(409, "REQUEST_IN_PROGRESS", "This request is still being processed.")
        return row["response"]
    try:
        result = await run()
    except BaseException:
        async with db.transaction() as conn:
            await conn.execute(text("DELETE FROM idempotency_keys WHERE account_id = :a AND scope = :s AND key = :k"), {"a": p.account_id, "s": scope, "k": key})
        raise
    async with db.transaction() as conn:
        await conn.execute(text("UPDATE idempotency_keys SET status_code = 201, response = CAST(:r AS jsonb) WHERE account_id = :a AND scope = :s AND key = :k"),
                           {"r": json.dumps(result, default=str), "a": p.account_id, "s": scope, "k": key})
    return result


@router.post("/policies/{policy_id}/claims", status_code=201)
async def submit_claim(policy_id: UUID, body: ClaimIn, p: Principal = Depends(current_customer), idempotency_key: Optional[str] = Header(None)):
    """A policyholder's own claim (hospitalisation / disability). Death claims are not accepted here: they need the
    claimant (a nominee or legal heir) to be identified separately, and a deceased policyholder's login must never be
    used for that."""
    key = _idem(idempotency_key)
    c, scope = _up(p)
    payload = body.model_dump(mode="json")
    result = await _idempotent(p, f"claim:{policy_id}", key, payload, lambda: c.post(f"{scope}/policies/{policy_id}/claims", payload))
    async with db.transaction() as conn:
        await accounts.audit(conn, "CLAIM_SUBMITTED", account_id=p.account_id, tenant_id=p.tenant_id, policy_id=str(policy_id), claim=result.get("claim_number"))
    return result


@router.post("/claims/{claim_id}/documents/{doc_key}")
async def upload_claim_document(claim_id: UUID, doc_key: str, request: Request, p: Principal = Depends(current_customer),
                                file: UploadFile = File(...), note: Optional[str] = Form(None)):
    if not (1 <= len(doc_key) <= 60) or not all(ch.isalnum() or ch in "-_" for ch in doc_key):
        raise validation("Unknown document")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > settings.max_upload_bytes + 4096:
        raise ApiError(413, "FILE_TOO_LARGE", "The file is larger than 15 MB.")
    data = await file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise ApiError(413, "FILE_TOO_LARGE", "The file is larger than 15 MB.")
    if not data:
        raise ApiError(400, "FILE_EMPTY", "The file is empty.")
    name = os.path.basename(file.filename or "document")[:120] or "document"
    c, scope = _up(p)
    result = await c.upload(f"{scope}/claims/{claim_id}/documents/{doc_key}", name, data, file.content_type or "application/octet-stream", (note or "")[:500] or None)
    async with db.transaction() as conn:
        await accounts.audit(conn, "CLAIM_DOCUMENT_UPLOADED", account_id=p.account_id, tenant_id=p.tenant_id, claim_id=str(claim_id), document=doc_key)
    return result


# ── documents ─────────────────────────────────────────────────────────────────

@router.get("/documents")
async def list_documents(segment: str = Query("individual"), p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    items = await c.get(f"{scope}/documents", segment=_segment(segment))
    return {"items": items, "total": len(items)}


@router.get("/documents/download")
async def download_document(handle: str = Query(min_length=10, max_length=300), p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    up = await c.download(f"{scope}/documents/download", handle=handle)
    headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
               "Content-Disposition": (up.headers or {}).get("content-disposition", 'attachment; filename="document.pdf"')}
    async with db.transaction() as conn:
        await accounts.audit(conn, "DOCUMENT_DOWNLOADED", account_id=p.account_id, tenant_id=p.tenant_id, document_kind=handle.split(":", 1)[0])
    return Response(up.content, media_type=(up.headers or {}).get("content-type", "application/octet-stream"), headers=headers)


# ── profile ───────────────────────────────────────────────────────────────────

@router.get("/profile")
async def profile(p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    return {**await c.get(f"{scope}/profile"), "username": p.username, "language": p.language}


class ContactIn(Strict):
    current_password: str = Field(min_length=1, max_length=256)
    email: Optional[str] = Field(default=None, max_length=255)
    phone: Optional[str] = Field(default=None, max_length=30)
    address: Optional[str] = Field(default=None, max_length=500)


@router.patch("/profile/contact")
async def update_contact(body: ContactIn, request: Request, p: Principal = Depends(current_customer)):
    """Contact details only, and only after the customer re-enters their password. Identity details (name, CNIC, date of
    birth) are changed through the insurer's correction process, not here."""
    async with db.engine().connect() as conn:
        hashed = (await conn.execute(text("SELECT password_hash FROM accounts WHERE id = :id"), {"id": p.account_id})).scalar_one()
    if not security.verify_password(body.current_password, hashed):
        raise ApiError(400, "CURRENT_PASSWORD_INCORRECT", "The password you entered is incorrect.")
    c, scope = _up(p)
    result = await c.patch(f"{scope}/profile/contact", body.model_dump(exclude={"current_password"}, exclude_none=True) | {"actor": f"customer:{p.username}"})
    async with db.transaction() as conn:
        await accounts.audit(conn, "CONTACT_UPDATED", account_id=p.account_id, tenant_id=p.tenant_id,
                             fields=[k for k in ("email", "phone", "address") if getattr(body, k)])
    return result


# ── notifications ─────────────────────────────────────────────────────────────

@router.get("/notifications")
async def list_notifications(p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    ok_pol, policies = await _safe(c.get(f"{scope}/policies", segment="all"))
    ok_clm, claims = await _safe(c.get(f"{scope}/claims", segment="all"))
    if not ok_pol and not ok_clm:
        raise ApiError(503, "DOMAIN_UNAVAILABLE", "Notifications are temporarily unavailable.")
    built = notices.build(_policies(policies or []), claims or [])
    async with db.engine().connect() as conn:
        read = {r[0] for r in (await conn.execute(text("SELECT notice_key FROM notification_state WHERE account_id = :a"), {"a": p.account_id})).all()}
    items = [dict(n, read=n["key"] in read) for n in built]
    return {"items": items, "total": len(items), "unread": sum(1 for n in items if not n["read"]), "partial": not (ok_pol and ok_clm)}


class ReadIn(Strict):
    keys: list[str] = Field(default_factory=list, max_length=200)
    all: bool = False


@router.post("/notifications/read")
async def mark_read(body: ReadIn, p: Principal = Depends(current_customer)):
    keys = body.keys
    if body.all:
        c, scope = _up(p)
        _, policies = await _safe(c.get(f"{scope}/policies", segment="all"))
        _, claims = await _safe(c.get(f"{scope}/claims", segment="all"))
        keys = [n["key"] for n in notices.build(_policies(policies or []), claims or [])]
    async with db.transaction() as conn:
        for k in keys[:500]:
            await conn.execute(text("INSERT INTO notification_state (account_id, notice_key) VALUES (:a, :k) ON CONFLICT DO NOTHING"), {"a": p.account_id, "k": k[:200]})
    return {"marked": len(keys)}


# ── renewals (the existing renewal engine, customer-safe) ─────────────────────

@router.get("/policies/{policy_id}/renewal")
async def renewal_status(policy_id: UUID, p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    return await c.get(f"{scope}/policies/{policy_id}/renewal")


class RenewalAcceptanceIn(Strict):
    accepted: bool
    note: Optional[str] = Field(default=None, max_length=500)


@router.post("/policies/{policy_id}/renewal/acceptance")
async def renewal_acceptance(policy_id: UUID, body: RenewalAcceptanceIn, p: Principal = Depends(current_customer)):
    c, scope = _up(p)
    result = await c.post(f"{scope}/policies/{policy_id}/renewal/acceptance", body.model_dump(exclude_none=True))
    async with db.transaction() as conn:
        await accounts.audit(conn, "RENEWAL_TERMS_ACCEPTED" if body.accepted else "RENEWAL_TERMS_DECLINED", account_id=p.account_id, tenant_id=p.tenant_id, policy_id=str(policy_id))
    return result
