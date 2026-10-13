"""Account, session and sign-in logic. Raw SQL on the customer_management schema; every function takes the open
transaction so a request is one atomic unit."""
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app import security
from app.config import settings
from app.errors import ApiError, unauthenticated, validation

log = logging.getLogger("customer-management.accounts")


def now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Principal:
    """The authenticated customer. tenant_id / customer_id come from the ACCOUNT row, never from the token or the browser."""
    account_id: uuid.UUID
    tenant_id: uuid.UUID
    customer_id: uuid.UUID
    session_id: uuid.UUID
    scope: str
    username: str
    display_name: str
    language: str
    tenant_code: str
    state: str
    must_change_password: bool


async def audit(conn: AsyncConnection, kind: str, *, account_id=None, tenant_id=None, ip_hash: Optional[str] = None, **detail: Any) -> None:
    """Append to the security trail. `detail` must never contain passwords, hashes or tokens."""
    await conn.execute(text("INSERT INTO security_events (tenant_id, account_id, kind, detail, ip_hash) VALUES (:t, :a, :k, CAST(:d AS jsonb), :ip)"),
                       {"t": tenant_id, "a": account_id, "k": kind, "d": json.dumps(detail, default=str), "ip": ip_hash})


# ── sign-in ───────────────────────────────────────────────────────────────────

async def _recent_failures(conn: AsyncConnection, column: str, value: str, minutes: int) -> int:
    """Failed attempts since the last success inside the window."""
    return (await conn.execute(text(f"""
        SELECT count(*) FROM login_attempts
         WHERE {column} = :v AND outcome <> 'SUCCESS' AND outcome <> 'THROTTLED' AND at > now() - make_interval(mins => :m)
           AND at > COALESCE((SELECT max(at) FROM login_attempts WHERE {column} = :v AND outcome = 'SUCCESS'), '-infinity')"""),
        {"v": value, "m": minutes})).scalar_one()


async def _attempt(conn: AsyncConnection, key: str, ip_hash: str, account_id, outcome: str) -> None:
    await conn.execute(text("INSERT INTO login_attempts (username_key, ip_hash, account_id, outcome) VALUES (:k, :ip, :a, :o)"),
                       {"k": key, "ip": ip_hash, "a": account_id, "o": outcome})


def too_many() -> ApiError:
    return ApiError(429, "TOO_MANY_ATTEMPTS", "Too many sign-in attempts. Please wait a few minutes and try again.",
                    headers={"Retry-After": str(settings.lockout_minutes * 60)})


def invalid_credentials() -> ApiError:
    return ApiError(401, "INVALID_CREDENTIALS", "The username or password is incorrect.")


async def create_session(conn: AsyncConnection, account: dict, scope: str, ip_hash: str, ua_hash: str) -> dict:
    session_id = uuid.uuid4()
    refresh = security.new_refresh_token()
    moment = now()
    absolute = moment + (timedelta(minutes=settings.first_login_window_minutes) if scope == "pwd_change" else timedelta(hours=settings.session_absolute_hours))
    idle = min(moment + timedelta(minutes=settings.session_idle_minutes), absolute)
    await conn.execute(text("""INSERT INTO sessions (id, account_id, scope, refresh_hash, ip_hash, user_agent_hash, idle_expires_at, absolute_expires_at)
                               VALUES (:id, :a, :s, :rh, :ip, :ua, :idle, :abs)"""),
                       {"id": session_id, "a": account["id"], "s": scope, "rh": security.sha256(refresh), "ip": ip_hash, "ua": ua_hash,
                        "idle": idle, "abs": absolute})
    token, ttl = security.issue_access_token(account_id=str(account["id"]), tenant_id=str(account["tenant_id"]),
                                             customer_id=str(account["customer_id"]), session_id=str(session_id), scope=scope)
    return {"access_token": token, "refresh_token": refresh, "expires_in": ttl, "scope": scope, "session_id": str(session_id)}


def account_public(a: dict) -> dict:
    return {"id": str(a["id"]), "username": a["username"], "display_name": a["display_name"], "language": a["language"],
            "tenant_code": a["tenant_code"], "must_change_password": a["must_change_password"], "state": a["state"]}


