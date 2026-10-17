"""Walk-in customers: verify an email with a one-time code, browse plans, submit ONE interest request, follow it.

A walk-in identity is NOT a customer account. Its token has its own audience and scope, so it is accepted only by the
endpoints in this file; every policy, claim, payment, document and family endpoint refuses it. The tenant is fixed by
configuration (CM_WALKIN_TENANT_CODE). The request itself is created in tenant-service by the signed adapter, which is
handed the VERIFIED email from our identity row — never an address typed into the application form.
"""
import logging
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, Header, Request, UploadFile
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text

from app import accounts, db, security, tenant_client
from app.config import settings
from app.deps import client_ip
from app.errors import ApiError, unauthenticated, validation
from app.walkin_profile import FamilyApplication, WalkInProfile

log = logging.getLogger("customer-management.walk-in")
router = APIRouter(prefix="/v1/walk-in", tags=["Walk-in"])
PREFIX = tenant_client.PREFIX + "/walk-in"
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$")
_tenant_cache: dict[str, str] = {}


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


@dataclass
class Walker:
    identity_id: uuid.UUID
    tenant_id: uuid.UUID
    email: str
    display_name: str
    language: str


def dev_otp_allowed() -> bool:
    return bool(settings.walkin_dev_otp) and settings.env != "production"


async def tenant_id() -> str:
    """The one tenant walk-ins belong to; resolved once from configuration through the signed adapter."""
    code = settings.walkin_tenant_code
    if not code:
        raise ApiError(503, "WALK_IN_UNAVAILABLE", "Walk-in registration is not available right now.")
    if code not in _tenant_cache:
        found = await tenant_client.get_client().get(f"{PREFIX}/tenant", code=code)
        _tenant_cache[code] = str(found["tenant_id"])
    return _tenant_cache[code]


async def current_walker(request: Request, authorization: Optional[str] = Header(None)) -> Walker:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise unauthenticated()
    claims = security.decode_walk_in_token(authorization[7:].strip())
    expired = ApiError(401, "SESSION_EXPIRED", "Your session has ended. Please verify your email again.")
    if claims is None:
        raise expired
    async with db.transaction() as conn:
        row = (await conn.execute(text(
            """SELECT i.id, i.tenant_id, i.email, i.display_name, i.language FROM walk_in_sessions s JOIN walk_in_identities i ON i.id = s.identity_id
                WHERE s.id = :s AND i.id = :i AND s.revoked_at IS NULL AND s.expires_at > now()"""),
            {"s": claims["sid"], "i": claims["sub"]})).mappings().first()
    if row is None:
        raise expired
    request.state.account_id = f"walk-in:{row['id']}"
    return Walker(row["id"], row["tenant_id"], row["email"], row["display_name"], row["language"])


# ── plans (public) ────────────────────────────────────────────────────────────

@router.get("/plans")
async def plans():
    """Active plans from the catalogue, without pricing. Public: choosing a plan never needs an account."""
    return await tenant_client.get_client().get(f"{PREFIX}/plans", tenant_id=await tenant_id())


# ── one-time code ─────────────────────────────────────────────────────────────

class OtpRequest(Strict):
    email: str = Field(max_length=255)


class OtpVerify(Strict):
    email: str = Field(max_length=255)
    code: Optional[str] = Field(default=None, min_length=4, max_length=12)     # not needed in demo mode


@router.get("/config")
async def walk_in_config():
    """What the sign-up page needs to know before it asks for anything: in demo mode, no verification code is asked for."""
    return {"demo": settings.demo}


def _email(raw: str) -> str:
    email = raw.strip().lower()
    if not EMAIL_RE.match(email):
        raise ApiError(422, "INVALID_EMAIL", "Enter a valid email address")
    return email


