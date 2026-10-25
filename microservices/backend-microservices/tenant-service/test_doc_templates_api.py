"""The Templates API (Super Admin): who may use it, what it refuses, and the whole edit-and-publish flow. The read and permission checks run over HTTP
against the live service. The write flow calls the endpoint functions inside a transaction that is rolled back (a published version can never be
deleted, so the test must not leave one) with the audit write stubbed.

Run: docker exec insurance-tenant-service python test_doc_templates_api.py
"""
import asyncio
import copy
import sys
import uuid

import httpx
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from routers import doc_templates as r
from routers.auth import create_access_token
from shared import doc_templates as dt
from shared.models.core import Role, User
from shared.models.templates import DocumentTemplate, DocumentTemplateVersion

BASE = "http://localhost:8001"
FAILS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


async def raises(coro, status: int):
    try:
        await coro
    except HTTPException as exc:
        return exc if exc.status_code == status else None
    return None


async def main() -> int:
    async with database._session_factory() as s:
        sa = (await s.exec(select(Role).where(Role.name == "SuperAdmin"))).first()
        admin = (await s.exec(select(User).where(User.role_id == sa.id, User.is_deleted == False))).first()   # noqa: E712
        other = (await s.exec(select(User).where(User.role_id != sa.id, User.is_deleted == False))).first()    # noqa: E712
        A = {"Authorization": f"Bearer {create_access_token({'sub': str(admin.id)})}"}
        O = {"Authorization": f"Bearer {create_access_token({'sub': str(other.id)})}"}

    async with httpx.AsyncClient(base_url=BASE, timeout=60) as c:
        check("anonymous callers are refused", (await c.get("/admin/doc-templates")).status_code == 401)
        check("an ordinary user cannot list the templates", (await c.get("/admin/doc-templates", headers=O)).status_code == 403)
        check("an ordinary user cannot save a draft", (await c.put("/admin/doc-templates/proposal/draft", headers=O, json={"content": {}})).status_code == 403)
        check("an ordinary user cannot publish", (await c.post("/admin/doc-templates/proposal/publish", headers=O, json={"change_note": "x x x"})).status_code == 403)
        lst = await c.get("/admin/doc-templates", headers=A)
        keys = {t["key"]: t for t in lst.json()}
        check("the Super Admin sees the lead form and the proposal (and no retired template)", lst.status_code == 200 and {"lead_acquisition", "proposal"} <= set(keys) and not any(k.startswith("illustration:") for k in keys), str(list(keys)))
        check("every template has a published version with fields", all(t["published_version"] and t["fields"] > 0 for t in keys.values()))
        one = (await c.get("/admin/doc-templates/proposal", headers=A)).json()
        check("a template shows its published content, versions and no draft", one["published"]["content"]["sections"] and one["versions"] and one["draft"] is None)
        check("an unknown template is 404", (await c.get("/admin/doc-templates/nope", headers=A)).status_code == 404)
        pub = await c.get("/doc-templates/proposal", headers=O)
        check("any signed-in user can read the PUBLISHED content (the forms render from it)", pub.status_code == 200 and pub.json()["version"] == one["published"]["version"] and "content" in pub.json())
        check("a visitor who is not signed in cannot", (await c.get("/doc-templates/proposal")).status_code == 401)

    # ── the write flow, rolled back ──
    async with database.engine.connect() as conn:
        outer = await conn.begin()
        try:
            session = AsyncSession(conn, join_transaction_mode="create_savepoint", expire_on_commit=False)
            r.record_standalone = lambda **kw: asyncio.sleep(0)                      # no audit rows from a test
            actor = await session.get(User, admin.id)
            key = f"lead_test_{uuid.uuid4().hex[:6]}"
            seed = dt.seed_lead_acquisition()
            t = DocumentTemplate(template_key=key, kind="lead", group_key=None, title="Test lead form")
            session.add(t)
            await session.flush()
            session.add(DocumentTemplateVersion(template_id=t.id, version=1, state="published", content=seed, content_sha256=dt.content_hash(seed), change_note="v1",
                                                created_by=actor.id, published_by=actor.id, published_at=__import__("datetime").datetime.utcnow()))
            await session.flush()

            bad = copy.deepcopy(seed); bad["title"] = ""
            e = await raises(r.save_draft(key, r.DraftIn(content=bad), session, actor), 422)
            check("an invalid draft is refused with the reasons", e is not None and "needs a title" in str(e.detail), str(e))
            v2 = copy.deepcopy(seed)
            v2["sections"][2]["fields"].append({"id": "extra_note", "label": "Extra note", "type": "text", "required": False})
            v2["sections"][0]["fields"] = [f for f in v2["sections"][0]["fields"] if f["id"] != "emergency_contact_name"]
            saved = await r.save_draft(key, r.DraftIn(content=v2), session, actor)
            check("a valid draft is saved and shows what it changes", saved["draft"]["state"] == "draft" and saved["draft"]["version"] == 2 and
                  {(x["change"], x["what"]) for x in saved["changes"]} >= {("added", "field:extra_note"), ("removed", "field:emergency_contact_name")}, str(saved)[:300])
            again = await r.save_draft(key, r.DraftIn(content=v2), session, actor)
            check("saving again updates the same draft", again["draft"]["version"] == 2 and len([v for v in await r._versions(session, t) if v.state == "draft"]) == 1)
            check("until it is published, others still read version 1", (await r.published_content(key, session, actor))["version"] == 1)

            from pydantic import ValidationError
            blank = []
            for note in ("", "  ", "     "):
                try:
                    r.PublishIn(change_note=note)
                    blank.append(note)
                except ValidationError:
                    pass
            check("publishing without a written reason is refused (empty and blank notes)", blank == [], str(blank))

            locked = copy.deepcopy(v2)
            locked["sections"][0]["fields"] = [f for f in locked["sections"][0]["fields"] if f["id"] != "first_name"]
            await r.save_draft(key, r.DraftIn(content=locked), session, actor)
            e = await raises(r.publish(key, r.PublishIn(change_note="remove the plan name"), session, actor), 422)
            check("a locked field cannot be removed, and the reason names it", e is not None and any("first_name" in p and "locked" in p for p in e.detail["problems"]), str(e))
            check("the draft is kept after a refused publish", (await r.get_template(key, session, actor))["draft"] is not None)

            await r.save_draft(key, r.DraftIn(content=v2), session, actor)
            done = await r.publish(key, r.PublishIn(change_note="Added an extra note, removed the insurer line"), session, actor)
            check("publishing makes the draft the next published version", done["published"]["version"] == 2 and done["published"]["state"] == "published" and done["published"]["published_by"] == str(admin.id))
            vs = await r._versions(session, t)
            check("the earlier version is superseded and there is no draft", {v.version: v.state for v in vs} == {1: "superseded", 2: "published"})
            check("everyone now reads version 2", (await r.published_content(key, session, actor))["version"] == 2)
            check("the publish says what changed", len(done["changes"]) >= 2)
            e = await raises(r.publish(key, r.PublishIn(change_note="again"), session, actor), 409)
            check("publishing with no draft is refused", e is not None)

            d = await r.get_diff(key, "1", "2", session)
            check("the difference between versions 1 and 2 is available", {(x["change"], x["what"]) for x in d["changes"]} >= {("added", "field:extra_note"), ("removed", "field:emergency_contact_name")})
            restored = await r.restore(key, 1, session, actor)
            check("an older version can be restored into the draft (nothing is published)", restored["draft"]["version"] == 3 and (await r.published_content(key, session, actor))["version"] == 2)
            back = await r.publish(key, r.PublishIn(change_note="Restore the layout of version 1"), session, actor)
            check("a restored version can be published as a new version (history is never rewritten)", back["published"]["version"] == 3
                  and {v.version: v.state for v in await r._versions(session, t)} == {1: "superseded", 2: "superseded", 3: "published"})
            await r.save_draft(key, r.DraftIn(content=v2), session, actor)
            discarded = await r.discard_draft(key, session, actor)
            check("a draft can be discarded", discarded["discarded"] is True and (await r.get_template(key, session, actor))["draft"] is None)

            # the database refuses to change history, whatever the API does
            async def refused(sql, params):
                try:
                    async with conn.begin_nested():
                        await conn.execute(text(sql), params)
                    return None
                except DBAPIError as exc:
                    return str(exc.orig)
            m = await refused("update document_template_versions set content = '{}'::jsonb where template_id = :t and version = 3", {"t": t.id})
            check("the database refuses to edit a published version", m is not None and "immutable" in m, str(m))
            m = await refused("delete from document_template_versions where template_id = :t and version = 3", {"t": t.id})
            check("the database refuses to delete a published version", m is not None and "never deleted" in m, str(m))
            m = await refused("update document_template_versions set state = 'draft' where template_id = :t and version = 3", {"t": t.id})
            check("a published version cannot go back to draft", m is not None, str(m))
            m = await refused("insert into document_template_versions (id, template_id, version, state, content, content_sha256, created_at, updated_at) values (gen_random_uuid(), :t, 9, 'published', '{}'::jsonb, 'x', now(), now())", {"t": t.id})
            check("a published version needs a person and a note", m is not None and "published_needs_person_and_note" in m, str(m))
            await session.close()
        finally:
            await outer.rollback()
    print(f"\n{'PASS' if not FAILS else 'FAILED'}: {FAILS} failed")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