async def login(conn: AsyncConnection, *, username: str, password: str, tenant_code: Optional[str], ip: str, user_agent: str) -> dict:
    key = username.strip().lower()[:255]
    ip_hash, ua_hash = security.hash_ip(ip), security.sha256(user_agent or "")[:32]
    if not key:
        raise invalid_credentials()

    # Throttle by typed username AND by IP before doing any password work. Both count attempts for usernames that
    # do not exist, so the response never reveals which usernames are real.
    if await _recent_failures(conn, "ip_hash", ip_hash, settings.ip_window_minutes) >= settings.max_failed_per_ip \
            or await _recent_failures(conn, "username_key", key, settings.user_window_minutes) >= settings.max_failed_per_user:
        await _attempt(conn, key, ip_hash, None, "THROTTLED")
        raise too_many()

    params: dict[str, Any] = {"u": key}
    sql = "SELECT * FROM accounts WHERE lower(username) = :u"
    if tenant_code and tenant_code.strip():
        sql += " AND lower(tenant_code) = :tc"
        params["tc"] = tenant_code.strip().lower()
    rows = (await conn.execute(text(sql + " ORDER BY created_at"), params)).mappings().all()

    if len(rows) > 1:
        # The same username exists in more than one company; the customer must say which.
        security.burn_password_check(password)
        raise ApiError(400, "TENANT_CODE_REQUIRED", "Enter your company code to sign in.")
    if not rows:
        security.burn_password_check(password)
        await _attempt(conn, key, ip_hash, None, "UNKNOWN")
        raise invalid_credentials()

    account = dict(rows[0])
    if account["locked_until"] and account["locked_until"] > now():
        await _attempt(conn, key, ip_hash, account["id"], "THROTTLED")
        raise too_many()

    if not security.verify_password(password, account["password_hash"]):
        failed = account["failed_count"] + 1
        locked = now() + timedelta(minutes=settings.lockout_minutes) if failed >= settings.max_failed_per_user else None
        await conn.execute(text("UPDATE accounts SET failed_count = :f, locked_until = :l, updated_at = now() WHERE id = :id"),
                           {"f": failed, "l": locked, "id": account["id"]})
        await _attempt(conn, key, ip_hash, account["id"], "BAD_PASSWORD")
        await audit(conn, "LOGIN_FAILED" if not locked else "ACCOUNT_LOCKED", account_id=account["id"], tenant_id=account["tenant_id"], ip_hash=ip_hash)
        raise invalid_credentials()

    # Correct password from here on.
    if account["state"] in ("SUSPENDED", "CLOSED"):
        await _attempt(conn, key, ip_hash, account["id"], "SUSPENDED")
        await audit(conn, "LOGIN_BLOCKED", account_id=account["id"], tenant_id=account["tenant_id"], ip_hash=ip_hash, state=account["state"])
        raise ApiError(403, "ACCOUNT_SUSPENDED", "Your online access is suspended. Please contact your insurer.")
    if account["must_change_password"] and account["credential_expires_at"] and account["credential_expires_at"] < now():
        await _attempt(conn, key, ip_hash, account["id"], "EXPIRED")
        raise ApiError(401, "CREDENTIAL_EXPIRED", "Your temporary password has expired. Please ask your insurer for new sign-in details.")

    await conn.execute(text("UPDATE accounts SET failed_count = 0, locked_until = NULL, last_login_at = now(), updated_at = now() WHERE id = :id"), {"id": account["id"]})
    await _attempt(conn, key, ip_hash, account["id"], "SUCCESS")
    scope = "pwd_change" if account["must_change_password"] else "full"
    tokens = await create_session(conn, account, scope, ip_hash, ua_hash)
    await audit(conn, "LOGIN_SUCCESS", account_id=account["id"], tenant_id=account["tenant_id"], ip_hash=ip_hash, scope=scope)
    return {**tokens, "must_change_password": account["must_change_password"], "account": account_public(account)}


# ── session use ───────────────────────────────────────────────────────────────

