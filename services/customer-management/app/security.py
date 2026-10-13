"""Passwords, tokens and hashing helpers. No secret is ever logged from here."""
import hashlib
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import settings

# Same scheme as tenant-service's CustomerPortalAccount, so hashes issued by the post-issuance flow verify as they are.
_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

# A real bcrypt hash of a random string, verified when the username does not exist so "unknown user" costs the same as
# "wrong password".
_DUMMY_HASH = _pwd.hash(secrets.token_urlsafe(16))

COMMON = {"password", "password1", "password123", "123456789", "1234567890", "qwerty123", "iloveyou1", "welcome123",
          "letmein123", "admin12345", "changeme123", "pakistan123", "insurance123"}


def hash_password(raw: str) -> str:
    return _pwd.hash(raw)


def verify_password(raw: str, hashed: Optional[str]) -> bool:
    try:
        return _pwd.verify(raw, hashed or _DUMMY_HASH) and bool(hashed)
    except (ValueError, TypeError):
        return False


def burn_password_check(raw: str) -> None:
    """Constant-ish work for unknown usernames."""
    try:
        _pwd.verify(raw, _DUMMY_HASH)
    except (ValueError, TypeError):
        pass


def password_problems(new: str, *, username: str = "", current: str = "") -> list[str]:
    """Reasons a new password is not acceptable (machine codes the portal translates)."""
    out = []
    if len(new) < 10:
        out.append("TOO_SHORT")
    if len(new) > 128:
        out.append("TOO_LONG")
    if not re.search(r"[A-Za-z]", new) or not re.search(r"\d", new):
        out.append("NEEDS_LETTER_AND_DIGIT")
    low = new.lower()
    if low in COMMON or len(set(low)) <= 3:
        out.append("TOO_COMMON")
    if username and username.lower() in low:
        out.append("CONTAINS_USERNAME")
    if current and new == current:
        out.append("SAME_AS_CURRENT")
    return out


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def hash_ip(ip: str) -> str:
    # Keyed so raw IPs are not recoverable from the table.
    return hashlib.sha256(f"{settings.jwt_secret}|ip|{ip}".encode()).hexdigest()[:32]


def new_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def issue_access_token(*, account_id: str, tenant_id: str, customer_id: str, session_id: str, scope: str) -> tuple[str, int]:
    now = datetime.now(timezone.utc)
    ttl = settings.access_ttl_minutes if scope == "full" else settings.first_login_window_minutes
    claims = {"iss": settings.jwt_issuer, "aud": settings.jwt_audience, "sub": account_id, "tid": tenant_id, "cid": customer_id,
              "sid": session_id, "scp": scope, "jti": uuid.uuid4().hex, "iat": int(now.timestamp()),
              "exp": int((now + timedelta(minutes=ttl)).timestamp())}
    return jwt.encode(claims, settings.jwt_secret, algorithm="HS256", headers={"typ": "at+jwt"}), ttl * 60


def decode_access_token(token: str) -> Optional[dict[str, Any]]:
    """Claims if the token is a valid, unexpired CUSTOMER token; None for anything else (including staff tokens)."""
    if not settings.jwt_secret:
        return None
    try:
        header = jwt.get_unverified_header(token)
        if header.get("typ") != "at+jwt" or header.get("alg") != "HS256":
            return None
        claims = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"], audience=settings.jwt_audience, issuer=settings.jwt_issuer)
    except JWTError:
        return None
    return claims if claims.get("scp") in ("full", "pwd_change") and claims.get("sub") and claims.get("sid") else None
