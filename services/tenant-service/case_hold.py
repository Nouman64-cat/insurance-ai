"""Underwriting hold: the one place that refuses writes to a held case.

A held case is frozen exactly where it stands. Every write to /tenants/{t}/cases/{case}/… is refused with 409 CASE_ON_HOLD,
whichever router owns it (status, requirements, medical, e-application, ACR, insurance history, premium, plan change,
assignment …). Reads, the hold/release pair and notes (comments) stay open, so the reason can be discussed and the hold lifted.
The AI evaluation lives in the API gateway and checks the same flag itself (api-gateway/routers/evaluate.py)."""
import re

from fastapi import Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

import database

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
CASE_WRITE = re.compile(r"^/tenants/([0-9a-fA-F-]{36})/cases/([0-9a-fA-F-]{36})(/[^?]*)?$")
EXEMPT = ("/hold", "/release", "/comments")

ON_HOLD = {"detail": {"code": "CASE_ON_HOLD", "message": "This case is on hold. Remove the hold to continue the underwriting process."}}


def targets_case(method: str, path: str):
    """(tenant_id, case_id) when this request writes to a case that the hold applies to, else None."""
    if method not in WRITE_METHODS:
        return None
    m = CASE_WRITE.match(path)
    if not m or (m.group(3) or "").startswith(EXEMPT):
        return None
    return m.group(1), m.group(2)


async def refuse_writes_on_held_case(request: Request, call_next):
    target = targets_case(request.method, request.url.path)
    if target:
        try:
            async with database._session_factory() as s:
                held = (await s.execute(text('SELECT on_hold FROM cases WHERE "caseld" = :c AND tenant_id = :t'),
                                        {"c": target[1], "t": target[0]})).scalar()
        except Exception:        # the guard must never be what takes writes down
            held = False
        if held:
            return JSONResponse(status_code=409, content=ON_HOLD)
    return await call_next(request)
