"""Editable templates for the Super Admin (the Templates tab): the Proposal and one Illustration per acquisition source type.

  GET    /admin/doc-templates                       every template, its published version and whether it has an unpublished draft
  GET    /admin/doc-templates/{key}                 one template: the published content, the draft (if any) and the version list
  PUT    /admin/doc-templates/{key}/draft           save the draft (checked for structure; a draft may be saved even if it is not yet publishable)
  DELETE /admin/doc-templates/{key}/draft           discard the draft
  POST   /admin/doc-templates/{key}/publish         make the draft the next published version (needs a written note; locked fields are protected)
  GET    /admin/doc-templates/{key}/versions/{n}    one version
  GET    /admin/doc-templates/{key}/diff?from=&to=  what changed between two versions (`to` may be `draft`)
  POST   /admin/doc-templates/{key}/restore/{n}     put an older version in the draft (nothing is published)
  GET    /doc-templates/{key}                       the published content, for any signed-in user (the forms read it from here)

Saving a draft changes nothing anyone else sees. Publishing is the only act that does, and it is recorded (who, when, why) and read by the
change registry, which finds the golden cases that depend on the template.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, oauth2_scheme, verify_superadmin
from services.audit_capture import record_standalone
from shared import doc_templates as dt
from shared.models.core import User
from shared.models.templates import DocumentTemplate, DocumentTemplateVersion

admin = APIRouter(prefix="/admin/doc-templates", tags=["Templates"], dependencies=[Depends(verify_superadmin)])
reader = APIRouter(prefix="/doc-templates", tags=["Templates"])

KEY = r"^[a-z][a-z0-9_:]{1,78}$"


class DraftIn(BaseModel):
    content: Dict[str, Any]
    change_note: Optional[str] = Field(default=None, max_length=2000)


class PublishIn(BaseModel):
    change_note: str = Field(min_length=3, max_length=2000)

    @field_validator("change_note")
    @classmethod
    def _real_words(cls, v: str) -> str:
        if len(v.strip()) < 3:
            raise ValueError("write why the template is changing")
        return v.strip()


async def _actor(token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)) -> User:
    return await _get_current_user(token, session)


async def ensure_seed(session: AsyncSession, actor: User) -> int:
    """Create any template that does not exist yet, with its seeded content as version 1. Idempotent: an existing template is never touched."""
    made = 0
    for seed in dt.seed_templates():
        if (await session.exec(select(DocumentTemplate).where(DocumentTemplate.template_key == seed["template_key"]))).first():
            continue
        t = DocumentTemplate(template_key=seed["template_key"], kind=seed["kind"], group_key=seed["group_key"], title=seed["title"], description=seed["description"])
        session.add(t)
        await session.flush()
        now = datetime.utcnow()
        session.add(DocumentTemplateVersion(template_id=t.id, version=1, state="published", content=seed["content"], content_sha256=dt.content_hash(seed["content"]),
                                            change_note="Initial version, seeded from the live form and not yet reviewed", created_by=actor.id, published_by=actor.id, published_at=now))
        made += 1
    if made:
        await session.commit()
        for seed in dt.seed_templates():                       # the first reading is the baseline the next change is compared with
            await _tell_the_registry(session, seed["template_key"])
    return made


async def _template(session: AsyncSession, key: str) -> DocumentTemplate:
    t = (await session.exec(select(DocumentTemplate).where(DocumentTemplate.template_key == key))).first()
    if t is None:
        raise HTTPException(404, "No such template.")
    return t


async def _versions(session: AsyncSession, t: DocumentTemplate) -> List[DocumentTemplateVersion]:
    return list((await session.exec(select(DocumentTemplateVersion).where(DocumentTemplateVersion.template_id == t.id).order_by(DocumentTemplateVersion.version.desc()))).all())


def _vout(v: DocumentTemplateVersion, with_content: bool = False) -> Dict[str, Any]:
    out = {"version": v.version, "state": v.state, "change_note": v.change_note, "created_by": str(v.created_by) if v.created_by else None, "created_at": v.created_at,
           "updated_at": v.updated_at, "published_by": str(v.published_by) if v.published_by else None, "published_at": v.published_at, "sha256": v.content_sha256}
    if with_content:
        out["content"] = v.content
    return out


def _published(vs: List[DocumentTemplateVersion]) -> Optional[DocumentTemplateVersion]:
    return next((v for v in vs if v.state == "published"), None)


def _draft(vs: List[DocumentTemplateVersion]) -> Optional[DocumentTemplateVersion]:
    return next((v for v in vs if v.state == "draft"), None)


@admin.get("")
async def list_templates(session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    await ensure_seed(session, actor)
    out = []
    for t in (await session.exec(select(DocumentTemplate).where(DocumentTemplate.status == "active").order_by(DocumentTemplate.kind, DocumentTemplate.template_key))).all():
        vs = await _versions(session, t)
        pub, draft = _published(vs), _draft(vs)
        out.append({"key": t.template_key, "kind": t.kind, "group_key": t.group_key, "title": t.title, "description": t.description, "status": t.status,
                    "published_version": pub.version if pub else None, "published_at": pub.published_at if pub else None, "has_draft": draft is not None,
                    "draft_updated_at": draft.updated_at if draft else None, "fields": len(dt.field_ids(pub.content)) if pub else 0})
    return out


@admin.get("/{key}")
async def get_template(key: str, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    await ensure_seed(session, actor)
    t = await _template(session, key)
    vs = await _versions(session, t)
    pub, draft = _published(vs), _draft(vs)
    return {"key": t.template_key, "kind": t.kind, "group_key": t.group_key, "title": t.title, "description": t.description,
            "published": _vout(pub, True) if pub else None, "draft": _vout(draft, True) if draft else None, "versions": [_vout(v) for v in vs],
            "draft_problems": dt.publish_problems(draft.content, pub.content if pub else None) if draft else []}


@admin.put("/{key}/draft")
async def save_draft(key: str, body: DraftIn, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    t = await _template(session, key)
    vs = await _versions(session, t)
    structural = dt.problems(body.content)
    if structural:
        raise HTTPException(422, detail={"message": "The template is not valid.", "problems": structural})
    draft = _draft(vs)
    now = datetime.utcnow()
    if draft is None:
        top = max((v.version for v in vs), default=0)
        draft = DocumentTemplateVersion(template_id=t.id, version=top + 1, state="draft", content=body.content, content_sha256=dt.content_hash(body.content),
                                        change_note=body.change_note, created_by=actor.id)
        session.add(draft)
    else:
        draft.content, draft.content_sha256, draft.updated_at = body.content, dt.content_hash(body.content), now
        if body.change_note is not None:
            draft.change_note = body.change_note
        session.add(draft)
    await session.commit()
    pub = _published(vs)
    return {"draft": _vout(draft), "publish_problems": dt.publish_problems(body.content, pub.content if pub else None),
            "changes": dt.diff(pub.content, body.content) if pub else []}


@admin.delete("/{key}/draft")
async def discard_draft(key: str, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    t = await _template(session, key)
    draft = _draft(await _versions(session, t))
    if draft is None:
        raise HTTPException(404, "There is no draft to discard.")
    await session.delete(draft)
    await session.commit()
    return {"discarded": True}


@admin.post("/{key}/publish", status_code=201)
async def publish(key: str, body: PublishIn, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    t = await _template(session, key)
    vs = await _versions(session, t)
    draft, pub = _draft(vs), _published(vs)
    if draft is None:
        raise HTTPException(409, "There is no draft to publish. Edit the template first.")
    blocked = dt.publish_problems(draft.content, pub.content if pub else None)
    if blocked:
        raise HTTPException(422, detail={"message": "This template cannot be published yet.", "problems": blocked})
    changes = dt.diff(pub.content, draft.content) if pub else []
    if pub is not None and not changes:
        raise HTTPException(409, "The draft is identical to the published version. There is nothing to publish.")
    now = datetime.utcnow()
    if pub is not None:
        pub.state = "superseded"
        session.add(pub)
        await session.flush()
    draft.state, draft.change_note, draft.published_by, draft.published_at, draft.updated_at = "published", body.change_note.strip(), actor.id, now, now
    session.add(draft)
    await session.commit()
    await record_standalone(module="administration", action="template.publish", entity_type="document_template", entity_id=key, tenant_id=actor.tenant_id, actor_id=str(actor.id),
                            actor_type="USER", actor_role="SuperAdmin", metadata={"version": draft.version, "changes": len(changes), "note": body.change_note[:300]})
    registry = await _tell_the_registry(session, key, changes)
    from services import template_knowledge
    knowledge = await template_knowledge.sync_template(session, key)
    return {"published": _vout(draft), "changes": changes, "registry": registry, "knowledge_base": knowledge}


async def _tell_the_registry(session: AsyncSession, key: str, changes: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """A publish is a change the golden cases may depend on: record it in the change registry now, not at the next scan, open a review item that
    lists the cases depending on it, and suggest cases for the fields it added. A failure here never undoes the publish (the template is saved);
    it is reported so that the next scan picks it up."""
    try:
        from services import eval_drift, eval_registry
        obs = [o for o in await eval_registry.read_templates(session) if o["key"] == f"template:{key}"]
        results = await eval_registry.snapshot(session, captured_from="publish", observations=obs)
        r = results[0]["reading"] if results else None
        review = None
        if r and r["status"] == "changed":
            review = await eval_drift.record_config_change(session, obs[0], r, template_diff=changes if changes is not None else await eval_drift._template_changes(session, obs[0], r),
                                                           template_title=obs[0]["title"], scan_id="registry-publish")
        await session.commit()
        return {"recorded": bool(r), "status": r["status"] if r else None, "registry_version": r["version"] if r else None, "review": review}
    except Exception as exc:                                                              # noqa: BLE001
        await session.rollback()
        return {"recorded": False, "error": f"{type(exc).__name__}: {str(exc)[:160]}", "note": "the template was published; the next scan will record the change"}


@admin.get("/{key}/versions/{n}")
async def get_version(key: str, n: int, session: AsyncSession = Depends(get_session)):
    t = await _template(session, key)
    v = next((x for x in await _versions(session, t) if x.version == n), None)
    if v is None:
        raise HTTPException(404, "No such version.")
    return _vout(v, True)


@admin.get("/{key}/diff")
async def get_diff(key: str, from_: str = Query(alias="from"), to: str = Query(default="draft"), session: AsyncSession = Depends(get_session)):
    t = await _template(session, key)
    vs = await _versions(session, t)

    def pick(x: str) -> DocumentTemplateVersion:
        v = _draft(vs) if x == "draft" else next((y for y in vs if x.isdigit() and y.version == int(x)), None)
        if v is None:
            raise HTTPException(404, f"No version '{x}'.")
        return v
    a, b = pick(from_), pick(to)
    return {"from": a.version, "to": b.version, "changes": dt.diff(a.content, b.content)}


@admin.post("/{key}/restore/{n}")
async def restore(key: str, n: int, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    t = await _template(session, key)
    vs = await _versions(session, t)
    old = next((v for v in vs if v.version == n and v.state != "draft"), None)
    if old is None:
        raise HTTPException(404, "No such published version.")
    return await save_draft(key, DraftIn(content=old.content, change_note=f"Restored from version {n}"), session, actor)


@reader.get("/{key}")
async def published_content(key: str, session: AsyncSession = Depends(get_session), actor: User = Depends(_actor)):
    """What a form renders from: the published version only, never a draft."""
    t = await _template(session, key)
    pub = _published(await _versions(session, t))
    if pub is None:
        raise HTTPException(404, "This template has no published version.")
    return {"key": t.template_key, "version": pub.version, "published_at": pub.published_at, "content": pub.content}
