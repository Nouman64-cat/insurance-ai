import asyncio
import os
from typing import List, Optional
from uuid import UUID, uuid4

import boto3
import httpx
from botocore.exceptions import ClientError
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from jose import JWTError
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import decode_access_token, oauth2_scheme
from shared.models.core import Artifact, Case, Tenant, User

router = APIRouter(prefix="/tenants", tags=["Artifacts"])

_OCR_URL = os.environ.get("OCR_ENGINE_URL", "http://ocr-engine:8004")
_S3_BUCKET = os.environ.get("S3_BUCKET_NAME", "insurance-ai-dev")
_AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

SUPPORTED_MIME = {
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "tiff": "image/tiff",
    "bmp": "image/bmp",
}


def _s3_client():
    return boto3.client(
        "s3",
        region_name=_AWS_REGION,
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )


def _upload_to_s3(file_bytes: bytes, key: str, content_type: str) -> str:
    client = _s3_client()
    client.put_object(
        Bucket=_S3_BUCKET,
        Key=key,
        Body=file_bytes,
        ContentType=content_type,
    )
    return f"https://{_S3_BUCKET}.s3.{_AWS_REGION}.amazonaws.com/{key}"


def _presign_url(key: str, expires: int = 3600) -> str:
    try:
        client = _s3_client()
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": _S3_BUCKET, "Key": key},
            ExpiresIn=expires,
        )
    except ClientError:
        return ""


def _s3_key(tenant_id: UUID, case_id: UUID, artifact_id: UUID, file_name: str) -> str:
    return f"{tenant_id}/cases/{case_id}/{artifact_id}/{file_name}"


async def _run_ocr(file_bytes: bytes, filename: str, mime_type: str) -> dict:
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{_OCR_URL}/extract",
            files={"file": (filename, file_bytes, mime_type)},
        )
        resp.raise_for_status()
        return resp.json()


def _confidence_from_ocr(ocr_text: str) -> float:
    if not ocr_text or not ocr_text.strip():
        return 0.1
    length = len(ocr_text.strip())
    if length > 200:
        return 0.9
    if length > 50:
        return 0.7
    return 0.5


async def _get_current_user_id(token: str) -> UUID:
    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
        return UUID(user_id)
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


@router.post("/{tenant_id}/cases/{case_id}/artifacts", status_code=201, summary="Upload document and run OCR")
async def upload_artifact(
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

    # Upload to S3
    loop = asyncio.get_running_loop()
    try:
        storage_url = await loop.run_in_executor(
            None, lambda: _upload_to_s3(file_bytes, s3_key, mime_type)
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"S3 upload failed: {exc}")

    # Run OCR
    ocr_text = ""
    confidence = 0.0
    try:
        ocr_result = await _run_ocr(file_bytes, file.filename, mime_type)
        ocr_text = ocr_result.get("extracted_text", "")
        confidence = _confidence_from_ocr(ocr_text)
    except Exception:
        confidence = 0.0

    artifact_status = "Accepted" if confidence >= 0.7 else "Re-submission Requested"

    artifact = Artifact(
        id=artifact_id,
        tenant_id=tenant_id,
        case_id=case_id,
        applicant_id=case.applicant_id,
        uploaded_by=user_id,
        document_type=document_type,
        file_name=file.filename,
        file_size=len(file_bytes),
        file_type=mime_type,
        storage_url=storage_url,
        ocr_result=ocr_text,
        ocr_confidence_score=confidence,
        authenticity_score=1.0,
        quality_score=1.0,
        status=artifact_status,
    )
    session.add(artifact)
    await session.commit()
    await session.refresh(artifact)

    return _artifact_response(artifact, s3_key)


@router.get("/{tenant_id}/cases/{case_id}/artifacts", summary="List artifacts for a case")
async def list_case_artifacts(
    tenant_id: UUID,
    case_id: UUID,
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
):
    case = await session.get(Case, case_id)
    if case is None or case.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Case not found")

    rows = (await session.exec(
        select(Artifact).where(Artifact.case_id == case_id, Artifact.tenant_id == tenant_id)
    )).all()

    return [_artifact_response(a) for a in rows]


@router.get("/{tenant_id}/artifacts/{artifact_id}", summary="Get artifact with fresh presigned URL")
async def get_artifact(
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
        # reconstruct key from URL: everything after the bucket domain
        try:
            key = artifact.storage_url.split(".amazonaws.com/", 1)[1]
        except IndexError:
            pass

    return _artifact_response(artifact, key)


class ArtifactUpdate(BaseModel):
    document_type: Optional[str] = None


@router.patch("/{tenant_id}/artifacts/{artifact_id}", summary="Update artifact metadata")
async def update_artifact(
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
        try:
            key = artifact.storage_url.split(".amazonaws.com/", 1)[1]
        except IndexError:
            pass

    return _artifact_response(artifact, key)


@router.delete("/{tenant_id}/artifacts/{artifact_id}", status_code=204, summary="Delete artifact from S3 and database")
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
            key = artifact.storage_url.split(".amazonaws.com/", 1)[1]
            s3 = _s3_client()
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, lambda: s3.delete_object(Bucket=_S3_BUCKET, Key=key))
        except Exception:
            pass  # don't block DB deletion on S3 failure

    await session.delete(artifact)
    await session.commit()


def _artifact_response(artifact: Artifact, s3_key: str | None = None) -> dict:
    presigned = _presign_url(s3_key) if s3_key else ""
    return {
        "id": str(artifact.id),
        "tenant_id": str(artifact.tenant_id),
        "case_id": str(artifact.case_id) if artifact.case_id else None,
        "applicant_id": str(artifact.applicant_id) if artifact.applicant_id else None,
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