async def principal_for(conn: AsyncConnection, claims: dict) -> Optional[Principal]:
    row = (await conn.execute(text("""
        SELECT s.id AS sid, s.scope, s.idle_expires_at, s.absolute_expires_at, s.revoked_at, a.*
          FROM sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.id = :sid AND a.id = :aid"""), {"sid": claims["sid"], "aid": claims["sub"]})).mappings().first()
    if row is None or row["revoked_at"] is not None or row["scope"] != claims["scp"]:
        return None
    moment = now()
    if row["idle_expires_at"] < moment or row["absolute_expires_at"] < moment:
        return None
    if row["state"] not in ("ACTIVE", "PROVISIONED") or (row["state"] == "PROVISIONED" and claims["scp"] == "full"):
        return None
    return Principal(account_id=row["id"], tenant_id=row["tenant_id"], customer_id=row["customer_id"], session_id=row["sid"], scope=row["scope"],
                     username=row["username"], display_name=row["display_name"], language=row["language"], tenant_code=row["tenant_code"],
                     state=row["state"], must_change_password=row["must_change_password"])


async def refresh(conn: AsyncConnection, refresh_token: str, ip: str, user_agent: str) -> dict:
    digest = security.sha256(refresh_token)
    row = (await conn.execute(text("SELECT s.*, a.tenant_id, a.customer_id, a.state, a.id AS aid FROM sessions s JOIN accounts a ON a.id = s.account_id "
                                   "WHERE s.refresh_hash = :h OR s.prev_refresh_hash = :h FOR UPDATE OF s"), {"h": digest})).mappings().first()
    if row is None:
        raise unauthenticated()
    if row["refresh_hash"] != digest:
        # Two tabs refreshing together: the loser presents the token the winner just replaced. Tell it to retry with the
        # cookie the winner set, without punishing the session.
        if row["rotated_at"] and (now() - row["rotated_at"]).total_seconds() < settings.refresh_grace_seconds and row["revoked_at"] is None:
            raise ApiError(409, "REFRESH_IN_PROGRESS", "Another tab is renewing the session. Try again.")
        # An already-rotated refresh token came back later: treat the session as stolen.
        await conn.execute(text("UPDATE sessions SET revoked_at = now(), revoke_reason = 'REFRESH_REUSE' WHERE id = :id AND revoked_at IS NULL"), {"id": row["id"]})
        await audit(conn, "REFRESH_REUSE", account_id=row["aid"], tenant_id=row["tenant_id"], ip_hash=security.hash_ip(ip))
        raise ApiError(401, "SESSION_EXPIRED", "Your session has ended. Please sign in again.")
    moment = now()
    if row["revoked_at"] or row["idle_expires_at"] < moment or row["absolute_expires_at"] < moment or row["state"] != "ACTIVE" or row["scope"] != "full":
        raise ApiError(401, "SESSION_EXPIRED", "Your session has ended. Please sign in again.")
    new_refresh = security.new_refresh_token()
    idle = min(moment + timedelta(minutes=settings.session_idle_minutes), row["absolute_expires_at"])
    await conn.execute(text("UPDATE sessions SET refresh_hash = :n, prev_refresh_hash = :o, idle_expires_at = :i, last_seen_at = now(), rotated_at = now() WHERE id = :id"),
                       {"n": security.sha256(new_refresh), "o": digest, "i": idle, "id": row["id"]})
    token, ttl = security.issue_access_token(account_id=str(row["aid"]), tenant_id=str(row["tenant_id"]), customer_id=str(row["customer_id"]),
                                             session_id=str(row["id"]), scope="full")
    return {"access_token": token, "refresh_token": new_refresh, "expires_in": ttl, "scope": "full", "session_id": str(row["id"])}


async def revoke_session(conn: AsyncConnection, session_id, reason: str = "LOGOUT") -> None:
    await conn.execute(text("UPDATE sessions SET revoked_at = now(), revoke_reason = :r WHERE id = :id AND revoked_at IS NULL"), {"id": session_id, "r": reason})


async def revoke_other_sessions(conn: AsyncConnection, account_id, keep_session_id=None, reason: str = "PASSWORD_CHANGED") -> None:
    await conn.execute(text("UPDATE sessions SET revoked_at = now(), revoke_reason = :r WHERE account_id = :a AND revoked_at IS NULL "
                            "AND (CAST(:keep AS uuid) IS NULL OR id <> CAST(:keep AS uuid))"), {"a": account_id, "keep": keep_session_id, "r": reason})


# ── password changes ──────────────────────────────────────────────────────────

