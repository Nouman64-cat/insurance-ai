"""The object store behind the lake: MinIO through its S3 API (boto3), and an in-memory twin for tests.

Both enforce the same rules:
  * put_if_absent never overwrites. An object that already exists with the same checksum is adopted ("exists"), one with
    a different checksum is an error. Published objects therefore cannot be replaced.
  * Every object carries its SHA-256 as metadata, and the S3 request carries it as a checksum the server verifies.
  * With object lock on, retain() makes an object undeletable until a date (governance mode: a privileged user can still
    lift it on purpose).
"""
from __future__ import annotations

import base64
import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional, Protocol

from shared.evaluation.canonical import sha256_hex
from shared.evaluation.config import LakeSettings

log = logging.getLogger("evaluation.lake.store")


class LakeError(Exception):
    """Base class for lake failures."""


class LakeNotReady(LakeError):
    """The object store cannot be reached or is not set up the way the lake needs."""


class ObjectMissing(LakeError):
    pass


class ObjectExists(LakeError):
    """The key already holds different content."""


class ObjectLocked(LakeError):
    """The object is under retention and cannot be deleted."""


class IntegrityFailure(LakeError):
    """Stored content does not match its recorded checksum."""


@dataclass(frozen=True)
class ObjectInfo:
    key: str
    size: int
    sha256: Optional[str] = None
    content_type: Optional[str] = None
    etag: Optional[str] = None
    version_id: Optional[str] = None
    retain_until: Optional[datetime] = None          # timezone-aware UTC
    last_modified: Optional[datetime] = None

    @property
    def locked(self) -> bool:
        return self.retain_until is not None and self.retain_until > datetime.now(timezone.utc)


@dataclass(frozen=True)
class PutResult:
    created: bool          # False: the same content was already there and has been adopted
    info: ObjectInfo


class ObjectStore(Protocol):
    def ensure_ready(self) -> None: ...
    def put_if_absent(self, key: str, data: bytes, *, content_type: str, sha256: Optional[str] = None) -> PutResult: ...
    def get(self, key: str) -> bytes: ...
    def head(self, key: str) -> Optional[ObjectInfo]: ...
    def delete(self, key: str, *, bypass_governance: bool = False) -> None: ...
    def list(self, prefix: str) -> List[ObjectInfo]: ...
    def retain(self, key: str, until: datetime) -> None: ...


def _same_or_raise(key: str, existing: ObjectInfo, digest: str, size: int, fetch: Callable[[], bytes]) -> PutResult:
    """The key is taken: adopt it if it holds exactly this content, otherwise refuse."""
    if existing.sha256 is not None:
        same = existing.sha256 == digest and existing.size == size
    else:                                    # written by something else, without our checksum metadata
        same = existing.size == size and sha256_hex(fetch()) == digest
    if not same:
        raise ObjectExists(f"{key} already exists with different content; published and raw objects are never overwritten")
    return PutResult(created=False, info=existing)


# ── MinIO / S3 ────────────────────────────────────────────────────────────────

