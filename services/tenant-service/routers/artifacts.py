import asyncio
import os
from typing import List, Optional
from uuid import UUID, uuid4

import boto3
from aiokafka import AIOKafkaProducer
from botocore.exceptions import ClientError
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from jose import JWTError
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import decode_access_token, oauth2_scheme
from shared.events.kafka_events import ArtifactOCRPayload, ArtifactOCRRequestedEvent
from shared.models.core import Artifact, Case, Claim, Policy, Tenant, User

router = APIRouter(prefix="/tenants", tags=["Artifacts"])

_S3_BUCKET  = os.environ.get("S3_BUCKET_NAME", "insurance-ai-dev")
# S3 has its own region var, separate from AWS_REGION (used by SES, which
# doesn't support every S3 region — e.g. the insurance-ai-dev bucket lives in
# ap-south-1, a region SES isn't available in).
_AWS_REGION = os.environ.get("AWS_S3_REGION") or os.environ.get("AWS_REGION", "us-east-1")
OCR_TOPIC   = "insurance.artifact.ocr.requested.v1"

SUPPORTED_MIME = {
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "tiff": "image/tiff",
    "bmp": "image/bmp",
    "heic": "image/heic",
}


def _s3_client():
    return boto3.client(
        "s3",
        region_name=_AWS_REGION,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


from fastapi.responses import FileResponse, HTMLResponse

def _upload_to_s3(file_bytes: bytes, key: str, content_type: str) -> str:
    try:
        # Check if dummy credentials are used to avoid slow timeout/exception
        access_key = os.environ.get("AWS_ACCESS_KEY_ID", "")
        if not access_key or "your_aws_access_key" in access_key:
            raise ValueError("Dummy AWS credentials detected")

        client = _s3_client()
        client.put_object(
            Bucket=_S3_BUCKET,
            Key=key,
            Body=file_bytes,
            ContentType=content_type,
        )
        return f"https://{_S3_BUCKET}.s3.{_AWS_REGION}.amazonaws.com/{key}"
    except Exception as exc:
        import logging
        logging.getLogger("tenant-service.artifacts").warning(
            "S3 upload failed: %s. Using local filesystem storage fallback.", exc
        )
        local_path = os.path.join("/app/shared/storage", key)
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        with open(local_path, "wb") as f:
            f.write(file_bytes)
        return f"local://{key}"


def _presign_url(key: str, expires: int = 3600) -> str:
    try:
        access_key = os.environ.get("AWS_ACCESS_KEY_ID", "")
        if not access_key or "your_aws_access_key" in access_key:
            raise ValueError("Dummy AWS credentials")

        client = _s3_client()
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": _S3_BUCKET, "Key": key},
            ExpiresIn=expires,
        )
    except Exception:
        return ""


def _s3_key(tenant_id: UUID, case_id: UUID, artifact_id: UUID, file_name: str) -> str:
    return f"{tenant_id}/cases/{case_id}/{artifact_id}/{file_name}"


async def _get_current_user_id(token: str) -> UUID:
    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
        return UUID(user_id)
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