@router.post("/otp/request")
async def otp_request(body: OtpRequest, request: Request):
    email, tid, ip = _email(body.email), await tenant_id(), security.hash_ip(client_ip(request))
    if settings.demo:                       # demo: nothing is emailed and nothing is checked; the page goes straight on
        return {"sent": False, "demo": True, "expires_in": 0}
    async with db.transaction() as conn:
        by_email = (await conn.execute(text("SELECT count(*) FROM walk_in_otps WHERE tenant_id = :t AND email = :e AND created_at > now() - interval '15 minutes'"),
                                       {"t": tid, "e": email})).scalar_one()
        by_ip = (await conn.execute(text("SELECT count(*) FROM walk_in_otps WHERE ip_hash = :ip AND created_at > now() - interval '15 minutes'"), {"ip": ip})).scalar_one()
    if by_email >= settings.walkin_otp_per_email or by_ip >= settings.walkin_otp_per_ip:
        raise ApiError(429, "TOO_MANY_REQUESTS", "Too many codes requested. Please wait a few minutes and try again.", headers={"Retry-After": "300"})

    code = f"{secrets.randbelow(1_000_000):06d}"
    otp_id = uuid.uuid4()
    async with db.transaction() as conn:
        await conn.execute(text("UPDATE walk_in_otps SET consumed_at = now() WHERE tenant_id = :t AND email = :e AND consumed_at IS NULL"), {"t": tid, "e": email})
        await conn.execute(text(
            """INSERT INTO walk_in_otps (id, tenant_id, email, code_hash, ip_hash, expires_at)
               VALUES (:id, :t, :e, :h, :ip, now() + make_interval(mins => :m))"""),
            {"id": otp_id, "t": tid, "e": email, "h": security.otp_hash(email, code), "ip": ip, "m": settings.walkin_otp_minutes})

    delivered = False
    try:
        out = await tenant_client.get_client().post(f"{PREFIX}/otp-email", {"tenant_id": tid, "email": email, "code": code, "minutes": settings.walkin_otp_minutes})
        delivered = bool(out and out.get("delivered"))
    except ApiError as exc:
        log.warning("otp email could not be requested: %s", exc.code)
    if delivered:
        return {"sent": True, "expires_in": settings.walkin_otp_minutes * 60}
    if dev_otp_allowed():                       # development only: the mail provider is not reachable, a fixed code stands in
        async with db.transaction() as conn:
            await conn.execute(text("UPDATE walk_in_otps SET code_hash = :h WHERE id = :id"), {"h": security.otp_hash(email, settings.walkin_dev_otp), "id": otp_id})
        return {"sent": True, "expires_in": settings.walkin_otp_minutes * 60, "dev_mode": True}
    async with db.transaction() as conn:
        await conn.execute(text("UPDATE walk_in_otps SET consumed_at = now() WHERE id = :id"), {"id": otp_id})
    raise ApiError(503, "OTP_DELIVERY_UNAVAILABLE", "We could not send the verification email. Please try again shortly.")


@router.post("/otp/verify")
async def otp_verify(body: OtpVerify, request: Request):
    email, tid = _email(body.email), await tenant_id()
    bad = ApiError(400, "OTP_INVALID", "That code is not correct or has expired. Request a new one.")
    if not settings.demo and not body.code:
        raise bad

    async def attempt(conn):
        if not settings.demo:               # demo mode signs the email in without a code
            row = (await conn.execute(text(
                """SELECT id, code_hash, attempts FROM walk_in_otps WHERE tenant_id = :t AND email = :e AND consumed_at IS NULL AND expires_at > now()
                    ORDER BY created_at DESC LIMIT 1 FOR UPDATE"""), {"t": tid, "e": email})).mappings().first()
            if row is None:
                raise bad
            if row["attempts"] >= settings.walkin_otp_attempts:
                await conn.execute(text("UPDATE walk_in_otps SET consumed_at = now() WHERE id = :id"), {"id": row["id"]})
                raise ApiError(400, "OTP_LOCKED", "Too many incorrect attempts. Request a new code.")
            await conn.execute(text("UPDATE walk_in_otps SET attempts = attempts + 1 WHERE id = :id"), {"id": row["id"]})
            if not secrets.compare_digest(row["code_hash"], security.otp_hash(email, body.code.strip())):
                raise bad
            await conn.execute(text("UPDATE walk_in_otps SET consumed_at = now() WHERE id = :id"), {"id": row["id"]})
        ident = (await conn.execute(text(
            """INSERT INTO walk_in_identities (id, tenant_id, email, last_login_at) VALUES (:id, :t, :e, now())
               ON CONFLICT (tenant_id, email) DO UPDATE SET last_login_at = now() RETURNING id, display_name, language"""),
            {"id": uuid.uuid4(), "t": tid, "e": email})).mappings().one()
        sid = uuid.uuid4()
        await conn.execute(text("INSERT INTO walk_in_sessions (id, identity_id, expires_at) VALUES (:s, :i, now() + make_interval(mins => :m))"),
                           {"s": sid, "i": ident["id"], "m": settings.walkin_session_minutes})
        await accounts.audit(conn, "WALK_IN_VERIFIED", tenant_id=uuid.UUID(tid), identity=str(ident["id"]))
        return ident, sid

    ident, sid = await db.run_committing(attempt)             # a wrong code still counts as an attempt
    token, ttl = security.issue_walk_in_token(identity_id=str(ident["id"]), tenant_id=tid, session_id=str(sid))
    return {"access_token": token, "expires_in": ttl, "scope": "walk_in", "profile": {"email": email, "display_name": ident["display_name"], "language": ident["language"]}}


