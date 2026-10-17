"""Document-submission links.

When a plan is attached to a customer (a Policy row) a DocumentRequest is created holding the documents that plan
requires, and the customer gets a link to upload them. Everything here is shared by the staff endpoints (routers/
customers.py) and the unauthenticated customer endpoints (routers/document_requests.py).

The link token is `<request id>.<signature>`, signed with the server secret from the request id and its
`token_version`. Nothing secret is stored, so staff can always copy the same link, and renewing it (bumping the
version) retires the old one.
"""

import hashlib
import hmac
import logging
import os
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from document_requirements import get_required_documents
from shared.models.core import Artifact, Case, DocumentRequest, InsurancePlan, Policy

log = logging.getLogger(__name__)

LINK_VALID_DAYS = 30
_SECRET = os.environ.get("JWT_SECRET_KEY", "change-me-in-production")

# An upload counts as received unless OCR found it unreadable and asked for it again.
_RESUBMIT = "Re-submission Requested"


# ── What the plan requires ───────────────────────────────────────────────────

async def required_documents_for(session: AsyncSession, policy: Policy) -> List[str]:
    """The plan's own required_documents; the standard checklist for the plan type if the plan lists none."""
    plan = (await session.exec(
        select(InsurancePlan).where(
            InsurancePlan.tenant_id == policy.tenant_id,
            InsurancePlan.label == policy.product_name,
        )
    )).first()
    if plan is None:
        plan = (await session.exec(
            select(InsurancePlan).where(
                InsurancePlan.tenant_id == policy.tenant_id,
                InsurancePlan.insurance_type == policy.insurance_type,
            )
        )).first()

    return required_documents_from_plan(plan, policy.insurance_type)


def required_documents_from_plan(plan: Optional[InsurancePlan], insurance_type: Any) -> List[str]:
    """A plan's own required_documents; the standard checklist for the plan type if it lists none."""
    docs: List[str] = list(plan.required_documents or []) if plan is not None else []
    if not docs:
        ins_type = getattr(insurance_type, "value", str(insurance_type))
        docs = list(get_required_documents(ins_type, "Underwriting"))

    seen: set = set()
    return [d for d in docs if not (d in seen or seen.add(d))]


# ── The request and its link ─────────────────────────────────────────────────

async def ensure_document_request(session: AsyncSession, policy: Policy) -> DocumentRequest:
    """The policy's document request, created if it does not exist yet and kept in step with the plan's list."""
    required = await required_documents_for(session, policy)
    req = (await session.exec(select(DocumentRequest).where(DocumentRequest.policy_id == policy.id))).first()
    now = datetime.utcnow()
    if req is None:
        req = DocumentRequest(
            tenant_id=policy.tenant_id,
            policy_id=policy.id,
            customer_id=policy.customer_id,
            required_documents=required,
            expires_at=now + timedelta(days=LINK_VALID_DAYS),
        )
        session.add(req)
    elif list(req.required_documents or []) != required:
        # A changed list means something may be missing again, so a submitted link is reopened.
        if req.submitted_at is not None and any(d not in (req.required_documents or []) for d in required):
            req.submitted_at = None
        req.required_documents = required
        req.updated_at = now
        session.add(req)
    await session.commit()
    await session.refresh(req)
    return req


async def renew_link(session: AsyncSession, req: DocumentRequest) -> DocumentRequest:
    """A fresh link and a fresh expiry; the previous link stops working."""
    req.token_version += 1
    req.submitted_at = None
    req.expires_at = datetime.utcnow() + timedelta(days=LINK_VALID_DAYS)
    req.updated_at = datetime.utcnow()
    session.add(req)
    await session.commit()
    await session.refresh(req)
    return req


def _signature(request_id: UUID, version: int) -> str:
    message = f"document-request:{request_id}:{version}".encode()
    return hmac.new(_SECRET.encode(), message, hashlib.sha256).hexdigest()[:40]


def make_token(req: DocumentRequest) -> str:
    return f"{req.id.hex}.{_signature(req.id, req.token_version)}"


async def find_by_token(session: AsyncSession, token: str) -> Optional[DocumentRequest]:
    try:
        id_hex, signature = token.split(".", 1)
        request_id = UUID(hex=id_hex)
    except (ValueError, AttributeError):
        return None
    req = await session.get(DocumentRequest, request_id)
    if req is None or not hmac.compare_digest(signature, _signature(req.id, req.token_version)):
        return None
    return req


# ── What has arrived ─────────────────────────────────────────────────────────

async def _cases_for(session: AsyncSession, req: DocumentRequest) -> List[Case]:
    return list((await session.exec(
        select(Case).where(Case.tenant_id == req.tenant_id, Case.policy_id == req.policy_id)
    )).all())


async def latest_case(session: AsyncSession, req: DocumentRequest) -> Optional[Case]:
    cases = await _cases_for(session, req)
    return max(cases, key=lambda c: c.createdAt) if cases else None


async def summary(session: AsyncSession, req: DocumentRequest) -> Dict[str, Any]:
    """Each required document with the files received for it. Files uploaded through the link, and files staff put on
    the policy's case, both count."""
    case_ids = [c.caseld for c in await _cases_for(session, req)]
    stmt = select(Artifact).where(Artifact.tenant_id == req.tenant_id, Artifact.claim_id.is_(None))
    arts = list((await session.exec(stmt.where(Artifact.source_request_id == req.id))).all())
    if case_ids:
        arts += list((await session.exec(stmt.where(Artifact.case_id.in_(case_ids)))).all())

    by_type: Dict[str, Dict[UUID, Artifact]] = {}
    for a in arts:
        by_type.setdefault(a.document_type, {})[a.id] = a

    items = []
    for doc in req.required_documents or []:
        files = sorted(by_type.get(doc, {}).values(), key=lambda a: a.created_at)
        usable = [f for f in files if f.status != _RESUBMIT]
        state = "received" if usable else ("reupload" if files else "missing")
        items.append({
            "document_type": doc,
            "state": state,
            "files": [{"file_name": f.file_name, "uploaded_at": f.created_at.isoformat(), "status": f.status} for f in files],
        })
    return {
        "requirements": items,
        "received": sum(1 for i in items if i["state"] == "received"),
        "total": len(items),
        "all_received": bool(items) and all(i["state"] == "received" for i in items),
        "submitted": req.submitted_at is not None,
        "expires_at": req.expires_at.isoformat(),
        "expired": req.expires_at < datetime.utcnow(),
    }


# ── Joining the case ─────────────────────────────────────────────────────────

async def adopt_documents(session: AsyncSession, case: Case) -> None:
    """A case was opened on the policy: files the customer uploaded earlier through the link join it, so
    underwriting sees them. Best-effort: it must never stop the case being created."""
    if case.policy_id is None:
        return
    try:
        req = (await session.exec(select(DocumentRequest).where(DocumentRequest.policy_id == case.policy_id))).first()
        if req is None:
            return
        orphans = (await session.exec(
            select(Artifact).where(Artifact.source_request_id == req.id, Artifact.case_id.is_(None))
        )).all()
        if not orphans:
            return
        for artifact in orphans:
            artifact.case_id = case.caseld
            session.add(artifact)
        await session.commit()

        from services import underwriting_gate  # imported here: it pulls in a lot, and only this path needs it
        await underwriting_gate.compute_requirements(session, case.tenant_id, case)
    except Exception:
        log.exception("could not attach document-request uploads to case %s", case.caseld)
