"""Object storage for archives. The rest of the service talks to the ObjectStore protocol; S3Store implements it for MinIO (or any
S3-compatible server) with boto3. Calls are synchronous: the worker runs them in threads.

Two identities, least privilege: the WRITER (put/get/list/retention; no delete permission at all) used by the archive worker and the
READER (get/list only) used by verification, retrieval and evidence downloads. The MinIO root account is never used by the service.
Nothing here ever deletes an object or an object version.
"""
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional, Protocol

from app.config import Settings

log = logging.getLogger("audit.archive.store")


class StoreError(Exception):
    """`retryable` errors (outage, timeouts) are retried with backoff; the others need a person."""

    def __init__(self, code: str, message: str, *, retryable: bool = True):
        super().__init__(message)
        self.code, self.message, self.retryable = code, message, retryable


@dataclass
class ObjectInfo:
    key: str
    size: int
    version_id: Optional[str] = None
    sha256: Optional[str] = None
    lock_mode: Optional[str] = None
    retain_until: Optional[datetime] = None


class ObjectStore(Protocol):
    def put_file(self, key: str, path: Path, *, sha256: str, content_type: str = "application/octet-stream",
                 lock_mode: Optional[str] = None, retain_until: Optional[datetime] = None) -> ObjectInfo: ...
    def put_bytes(self, key: str, data: bytes, *, sha256: str, content_type: str = "application/json",
                  lock_mode: Optional[str] = None, retain_until: Optional[datetime] = None) -> ObjectInfo: ...
    def head(self, key: str, version_id: Optional[str] = None) -> Optional[ObjectInfo]: ...
    def get_file(self, key: str, dest: Path, version_id: Optional[str] = None) -> ObjectInfo: ...
    def get_bytes(self, key: str, version_id: Optional[str] = None) -> bytes: ...
    def list_keys(self, prefix: str) -> list[str]: ...
    def capabilities(self) -> dict: ...