class S3ObjectStore:
    def __init__(self, settings: LakeSettings):
        self.settings = settings
        self._client = None
        self._ready = False
        self._lock = threading.Lock()

    def client(self):
        with self._lock:
            if self._client is None:
                import boto3
                from botocore.config import Config
                options = dict(signature_version="s3v4", s3={"addressing_style": "path"}, connect_timeout=5, read_timeout=60,
                               retries={"max_attempts": 3, "mode": "standard"})
                try:   # newer botocore: send checksums only where S3 requires them, since we set our own
                    config = Config(request_checksum_calculation="when_required", response_checksum_validation="when_required", **options)
                except TypeError:
                    config = Config(**options)
                self._client = boto3.client(
                    "s3", endpoint_url=self.settings.endpoint_url, region_name=self.settings.region,
                    aws_access_key_id=self.settings.access_key, aws_secret_access_key=self.settings.secret_key, config=config)
            return self._client

    @staticmethod
    def _code(exc) -> str:
        return str((getattr(exc, "response", None) or {}).get("Error", {}).get("Code", ""))

    def _missing(self, exc) -> bool:
        return self._code(exc) in ("404", "NoSuchKey", "NotFound", "NoSuchBucket", "NoSuchVersion")

    def ensure_ready(self) -> None:
        """Reach the store, create the bucket (with object lock and versioning) if it is missing, and check that an
        existing one is set up as configured. Raises LakeNotReady with what to fix."""
        if self._ready:
            return
        from botocore.exceptions import BotoCoreError, ClientError
        s = self.settings
        if not s.access_key or not s.secret_key:
            raise LakeNotReady("EVAL_LAKE_ACCESS_KEY / EVAL_LAKE_SECRET_KEY (or MINIO_ROOT_USER / MINIO_ROOT_PASSWORD) are not set")
        c = self.client()
        try:
            try:
                c.head_bucket(Bucket=s.bucket)
            except ClientError as exc:
                if not self._missing(exc):
                    raise
                args = {"Bucket": s.bucket}
                if s.region != "us-east-1":
                    args["CreateBucketConfiguration"] = {"LocationConstraint": s.region}
                if s.locks_objects:
                    args["ObjectLockEnabledForBucket"] = True
                try:
                    c.create_bucket(**args)
                    log.info("created evaluation lake bucket %s (object lock %s)", s.bucket, s.retention_mode)
                except ClientError as created:        # another service made it first
                    if self._code(created) not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
                        raise
            if c.get_bucket_versioning(Bucket=s.bucket).get("Status") != "Enabled":
                c.put_bucket_versioning(Bucket=s.bucket, VersioningConfiguration={"Status": "Enabled"})
            if s.locks_objects:
                try:
                    enabled = c.get_object_lock_configuration(Bucket=s.bucket).get("ObjectLockConfiguration", {}).get("ObjectLockEnabled")
                except ClientError as exc:
                    if self._code(exc) != "ObjectLockConfigurationNotFoundError":
                        raise
                    enabled = None
                if enabled != "Enabled":
                    raise LakeNotReady(
                        f"bucket {s.bucket!r} exists without object lock. Set EVAL_LAKE_RETENTION_MODE=NONE to run without it, "
                        "or point EVAL_LAKE_BUCKET at a new bucket (object lock can only be turned on when a bucket is created).")
        except LakeNotReady:
            raise
        except (BotoCoreError, ClientError) as exc:
            raise LakeNotReady(f"cannot use object storage at {s.endpoint_url} (bucket {s.bucket!r}): {exc}") from exc
        self._ready = True

    def head(self, key: str) -> Optional[ObjectInfo]:
        from botocore.exceptions import ClientError
        try:
            r = self.client().head_object(Bucket=self.settings.bucket, Key=key)
        except ClientError as exc:
            if self._missing(exc):
                return None
            raise
        meta = {k.lower(): v for k, v in (r.get("Metadata") or {}).items()}
        retain = r.get("ObjectLockRetainUntilDate")
        return ObjectInfo(key=key, size=int(r.get("ContentLength", 0)), sha256=meta.get("sha256"), content_type=r.get("ContentType"),
                          etag=(r.get("ETag") or "").strip('"') or None, version_id=r.get("VersionId"),
                          retain_until=retain if isinstance(retain, datetime) else None, last_modified=r.get("LastModified"))

    def put_if_absent(self, key: str, data: bytes, *, content_type: str, sha256: Optional[str] = None) -> PutResult:
        from botocore.exceptions import ClientError, ParamValidationError
        digest = sha256 or sha256_hex(data)
        if digest != sha256_hex(data):
            raise IntegrityFailure(f"the checksum given for {key} does not match the bytes")
        existing = self.head(key)
        if existing is not None:
            return _same_or_raise(key, existing, digest, len(data), lambda: self.get(key))
        args = dict(Bucket=self.settings.bucket, Key=key, Body=data, ContentType=content_type, Metadata={"sha256": digest},
                    ChecksumSHA256=base64.b64encode(bytes.fromhex(digest)).decode("ascii"))
        try:
            try:
                self.client().put_object(IfNoneMatch="*", **args)      # also refuses if another writer got there first
            except ParamValidationError:                                # an older boto3 without conditional writes
                self.client().put_object(**args)
            except ClientError as exc:
                if self._code(exc) not in ("NotImplemented", "501"):    # a server without conditional writes
                    raise
                self.client().put_object(**args)
        except ClientError as exc:
            if self._code(exc) in ("PreconditionFailed", "412"):
                raced = self.head(key)
                if raced is not None:
                    return _same_or_raise(key, raced, digest, len(data), lambda: self.get(key))
            raise
        info = self.head(key)
        if info is None:
            raise LakeError(f"{key} was uploaded but cannot be found")
        return PutResult(created=True, info=info)

    def get(self, key: str) -> bytes:
        from botocore.exceptions import ClientError
        try:
            return self.client().get_object(Bucket=self.settings.bucket, Key=key)["Body"].read()
        except ClientError as exc:
            if self._missing(exc):
                raise ObjectMissing(key) from exc
            raise

    def delete(self, key: str, *, bypass_governance: bool = False) -> None:
        """Remove every version of the key. Raises ObjectLocked if any version is under retention."""
        from botocore.exceptions import ClientError
        c, bucket = self.client(), self.settings.bucket
        targets: List[Optional[str]] = []
        for page in c.get_paginator("list_object_versions").paginate(Bucket=bucket, Prefix=key):
            for v in (page.get("Versions") or []) + (page.get("DeleteMarkers") or []):
                if v["Key"] == key:
                    targets.append(v.get("VersionId"))
        try:
            if not targets:
                c.delete_object(Bucket=bucket, Key=key)
            for version_id in targets:
                extra = {"VersionId": version_id} if version_id and version_id != "null" else {}
                if bypass_governance:
                    extra["BypassGovernanceRetention"] = True
                c.delete_object(Bucket=bucket, Key=key, **extra)
        except ClientError as exc:
            if self._code(exc) in ("AccessDenied", "ObjectLocked", "InvalidRequest", "AccessDeniedException"):
                raise ObjectLocked(f"{key} is under retention and cannot be deleted") from exc
            raise

    def list(self, prefix: str) -> List[ObjectInfo]:
        out: List[ObjectInfo] = []
        for page in self.client().get_paginator("list_objects_v2").paginate(Bucket=self.settings.bucket, Prefix=prefix):
            for o in page.get("Contents") or []:
                out.append(ObjectInfo(key=o["Key"], size=int(o["Size"]), etag=(o.get("ETag") or "").strip('"') or None,
                                      last_modified=o.get("LastModified")))
        return out

    def retain(self, key: str, until: datetime) -> None:
        """Keep the object undeletable until `until`. A no-op when object lock is off; never shortens an existing hold."""
        if not self.settings.locks_objects:
            return
        current = self.head(key)
        if current is not None and current.retain_until is not None and current.retain_until >= until:
            return
        self.client().put_object_retention(
            Bucket=self.settings.bucket, Key=key, Retention={"Mode": self.settings.retention_mode, "RetainUntilDate": until})


