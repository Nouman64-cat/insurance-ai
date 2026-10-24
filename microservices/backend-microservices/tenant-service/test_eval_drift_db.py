"""The database enforces the review rules of the change registry (Phase 6, M1), whatever the application does:
history cannot be edited or deleted, a decision needs a named person and a written reason, accepting something that creates a case needs an
expected value, and that value is always the reviewer's. Also: the migration can be applied twice.

Everything is written inside one transaction that is rolled back at the end (these rows can never be deleted, so the test must not leave any).

Run: docker exec insurance-tenant-service python test_eval_drift_db.py
"""
import asyncio
import sys
import uuid
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from database import engine
from shared.evaluation.ddl import EVAL_DRIFT_DDL

FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


async def refused(conn, sql: str, params: dict) -> str | None:
    """The database's refusal, or None if it let the statement through. Runs in a savepoint so the transaction survives."""
    try:
        async with conn.begin_nested():
            await conn.execute(text(sql), params)
        return None
    except (IntegrityError, DBAPIError) as exc:
        return str(exc.orig)[:500]


async def main() -> int:
    async with engine.connect() as conn:
        outer = await conn.begin()
        try:
            user = (await conn.execute(text("select id from users limit 1"))).scalar()
            item_id, other_id = uuid.uuid4(), uuid.uuid4()
            base = dict(kind="rule_changed", key=f"test:{uuid.uuid4().hex[:8]}")
            insert = ("insert into eval_drift_items (id, finding_key, kind, severity, state, summary, affected_cases, detail, times_seen, opened_at, last_seen_at, "
                      "decided_by, decided_at, decision_note, expected, expected_source) values "
                      "(:id, :key, :kind, 'high', :state, 'test', '[]'::jsonb, '{}'::jsonb, 1, now(), now(), :by, :at, :note, cast(:expected as jsonb), :src)")

            def row(**kw):
                return {**dict(id=uuid.uuid4(), key=f"test:{uuid.uuid4().hex[:10]}", kind="rule_changed", state="open", by=None, at=None, note=None, expected=None, src=None), **kw}

            r = await refused(conn, insert, row(id=item_id, key=base["key"])); check("a new item opens", r is None, str(r))
            check("a state that does not exist is refused", "ck_eval_drift_state" in (str(await refused(conn, insert, row(state="approved"))) or ""), "refused for another reason")
            check("the same finding cannot be stored twice", "finding_key" in (str(await refused(conn, insert, row(key=base["key"]))) or ""), "refused for another reason")

            now = datetime(2026, 10, 23, 12, 0, 0)
            decided = dict(by=user, at=now, note="confirmed with the business", expected='{"status": 422}', src="reviewer")
            check("a decision with no named person is refused", "ck_eval_drift_decision_needs_person_and_reason" in (str(await refused(conn, insert, row(state="rejected", **{**decided, "by": None}))) or ""), "refused for another reason")
            check("a decision with no reason is refused", "ck_eval_drift_decision_needs_person_and_reason" in (str(await refused(conn, insert, row(state="dismissed", **{**decided, "note": None}))) or ""), "refused for another reason")
            check("a decision with a blank reason is refused", "ck_eval_drift_decision_needs_person_and_reason" in (str(await refused(conn, insert, row(state="rejected", **{**decided, "note": "   "}))) or ""), "refused for another reason")
            check("accepting a rule change without an expected value is refused", "ck_eval_drift_accept_needs_expected" in (str(await refused(conn, insert, row(state="accepted", **{**decided, "expected": None, "src": None}))) or ""), "refused for another reason")
            check("an expected value that is not the reviewer's is refused", "ck_eval_drift_expected_is_reviewers" in (str(await refused(conn, insert, row(state="accepted", **{**decided, "src": "model"}))) or ""), "refused for another reason")
            check("an expected value with no source is refused", "ck_eval_drift_expected_is_reviewers" in (str(await refused(conn, insert, row(state="accepted", **{**decided, "src": None}))) or ""), "refused for another reason")
            check("a complete acceptance (person, reason, reviewer's expected value) is stored", await refused(conn, insert, row(id=other_id, state="accepted", **decided)) is None)
            check("a rejection needs no expected value", await refused(conn, insert, row(state="rejected", **{**decided, "expected": None, "src": None})) is None)
            check("accepting an acknowledgement (review due) needs no expected value", await refused(conn, insert, row(kind="review_due", state="accepted", **{**decided, "expected": None, "src": None})) is None)

            check("a review item can never be deleted", "append-only" in (str(await refused(conn, "delete from eval_drift_items where id = :id", {"id": item_id})) or ""), "refused for another reason")
            check("an open item can be updated (a scan records that it saw it again)", await refused(conn, "update eval_drift_items set times_seen = 2 where id = :id", {"id": item_id}) is None)

            event = "insert into eval_drift_events (drift_item_id, at, from_state, to_state, actor_kind, actor_id, note, data) values (:i, now(), 'open', 'in_review', 'user', :u, 'x', '{}'::jsonb)"
            check("an event is recorded", await refused(conn, event, {"i": item_id, "u": user}) is None)
            check("an event can never be changed", "append-only" in (str(await refused(conn, "update eval_drift_events set note = 'edited' where drift_item_id = :i", {"i": item_id})) or ""), "refused for another reason")
            check("an event can never be deleted", "append-only" in (str(await refused(conn, "delete from eval_drift_events where drift_item_id = :i", {"i": item_id})) or ""), "refused for another reason")

            reg = uuid.uuid4()
            check("a registry item is stored", await refused(conn, "insert into eval_registry_items (id, item_key, item_type, title, status, created_at) values (:i, :k, 'plan', 't', 'active', now())",
                                                             {"i": reg, "k": f"plan:{uuid.uuid4().hex[:8]}"}) is None)
            ver = "insert into eval_registry_versions (id, item_id, version, fingerprint, summary, captured_from, captured_at) values (gen_random_uuid(), :i, :v, 'abc', '{}'::jsonb, 'scan', now())"
            check("a registry version is stored", await refused(conn, ver, {"i": reg, "v": 1}) is None)
            check("a version number cannot repeat for an item", "uq_eval_registry_item_version" in (str(await refused(conn, ver, {"i": reg, "v": 1})) or ""), "refused for another reason")
            check("a registry version can never be changed", "append-only" in (str(await refused(conn, "update eval_registry_versions set fingerprint = 'x' where item_id = :i", {"i": reg})) or ""), "refused for another reason")
            check("a registry version can never be deleted", "append-only" in (str(await refused(conn, "delete from eval_registry_versions where item_id = :i", {"i": reg})) or ""), "refused for another reason")

            scan = "insert into eval_drift_scans (id, scan_id, source, counts, summary, created_at) values (gen_random_uuid(), :s, 'working', '{}'::jsonb, '{}'::jsonb, now())"
            sid = f"scan-test-{uuid.uuid4().hex[:6]}"
            check("a scan is recorded", await refused(conn, scan, {"s": sid}) is None)
            check("a scan can never be changed", "append-only" in (str(await refused(conn, "update eval_drift_scans set source = 'published' where scan_id = :s", {"s": sid})) or ""), "refused for another reason")
            check("a scan can never be deleted", "append-only" in (str(await refused(conn, "delete from eval_drift_scans where scan_id = :s", {"s": sid})) or ""), "refused for another reason")

            dep = "insert into eval_case_dependencies (id, dataset_slug, dataset_version, case_key, item_key) values (gen_random_uuid(), 'd', '1.0.0', 'C1', 'plan:x')"
            check("a case dependency is stored", await refused(conn, dep, {}) is None)
            check("the same dependency cannot be stored twice", "uq_eval_case_dependency" in (str(await refused(conn, dep, {})) or ""), "refused for another reason")
        finally:
            await outer.rollback()

    # The migration steps are safe to run again.
    async with engine.begin() as conn:
        failed = None
        for label, sql in EVAL_DRIFT_DDL + EVAL_DRIFT_DDL:
            try:
                await conn.execute(text(sql))
            except Exception as exc:                                                       # noqa: BLE001
                failed = f"{label}: {exc}"
                break
        check("the migration can be applied twice without error", failed is None, failed or "")
    async with engine.connect() as conn:
        left = (await conn.execute(text("select count(*) from eval_drift_items where kind in ('rule_changed','review_due') and summary = 'test'"))).scalar()
        check("the test left nothing behind", left == 0, str(left))
    print(f"\n{'PASS' if not FAILS else 'FAILED'}: {FAILS} failed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
