"""The review queue service (Phase 6, M3): ingesting a scan, recording registry changes, and a person's decisions.
Everything runs in one transaction that is rolled back (review items can never be deleted, so the test must leave none).

Run: docker exec insurance-tenant-service python test_eval_drift_service.py
"""
import asyncio
import sys
import uuid

from fastapi import HTTPException
from sqlmodel import select

import database
from services import eval_drift as svc
from shared.evaluation import drift
from shared.models.core import User
from shared.models.evaluation import EvalDriftEvent, EvalDriftItem

FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


def finding(tag: str, kind="rule_changed", sev="high"):
    return {"key": f"t-{tag}-{kind}", "kind": kind, "severity": sev, "summary": f"{tag} problem", "affected_cases": ["IND-X-001"], "detail": {}}


def report(scan_id: str, findings, proposals=(), slug="test-ds"):
    return {"scan_id": scan_id, "dataset": {"dataset": slug, "version": "9.9.9", "verified": True}, "compared": None, "counts": {"cases": 3},
            "summary": {}, "coverage": {}, "findings": list(findings), "proposals": list(proposals)}


async def item(s, key):
    return (await s.exec(select(EvalDriftItem).where(EvalDriftItem.finding_key == key))).first()


async def main() -> int:
    async with database._session_factory() as s:
        try:
            uid = (await s.exec(select(User.id).limit(1))).first()
            tag = uuid.uuid4().hex[:6]
            a, b = finding(tag + "a"), finding(tag + "b", "unconfirmed", "medium")
            r1 = await svc.ingest_scan(s, report(f"scan-{tag}-1", [a, b]))
            check("a first scan creates one item per finding", r1["created"] == 2 and not r1["already_ingested"], str(r1))
            again = await svc.ingest_scan(s, report(f"scan-{tag}-1", [a, b]))
            check("loading the same scan twice changes nothing", again["already_ingested"] is True)
            r2 = await svc.ingest_scan(s, report(f"scan-{tag}-2", [a, b]))
            ia = await item(s, a["key"])
            check("the same problem found again is the SAME item (seen twice), not a new one", r2["created"] == 0 and r2["seen_again"] == 2 and ia.times_seen == 2, str(r2))

            r3 = await svc.ingest_scan(s, report(f"scan-{tag}-3", [a]))
            ib = await item(s, b["key"])
            check("an item the scan no longer finds is cleared", r3["cleared"] == 1 and ib.state == "cleared" and ib.cleared_at is not None, str(r3))
            r4 = await svc.ingest_scan(s, report(f"scan-{tag}-4", [a, b]))
            await s.refresh(ib)
            check("a problem that comes back is reopened", r4["reopened"] == 1 and ib.state == "open", str(r4))

            await svc.transition(s, ia, "start", actor_id=uid, note=None)
            check("start puts the item in review for that person", ia.state == "in_review" and ia.assigned_to == uid)
            try:
                await svc.transition(s, ia, "dismiss", actor_id=uid, note="  ")
                check("a decision without a reason is refused", False)
            except HTTPException as e:
                check("a decision without a reason is refused", e.status_code == 422, e.detail)
            try:
                await svc.transition(s, ia, "accept", actor_id=uid, note="the new rule is right")
                check("accepting a rule change without the reviewer's expected value is refused", False)
            except HTTPException as e:
                check("accepting a rule change without the reviewer's expected value is refused", e.status_code == 422, e.detail)
            await svc.transition(s, ia, "accept", actor_id=uid, note="the new rule is right", expected={"value": 7})
            check("accept with a reason and the reviewer's expected value is recorded as theirs", ia.state == "accepted" and ia.expected_source == "reviewer" and ia.decided_by == uid)

            r5 = await svc.ingest_scan(s, report(f"scan-{tag}-5", []))
            await s.refresh(ia)
            check("a scan never changes or clears a decided item", ia.state == "accepted" and r5["cleared"] >= 1, f"{ia.state} {r5}")

            ev = (await s.exec(select(EvalDriftEvent).where(EvalDriftEvent.drift_item_id == ia.id))).all()
            check("every step is in the item's history", [e.to_state for e in ev][:1] == ["open"] and "in_review" in [e.to_state for e in ev] and "accepted" in [e.to_state for e in ev], str([e.to_state for e in ev]))

            prop = {"key": f"p-{tag}", "stage": "kyc", "scenario_type": "negative", "rationale": "no negative KYC case", "provenance": {"kind": "coverage"}}
            r6 = await svc.ingest_scan(s, report(f"scan-{tag}-6", [], [prop]))
            ip = await item(s, prop["key"])
            check("a suggested case becomes a proposal item with no input or expected value", r6["created"] == 1 and ip.kind == "proposal" and ip.expected is None and ip.detail.get("expected") is None)

            ov = await svc.overview(s)
            check("the overview counts open items and shows the last scan", ov["open"] >= 1 and ov["last_scan"]["scan_id"] == f"scan-{tag}-6", str(ov)[:300])

            obs = {"key": f"template:test-{tag}", "type": "template", "title": "Test template", "source": "test", "summary": {"content": {"title": "t", "sections": []}}}
            reading = {"status": "changed", "version": 2, "fingerprint": "x", "diff": [{"path": "content.sections", "before": [], "after": [1], "change": "changed"}]}
            ch = await svc.record_config_change(s, obs, reading, scan_id="registry-test")
            ic = (await s.exec(select(EvalDriftItem).where(EvalDriftItem.id == uuid.UUID(ch["item_id"])))).one()
            check("a registry change becomes a config_changed item (no dependents = low)", ch["recorded"] and ic.kind == "config_changed" and ic.severity == "low", str(ch))
            ch2 = await svc.record_config_change(s, obs, reading, scan_id="registry-test")
            check("recording the same change twice is one item", ch2["item_id"] == ch["item_id"])
            none = await svc.record_config_change(s, obs, {**reading, "status": "unchanged"})
            check("an unchanged reading records nothing", none == {"recorded": False})

            # unchanged product: a registry scan with supplied readings records no change on a second pass
            seen = await svc.scan_registry(s, captured_from="test", observations=[{**obs, "key": f"calc:t-{tag}", "type": "calc"}])
            seen2 = await svc.scan_registry(s, captured_from="test", observations=[{**obs, "key": f"calc:t-{tag}", "type": "calc"}])
            check("a registry scan records new items without raising changes, and an unchanged second pass raises none", seen["new"] == 1 and seen2["unchanged"] == 1 and not seen2["recorded"], str((seen, seen2)))
        finally:
            await s.rollback()
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
