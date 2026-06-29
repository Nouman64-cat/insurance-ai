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
from shared.models.core import Artifact, Case, Tenant, User

router = APIRouter(prefix="/tenants", tags=["Artifacts"])

_S3_BUCKET  = os.environ.get("S3_BUCKET_NAME", "insurance-ai-dev")
_AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
OCR_TOPIC   = "insurance.artifact.ocr.requested.v1"

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


from fastapi.responses import FileResponse

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
        applicant_id=case.applicant_id,
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
        status="Processing",
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
        select(Artifact).where(Artifact.case_id == case_id, Artifact.tenant_id == tenant_id)
    )).all()

    return [_artifact_response(a, a.storage_url.split(".amazonaws.com/", 1)[1] if a.storage_url and ".amazonaws.com/" in a.storage_url else None, request) for a in rows]


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


@router.get("/{tenant_id}/artifacts/{artifact_id}/download", summary="Download local artifact file")
async def download_local_artifact(
    tenant_id: UUID,
    artifact_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    artifact = await session.get(Artifact, artifact_id)
    if artifact is None or artifact.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Artifact not found")

    if not artifact.storage_url or not artifact.storage_url.startswith("local://"):
        raise HTTPException(status_code=400, detail="Artifact is not stored locally")

    key = artifact.storage_url.replace("local://", "")
    local_path = os.path.join("/app/shared/storage", key)
    if not os.path.exists(local_path):
        raise HTTPException(status_code=404, detail="Local file not found")

    return FileResponse(local_path, media_type=artifact.file_type, filename=artifact.file_name)


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
