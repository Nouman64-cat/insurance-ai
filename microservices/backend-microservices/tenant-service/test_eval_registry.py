"""The registry readers against the real product (Phase 6, M2): what is watched, that a reading is stable, that the first reading records version 1
and is not a change, that an unchanged reading writes nothing and that a changed item gets the next version. Everything runs inside one
transaction that is rolled back (registry history is append-only, so the test must leave nothing).

Run: docker exec insurance-tenant-service python test_eval_registry.py
"""
import asyncio
import sys

from sqlalchemy import func
from sqlmodel import select

import database
from services import eval_registry as reg
from shared.evaluation import change_registry as cr
from shared.models.evaluation import EvalRegistryItem, EvalRegistryVersion

FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


async def versions(session) -> int:
    return (await session.exec(select(func.count()).select_from(EvalRegistryVersion))).one()


async def main() -> int:
    async with database._session_factory() as session:
        before_items = (await session.exec(select(func.count()).select_from(EvalRegistryItem))).one()
        before_versions = await versions(session)
        try:
            a = await reg.read_all(session)
            keys = {o["key"] for o in a}
            check("the premium calculation, payment gate, claims access and policy workflow are watched", {"calc:premium", "gate:initial-premium", "access:claims", "workflow:policy-status"} <= keys, str(sorted(keys))[:300])
            check("plans are watched, one item per plan code", any(k.startswith("plan:") for k in keys), str(sorted(keys))[:200])
            from shared.models.core import RuleSet
            n_sets = (await session.exec(select(func.count()).select_from(RuleSet))).one()
            n_rules = len([k for k in keys if k.startswith("rule:")])
            check(f"every rule set is watched ({n_sets} rule sets, {n_rules} watched)", n_rules == n_sets, f"{n_sets} vs {n_rules}")
            check("every item says what it is and where it came from", all(o["key"] and o["type"] and o["title"] and o["source"] and o["summary"] for o in a))
            premium = next(o for o in a if o["key"] == "calc:premium")
            check("the premium calculation is summarised by its functions", any("functions" in v for v in premium["summary"].values()), str(premium["summary"])[:200])
            transitions = next(o for o in a if o["key"] == "workflow:policy-status")["summary"]["transitions"]
            check("the policy workflow lists the legal moves", bool(transitions) and all(isinstance(v, list) for v in transitions.values()), str(transitions)[:200])

            b = await reg.read_all(session)
            check("two readings of an unchanged product give the same fingerprints", {o["key"]: cr.fingerprint(o["summary"]) for o in a} == {o["key"]: cr.fingerprint(o["summary"]) for o in b})

            first = await reg.snapshot(session, observations=a)
            n_new = sum(r["reading"]["status"] == "new" for r in first)
            check("a reading records an item not seen before as new (version 1), never as a change", all(r["reading"]["status"] in ("new", "unchanged") for r in first) and await versions(session) == before_versions + n_new, str([r["reading"]["status"] for r in first][:5]))
            second = await reg.snapshot(session, observations=a)
            check("an unchanged reading writes nothing", all(r["reading"]["status"] == "unchanged" for r in second) and await versions(session) == before_versions + n_new)

            changed = [{**o, "summary": {**o["summary"], "CHANGED": 1}} if o["key"] == "calc:premium" else o for o in a]
            third = await reg.snapshot(session, observations=changed)
            by = {r["observation"]["key"]: r["reading"] for r in third}
            check("a changed item gets the next version and the others stay unchanged", by["calc:premium"]["status"] == "changed" and by["calc:premium"]["version"] == 2
                  and all(v["status"] == "unchanged" for k, v in by.items() if k != "calc:premium"))
            check("the change says what was added", any(d["path"] == "CHANGED" and d["change"] == "added" for d in by["calc:premium"]["diff"]), str(by["calc:premium"]["diff"])[:200])
            check("history keeps both versions of the item", await versions(session) == before_versions + n_new + 1)
            finding = cr.change_finding(changed[[o["key"] for o in changed].index("calc:premium")], by["calc:premium"], [{"case_id": "IND-PLAN-001", "severity": "high"}])
            import json, pathlib
            deps_file = pathlib.Path("/app/dependencies-test.json")
            mapping = {"IND-PLAN-001": ["plan:*", "calc:premium"], "IND-ISS-001": ["workflow:policy-status"], "IND-SEC-009": ["access:claims"]}
            n = await reg.load_dependencies(session, "test-ds", "9.9.9", mapping, sorted(keys))
            check("declared dependencies are stored", n == 4, str(n))
            again = await reg.load_dependencies(session, "test-ds", "9.9.9", mapping, sorted(keys))
            check("loading the same declaration twice stores it once", again == 4 and len(await reg.dependent_cases(session, "test-ds", "9.9.9", "calc:premium", {})) == 1)
            fam = {d["case_id"] for d in await reg.dependent_cases(session, "test-ds", "9.9.9", sorted(k for k in keys if k.startswith("plan:"))[0], {})}
            check("a family declaration (plan:*) covers each plan", fam == {"IND-PLAN-001"}, str(fam))
            try:
                await reg.load_dependencies(session, "test-ds", "9.9.9", {"X": ["calc:typo"]}, sorted(keys))
                typo_refused = False
            except reg.DependencyError:
                typo_refused = True
            check("a key that names nothing watched is refused, so a typo cannot protect nothing", typo_refused)
            check("the change becomes a finding for the cases that depend on it", finding["kind"] == "config_changed" and finding["affected_cases"] == ["IND-PLAN-001"] and finding["severity"] == "high")
        finally:
            await session.rollback()
    async with database._session_factory() as session:
        check("the test left nothing behind", (await session.exec(select(func.count()).select_from(EvalRegistryItem))).one() == before_items and await versions(session) == before_versions)
    print(f"\n{'PASS' if not FAILS else 'FAILED'}: {FAILS} failed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