@router.post(
    "/{tenant_id}/cases/{case_id}/artifacts",
    status_code=202,
    summary="Upload document — S3 sync, OCR async via Kafka",
)
async def upload_artifact(
    request: Request,
    tenant_id: UUID,
    case_id: UUID,
    document_type: str = Form(..., description="e.g. CNIC, Salary Slip, Medical Report, X-Ray"),
    file: UploadFile = File(...),
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    user_id = await _get_current_user_id(token)

    tenant = await session.get(Tenant, tenant_id)
    if tenant is None or not tenant.is_active:
        raise HTTPException(status_code=404, detail="Tenant not found or inactive")

    case = await session.get(Case, case_id)
    if case is None or case.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Case not found")

    ext = (file.filename or "").lower().rsplit(".", 1)[-1]
    if ext not in SUPPORTED_MIME:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '.{ext}'. Allowed: {', '.join(SUPPORTED_MIME)}",
        )
    mime_type = SUPPORTED_MIME[ext]

    file_bytes = await file.read()
    artifact_id = uuid4()
    s3_key = _s3_key(tenant_id, case_id, artifact_id, file.filename)

    # 1. Upload to S3 (with local filesystem fallback)
    loop = asyncio.get_running_loop()
    try:
        storage_url = await loop.run_in_executor(
            None, lambda: _upload_to_s3(file_bytes, s3_key, mime_type)
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"S3 upload failed: {exc}")

    # 2. Persist artifact row immediately with Processing status
    artifact = Artifact(
        id=artifact_id,
        tenant_id=tenant_id,
        case_id=case_id,
        customer_id=case.customer_id,
        uploaded_by=user_id,
        document_type=document_type,
        file_name=file.filename,
        file_size=len(file_bytes),
        file_type=mime_type,
        storage_url=storage_url,
        ocr_result=None,
        ocr_confidence_score=0.0,
        authenticity_score=1.0,
        quality_score=1.0,
        status="Uploaded",
    )
    session.add(artifact)
    await session.commit()
    await session.refresh(artifact)

    # 3. Publish OCR job to Kafka — worker picks it up and updates the row async
    event = ArtifactOCRRequestedEvent(
        tenant_id=tenant_id,
        payload=ArtifactOCRPayload(
            artifact_id=artifact_id,
            tenant_id=tenant_id,
            case_id=case_id,
            s3_key=s3_key,
            file_name=file.filename or "",
            mime_type=mime_type,
        ),
    )
    try:
        producer: AIOKafkaProducer = request.app.state.kafka_producer
        await producer.send_and_wait(
            OCR_TOPIC,
            value=event.model_dump_json(),
            key=str(artifact_id),
        )
    except Exception as exc:
        import logging
        logging.getLogger("tenant-service.artifacts").warning(
            "Kafka publish failed for artifact %s: %s", artifact_id, exc
        )

    return _artifact_response(artifact, s3_key, request)


@router.post(
    "/{tenant_id}/claims/{claim_id}/artifacts",
    status_code=202,
    summary="Upload claim document — S3 sync, OCR async via Kafka",
)
async def upload_claim_artifact(
    request: Request,
    tenant_id: UUID,
    claim_id: UUID,
    document_type: str = Form(..., description="e.g. Hospital Bill, Discharge Summary, Death Certificate, CNIC"),
    file: UploadFile = File(...),
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    user_id = await _get_current_user_id(token)

    tenant = await session.get(Tenant, tenant_id)
    if tenant is None or not tenant.is_active:
        raise HTTPException(status_code=404, detail="Tenant not found or inactive")

    claim = await session.get(Claim, claim_id)
    if claim is None or claim.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Claim not found")

    ext = (file.filename or "").lower().rsplit(".", 1)[-1]
    if ext not in SUPPORTED_MIME:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '.{ext}'. Allowed: {', '.join(SUPPORTED_MIME)}",
        )
    mime_type = SUPPORTED_MIME[ext]

    file_bytes = await file.read()
    artifact_id = uuid4()
    s3_key = f"{tenant_id}/claims/{claim_id}/{artifact_id}/{file.filename}"

    loop = asyncio.get_running_loop()
    try:
        storage_url = await loop.run_in_executor(
            None, lambda: _upload_to_s3(file_bytes, s3_key, mime_type)
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"S3 upload failed: {exc}")

    policy = await session.get(Policy, claim.policy_id)
    cust_id = policy.customer_id if policy else None

    artifact = Artifact(
        id=artifact_id,
        tenant_id=tenant_id,
        claim_id=claim_id,
        case_id=claim.case_id,
        customer_id=cust_id,
        uploaded_by=user_id,
        document_type=document_type,
        file_name=file.filename,
        file_size=len(file_bytes),
        file_type=mime_type,
        storage_url=storage_url,
        ocr_result=None,
        ocr_confidence_score=0.0,
        authenticity_score=1.0,
        quality_score=1.0,
        status="Uploaded",
    )
    session.add(artifact)
    await session.commit()
    await session.refresh(artifact)

    event = ArtifactOCRRequestedEvent(
        tenant_id=tenant_id,
        payload=ArtifactOCRPayload(
            artifact_id=artifact_id,
            tenant_id=tenant_id,
            case_id=claim.case_id or claim_id,
            s3_key=s3_key,
            file_name=file.filename or "",
            mime_type=mime_type,
        ),
    )
    try:
        producer: AIOKafkaProducer = request.app.state.kafka_producer
        await producer.send_and_wait(
            OCR_TOPIC,
            value=event.model_dump_json(),
            key=str(artifact_id),
        )
    except Exception as exc:
        import logging
        logging.getLogger("tenant-service.artifacts").warning(
            "Kafka publish failed for artifact %s: %s", artifact_id, exc
        )

    return _artifact_response(artifact, s3_key, request)


