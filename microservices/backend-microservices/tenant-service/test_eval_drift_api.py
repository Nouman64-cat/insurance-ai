"""The Drift Monitor API against a running tenant-service (and, with GATEWAY set, through the gateway), with real tokens.
Review items can never be deleted, so run this against the ISOLATED evaluation stack, not the working database.

Run: docker exec eval-tenant-service python test_eval_drift_api.py
"""
import asyncio
import os
import sys
import uuid

import httpx
from sqlmodel import select

import database
from routers.auth import create_access_token
from shared.models.core import Role, User

BASE = os.environ.get("BASE", "http://localhost:8001")
FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


async def tokens():
    async with database._session_factory() as s:
        sa = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
        admin = (await s.exec(select(User).where(User.role_id == sa.id, User.is_deleted == False))).first()  # noqa: E712
        other = (await s.exec(select(User).where(User.role_id != sa.id, User.is_deleted == False))).first()    # noqa: E712
        return create_access_token({"sub": str(admin.id)}), create_access_token({"sub": str(other.id)})


async def main() -> int:
    admin, other = await tokens()
    A, O = {"Authorization": f"Bearer {admin}"}, {"Authorization": f"Bearer {other}"}
    S = {"X-Internal-Secret": os.environ.get("INTERNAL_API_SECRET", "")}
    tag = uuid.uuid4().hex[:6]
    f = {"key": f"api-{tag}", "kind": "rule_changed", "severity": "high", "summary": f"api test {tag}", "affected_cases": ["IND-X-1"], "detail": {}}
    prop = {"key": f"api-p-{tag}", "stage": "kyc", "scenario_type": "negative", "rationale": f"api proposal {tag}", "provenance": {"kind": "coverage"}}
    report = {"scan_id": f"scan-api-{tag}", "dataset": {"dataset": "api-test", "version": "1.0.0", "verified": True}, "counts": {}, "summary": {}, "coverage": {}, "findings": [f], "proposals": [prop]}
    async with httpx.AsyncClient(base_url=BASE, timeout=60) as c:
        check("anonymous callers are refused", (await c.get("/eval/drift/overview")).status_code == 401)
        check("an ordinary user is refused", (await c.get("/eval/drift/overview", headers=O)).status_code == 403)
        check("the worker's endpoints refuse a missing secret", (await c.post("/internal/eval/drift/ingest", json={"worker_id": "t", "report": report})).status_code in (401, 503))
        r = await c.post("/internal/eval/drift/ingest", headers=S, json={"worker_id": "t", "report": report})
        check("a scan report is ingested", r.status_code == 200 and r.json()["created"] == 2, r.text)

        r = await c.get("/eval/drift/overview", headers=A)
        check("the overview shows the scan and the open items", r.status_code == 200 and r.json()["open"] >= 2 and r.json()["last_scan"]["scan_id"] == report["scan_id"], r.text[:300])
        r = await c.get("/eval/drift/items", headers=A, params={"state": "active", "q": tag})
        items = r.json()["items"]
        check("items can be searched, open ones listed", r.status_code == 200 and len(items) == 2, r.text[:300])
        rule = next(i for i in items if i["kind"] == "rule_changed")
        proposal = next(i for i in items if i["kind"] == "proposal")
        check("a suggested case has no input and no expected value", proposal["expected"] is None and proposal["detail"].get("proposed_input") is None)

        r = await c.post(f"/eval/drift/items/{rule['id']}/accept", headers=A, json={"note": "x", "expected": {"v": 1}})
        check("accepting without reviewing first is refused", r.status_code == 422, r.text)
        check("start", (await c.post(f"/eval/drift/items/{rule['id']}/start", headers=A, json={})).json()["state"] == "in_review")
        check("a decision with no reason is refused", (await c.post(f"/eval/drift/items/{rule['id']}/dismiss", headers=A, json={"note": " "})).status_code == 422)
        check("accepting without the reviewer's expected value is refused", (await c.post(f"/eval/drift/items/{rule['id']}/accept", headers=A, json={"note": "right"})).status_code == 422)
        check("an unknown action is refused", (await c.post(f"/eval/drift/items/{rule['id']}/delete", headers=A, json={"note": "x"})).status_code == 422)
        check("an ordinary user cannot decide", (await c.post(f"/eval/drift/items/{rule['id']}/accept", headers=O, json={"note": "x", "expected": {"v": 1}})).status_code == 403)
        r = await c.post(f"/eval/drift/items/{rule['id']}/accept", headers=A, json={"note": "the new rule is right", "expected": {"v": 1}})
        check("accept with a reason and the reviewer's own expected value", r.status_code == 200 and r.json()["state"] == "accepted" and r.json()["expected_source"] == "reviewer", r.text)
        r = await c.get(f"/eval/drift/items/{rule['id']}/draft", headers=A)
        check("an accepted item has a prepared draft carrying the reviewer's expected value", r.status_code == 200 and r.json()["draft"]["expected"] == {"v": 1} and r.json()["draft"]["expected_source"] == "reviewer", r.text)
        check("an item that is not accepted has no draft", (await c.get(f"/eval/drift/items/{proposal['id']}/draft", headers=A)).status_code == 409)
        h = (await c.get(f"/eval/drift/items/{rule['id']}", headers=A)).json()["history"]
        check("the item's history shows each step", [e["to"] for e in h] == ["open", "in_review", "accepted"], str(h))
        check("a decided item cannot be re-decided", (await c.post(f"/eval/drift/items/{rule['id']}/dismiss", headers=A, json={"note": "x"})).status_code == 422)

        r = await c.get("/eval/drift/scans", headers=A)
        check("scans are listed", r.status_code == 200 and any(s["scan_id"] == report["scan_id"] for s in r.json()["scans"]), r.text[:200])
        r = await c.get("/eval/drift/registry", headers=A)
        check("the registry lists watched items with dependents counted", r.status_code == 200 and "items" in r.json(), r.text[:200])
        if r.json()["items"]:
            k = r.json()["items"][0]["key"]
            v = await c.get("/eval/drift/registry/versions", headers=A, params={"key": k})
            check("an item's versions can be read", v.status_code == 200 and v.json()["versions"], v.text[:200])
        check("an unknown watched item is a 404", (await c.get("/eval/drift/registry/versions", headers=A, params={"key": "nope"})).status_code == 404)
        r = await c.post("/eval/drift/scans", headers=A, json={})
        check("scan now reads the registry and (if a version is published) queues a scan job", r.status_code == 201 and "registry" in r.json(), r.text[:300])
        jobs = (await c.get("/eval/jobs", headers=A)).json()
        check("scan jobs do not appear among evaluation runs", all((j["config"] or {}).get("kind") != "drift_scan" for j in jobs))
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
