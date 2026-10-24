"""The published Lead acquisition template, for the code that saves a lead: the walk-in route, and customer create / update.

`check_custom` is the one place the answers to fields added in the Templates tab are validated before they are stored (shared/doc_templates.py has the
rules). A record is never stored with an unvalidated `details.custom`.
"""
from typing import Any, Dict, Optional, Tuple

from fastapi import HTTPException
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared import doc_templates as dt
from shared.models.templates import DocumentTemplate, DocumentTemplateVersion

LEAD_KEY = "lead_acquisition"


async def published(session: AsyncSession, key: str = LEAD_KEY) -> Optional[Dict[str, Any]]:
    t = (await session.exec(select(DocumentTemplate).where(DocumentTemplate.template_key == key, DocumentTemplate.status == "active"))).first()
    if t is None:
        return None
    v = (await session.exec(select(DocumentTemplateVersion).where(DocumentTemplateVersion.template_id == t.id, DocumentTemplateVersion.state == "published"))).first()
    return {"key": key, "version": v.version, "content": v.content} if v else None


async def check_declaration(session: AsyncSession, declaration: Optional[Dict[str, Any]], *, submitting: bool) -> Optional[Dict[str, Any]]:
    """The same for the customer e-application: the answers to fields added to the Proposal template travel in `declaration.custom`. A saved draft
    is only checked for type and shape; the required ones are enforced when the application is submitted."""
    if not isinstance(declaration, dict) or "custom" not in declaration:
        return declaration
    tpl = await published(session, "proposal")
    clean, problems = dt.validate_answers(tpl["content"] if tpl else None, declaration.get("custom"), enforce_required=submitting)
    if problems:
        raise HTTPException(422, detail={"message": "Some of the additional questions are not valid.", "problems": problems})
    out = dict(declaration)
    out["custom"] = clean
    if tpl:
        out["template"] = {"key": "proposal", "version": tpl["version"]}
    return out


async def check_custom(session: AsyncSession, details: Optional[Dict[str, Any]], *, existing: Optional[Dict[str, Any]] = None, creating: bool) -> Optional[Dict[str, Any]]:
    """Validate `details["custom"]` against the published template and return the details to store (or the details unchanged if there is no `custom`).
    A new record must answer the required added fields; an existing one keeps answers to fields since removed and is not locked out by a field that
    became required later. Anything invalid is refused with the field named."""
    if not isinstance(details, dict) or "custom" not in details:
        return details
    tpl = await published(session)
    keep = (existing or {}) if not creating else {}
    clean, problems = dt.validate_answers(tpl["content"] if tpl else None, details.get("custom"), enforce_required=creating, keep=keep)
    if problems:
        raise HTTPException(422, detail={"message": "Some of the additional fields are not valid.", "problems": problems})
    out = dict(details)
    out["custom"] = clean
    if tpl:
        out["template"] = {"key": tpl["key"], "version": tpl["version"]}
    return out