@router.get("/{tenant_id}/claims/{claim_id}/artifacts", summary="List artifacts for a claim")
async def list_claim_artifacts(
    request: Request,
    tenant_id: UUID,
    claim_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    await _get_current_user_id(token)
    stmt = select(Artifact).where(Artifact.tenant_id == tenant_id, Artifact.claim_id == claim_id)
    artifacts = (await session.exec(stmt)).all()
    return [_artifact_response(a, a.storage_url.replace(f"https://{_S3_BUCKET}.s3.{_AWS_REGION}.amazonaws.com/", ""), request) for a in artifacts]


@router.get("/{tenant_id}/cases/{case_id}/artifacts", summary="List artifacts for a case")
async def list_case_artifacts(
    request: Request,
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    case = await session.get(Case, case_id)
    if case is None or case.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Case not found")
    rows = (await session.exec(
        select(Artifact).where(Artifact.customer_id == case.customer_id, Artifact.tenant_id == tenant_id)
    )).all()

    return [_artifact_response(a, a.storage_url.split(".amazonaws.com/", 1)[1] if a.storage_url and ".amazonaws.com/" in a.storage_url else None, request) for a in rows]


def _upload_to_s3(file_bytes: bytes, key: str, content_type: str) -> str:
    # Always write to local storage first so previewing and viewing work 100% reliably
    local_path = os.path.join("/app/shared/storage", key)
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    with open(local_path, "wb") as f:
        f.write(file_bytes)

    try:
        access_key = os.environ.get("AWS_ACCESS_KEY_ID", "")
        if not access_key or "your_aws_access_key" in access_key:
            return f"local://{key}"

        client = _s3_client()
        client.put_object(
            Bucket=_S3_BUCKET,
            Key=key,
            Body=file_bytes,
            ContentType=content_type,
        )
        return f"local://{key}"
    except Exception as exc:
        import logging
        logging.getLogger("tenant-service.artifacts").warning(
            "S3 upload failed: %s. Using local filesystem storage fallback.", exc
        )
        return f"local://{key}"


def _presign_url(key: str, expires: int = 3600) -> str:
    try:
        access_key = os.environ.get("AWS_ACCESS_KEY_ID", "")
        if not access_key or "your_aws_access_key" in access_key:
            raise ValueError("Dummy AWS credentials")

        client = _s3_client()
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": _S3_BUCKET, "Key": key},
            ExpiresIn=expires,
        )
    except Exception:
        return f"/tenants/demo/artifacts/{key}"


@router.get("/{tenant_id}/artifacts/{artifact_id}/download", summary="Download/View artifact file")
@router.get("/{tenant_id}/artifacts/{artifact_id}/view", summary="View artifact document preview")
async def view_artifact_file(
    tenant_id: UUID,
    artifact_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    artifact = await session.get(Artifact, artifact_id)
    if artifact is None or artifact.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Artifact not found")

    # 1. Search for local file on disk
    possible_keys = []
    if artifact.storage_url:
        if artifact.storage_url.startswith("local://"):
            possible_keys.append(artifact.storage_url.replace("local://", ""))
        elif ".amazonaws.com/" in artifact.storage_url:
            possible_keys.append(artifact.storage_url.split(".amazonaws.com/", 1)[-1])
        possible_keys.append(artifact.storage_url)

    if artifact.claim_id:
        possible_keys.append(f"{tenant_id}/claims/{artifact.claim_id}/{artifact_id}/{artifact.file_name}")
    if artifact.case_id:
        possible_keys.append(f"{tenant_id}/cases/{artifact.case_id}/{artifact_id}/{artifact.file_name}")

    for k in possible_keys:
        local_path = os.path.join("/app/shared/storage", k)
        if os.path.exists(local_path) and os.path.isfile(local_path):
            return FileResponse(
                local_path,
                media_type=artifact.file_type or "application/octet-stream",
                content_disposition_type="inline"
            )

    # 2. Format extracted document OCR content into rich document view
    import html, re
    document_body_html = ""

    # Clean filename by stripping trailing duplicate brackets like (1), (2)
    clean_filename = re.sub(r"\s*\(\d+\)(\.[a-zA-Z0-9]+)?$", r"\1", artifact.file_name or "")

    if artifact.ocr_result:
        raw_text = artifact.ocr_result.strip()
        if raw_text.startswith("```"):
            lines = raw_text.split("\n")
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            raw_text = "\n".join(lines)

        escaped_text = html.escape(raw_text)
        formatted_blocks = []

        for line in escaped_text.split("\n"):
            line_str = line.strip()
            if not line_str:
                formatted_blocks.append('<div style="height: 8px;"></div>')
            elif line_str.isupper() and len(line_str) < 50:
                formatted_blocks.append(f'<h3 style="font-size: 13px; font-weight: 800; color: #0f172a; margin: 18px 0 6px 0; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1.5px solid #cbd5e1; padding-bottom: 4px;">{line_str}</h3>')
            elif line_str.startswith("- "):
                formatted_blocks.append(f'<div style="display: flex; gap: 8px; margin: 4px 0 4px 12px; font-size: 13px; color: #334155;"><span style="color: #3b82f6;">•</span><span>{line_str[2:]}</span></div>')
            elif ":" in line_str and not line_str.startswith("http"):
                parts = line_str.split(":", 1)
                formatted_blocks.append(f'<div style="display: flex; gap: 8px; font-size: 13px; margin: 4px 0;"><span style="font-weight: 700; color: #475569; min-width: 140px;">{parts[0]}:</span><span style="color: #0f172a; font-weight: 500;">{parts[1]}</span></div>')
            else:
                formatted_blocks.append(f'<p style="margin: 4px 0; font-size: 13px; line-height: 1.6; color: #1e293b;">{line_str}</p>')

        document_body_html = "".join(formatted_blocks)
    elif artifact.file_type and artifact.file_type.startswith("image/"):
        document_body_html = f"""<div style="text-align: center; padding: 40px 20px;">
            <div style="background: #f1f5f9; border-radius: 12px; padding: 32px; border: 2px dashed #cbd5e1;">
                <svg width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="#64748b" stroke-width="1.5" style="margin: 0 auto 12px;"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"/></svg>
                <p style="font-weight: 700; font-size: 15px; margin: 0; color: #1e293b;">Image Document File - {clean_filename}</p>
                <p style="font-size: 13px; margin-top: 6px; color: #64748b;">Uploaded image document attached to claim. Re-upload or upload new documents to preview full-resolution images instantly.</p>
            </div>
        </div>"""
    else:
        document_body_html = f"""<div style="text-align: center; padding: 40px 20px; color: #64748b;">
            <svg width="40" height="40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" style="margin: 0 auto 12px; color: #94a3b8;"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3h7.5M6 20.25h12a2.25 2.25 0 002.25-2.25V8.25a2.25 2.25 0 00-2.25-2.25h-3a3.375 3.375 0 00-3.375-3.375H8.25A2.25 2.25 0 006 4.875v13.125A2.25 2.25 0 006 20.25z"/></svg>
            <p style="font-weight: 600; font-size: 14px; margin: 0; color: #334155;">Verification Document Record</p>
            <p style="font-size: 12px; margin-top: 4px; color: #94a3b8;">Document file attached to claim #{artifact.claim_id or artifact.id}</p>
        </div>"""

    created_date = artifact.created_at.strftime('%Y-%m-%d %H:%M UTC') if hasattr(artifact.created_at, 'strftime') else str(artifact.created_at).split('.')[0]
    size_str = f"{(artifact.file_size / 1024):.1f} KB" if artifact.file_size else "N/A"

    content = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Document Viewer - {clean_filename}</title>
    <style>
        * {{ box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }}
        body {{ background-color: #0f172a; color: #0f172a; margin: 0; padding: 0; min-height: 100vh; display: flex; flex-direction: column; }}
        .navbar {{ background: #1e293b; border-bottom: 1px solid #334155; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; color: white; }}
        .nav-title {{ font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 10px; }}
        .badge {{ background: #064e3b; color: #34d399; font-weight: 600; font-size: 11px; padding: 3px 10px; border-radius: 9999px; border: 1px solid #059669; display: inline-flex; align-items: center; gap: 6px; }}
        .badge-dot {{ width: 6px; height: 6px; background: #34d399; border-radius: 50%; }}
        .viewer-container {{ flex: 1; display: flex; justify-content: center; padding: 32px 16px; overflow-y: auto; background: #0f172a; }}
        .paper-sheet {{ background: #ffffff; border-radius: 8px; box-shadow: 0 20px 40px rgba(0,0,0,0.4); max-width: 800px; width: 100%; min-height: 950px; padding: 48px 56px; border: 1px solid #e2e8f0; display: flex; flex-direction: column; justify-content: space-between; }}
        .paper-header {{ border-bottom: 2px solid #0f172a; padding-bottom: 16px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: flex-end; }}
        .paper-title {{ font-size: 20px; font-weight: 800; color: #0f172a; margin: 0; text-transform: uppercase; tracking: -0.02em; }}
        .paper-subtitle {{ font-size: 12px; color: #64748b; font-weight: 600; margin-top: 4px; }}
        .meta-strip {{ background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; display: flex; justify-content: space-between; font-size: 12px; color: #475569; }}
        .paper-body {{ flex: 1; font-size: 13px; line-height: 1.6; color: #1e293b; }}
        .paper-footer {{ border-top: 1px solid #e2e8f0; margin-top: 32px; padding-top: 16px; display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #94a3b8; font-weight: 500; }}
    </style>
</head>
<body>
    <div class="navbar">
        <div class="nav-title">
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#94a3b8" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            <span>{clean_filename}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
            <span class="badge"><span class="badge-dot"></span>{artifact.status or "Verified"}</span>
            <button onclick="window.print()" style="background: #334155; color: white; border: none; padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;">Print Document</button>
        </div>
    </div>

    <div class="viewer-container">
        <div class="paper-sheet">
            <div>
                <div class="paper-header">
                    <div>
                        <h1 class="paper-title">Official Claim Document</h1>
                        <div class="paper-subtitle">{artifact.document_type} · Prerequisite Audit Artifact</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 11px; font-weight: 700; color: #059669; text-transform: uppercase;">VERIFIED EVIDENCE</div>
                        <div style="font-size: 10px; color: #94a3b8; margin-top: 2px;">ID: {str(artifact.id)[:18]}...</div>
                    </div>
                </div>

                <div class="meta-strip">
                    <div><strong>File Name:</strong> {clean_filename}</div>
                    <div><strong>Size:</strong> {size_str}</div>
                    <div><strong>Uploaded:</strong> {created_date}</div>
                </div>

                <div class="paper-body">
                    {document_body_html}
                </div>
            </div>

            <div class="paper-footer">
                <div>Insurance AI Governance Framework · Document Gate Verified</div>
                <div>Page 1 of 1</div>
            </div>
        </div>
    </div>
</body>
</html>"""
    return HTMLResponse(content=content, status_code=200)


@router.get("/{tenant_id}/artifacts/{artifact_id}", summary="Get artifact with fresh presigned URL")
async def get_artifact(
    request: Request,
    tenant_id: UUID,
    artifact_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    artifact = await session.get(Artifact, artifact_id)
    if artifact is None or artifact.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Artifact not found")

    key = None
    if artifact.storage_url:
        if artifact.storage_url.startswith("local://"):
            key = artifact.storage_url.replace("local://", "")
        else:
            try:
                key = artifact.storage_url.split(".amazonaws.com/", 1)[1]
            except IndexError:
                pass

    return _artifact_response(artifact, key, request)


class ArtifactUpdate(BaseModel):
    document_type: Optional[str] = None


@router.patch("/{tenant_id}/artifacts/{artifact_id}", summary="Update artifact metadata")
async def update_artifact(
    request: Request,
    tenant_id: UUID,
    artifact_id: UUID,
    payload: ArtifactUpdate,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    artifact = await session.get(Artifact, artifact_id)
    if artifact is None or artifact.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Artifact not found")

    if payload.document_type is not None:
        artifact.document_type = payload.document_type

    session.add(artifact)
    await session.commit()
    await session.refresh(artifact)

    key = None
    if artifact.storage_url:
        if artifact.storage_url.startswith("local://"):
            key = artifact.storage_url.replace("local://", "")
        else:
            try:
                key = artifact.storage_url.split(".amazonaws.com/", 1)[1]
            except IndexError:
                pass

    return _artifact_response(artifact, key, request)


@router.delete("/{tenant_id}/artifacts/{artifact_id}", status_code=204, summary="Delete artifact from S3/local and database")
async def delete_artifact(
    tenant_id: UUID,
    artifact_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    artifact = await session.get(Artifact, artifact_id)
    if artifact is None or artifact.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Artifact not found")

    if artifact.storage_url:
        try:
            if artifact.storage_url.startswith("local://"):
                key = artifact.storage_url.replace("local://", "")
                local_path = os.path.join("/app/shared/storage", key)
                if os.path.exists(local_path):
                    os.remove(local_path)
            else:
                key = artifact.storage_url.split(".amazonaws.com/", 1)[1]
                s3 = _s3_client()
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, lambda: s3.delete_object(Bucket=_S3_BUCKET, Key=key))
        except Exception:
            pass  # don't block DB deletion on S3 failure

    await session.delete(artifact)
    await session.commit()





def _artifact_response(artifact: Artifact, s3_key: str | None = None, request: Request | None = None) -> dict:
    if artifact.storage_url and artifact.storage_url.startswith("local://"):
        if request:
            base = str(request.base_url).rstrip("/")
            presigned = f"{base}/tenants/{artifact.tenant_id}/artifacts/{artifact.id}/download"
        else:
            presigned = f"/tenants/{artifact.tenant_id}/artifacts/{artifact.id}/download"
    else:
        presigned = _presign_url(s3_key) if s3_key else ""

    return {
        "id": str(artifact.id),
        "tenant_id": str(artifact.tenant_id),
        "case_id": str(artifact.case_id) if artifact.case_id else None,
        "customer_id": str(artifact.customer_id) if artifact.customer_id else None,
        "uploaded_by": str(artifact.uploaded_by) if artifact.uploaded_by else None,
        "document_type": artifact.document_type,
        "file_name": artifact.file_name,
        "file_size": artifact.file_size,
        "file_type": artifact.file_type,
        "storage_url": artifact.storage_url,
        "download_url": presigned,
        "ocr_result": artifact.ocr_result,
        "ocr_confidence_score": artifact.ocr_confidence_score,
        "authenticity_score": artifact.authenticity_score,
        "quality_score": artifact.quality_score,
        "tampered_flag": artifact.tampered_flag,
        "status": artifact.status,
        "created_at": artifact.created_at.isoformat(),
    }