class S3Store:
    def __init__(self, config: Settings, role: str = "writer", client=None):
        self.config, self.role, self.bucket = config, role, config.archive_bucket
        if client is not None:
            self._client = client
            return
        import boto3
        from botocore.config import Config
        key, secret = (config.writer_key, config.writer_secret) if role == "writer" else (config.reader_key, config.reader_secret)
        if not key or not secret:
            raise StoreError("STORE_NOT_CONFIGURED", f"the archive {role} credentials are not set (AUDIT_ARCHIVE_{role.upper()}_KEY/SECRET)", retryable=False)
        self._client = boto3.client(
            "s3", endpoint_url=config.s3_endpoint, aws_access_key_id=key, aws_secret_access_key=secret, region_name=config.s3_region,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}, retries={"max_attempts": 3, "mode": "standard"},
                          connect_timeout=5, read_timeout=120, request_checksum_calculation="when_required", response_checksum_validation="when_required"))

    # ── errors ──
    def _wrap(self, exc: Exception, what: str) -> StoreError:
        from botocore.exceptions import BotoCoreError, ClientError
        if isinstance(exc, ClientError):
            code = exc.response.get("Error", {}).get("Code", "")
            status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
            if code in ("AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch") or status == 403:
                return StoreError("STORE_ACCESS_DENIED", f"{what}: access denied ({code})", retryable=False)
            if code in ("NoSuchBucket",):
                return StoreError("STORE_BUCKET_MISSING", f"{what}: the archive bucket does not exist (run the minio-init step)", retryable=True)
            if code in ("NoSuchKey", "404", "NotFound") or status == 404:
                return StoreError("STORE_NOT_FOUND", f"{what}: object not found", retryable=False)
            return StoreError("STORE_ERROR", f"{what}: {code or status}", retryable=status >= 500 or status == 0)
        if isinstance(exc, BotoCoreError):
            return StoreError("STORE_UNAVAILABLE", f"{what}: object storage cannot be reached ({type(exc).__name__})")
        return StoreError("STORE_ERROR", f"{what}: {type(exc).__name__}: {exc}")

    def _extra(self, sha256: str, content_type: str, lock_mode: Optional[str], retain_until: Optional[datetime]) -> dict:
        extra: dict = {"ContentType": content_type, "Metadata": {"sha256": sha256}}
        if lock_mode and retain_until:
            extra["ObjectLockMode"] = lock_mode
            extra["ObjectLockRetainUntilDate"] = retain_until
        return extra

    # ── writes (writer identity) ──
    def put_file(self, key: str, path: Path, *, sha256: str, content_type: str = "application/octet-stream",
                 lock_mode: Optional[str] = None, retain_until: Optional[datetime] = None) -> ObjectInfo:
        try:
            self._client.upload_file(str(path), self.bucket, key, ExtraArgs=self._extra(sha256, content_type, lock_mode, retain_until))
        except Exception as exc:
            raise self._wrap(exc, f"upload of {key}") from exc
        info = self.head(key)
        if info is None:
            raise StoreError("STORE_NOT_VISIBLE", f"{key} was uploaded but cannot be read back")
        return info

    def put_bytes(self, key: str, data: bytes, *, sha256: str, content_type: str = "application/json",
                  lock_mode: Optional[str] = None, retain_until: Optional[datetime] = None) -> ObjectInfo:
        try:
            self._client.put_object(Bucket=self.bucket, Key=key, Body=data, **self._extra(sha256, content_type, lock_mode, retain_until))
        except Exception as exc:
            raise self._wrap(exc, f"upload of {key}") from exc
        info = self.head(key)
        if info is None:
            raise StoreError("STORE_NOT_VISIBLE", f"{key} was uploaded but cannot be read back")
        return info

    # ── reads ──
    def head(self, key: str, version_id: Optional[str] = None) -> Optional[ObjectInfo]:
        args = {"Bucket": self.bucket, "Key": key}
        if version_id:
            args["VersionId"] = version_id
        try:
            r = self._client.head_object(**args)
        except Exception as exc:
            err = self._wrap(exc, f"head of {key}")
            if err.code == "STORE_NOT_FOUND":
                return None
            raise err from exc
        return ObjectInfo(key, int(r["ContentLength"]), r.get("VersionId"), (r.get("Metadata") or {}).get("sha256"),
                          r.get("ObjectLockMode"), r.get("ObjectLockRetainUntilDate"))

    def get_file(self, key: str, dest: Path, version_id: Optional[str] = None) -> ObjectInfo:
        extra = {"VersionId": version_id} if version_id else None
        try:
            self._client.download_file(self.bucket, key, str(dest), ExtraArgs=extra)
        except Exception as exc:
            raise self._wrap(exc, f"download of {key}") from exc
        info = self.head(key, version_id)
        return info or ObjectInfo(key, dest.stat().st_size, version_id)

    def get_bytes(self, key: str, version_id: Optional[str] = None) -> bytes:
        args = {"Bucket": self.bucket, "Key": key}
        if version_id:
            args["VersionId"] = version_id
        try:
            return self._client.get_object(**args)["Body"].read()
        except Exception as exc:
            raise self._wrap(exc, f"download of {key}") from exc

    def list_keys(self, prefix: str) -> list[str]:
        keys: list[str] = []
        try:
            for page in self._client.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
                keys.extend(o["Key"] for o in page.get("Contents", []))
        except Exception as exc:
            raise self._wrap(exc, f"listing of {prefix}") from exc
        return keys

    def capabilities(self) -> dict:
        """What the bucket really supports, asked of the server (never assumed): versioning, Object Lock, and that anonymous access is refused."""
        out = {"reachable": False, "bucket": self.bucket, "versioning": None, "object_lock": None, "private": None, "problem": None}
        try:
            out["versioning"] = self._client.get_bucket_versioning(Bucket=self.bucket).get("Status") == "Enabled"
            out["reachable"] = True
        except Exception as exc:
            out["problem"] = self._wrap(exc, "bucket check").message
            return out
        try:
            cfg = self._client.get_object_lock_configuration(Bucket=self.bucket).get("ObjectLockConfiguration", {})
            out["object_lock"] = cfg.get("ObjectLockEnabled") == "Enabled"
        except Exception as exc:
            code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
            out["object_lock"] = False if code == "ObjectLockConfigurationNotFoundError" else None
        out["private"] = self._anonymous_denied()
        return out

    def _anonymous_denied(self) -> Optional[bool]:
        try:
            urllib.request.urlopen(f"{self.config.s3_endpoint}/{self.bucket}/", timeout=5)
            return False                       # an unauthenticated listing succeeded: the bucket is public
        except urllib.error.HTTPError as exc:
            return exc.code in (401, 403)
        except Exception:
            return None
