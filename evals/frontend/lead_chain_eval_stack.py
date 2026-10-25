"""The whole chain behind the Add Customer form, on the isolated evaluation stack (its own database; nothing of yours is touched):

  Super Admin adds a section and fields to the Lead acquisition template and publishes  ->  an agent reads the new version at once  ->  the agent saves a
  customer with answers to the added fields  ->  the answers are in the database and come back  ->  an edit is saved  ->  the Super Admin removes a field
  and publishes version 3  ->  the agent sees it gone, and the old answer is still safely stored with the customer.

    python evals/environment/envctl.py ... (stack up and seeded)   then:
    docker exec eval-runner python /work/evals/frontend/lead_chain_eval_stack.py
"""
import asyncio
import copy
import os
import sys
import uuid

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

API = os.environ["EVAL_API_URL"].rstrip("/")
PASSWORD = os.environ["EVAL_USER_PASSWORD"]
FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


async def login(c: httpx.AsyncClient, ref: str) -> dict:
    r = await c.post("/auth/token", data={"username": f"{ref}@eval.invalid", "password": PASSWORD})
    r.raise_for_status()
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def main() -> int:
    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with httpx.AsyncClient(base_url=API, timeout=60) as c:
        SA, AG = await login(c, "superadmin-1"), await login(c, "agent-a1")
        me = (await c.get("/auth/me", headers=AG)).json()
        tenant_id = me.get("tenant_id")
        check("an agent can sign in on the stack and belongs to a tenant", bool(tenant_id), str(me)[:200])

        check("an agent cannot open the Templates admin", (await c.get("/admin/doc-templates", headers=AG)).status_code == 403)
        lst = (await c.get("/admin/doc-templates", headers=SA)).json()
        check("the Super Admin finds the lead template (created on first use)", any(t["key"] == "lead_acquisition" for t in lst), str(lst)[:200])
        v1 = (await c.get("/doc-templates/lead_acquisition", headers=AG)).json()
        check("the agent reads the published version", v1["version"] >= 1 and len(v1["content"]["sections"]) >= 8)

        tag = uuid.uuid4().hex[:6]
        draft = copy.deepcopy(v1["content"])
        next(s for s in draft["sections"] if s["id"] == "demographics")["fields"].append(
            {"id": f"blood_group_{tag}", "label": "Blood group", "type": "select", "required": True, "binding": {"store": "details"},
             "options": [{"id": "o_pos", "label": "O+", "value": "O+"}, {"id": "a_pos", "label": "A+", "value": "A+"}]})
        draft["sections"].append({"id": f"branch_notes_{tag}", "title": "Branch notes", "fields": [
            {"id": f"visit_reason_{tag}", "label": "Visit reason", "type": "text", "required": False, "binding": {"store": "details"}},
            {"id": f"callback_{tag}", "label": "Wants a call back", "type": "checkbox", "required": False, "binding": {"store": "details"}}]})
        saved = await c.put("/admin/doc-templates/lead_acquisition/draft", headers=SA, json={"content": draft})
        check("the Super Admin saves a draft with a new field and a new section", saved.status_code == 200 and not saved.json()["publish_problems"], saved.text[:300])
        same = (await c.get("/doc-templates/lead_acquisition", headers=AG)).json()
        check("until it is published the agent still sees the old version", same["version"] == v1["version"])
        pub = await c.post("/admin/doc-templates/lead_acquisition/publish", headers=SA, json={"change_note": "Added blood group and a branch notes section"})
        check("the Super Admin publishes it", pub.status_code == 201, pub.text[:300])
        v2 = (await c.get("/doc-templates/lead_acquisition", headers=AG)).json()
        ids = [f["id"] for s in v2["content"]["sections"] for f in s["fields"]]
        check("the agent sees the new version immediately, with the new field and section", v2["version"] == pub.json()["published"]["version"] and f"blood_group_{tag}" in ids and f"callback_{tag}" in ids)

        body = {"first_name": "Chain", "last_name": f"Test{tag}", "gender": "Male", "city": "Lahore",
                "details": {"custom": {f"blood_group_{tag}": "O+", f"visit_reason_{tag}": "Walk-in enquiry", f"callback_{tag}": True},
                          "template": {"key": "lead_acquisition", "version": v2["version"]}}}
        created = await c.post(f"/tenants/{tenant_id}/customers", headers=AG, json=body)
        check("the agent saves a customer with answers to the added fields", created.status_code == 201, created.text[:300])
        cid = created.json()["id"]
        async with engine.connect() as conn:
            row = (await conn.execute(text("select details->'custom', details->'template' from customers where id = :i"), {"i": cid})).first()
        check("the answers are in the database, with the template version they were given under",
              row is not None and row[0] == {f"blood_group_{tag}": "O+", f"visit_reason_{tag}": "Walk-in enquiry", f"callback_{tag}": True} and row[1]["version"] == v2["version"], str(row))
        back = (await c.get(f"/tenants/{tenant_id}/customers/{cid}", headers=AG)).json()
        check("opening the customer returns the answers (so the form shows them)", (back["details"] or {}).get("custom", {}).get(f"blood_group_{tag}") == "O+", str(back.get("details"))[:200])

        details = back["details"]
        details["custom"][f"blood_group_{tag}"] = "A+"
        upd = await c.put(f"/tenants/{tenant_id}/customers/{cid}", headers=AG, json={"first_name": "Chain", "last_name": f"Test{tag}", "details": details})
        check("an edit of an added field is saved", upd.status_code == 200, upd.text[:300])
        async with engine.connect() as conn:
            now = (await conn.execute(text("select details->'custom'->>:k from customers where id = :i"), {"k": f"blood_group_{tag}", "i": cid})).scalar()
        check("and it is the new value in the database", now == "A+", str(now))

        gone = copy.deepcopy(v2["content"])
        for s in gone["sections"]:
            s["fields"] = [f for f in s["fields"] if f["id"] != f"callback_{tag}"]
        await c.put("/admin/doc-templates/lead_acquisition/draft", headers=SA, json={"content": gone})
        p3 = await c.post("/admin/doc-templates/lead_acquisition/publish", headers=SA, json={"change_note": "Removed the call back tick box"})
        v3 = (await c.get("/doc-templates/lead_acquisition", headers=AG)).json()
        ids3 = [f["id"] for s in v3["content"]["sections"] for f in s["fields"]]
        check("after the next publish the agent no longer sees the removed field", p3.status_code == 201 and v3["version"] == v2["version"] + 1 and f"callback_{tag}" not in ids3 and f"blood_group_{tag}" in ids3)
        async with engine.connect() as conn:
            kept = (await conn.execute(text("select details->'custom'->>:k from customers where id = :i"), {"k": f"callback_{tag}", "i": cid})).scalar()
        check("an answer given earlier to the removed field stays stored with the customer (nothing is lost)", kept == "true", str(kept))

        locked = copy.deepcopy(v3["content"])
        for s in locked["sections"]:
            s["fields"] = [f for f in s["fields"] if f["id"] != "first_name"]
        r = await c.put("/admin/doc-templates/lead_acquisition/draft", headers=SA, json={"content": locked})
        refused = await c.post("/admin/doc-templates/lead_acquisition/publish", headers=SA, json={"change_note": "try to remove the first name"})
        check("removing a required built-in field cannot be published", r.status_code == 200 and refused.status_code == 422 and "first_name" in refused.text, refused.text[:200])
        await c.delete("/admin/doc-templates/lead_acquisition/draft", headers=SA)
        await c.delete(f"/tenants/{tenant_id}/customers/{cid}", headers=AG)
    await engine.dispose()
    print(f"\n{'PASS' if not FAILS else 'FAILED'}: {FAILS} failed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
