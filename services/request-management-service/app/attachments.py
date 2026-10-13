"""Request attachments: private files, readable only through this service after authorization.

Storage follows the platform's existing approach (tenant-service's artifacts): S3 when it is configured, otherwise a
local directory (development). Keys are always generated here (request-management/<tenant>/<request>/<uuid>); the
client never names a storage key, so it can't point an attachment at another request's, customer's or tenant's file.
Size and type are checked on the bytes themselves, not on what the browser claims.
"""
import asyncio
import hashlib
import os
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import text

from app import db, records, workflow
from app.config import settings
from app.errors import ApiError, forbidden, not_found, validation
from app.identity import Identity
from app.records import audit

# Allowed types, recognised by their leading bytes.
SIGNATURES = (
    (b"%PDF-", "application/pdf", ".pdf"),
    (b"\x89PNG\r\n\x1a\n", "image/png", ".png"),
    (b"\xff\xd8\xff", "image/jpeg", ".jpg"),
)


def sniff(data: bytes) -> Optional[tuple[str, str]]:
    for magic, mime, ext in SIGNATURES:
        if data.startswith(magic):
            return mime, ext
    return None


class Storage:
    async def put(self, key: str, data: bytes, content_type: str) -> None: ...
    async def get(self, key: str) -> bytes: ...


class LocalStorage(Storage):
    def __init__(self, root: str):
        self.root = root

    def _path(self, key: str) -> str:
        path = os.path.normpath(os.path.join(self.root, key))
        if not path.startswith(os.path.normpath(self.root) + os.sep):
            raise ValueError("bad key")
        return path

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        path = self._path(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        await asyncio.to_thread(lambda: open(path, "wb").write(data))

    async def get(self, key: str) -> bytes:
        return await asyncio.to_thread(lambda: open(self._path(key), "rb").read())


class S3Storage(Storage):
    def __init__(self, bucket: str, region: str):
        import boto3
        self.bucket = bucket
        self.client = boto3.client("s3", region_name=region, aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
                                   aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"))

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        await asyncio.to_thread(self.client.put_object, Bucket=self.bucket, Key=key, Body=data, ContentType=content_type,
                                ServerSideEncryption="AES256")

    async def get(self, key: str) -> bytes:
        obj = await asyncio.to_thread(self.client.get_object, Bucket=self.bucket, Key=key)
        return await asyncio.to_thread(obj["Body"].read)


_storage: Optional[Storage] = None


def storage() -> Storage:
    global _storage
    if _storage is None:
        key = os.environ.get("AWS_ACCESS_KEY_ID", "")
        if settings.storage_backend == "s3" and settings.s3_bucket and key and "your_aws" not in key:
            _storage = S3Storage(settings.s3_bucket, settings.s3_region)
        else:
            _storage = LocalStorage(settings.local_storage_dir)
    return _storage


def set_storage(new: Storage) -> None:
    global _storage
    _storage = new


def _safe_name(name: str) -> str:
    base = os.path.basename(name or "file").strip().replace("\x00", "")
    cleaned = "".join(c for c in base if c.isalnum() or c in " ._-()")[:120].strip(" .")
    return cleaned or "file"


async def upload(identity: Identity, request_id: UUID, file_name: str, data: bytes, visibility: str) -> UUID:
    if visibility not in ("REQUESTER", "INTERNAL"):
        raise validation("visibility must be REQUESTER or INTERNAL", field="visibility")
    if not data:
        raise validation("The file is empty", field="file")
    if len(data) > settings.max_attachment_bytes:
        raise validation(f"Files may be up to {settings.max_attachment_bytes // (1024 * 1024)} MB", field="file")
    kind = sniff(data)
    if not kind:
        raise validation("Only PDF, PNG and JPEG files can be attached", field="file")
    mime, _ = kind

    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id)
    rel = workflow.relation(identity, req)
    if not rel.can_view or (req["review_status"] == "DRAFT" and not rel.is_requester):
        raise not_found()
    if visibility == "INTERNAL" and not rel.sees_internal:
        raise forbidden("Only reviewers can add internal attachments.", code="INTERNAL_NOT_ALLOWED")
    if req["review_status"] == "CANCELLED":
        raise ApiError(409, "INVALID_TRANSITION", "Cancelled requests can't take new attachments")

    attachment_id = uuid4()
    key = f"request-management/{identity.tenant_id}/{request_id}/{attachment_id}"
    await storage().put(key, data, mime)
    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id, lock=True)
        await conn.execute(text("""
            INSERT INTO attachments (id, request_id, tenant_id, uploaded_by, uploaded_by_name, visibility, file_name, content_type,
                size_bytes, sha256, storage_key, revision_no)
            VALUES (:id, :r, :t, :u, :n, :v, :f, :c, :s, :h, :k, :rev)
        """), {"id": attachment_id, "r": request_id, "t": identity.tenant_id, "u": identity.user_id, "n": identity.name,
               "v": visibility, "f": _safe_name(file_name), "c": mime, "s": len(data), "h": hashlib.sha256(data).hexdigest(),
               "k": key, "rev": req["current_revision_no"]})
        await audit(conn, tenant_id=identity.tenant_id, request_id=request_id, event_type="ATTACHMENT_ADDED", actor_id=identity.user_id,
                    actor_name=identity.name, actor_role=identity.role,
                    data={"attachment_id": str(attachment_id), "file_name": _safe_name(file_name), "visibility": visibility})
    return attachment_id


async def download(identity: Identity, request_id: UUID, attachment_id: UUID) -> tuple[bytes, str, str]:
    async with db.transaction() as conn:
        req = await records.load_request(conn, request_id, identity.tenant_id)
        row = (await conn.execute(text(
            "SELECT * FROM attachments WHERE id = :a AND request_id = :r AND tenant_id = :t AND deleted_at IS NULL"
        ), {"a": attachment_id, "r": request_id, "t": identity.tenant_id})).mappings().first()
    rel = workflow.relation(identity, req, decided_by_me=req.get("decided_by") == identity.user_id)
    if not row or not rel.can_view or (req["review_status"] == "DRAFT" and not rel.is_requester):
        raise not_found("Attachment")
    if row["visibility"] == "INTERNAL" and not rel.sees_internal:
        raise not_found("Attachment")
    return await storage().get(row["storage_key"]), row["content_type"], row["file_name"]