async def set_password(conn: AsyncConnection, principal: Principal, *, current_password: str, new_password: str, first_change: bool,
                       ip: str, user_agent: str) -> dict:
    row = (await conn.execute(text("SELECT * FROM accounts WHERE id = :id FOR UPDATE"), {"id": principal.account_id})).mappings().one()
    if not security.verify_password(current_password, row["password_hash"]):
        await audit(conn, "PASSWORD_CHANGE_REJECTED", account_id=row["id"], tenant_id=row["tenant_id"], ip_hash=security.hash_ip(ip))
        raise ApiError(400, "CURRENT_PASSWORD_INCORRECT", "The current password is incorrect.")
    problems = security.password_problems(new_password, username=row["username"], current=current_password)
    if security.verify_password(new_password, row["password_hash"]) and "SAME_AS_CURRENT" not in problems:
        problems.append("SAME_AS_CURRENT")
    if problems:
        raise validation("Choose a stronger password", problems=problems)
    await conn.execute(text("""UPDATE accounts SET password_hash = :h, must_change_password = FALSE, state = 'ACTIVE', password_changed_at = now(),
                               activated_at = COALESCE(activated_at, now()), credential_expires_at = NULL, failed_count = 0, locked_until = NULL,
                               version = version + 1, updated_at = now() WHERE id = :id"""),
                       {"h": security.hash_password(new_password), "id": row["id"]})
    await revoke_other_sessions(conn, row["id"], None)  # every session, including this one: a fresh one is issued below
    account = {**dict(row), "state": "ACTIVE", "must_change_password": False}
    tokens = await create_session(conn, account, "full", security.hash_ip(ip), security.sha256(user_agent or "")[:32])
    await audit(conn, "PASSWORD_FIRST_CHANGE" if first_change else "PASSWORD_CHANGED", account_id=row["id"], tenant_id=row["tenant_id"], ip_hash=security.hash_ip(ip))
    return {**tokens, "account": account_public(account)}


# ── provisioning (called by tenant-service) ───────────────────────────────────

async def ensure_account(conn: AsyncConnection, *, tenant_id, tenant_code: str, customer_id, username: str, password_hash: str, display_name: str,
                         credential_expires_at: Optional[datetime], mode: str, reason: Optional[str], source: str = "provisioning") -> dict:
    """Idempotent, race-safe provisioning. The rules that keep two services from clobbering one password:

      * no account yet                      -> create it (PROVISIONED, must change password);
      * account never signed in (PROVISIONED) -> take the new temporary credentials (an ops re-issue); same hash = no-op;
      * account already ACTIVE / SUSPENDED   -> leave it untouched ("already_active" / "suspended") unless mode == "reset",
        the one explicit staff action that replaces the password and revokes every session.
    """
    row = (await conn.execute(text("SELECT * FROM accounts WHERE tenant_id = :t AND customer_id = :c FOR UPDATE"),
                              {"t": tenant_id, "c": customer_id})).mappings().first()
    if row is None:
        taken = (await conn.execute(text("SELECT 1 FROM accounts WHERE tenant_id = :t AND lower(username) = lower(:u)"), {"t": tenant_id, "u": username})).first()
        if taken:
            raise ApiError(409, "USERNAME_TAKEN", "That username belongs to another customer in this company.")
        account_id = uuid.uuid4()
        await conn.execute(text("""INSERT INTO accounts (id, tenant_id, tenant_code, customer_id, username, password_hash, display_name, credential_expires_at, source)
                                   VALUES (:id, :t, :tc, :c, :u, :h, :n, :exp, :src)"""),
                           {"id": account_id, "t": tenant_id, "tc": tenant_code, "c": customer_id, "u": username, "h": password_hash, "n": display_name,
                            "exp": credential_expires_at, "src": source})
        await audit(conn, "ACCOUNT_PROVISIONED", account_id=account_id, tenant_id=tenant_id, source=source)
        return {"status": "created", "account_id": str(account_id), "username": username}

    if row["state"] == "PROVISIONED" or mode == "reset":
        if row["password_hash"] == password_hash and row["state"] == "PROVISIONED":
            return {"status": "unchanged", "account_id": str(row["id"]), "username": row["username"]}
        if row["state"] == "CLOSED":
            return {"status": "suspended", "account_id": str(row["id"]), "username": row["username"]}
        await conn.execute(text("""UPDATE accounts SET password_hash = :h, must_change_password = TRUE, state = CASE WHEN state = 'SUSPENDED' THEN state ELSE 'PROVISIONED' END,
                                   credential_expires_at = :exp, failed_count = 0, locked_until = NULL, display_name = COALESCE(NULLIF(:n, ''), display_name),
                                   version = version + 1, updated_at = now() WHERE id = :id"""),
                           {"h": password_hash, "exp": credential_expires_at, "n": display_name, "id": row["id"]})
        if row["state"] != "PROVISIONED":
            await revoke_other_sessions(conn, row["id"], None, "STAFF_RESET")
        await audit(conn, "CREDENTIALS_RESET" if row["state"] != "PROVISIONED" else "CREDENTIALS_REISSUED", account_id=row["id"], tenant_id=tenant_id, reason=reason, source=source)
        return {"status": "reset", "account_id": str(row["id"]), "username": row["username"]}

    return {"status": "suspended" if row["state"] in ("SUSPENDED", "CLOSED") else "already_active", "account_id": str(row["id"]), "username": row["username"]}


