"""Keeps the agent's knowledge base (the SOPs the suggested-actions assistant retrieves) in line with the published form templates.

When a template is published, its readable text replaces the previous entry for that template: one row per template, category 'Template'. A
failure (no embedding key, no vector support, the embedding service down) never undoes the publish; the old entry stays until a later sync
succeeds, and `freshness` says which templates are behind. Nothing here touches the SOP rows.
"""
import logging
import os
from typing import Any, Dict, List

from sqlalchemy import text
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

log = logging.getLogger(__name__)
CATEGORY = "Template"
MARK = "Template version: "


def render(title: str, version: int, content: Dict[str, Any]) -> str:
    """The template as plain text an assistant can quote: sections, field labels, choices, what is required."""
    lines = [f"Form: {title}", f"{MARK}{version}", content.get("intro") or ""]
    for s in content.get("sections", []):
        lines.append(f"\nSection: {s.get('title')}")
        for f in s.get("fields", []):
            if f.get("type") in ("display", "statement") and not f.get("label"):
                continue
            opts = ", ".join(str(o.get("label", o)) if isinstance(o, dict) else str(o) for o in f.get("options") or [])
            lines.append(f"- {f.get('label') or f.get('id')} ({f.get('type')}{', required' if f.get('required') else ''})" + (f": {opts}" if opts else ""))
    for d in content.get("disclaimers") or []:
        lines.append(f"Note: {d if isinstance(d, str) else d.get('text', '')}")
    return "\n".join(l for l in lines if l is not None)


def _embed(body: str) -> List[float]:
    from google import genai
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    return client.models.embed_content(model="models/gemini-embedding-001", contents=body).embeddings[0].values


async def sync_template(session: AsyncSession, template_key: str) -> Dict[str, Any]:
    """Replace the knowledge-base entry of one template with its published content. Returns a status; never raises."""
    from shared.models.templates import DocumentTemplate, DocumentTemplateVersion
    try:
        t = (await session.exec(select(DocumentTemplate).where(DocumentTemplate.template_key == template_key))).first()
        v = (await session.exec(select(DocumentTemplateVersion).where(DocumentTemplateVersion.template_id == t.id, DocumentTemplateVersion.state == "published"))).first() if t else None
        if v is None:
            return {"status": "skipped", "reason": "the template has no published version"}
        if not os.getenv("GEMINI_API_KEY"):
            return {"status": "skipped", "reason": "no embedding key is configured; the assistant keeps the previous entry"}
        has = (await session.execute(text("select to_regclass('agent_knowledge_base')"))).scalar()
        if not has:
            return {"status": "skipped", "reason": "the knowledge base is not available in this deployment"}
        body = render(t.title, v.version, v.content)
        vector = "[" + ",".join(str(x) for x in _embed(body)) + "]"                          # embedded first: if this fails, nothing is deleted
        title = f"Form template: {t.title}"
        async with session.begin_nested():
            await session.execute(text("delete from agent_knowledge_base where category = :c and title = :t"), {"c": CATEGORY, "t": title})
            await session.execute(text("insert into agent_knowledge_base (id, category, title, content, embedding, created_at) values (gen_random_uuid(), :c, :t, :b, cast(:v as vector), now())"),
                                  {"c": CATEGORY, "t": title, "b": body, "v": vector})
        await session.commit()
        return {"status": "indexed", "title": title, "version": v.version}
    except Exception as exc:                                                                 # noqa: BLE001
        await session.rollback()
        log.warning("knowledge-base sync for template %s failed: %s", template_key, exc)
        return {"status": "failed", "error": f"{type(exc).__name__}: {str(exc)[:160]}", "note": "the template was published; the assistant keeps the previous entry"}


async def freshness(session: AsyncSession) -> List[Dict[str, Any]]:
    """For each active template with a published version: the version the assistant knows, and whether it is current."""
    from shared.models.templates import DocumentTemplate, DocumentTemplateVersion
    out = []
    has = (await session.execute(text("select to_regclass('agent_knowledge_base')"))).scalar()
    for t in (await session.exec(select(DocumentTemplate).where(DocumentTemplate.status == "active").order_by(DocumentTemplate.template_key))).all():
        v = (await session.exec(select(DocumentTemplateVersion).where(DocumentTemplateVersion.template_id == t.id, DocumentTemplateVersion.state == "published"))).first()
        if v is None:
            continue
        known = None
        if has:
            row = (await session.execute(text("select content from agent_knowledge_base where category = :c and title = :t"), {"c": CATEGORY, "t": f"Form template: {t.title}"})).first()
            if row:
                line = next((l for l in row[0].splitlines() if l.startswith(MARK)), "")
                known = int(line[len(MARK):]) if line[len(MARK):].isdigit() else None
        out.append({"template": t.template_key, "title": t.title, "published_version": v.version, "assistant_knows": known, "current": known == v.version})
    return out
