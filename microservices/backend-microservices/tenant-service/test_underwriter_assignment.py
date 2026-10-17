"""Pre-underwriting waits until both the Medical and Financial underwriters are assigned.

Run: docker compose exec -T tenant-service python -m pytest -q test_underwriter_assignment.py
"""
import asyncio
from uuid import uuid4

import httpx
from fastapi import FastAPI

import database
import underwriter_assignment as ua

T, C = str(uuid4()), str(uuid4())


def url(tail: str) -> str:
    return f"/tenants/{T}/cases/{C}{tail}"


def test_only_gate_writes_are_gated():
    for method, tail in (("POST", "/e-application/invite"), ("POST", "/e-application/medical/invite"),
                         ("POST", "/e-application/verify"), ("PUT", "/acr"), ("POST", "/acr/request"),
                         ("POST", "/compliance/run"), ("POST", "/insurance-history/run"),
                         ("POST", "/medical-exam/assess"), ("POST", "/medical-exam/schedule")):
        assert ua.gated_case(method, url(tail)) == (T, C), tail
    for method, tail in (("GET", "/e-application"), ("PUT", "/e-application/custom-questions"),
                         ("PUT", "/underwriting-tracks/MEDICAL"), ("POST", "/hold"), ("POST", "/comments"),
                         ("PATCH", "/status"), ("POST", "/ipp/initiate"), ("POST", "/change-plan")):
        assert ua.gated_case(method, url(tail)) is None, tail
    assert ua.gated_case("POST", "/public/e-application/tok/submit") is None  # the customer's own link


class _Session:
    def __init__(self, assigned):
        self.assigned = assigned
    async def __aenter__(self):
        return self
    async def __aexit__(self, *a):
        return False
    async def execute(self, *a, **kw):
        rows = self.assigned
        class R:
            def scalars(self):
                return self
            def all(self):
                return rows
        return R()


def _call(assigned, tail="/e-application/invite"):
    app = FastAPI()
    app.middleware("http")(ua.refuse_gates_until_underwriters_assigned)

    @app.post("/tenants/{t}/cases/{c}/{rest:path}")
    async def ok(t: str, c: str, rest: str):
        return {"ok": True}

    orig = database._session_factory
    database._session_factory = lambda: _Session(assigned)
    try:
        async def go():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as h:
                return await h.post(url(tail))
        return asyncio.run(go())
    finally:
        database._session_factory = orig


def test_e_application_link_is_refused_until_both_underwriters_are_assigned():
    r = _call([])
    assert r.status_code == 409
    d = r.json()["detail"]
    assert d["code"] == "UNDERWRITERS_NOT_ASSIGNED" and d["missing_tracks"] == ["MEDICAL", "FINANCIAL"]
    assert "Medical Underwriter and a Financial Underwriter" in d["message"]
    r = _call(["MEDICAL"], "/compliance/run")
    assert r.status_code == 409 and r.json()["detail"]["missing_tracks"] == ["FINANCIAL"]
    assert _call(["MEDICAL", "FINANCIAL"]).json() == {"ok": True}
