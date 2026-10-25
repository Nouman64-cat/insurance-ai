"""The Studio's read model over HTTP, with real tokens, against the ISOLATED evaluation stack: who may read it, what it refuses, and what it returns for a world this test builds
(studio_seed.py). Everything it writes is permanent there.

Run: docker exec eval-tenant-service python test_eval_studio_api.py
"""
import asyncio
import sys

import httpx
from sqlmodel import select

import database
from routers.auth import create_access_token
from shared.models.core import Role, User
from studio_seed import seed

BASE = "http://localhost:8001"
FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {str(detail)[:500]}" if detail and not ok else ""))


async def main() -> int:
    async with database._session_factory() as s:
        sa = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
        admin = (await s.exec(select(User).where(User.role_id == sa.id, User.is_deleted == False))).first()  # noqa: E712
        other = (await s.exec(select(User).where(User.role_id != sa.id, User.is_deleted == False))).first()    # noqa: E712
        A, O = {"Authorization": f"Bearer {create_access_token({'sub': str(admin.id)})}"}, {"Authorization": f"Bearer {create_access_token({'sub': str(other.id)})}"}
        w = await seed(s)
        await s.commit()
    slug, key = w["slug"], w["key"]
    async with httpx.AsyncClient(base_url=BASE, timeout=60) as c:
        for path in ("/eval/studio/graph", "/eval/studio/observed", "/eval/studio/search?q=abc", "/eval/studio/impact", f"/eval/studio/impact/item?key={key}", "/eval/studio/results"):
            check(f"anonymous callers are refused ({path.split('?')[0]})", (await c.get(path)).status_code == 401)
            check(f"an ordinary user is refused ({path.split('?')[0]})", (await c.get(path, headers=O)).status_code == 403)
        g = (await c.get("/eval/studio/graph", headers=A)).json()
        nodes = {n["id"]: n for n in g["nodes"]}
        check("the map comes with layers, nodes with health and reasons, links between existing nodes and a health count that adds up", len(g["layers"]) == 6 and all(n["health"]["reason"] for n in g["nodes"]) and all(e["from"] in nodes and e["to"] in nodes for e in g["edges"])
              and sum(g["health"].values()) == len(g["nodes"]))
        d = nodes[f"dataset:{slug}"]
        check("the seeded dataset is on the map with its version, cases, the unconfirmed one and a bad health from its open high item", d["stats"]["latest_version"] == "1.0.1" and d["stats"]["cases"] == 3 and d["stats"]["unconfirmed"] == 1 and d["health"]["state"] == "bad", d)
        check("the running job lights the harness", nodes["harness"]["active"] and any(j["dataset"] == slug for j in g["running"]))
        check("the observed agent has the specialist and tools the seeded runs used", "specialists" in nodes and "tools" in nodes)
        s1 = (await c.get("/eval/studio/search", headers=A, params={"q": w["tag"]})).json()
        check("search finds the dataset, the rule and the review items", {"dataset", "rule", "finding"} <= {gp["kind"] for gp in s1["groups"]} and s1["total"] >= 4, s1["groups"])
        check("a case is found by its key with its dataset", any(i["id"] == "SW-A" and i["dataset"] == slug for gp in (await c.get("/eval/studio/search", headers=A, params={"q": "SW-A"})).json()["groups"] if gp["kind"] == "case" for i in gp["items"]))
        check("a one-letter or over-long query is handled", (await c.get("/eval/studio/search", headers=A, params={"q": "a"})).json()["total"] == 0 and (await c.get("/eval/studio/search", headers=A, params={"q": "x" * 200})).status_code == 422)
        cands = (await c.get("/eval/studio/impact", headers=A)).json()["items"]
        check("the changed rule is offered with its dependents and open findings", any(i["key"] == key and i["version"] == 2 and i["dependent_cases"] >= 2 and i["open_findings"] == 1 for i in cands))
        im = (await c.get("/eval/studio/impact/item", headers=A, params={"key": key})).json()
        deps = {x["case_id"]: x for x in im["dependents"] if x["dataset"] == slug}
        check("the impact lists before and after, the affected cases with their latest real result, and the suggestions", {d_["change"] for d_ in im["versions"][0]["diff"]} == {"added", "changed", "removed"} and set(deps) == {"SW-A", "SW-B"}
              and deps["SW-A"]["latest_real_result"]["status"] == "failed" and {x["kind"] for x in im["suggested_updates"] if w["tag"] in x["summary"]} == {"config_changed", "rule_changed"}, im["stages"])
        cmp_ = im["regression"][slug]["compare"]
        check("the regression compares the same model before and after the change, with the version published since", len(cmp_) == 1 and cmp_[0]["before"]["run_id"] == w["before"] and cmp_[0]["after"]["run_id"] == w["after"] and any(v["after_change"] for v in im["dataset_versions"][slug]))
        check("an unknown item is a 404", (await c.get("/eval/studio/impact/item", headers=A, params={"key": "rule:nope"})).status_code == 404)
        res = (await c.get("/eval/studio/results", headers=A, params={"dataset": slug})).json()
        check("executions across runs: newest first with the status counts and the filters to offer", res["total"] == 6 and res["by_status"] == {"passed": 4, "failed": 2} and res["results"][0]["run_id"] == w["after"] and slug in res["datasets"])
        check("a status filter and a run filter narrow the list", (await c.get("/eval/studio/results", headers=A, params={"dataset": slug, "status": "failed"})).json()["total"] == 2 and (await c.get("/eval/studio/results", headers=A, params={"run_id": w["before"]})).json()["total"] == 3)
        check("an unknown status is refused", (await c.get("/eval/studio/results", headers=A, params={"status": "magic"})).status_code == 422)
        ob = (await c.get("/eval/studio/observed", headers=A)).json()
        check("what the agent was observed doing says it is only what was observed", any(t["name"] == "record_lead" for t in ob["tools"]) and "no catalogue" in ob["note"])
    print("FAILED" if FAILS else "all passed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