# ── In-memory twin ────────────────────────────────────────────────────────────

class InMemoryObjectStore:
    """Behaves like the S3 store, for tests and throwaway runs. `fail_put(key) -> bool` makes uploads of matching keys fail,
    to rehearse a broken upload."""

    def __init__(self, settings: Optional[LakeSettings] = None):
        self.settings = settings or LakeSettings(backend="memory")
        self._objects: Dict[str, tuple] = {}            # key -> (bytes, ObjectInfo)
        self._lock = threading.Lock()
        self.fail_put: Optional[Callable[[str], bool]] = None

    def ensure_ready(self) -> None:
        return None

    def head(self, key: str) -> Optional[ObjectInfo]:
        with self._lock:
            entry = self._objects.get(key)
        return entry[1] if entry else None

    def put_if_absent(self, key: str, data: bytes, *, content_type: str, sha256: Optional[str] = None) -> PutResult:
        digest = sha256 or sha256_hex(data)
        if digest != sha256_hex(data):
            raise IntegrityFailure(f"the checksum given for {key} does not match the bytes")
        if self.fail_put is not None and self.fail_put(key):
            raise LakeError(f"simulated upload failure for {key}")
        with self._lock:
            entry = self._objects.get(key)
            if entry is not None:
                existing = entry[1]
            else:
                info = ObjectInfo(key=key, size=len(data), sha256=digest, content_type=content_type, etag=digest[:32],
                                  version_id="v1", last_modified=datetime.now(timezone.utc))
                self._objects[key] = (data, info)
                return PutResult(created=True, info=info)
        return _same_or_raise(key, existing, digest, len(data), lambda: self.get(key))

    def get(self, key: str) -> bytes:
        with self._lock:
            entry = self._objects.get(key)
        if entry is None:
            raise ObjectMissing(key)
        return entry[0]

    def delete(self, key: str, *, bypass_governance: bool = False) -> None:
        with self._lock:
            entry = self._objects.get(key)
            if entry is None:
                return
            if entry[1].locked and not (bypass_governance and self.settings.retention_mode == "GOVERNANCE"):
                raise ObjectLocked(f"{key} is under retention and cannot be deleted")
            del self._objects[key]

    def list(self, prefix: str) -> List[ObjectInfo]:
        with self._lock:
            return [info for k, (_, info) in sorted(self._objects.items()) if k.startswith(prefix)]

    def retain(self, key: str, until: datetime) -> None:
        if not self.settings.locks_objects:
            return
        with self._lock:
            entry = self._objects.get(key)
            if entry is None:
                raise ObjectMissing(key)
            data, info = entry
            if info.retain_until is not None and info.retain_until >= until:
                return
            self._objects[key] = (data, ObjectInfo(**{**info.__dict__, "retain_until": until}))

    # test helpers: change stored bytes behind the lake's back, as corruption or tampering would
    def _tamper(self, key: str, data: bytes) -> None:
        with self._lock:
            _, info = self._objects[key]
            self._objects[key] = (data, ObjectInfo(**{**info.__dict__, "size": len(data)}))


_MEMORY_STORE: Optional[InMemoryObjectStore] = None


def get_store(settings: LakeSettings) -> ObjectStore:
    global _MEMORY_STORE
    if settings.backend == "memory":
        if _MEMORY_STORE is None:
            _MEMORY_STORE = InMemoryObjectStore(settings)
        return _MEMORY_STORE
    return S3ObjectStore(settings)