async def set_state(conn: AsyncConnection, account_id, state: str, reason: Optional[str]) -> bool:
    row = (await conn.execute(text("SELECT tenant_id, state FROM accounts WHERE id = :id FOR UPDATE"), {"id": account_id})).first()
    if row is None:
        return False
    must = (await conn.execute(text("SELECT must_change_password FROM accounts WHERE id = :id"), {"id": account_id})).scalar_one()
    target = state if state == "SUSPENDED" else ("PROVISIONED" if must else "ACTIVE")
    await conn.execute(text("UPDATE accounts SET state = :s, suspended_reason = :r, version = version + 1, updated_at = now() WHERE id = :id"),
                       {"s": target, "r": reason if state == "SUSPENDED" else None, "id": account_id})
    if state == "SUSPENDED":
        await revoke_other_sessions(conn, account_id, None, "SUSPENDED")
    await audit(conn, "ACCOUNT_SUSPENDED" if state == "SUSPENDED" else "ACCOUNT_RELEASED", account_id=account_id, tenant_id=row[0], reason=reason)
    return True


async def import_legacy(conn: AsyncConnection, row: dict) -> str:
    """One-time import of an account issued by the ORIGINAL post-issuance flow (customer_portal_accounts in tenant-service).

    The bcrypt hash is carried over unchanged, so temporary passwords already handed to customers keep working. An account
    that already exists here is never touched (Customer Management is the authority from the moment it has the row)."""
    exists = (await conn.execute(text("SELECT 1 FROM accounts WHERE tenant_id = :t AND customer_id = :c"),
                                 {"t": row["tenant_id"], "c": row["customer_id"]})).first()
    if exists:
        return "skipped_exists"
    if (await conn.execute(text("SELECT 1 FROM accounts WHERE tenant_id = :t AND lower(username) = lower(:u)"), {"t": row["tenant_id"], "u": row["username"]})).first():
        return "skipped_username_taken"
    if not str(row["password_hash"]).startswith("$2"):
        return "skipped_bad_hash"
    activated = not row.get("must_reset", True)
    expires = datetime.fromisoformat(row["credential_expires_at"]).replace(tzinfo=timezone.utc) if row.get("credential_expires_at") else None
    last = datetime.fromisoformat(row["last_login_at"]).replace(tzinfo=timezone.utc) if row.get("last_login_at") else None
    account_id = uuid.uuid4()
    await conn.execute(text("""INSERT INTO accounts (id, tenant_id, tenant_code, customer_id, username, password_hash, display_name, state, must_change_password,
                               credential_expires_at, activated_at, password_changed_at, last_login_at, source)
                               VALUES (:id, :t, :tc, :c, :u, :h, :n, :st, :must, :exp, :act, :act, :last, 'legacy-import')"""),
                       {"id": account_id, "t": row["tenant_id"], "tc": row["tenant_code"], "c": row["customer_id"], "u": row["username"], "h": row["password_hash"],
                        "n": row.get("display_name") or "", "st": "ACTIVE" if activated else "PROVISIONED", "must": not activated,
                        "exp": None if activated else expires, "act": now() if activated else None, "last": last})
    await audit(conn, "ACCOUNT_IMPORTED", account_id=account_id, tenant_id=row["tenant_id"], source="legacy")
    return "imported"