@router.post("/logout")
async def logout(w: Walker = Depends(current_walker), authorization: Optional[str] = Header(None)):
    claims = security.decode_walk_in_token((authorization or "")[7:].strip()) or {}
    async with db.transaction() as conn:
        await conn.execute(text("UPDATE walk_in_sessions SET revoked_at = now() WHERE id = :s"), {"s": claims.get("sid")})
    return {"ok": True}


# ── profile ───────────────────────────────────────────────────────────────────

@router.get("/me")
async def me(w: Walker = Depends(current_walker)):
    return {"email": w.email, "display_name": w.display_name, "language": w.language}


class ProfileIn(Strict):
    display_name: Optional[str] = Field(default=None, min_length=2, max_length=120)
    language: Optional[str] = Field(default=None, pattern="^(en|ur)$")


@router.patch("/profile")
async def update_profile(body: ProfileIn, w: Walker = Depends(current_walker)):
    async with db.transaction() as conn:
        await conn.execute(text("UPDATE walk_in_identities SET display_name = COALESCE(:n, display_name), language = COALESCE(:l, language) WHERE id = :i"),
                           {"n": body.display_name, "l": body.language, "i": w.identity_id})
    return {"email": w.email, "display_name": body.display_name or w.display_name, "language": body.language or w.language}


# ── application ───────────────────────────────────────────────────────────────

class ApplicationIn(Strict):
    applicant_type: str = Field(default="Self", pattern="^(Self|Family)$")
    profile: Optional[WalkInProfile] = None     # for myself: the details the staff "Add New Customer" form collects
    family: Optional[FamilyApplication] = None  # for my family: the staff "Add New Family" form (details, policy, members)
    plan_id: uuid.UUID
    preferred_contact: str = Field(default="Any", pattern="^(Any|Phone|WhatsApp|Email)$")
    message: Optional[str] = Field(default=None, max_length=1000)
    consent: bool


def _idem(key: Optional[str]) -> str:
    if not key or not (8 <= len(key) <= 64) or not all(ch.isalnum() or ch in "-_" for ch in key):
        raise validation("An Idempotency-Key header (8-64 letters, digits, - or _) is required")
    return key


