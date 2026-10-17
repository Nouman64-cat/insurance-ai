"""Customer-facing document submission.

The customer opens the link staff share (/documents/<token>), sees the documents their plan requires, and uploads
each one. There is no login: the signed token in the link is the only credential, and it only ever lets the holder
see this one checklist and add files to it. Staff-facing endpoints live in routers/customers.py.

Uploads use the same storage and OCR path as staff uploads (routers/artifacts.py), so a document arrives exactly as
if staff had uploaded it.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, Optional
from uuid import UUID, uuid4

from aiokafka import AIOKafkaProducer
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.artifacts import OCR_TOPIC, SUPPORTED_MIME, _s3_key, _upload_to_s3
from services import document_requests as docreq
from shared.events.kafka_events import ArtifactOCRPayload, ArtifactOCRRequestedEvent
from shared.models.core import Artifact, Customer, DocumentRequest, Policy, Tenant

log = logging.getLogger(__name__)

router = APIRouter(tags=["Document Submission"])

MAX_UPLOAD_BYTES = 15 * 1024 * 1024
_NO_CASE = UUID(int=0)   # the OCR event schema wants a case id; the worker only reads the artifact row


async def _resolve(session: AsyncSession, raw_token: str) -> DocumentRequest:
    req = await docreq.find_by_token(session, raw_token)
    if req is None:
        raise HTTPException(status_code=404, detail="This link is not valid.")
    if req.expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="This link has expired. Please ask your agent for a new one.")
    return req


async def _view(session: AsyncSession, req: DocumentRequest) -> Dict[str, Any]:
    policy = await session.get(Policy, req.policy_id)
    customer = await session.get(Customer, req.customer_id)
    tenant = await session.get(Tenant, req.tenant_id)
    return {
        "customer_name": customer.name if customer else None,
        "plan_label": policy.product_name if policy else None,
        "insurer_name": tenant.name if tenant else None,
        **(await docreq.summary(session, req)),
    }


def _require_open(req: DocumentRequest) -> None:
    if req.submitted_at is not None:
        raise HTTPException(status_code=409, detail="These documents have already been submitted and can no longer be changed.")


@router.post("/public/documents/{raw_token}/submit")
async def public_submit_documents(raw_token: str, session: AsyncSession = Depends(get_session)):
    """The customer presses Done. Only possible once every required document has arrived; afterwards the link is
    read-only (staff can reopen it by renewing the link)."""
    req = await _resolve(session, raw_token)
    if req.submitted_at is None:
        summary = await docreq.summary(session, req)
        if summary["total"] and not summary["all_received"]:
            raise HTTPException(status_code=400, detail="Please upload every required document before pressing Done.")
        req.submitted_at = datetime.utcnow()
        session.add(req)
        await session.commit()
        await session.refresh(req)
    return await _view(session, req)


@router.get("/public/documents/{raw_token}")
async def public_get_documents(raw_token: str, session: AsyncSession = Depends(get_session)):
    return await _view(session, await _resolve(session, raw_token))


@router.post("/public/documents/{raw_token}/upload")
async def public_upload_document(
    request: Request,
    raw_token: str,
    document_type: str = Form(...),
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
):
    req = await _resolve(session, raw_token)
    _require_open(req)
    if document_type not in (req.required_documents or []):
        raise HTTPException(status_code=400, detail="That document is not on your list.")

    ext = (file.filename or "").lower().rsplit(".", 1)[-1]
    if ext not in SUPPORTED_MIME:
        raise HTTPException(status_code=400, detail=f"Unsupported file type '.{ext}'. Allowed: {', '.join(SUPPORTED_MIME)}")
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="That file is empty.")
    if len(file_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="That file is too large (15 MB maximum).")
    mime_type = SUPPORTED_MIME[ext]

    # A case may not exist yet (it opens when the proposal goes to underwriting): the file then waits on the request
    # and joins the case when it is created (services.document_requests.adopt_documents).
    case = await docreq.latest_case(session, req)
    artifact_id = uuid4()
    safe_name = (file.filename or f"{document_type}.{ext}").replace("/", "_")
    s3_key = (
        _s3_key(req.tenant_id, case.caseld, artifact_id, safe_name)
        if case is not None
        else f"{req.tenant_id}/policies/{req.policy_id}/{artifact_id}/{safe_name}"
    )
    loop = asyncio.get_running_loop()
    try:
        storage_url = await loop.run_in_executor(None, lambda: _upload_to_s3(file_bytes, s3_key, mime_type))
    except Exception as exc:
        log.exception("document upload failed for request %s", req.id)
        raise HTTPException(status_code=502, detail="We could not save that file. Please try again.") from exc

    session.add(Artifact(
        id=artifact_id,
        tenant_id=req.tenant_id,
        case_id=case.caseld if case is not None else None,
        customer_id=req.customer_id,
        source_request_id=req.id,
        document_type=document_type,
        file_name=safe_name,
        file_size=len(file_bytes),
        file_type=mime_type,
        storage_url=storage_url,
        status="Uploaded",
    ))
    await session.commit()

    try:
        producer: Optional[AIOKafkaProducer] = getattr(request.app.state, "kafka_producer", None)
        if producer is not None:
            event = ArtifactOCRRequestedEvent(
                tenant_id=req.tenant_id,
                payload=ArtifactOCRPayload(
                    artifact_id=artifact_id,
                    tenant_id=req.tenant_id,
                    case_id=case.caseld if case is not None else _NO_CASE,
                    s3_key=s3_key,
                    file_name=safe_name,
                    mime_type=mime_type,
                ),
            )
            await producer.send_and_wait(OCR_TOPIC, value=event.model_dump_json(), key=str(artifact_id))
    except Exception:
        log.warning("could not queue OCR for artifact %s", artifact_id, exc_info=True)

    return await _view(session, req)
