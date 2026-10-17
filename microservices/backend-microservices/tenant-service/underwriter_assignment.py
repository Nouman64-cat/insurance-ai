"""Pre-underwriting waits for its underwriters: the one place that refuses gate actions on an unassigned case.

Nothing goes to the customer, and no gate runs, until both the Medical and the Financial review of the case have an
underwriter (case_underwriting_tracks.assigned_user_id). Every write to the gate endpoints of /tenants/{t}/cases/{case}/…
— e-application links and verification, ACR, PEP & sanctions screening, insurance history, medical examination — is
refused with 409 UNDERWRITERS_NOT_ASSIGNED, whichever caller sends it (the case screens or the chat agent). Setting up the
e-application's custom questions is preparation, not a process, and stays open; so do the customer's own public links."""
import re

from fastapi import Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

import database
from case_hold import CASE_WRITE, WRITE_METHODS

GATED = re.compile(r"^/(e-application|acr|compliance|insurance-history|medical-exam)(/|$)")
EXEMPT = ("/e-application/custom-questions",)
REQUIRED = {"MEDICAL": "Medical", "FINANCIAL": "Financial"}


def gated_case(method: str, path: str):
    """(tenant_id, case_id) when this request starts or moves a pre-underwriting gate, else None."""
    if method not in WRITE_METHODS:
        return None
    m = CASE_WRITE.match(path)
    tail = (m.group(3) or "") if m else ""
    if not m or not GATED.match(tail) or tail.startswith(EXEMPT):
        return None
    return m.group(1), m.group(2)


def not_assigned(missing: list[str]) -> dict:
    who = " and ".join(f"a {REQUIRED[t]} Underwriter" for t in missing)
    return {"detail": {"code": "UNDERWRITERS_NOT_ASSIGNED", "missing_tracks": missing,
                       "message": f"Assign {who} to this case first. E-application links and the other "
                                  "pre-underwriting steps start only once both reviews have an underwriter."}}


async def refuse_gates_until_underwriters_assigned(request: Request, call_next):
    target = gated_case(request.method, request.url.path)
    if target:
        try:
            async with database._session_factory() as s:
                rows = (await s.execute(text(
                    "SELECT track FROM case_underwriting_tracks "
                    "WHERE case_id = :c AND tenant_id = :t AND assigned_user_id IS NOT NULL"),
                    {"c": target[1], "t": target[0]})).scalars().all()
            missing = [t for t in REQUIRED if t not in set(rows)]
        except Exception:        # the guard must never be what takes writes down
            missing = []
        if missing:
            return JSONResponse(status_code=409, content=not_assigned(missing))
    return await call_next(request)