@router.post("/application")
async def submit_application(body: ApplicationIn, w: Walker = Depends(current_walker), idempotency_key: Optional[str] = Header(None)):
    if not body.consent:
        raise ApiError(422, "CONSENT_REQUIRED", "Consent is required to submit your request")
    if body.applicant_type == "Family" and body.family is None:
        raise ApiError(422, "HOUSEHOLD_REQUIRED", "Add the members of your family")
    if body.applicant_type == "Family" and body.profile is not None:
        raise validation("A family application carries the family form, not a personal one")
    if body.applicant_type == "Self" and (body.profile is None or body.family is not None):
        raise validation("Your details are required")
    payload = body.model_dump(mode="json", exclude_none=True)
    payload.pop("consent")
    out = await tenant_client.get_client().post(f"{PREFIX}/leads", {**payload, "consent": True, "tenant_id": str(w.tenant_id), "email": w.email,
                                                                    "request_key": f"{w.identity_id}:{_idem(idempotency_key)}"[:80]})
    async with db.transaction() as conn:
        await conn.execute(text("UPDATE walk_in_identities SET display_name = :n WHERE id = :i AND display_name = ''"),
                           {"n": (f"{body.profile.first_name} {body.profile.last_name}" if body.profile else (body.family.contact_person or body.family.family_name)).strip(), "i": w.identity_id})
    return out


@router.get("/application")
async def my_applications(w: Walker = Depends(current_walker)):
    data = await tenant_client.get_client().get(f"{PREFIX}/leads", tenant_id=str(w.tenant_id), email=w.email)   # the VERIFIED email, never a parameter
    leads = []
    for lead in data.get("leads", []):
        customer_id = lead.pop("customer_id", None)
        handoff = dict(lead.get("handoff") or {})
        if handoff.get("available") and lead.get("stage") == "Policy Issued" and customer_id:
            async with db.transaction() as conn:
                has_account = (await conn.execute(text("SELECT 1 FROM accounts WHERE tenant_id = :t AND customer_id = :c"), {"t": w.tenant_id, "c": customer_id})).first()
                if has_account:
                    await conn.execute(text("UPDATE walk_in_identities SET handed_off_at = COALESCE(handed_off_at, now()) WHERE id = :i"), {"i": w.identity_id})
            handoff["account_ready"] = bool(has_account) or bool(handoff.get("account_ready"))
        lead["handoff"] = handoff
        leads.append(lead)
    return {"leads": leads}


# ── paying the initial premium from the customer's side (secure link, no sign-in) ──
# The token in the link is the only credential. It lets its holder see ONE payment and add a screenshot to it.

import re as _re

_TOKEN_RE = _re.compile(r"^[0-9a-f]{32}\.[0-9a-f]{40}$")
MAX_PROOF = 10 * 1024 * 1024


def _pay_token(token: str) -> str:
    if not _TOKEN_RE.match(token):
        raise ApiError(404, "PAY_LINK_INVALID", "This payment link is not valid.")
    return token


@router.get("/pay/{token}")
async def pay_details(token: str):
    return await tenant_client.get_client().get(f"{PREFIX}/pay/{_pay_token(token)}")


@router.post("/pay/{token}/proof")
async def pay_proof(token: str, request: Request, file: UploadFile = File(...), note: Optional[str] = Form(None), method: Optional[str] = Form(None),
                    reference: Optional[str] = Form(None)):
    """The customer's receipt (a photo, screenshot or PDF), with how and under what reference they paid."""
    token = _pay_token(token)
    content = await file.read()
    if not content:
        raise ApiError(422, "EMPTY_FILE", "That file is empty.")
    if len(content) > MAX_PROOF:
        raise ApiError(413, "FILE_TOO_LARGE", "That file is too large (10 MB maximum).")
    return await tenant_client.get_client().upload(f"{PREFIX}/pay/{token}/proof", file.filename or "payment.png", content,
                                                    file.content_type or "application/octet-stream", (note or "")[:500] or None,
                                                    {"method": (method or "")[:50], "reference": (reference or "")[:100]})


class DeclareIn(Strict):
    method: Optional[str] = Field(default=None, max_length=50)
    reference: Optional[str] = Field(default=None, max_length=100)
    note: Optional[str] = Field(default=None, max_length=500)


@router.post("/pay/{token}/declare")
async def pay_declare(token: str, body: DeclareIn):
    """"I have paid", without a receipt. Staff see it at once and confirm it."""
    return await tenant_client.get_client().post(f"{PREFIX}/pay/{_pay_token(token)}/declare", body.model_dump(exclude_none=True))
