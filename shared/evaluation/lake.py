"""DataLake: the Bronze -> Silver -> Gold pipeline over PostgreSQL and the object store.

  ingest_bronze     store a raw import untouched and file its records as Bronze cases
  promote_to_silver clean, validate and de-duplicate Bronze cases
  put_fixture       store a synthetic fixture under its checksum
  publish           freeze the approved Silver cases of a dataset as an immutable, versioned Gold snapshot
  load_version      read a published version back, checking every checksum on the way
  verify_version    the same checks as a report, plus the fixtures
  reconcile         finish or clean up a publication that was interrupted

Publishing is a protocol, not a single write, because MinIO and PostgreSQL cannot commit together:
  1. In one database transaction (dataset row locked), check everything, build the snapshot in memory and record the
     version as 'publishing' with the checksums it must end up with.
  2. Upload cases.jsonl, then manifest.json (last: it marks a complete snapshot). Nothing is ever overwritten; an identical
     object left by an earlier attempt is adopted. Read both back and compare checksums, check the fixtures.
  3. Put the objects under retention, then in one transaction add the case index, mark the version 'published' and move the
     dataset's latest version.
A failure before step 3 marks the version 'failed' and removes the objects this attempt created. A crash leaves it
'publishing', and reconcile() either completes it (the objects verify) or cleans it up.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
from uuid import UUID, uuid4

from sqlalchemy.exc import IntegrityError
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.evaluation import keys
from shared.evaluation.canonical import canonical_json, content_hash, parse_jsonl, sha256_hex, to_jsonl
from shared.evaluation.case_schema import CASE_ID_RE, SCHEMA_VERSION, summary_fields, validate_case
from shared.evaluation.config import LakeSettings
from shared.evaluation.formats import CONTENT_TYPES, detect_format, parse_cases, serialize_cases
from shared.evaluation.object_store import (IntegrityFailure, LakeError, ObjectLocked, ObjectMissing, ObjectStore)
from shared.evaluation.validation import Item, summarize, validate_batch
from shared.evaluation.workflows import get_workflow
from shared.models.evaluation import (CASE_STATUSES, TURN_MODES, EvalCase, EvalDataset, EvalDatasetVersion, EvalFixture,
                                      EvalIngestion, EvalStorageObject, EvalVersionCase)

log = logging.getLogger("evaluation.lake")

SOURCE_TYPES = ("import", "synthetic", "trace", "manual")
_SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
_FIXTURE_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
_TRANSITIONS = {
    "draft": {"in_review", "archived"},
    "in_review": {"approved", "rejected", "draft"},
    "approved": {"draft", "archived"},
    "rejected": {"draft", "archived"},
    "archived": {"draft"},
}


class LakeValidationError(LakeError):
    """The request cannot be accepted as it stands; `problems` says why, one line each."""

    def __init__(self, message: str, problems: Optional[List[str]] = None):
        super().__init__(message if not problems else f"{message}: " + "; ".join(problems))
        self.problems = problems or []


class PublishConflict(LakeError):
    """Another publication, or an existing version, stands in the way."""


@dataclass
class IngestionResult:
    ingestion_id: UUID
    raw_key: str
    sha256: str
    record_count: int
    created: int
    updated: int
    rejected: int
    rejects: List[dict]


@dataclass
class PromotionReport:
    batch_id: UUID
    accepted: int
    rejected: int
    duplicates: int
    rejects: List[dict]
    object_keys: List[str]


@dataclass
class VerifyReport:
    version_id: UUID
    version: str
    ok: bool
    problems: List[str]
    objects_checked: int


@dataclass
class LoadedVersion:
    dataset_slug: str
    version: str
    manifest: dict
    cases: List[dict]


@dataclass
class ReconcileReport:
    finalized: List[str] = field(default_factory=list)
    failed: List[str] = field(default_factory=list)
    skipped: List[str] = field(default_factory=list)


@dataclass
class _Plan:
    version_id: UUID
    dataset_id: UUID
    version: str
    cases_key: str
    manifest_key: str
    cases_bytes: bytes
    manifest_bytes: bytes
    cases_sha: str
    manifest_sha: str
    manifest: dict
    frozen_cases: List[dict]
    fixtures: List[dict]
    created_keys: List[str] = field(default_factory=list)
    locked: bool = False
    retain_until: Optional[datetime] = None


def _semver(v: str) -> Tuple[int, int, int]:
    m = _SEMVER.match(v)
    if not m:
        raise LakeValidationError(f"version {v!r} must look like 1.0.0")
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def _naive_utc(dt: Optional[datetime]) -> Optional[datetime]:
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt is not None and dt.tzinfo else dt


def _text(v: Any) -> Optional[str]:
    return v if isinstance(v, str) else None


def _pretty(doc: Any) -> bytes:
    return (json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")


def _holds_nul(doc: Any) -> bool:
    """PostgreSQL JSONB cannot hold a NUL character; refuse such a record with a clear message instead of failing the batch."""
    return "\\u0000" in canonical_json(doc)


def _dataset_fingerprint(case_entries: Sequence[dict], fixtures: Sequence[dict]) -> str:
    lines = [f"case:{c['case_id']}:{c['sha256']}" for c in case_entries] + [f"fixture:{f['fixture_key']}:{f['sha256']}" for f in fixtures]
    return sha256_hex("\n".join(sorted(lines)).encode("utf-8"))


class DataLake:
    def __init__(self, store: ObjectStore, settings: LakeSettings, session_factory: Callable[[], Any]):
        self.store = store
        self.settings = settings
        self.session_factory = session_factory

    async def _io(self, fn, *args, **kwargs):
        return await asyncio.to_thread(fn, *args, **kwargs)

    async def ensure_ready(self) -> None:
        await self._io(self.store.ensure_ready)

    # ── datasets ──────────────────────────────────────────────────────────────

    async def create_dataset(self, session: AsyncSession, *, slug: str, name: str, workflow: str, turn_mode: str,
                             description: Optional[str] = None, created_by: Optional[UUID] = None) -> EvalDataset:
        try:
            keys.check_slug(slug, "dataset slug")
            get_workflow(workflow)
        except ValueError as exc:
            raise LakeValidationError(str(exc)) from exc
        if turn_mode not in TURN_MODES:
            raise LakeValidationError(f"turn_mode must be one of {', '.join(TURN_MODES)}")
        if not name.strip():
            raise LakeValidationError("a dataset needs a name")
        if (await session.exec(select(EvalDataset).where(EvalDataset.slug == slug))).first():
            raise LakeValidationError(f"a dataset called {slug!r} already exists")
        dataset = EvalDataset(slug=slug, name=name.strip(), workflow=workflow, turn_mode=turn_mode, description=description,
                              schema_version=SCHEMA_VERSION, created_by=created_by)
        session.add(dataset)
        await session.commit()
        return dataset

    async def get_dataset(self, session: AsyncSession, slug: str) -> EvalDataset:
        dataset = (await session.exec(select(EvalDataset).where(EvalDataset.slug == slug))).first()
        if dataset is None:
            raise LakeValidationError(f"no dataset called {slug!r}")
        return dataset

    # ── the object registry ───────────────────────────────────────────────────

    async def _register(self, session: AsyncSession, *, key: str, layer: str, kind: str, sha256: str, size: int,
                        content_type: str, dataset_id: Optional[UUID] = None, version_id: Optional[UUID] = None,
                        ingestion_id: Optional[UUID] = None, state: str = "stored", info=None) -> EvalStorageObject:
        row = (await session.exec(select(EvalStorageObject).where(EvalStorageObject.object_key == key))).first()
        if row is None:
            row = EvalStorageObject(object_key=key, layer=layer, kind=kind, sha256=sha256, size_bytes=size)
        row.layer, row.kind, row.sha256, row.size_bytes, row.content_type = layer, kind, sha256, size, content_type
        row.dataset_id, row.version_id, row.ingestion_id, row.state = dataset_id, version_id, ingestion_id, state
        if info is not None:
            row.storage_version_id = info.version_id
            row.retain_until = _naive_utc(info.retain_until)
        session.add(row)
        return row

    async def _store(self, session: AsyncSession, *, key: str, data: bytes, content_type: str, layer: str, kind: str,
                     dataset_id: Optional[UUID] = None, ingestion_id: Optional[UUID] = None):
        """Write an object if absent, and record it in the registry."""
        digest = sha256_hex(data)
        result = await self._io(self.store.put_if_absent, key, data, content_type=content_type, sha256=digest)
        await self._register(session, key=key, layer=layer, kind=kind, sha256=digest, size=len(data), content_type=content_type,
                             dataset_id=dataset_id, ingestion_id=ingestion_id, info=result.info)
        return result

    # ── Bronze ────────────────────────────────────────────────────────────────

    async def ingest_bronze(self, session: AsyncSession, dataset: EvalDataset, *, data: bytes, filename: str,
                            source_type: str = "import", source_ref: Optional[str] = None, fmt: Optional[str] = None,
                            created_by: Optional[UUID] = None) -> IngestionResult:
        """Keep the raw file exactly as received and file each record as a Bronze case. A record whose case_id already
        exists replaces that case's content as a new revision (and sends it back to draft)."""
        if source_type not in SOURCE_TYPES:
            raise LakeValidationError(f"source_type must be one of {', '.join(SOURCE_TYPES)}")
        if not data:
            raise LakeValidationError("the file is empty")
        if len(data) > self.settings.max_import_bytes:
            raise LakeValidationError(f"the file is {len(data)} bytes; the limit is {self.settings.max_import_bytes}")
        try:
            fmt = fmt or detect_format(filename)
            await self.ensure_ready()
            ingestion_id, now = uuid4(), datetime.utcnow()
            raw_key = keys.bronze_raw_key(source_type, ingestion_id, now, filename)
            report_key = keys.bronze_report_key(source_type, ingestion_id, now)
        except ValueError as exc:
            raise LakeValidationError(str(exc)) from exc

        parsed = parse_cases(data, fmt)
        rejects: List[dict] = [{"position": r.position, "error": r.error} for r in parsed.rejects]
        candidates: List[Tuple[str, dict, str]] = []
        seen: set = set()
        for index, record in enumerate(parsed.records, start=1):
            case_id = record.get("case_id")
            if case_id is None or case_id == "":
                case_id = "CAND-" + _safe_hash(record)[:12].upper()
                record = {**record, "case_id": case_id}
            if not isinstance(case_id, str) or not CASE_ID_RE.match(case_id):
                rejects.append({"position": index, "error": f"case_id {case_id!r} is not a valid id (3-80 letters, digits, dot, dash, underscore)"})
                continue
            if case_id in seen:
                rejects.append({"position": index, "error": f"case_id {case_id!r} appears twice in this file; the first is kept"})
                continue
            try:
                if _holds_nul(record):
                    rejects.append({"position": index, "error": "contains a NUL character, which cannot be stored; write it as text such as %00"})
                    continue
                digest = content_hash(record)
            except ValueError as exc:
                rejects.append({"position": index, "error": f"holds a value that is not valid JSON: {exc}"})
                continue
            seen.add(case_id)
            candidates.append((case_id, record, digest))

        existing: Dict[str, EvalCase] = {}
        if candidates:
            found = (await session.exec(select(EvalCase).where(EvalCase.dataset_id == dataset.id,
                                                                EvalCase.case_key.in_([c[0] for c in candidates])))).all()
            existing = {c.case_key: c for c in found}
        created = sum(1 for c in candidates if c[0] not in existing)
        updated = len(candidates) - created
        total_read = len(parsed.records) + len(parsed.rejects)

        # The ingestion row comes first: the cases and the registry rows refer to it.
        session.add(EvalIngestion(id=ingestion_id, dataset_id=dataset.id, source_type=source_type, source_ref=source_ref, file_format=fmt,
                                  filename=filename, object_key=raw_key, sha256=sha256_hex(data), size_bytes=len(data),
                                  record_count=total_read, stored_count=len(candidates), rejected_count=len(rejects), status="stored",
                                  created_by=created_by, created_at=now))
        await session.flush()
        await self._store(session, key=raw_key, data=data, content_type=CONTENT_TYPES[fmt], layer="bronze", kind="raw",
                          dataset_id=dataset.id, ingestion_id=ingestion_id)
        report = {"ingestion_id": str(ingestion_id), "filename": filename, "format": fmt, "records_read": total_read,
                  "created": created, "updated": updated, "rejected": rejects}
        await self._store(session, key=report_key, data=_pretty(report), content_type="application/json", layer="bronze", kind="report",
                          dataset_id=dataset.id, ingestion_id=ingestion_id)

        for case_id, record, digest in candidates:
            fields = summary_fields(record)
            row = existing.get(case_id)
            if row is None:
                session.add(EvalCase(dataset_id=dataset.id, case_key=case_id, tier="bronze", status="draft", content=record,
                                     content_sha256=digest, source_ingestion_id=ingestion_id, created_by=created_by, updated_by=created_by,
                                     **{k: _text(v) for k, v in fields.items()}))
            else:
                row.content, row.content_sha256, row.tier, row.status = record, digest, "bronze", "draft"
                row.revision += 1
                row.dedupe_key, row.validation_errors = None, None
                row.approved_by, row.approved_at, row.approval_note = None, None, None
                row.source_ingestion_id, row.updated_by, row.updated_at = ingestion_id, created_by, now
                for k, v in fields.items():
                    setattr(row, k, _text(v))
                session.add(row)
        await session.commit()
        return IngestionResult(ingestion_id=ingestion_id, raw_key=raw_key, sha256=sha256_hex(data), record_count=total_read,
                               created=created, updated=updated, rejected=len(rejects), rejects=rejects)

    # ── Silver ────────────────────────────────────────────────────────────────

    async def promote_to_silver(self, session: AsyncSession, dataset: EvalDataset, *, ingestion_id: Optional[UUID] = None,
                                case_keys: Optional[Sequence[str]] = None) -> PromotionReport:
        """Validate Bronze cases (an ingestion's, the named ones, or all of them) and move the valid ones to Silver. The
        invalid ones stay Bronze with their errors recorded. The cleaned cases and the rejects are also kept in the lake."""
        await self.ensure_ready()
        stmt = select(EvalCase).where(EvalCase.dataset_id == dataset.id, EvalCase.tier == "bronze", EvalCase.status != "archived")
        if ingestion_id is not None:
            stmt = stmt.where(EvalCase.source_ingestion_id == ingestion_id)
        if case_keys:
            stmt = stmt.where(EvalCase.case_key.in_(list(case_keys)))
        rows = (await session.exec(stmt.order_by(EvalCase.case_key))).all()
        selected = {r.case_key for r in rows}
        others = (await session.exec(select(EvalCase.case_key, EvalCase.dedupe_key).where(
            EvalCase.dataset_id == dataset.id, EvalCase.tier == "silver", EvalCase.status != "archived",
            EvalCase.dedupe_key.is_not(None)))).all()
        known = {fp: key for key, fp in others if key not in selected}
        outcomes = validate_batch([Item(r.case_key, r.content) for r in rows], workflow=dataset.workflow,
                                  turn_mode=dataset.turn_mode, known_fingerprints=known)
        by_key = {o.key: o for o in outcomes}
        accepted = [o for o in outcomes if o.ok]
        rejected = [o for o in outcomes if not o.ok]

        batch_id, object_keys = uuid4(), []
        if outcomes:
            prefix = keys.silver_prefix(dataset.workflow, dataset.slug, batch_id)
            summary = summarize(outcomes)
            report = {"batch_id": str(batch_id), "dataset": dataset.slug, "ingestion_id": str(ingestion_id) if ingestion_id else None, **summary}
            artifacts = [("report.json", _pretty(report), "application/json", "report"),
                         ("rejects.json", _pretty([{"case_id": o.key, "errors": o.errors} for o in rejected]), "application/json", "report")]
            if accepted:
                artifacts.append(("cases.jsonl", to_jsonl([o.case for o in accepted]), CONTENT_TYPES["jsonl"], "cases"))
            for name, payload, ctype, kind in artifacts:
                await self._store(session, key=prefix + name, data=payload, content_type=ctype, layer="silver", kind=kind, dataset_id=dataset.id)
                object_keys.append(prefix + name)

        now = datetime.utcnow()
        for row in rows:
            o = by_key[row.case_key]
            if o.ok:
                row.content, row.content_sha256, row.dedupe_key = o.case, o.content_sha256, o.dedupe_key
                row.tier, row.validation_errors = "silver", None
                for k, v in summary_fields(o.case).items():
                    setattr(row, k, _text(v))
            else:
                row.validation_errors = o.errors
            row.updated_at = now
            session.add(row)
        if ingestion_id is not None:
            ingestion = await session.get(EvalIngestion, ingestion_id)
            if ingestion is not None:
                ingestion.status, ingestion.silver_batch_id = "promoted", batch_id
                session.add(ingestion)
        await session.commit()
        return PromotionReport(
            batch_id=batch_id, accepted=len(accepted), rejected=len(rejected),
            duplicates=sum(1 for o in rejected if any(e.get("type") == "duplicate" for e in o.errors)),
            rejects=[{"case_id": o.key, "errors": o.errors} for o in rejected], object_keys=object_keys)

    async def edit_case(self, session: AsyncSession, case: EvalCase, content: dict, *, actor: Optional[UUID] = None) -> EvalCase:
        """Replace a case's content as a new revision. It goes back to Bronze and draft: it must be validated and approved
        again, and no published version changes."""
        try:
            if _holds_nul(content):
                raise LakeValidationError("the case contains a NUL character, which cannot be stored")
            digest = content_hash(content)
        except ValueError as exc:
            raise LakeValidationError(f"the case holds a value that is not valid JSON: {exc}") from exc
        case.content, case.content_sha256 = content, digest
        case.tier, case.status, case.dedupe_key, case.validation_errors = "bronze", "draft", None, None
        case.approved_by, case.approved_at, case.approval_note = None, None, None
        case.revision += 1
        case.updated_by, case.updated_at = actor, datetime.utcnow()
        for k, v in summary_fields(content).items():
            setattr(case, k, _text(v))
        session.add(case)
        await session.commit()
        return case

    async def transition_case(self, session: AsyncSession, case: EvalCase, new_status: str, *, actor: Optional[UUID] = None,
                              note: Optional[str] = None) -> EvalCase:
        """Move a case through draft -> in_review -> approved/rejected. Only a validated (Silver) case can be reviewed."""
        if new_status not in CASE_STATUSES:
            raise LakeValidationError(f"status must be one of {', '.join(CASE_STATUSES)}")
        if new_status not in _TRANSITIONS.get(case.status, set()):
            raise LakeValidationError(f"a {case.status} case cannot become {new_status}")
        if new_status in ("in_review", "approved") and case.tier != "silver":
            raise LakeValidationError("only a validated (Silver) case can go to review or be approved")
        if new_status == "approved":
            if actor is None:
                raise LakeValidationError("an approval must say who approved it")
            case.approved_by, case.approved_at, case.approval_note = actor, datetime.utcnow(), note
        elif new_status in ("draft", "rejected", "archived"):
            case.approved_by, case.approved_at = None, None
            case.approval_note = note if new_status == "rejected" else None
        case.status, case.updated_by, case.updated_at = new_status, actor, datetime.utcnow()
        session.add(case)
        await session.commit()
        return case

    # ── fixtures ──────────────────────────────────────────────────────────────

    async def put_fixture(self, session: AsyncSession, dataset: EvalDataset, *, fixture_key: str, data: bytes, filename: str,
                          content_type: str = "application/json", kind: str = "payload", description: Optional[str] = None,
                          created_by: Optional[UUID] = None) -> EvalFixture:
        """Store a synthetic fixture under its checksum and point `fixture_key` at it. Changing a fixture adds a new object;
        a published version keeps the checksum it pinned."""
        if not _FIXTURE_KEY.match(fixture_key):
            raise LakeValidationError(f"fixture key {fixture_key!r} is not valid (letters, digits, dot, dash, underscore; up to 120)")
        if not data:
            raise LakeValidationError("the fixture is empty")
        await self.ensure_ready()
        digest = sha256_hex(data)
        try:
            key = keys.fixture_key(digest, filename)
        except ValueError as exc:
            raise LakeValidationError(str(exc)) from exc
        await self._store(session, key=key, data=data, content_type=content_type, layer="fixtures", kind="fixture", dataset_id=dataset.id)
        row = (await session.exec(select(EvalFixture).where(EvalFixture.dataset_id == dataset.id, EvalFixture.fixture_key == fixture_key))).first()
        if row is None:
            row = EvalFixture(dataset_id=dataset.id, fixture_key=fixture_key, filename=filename, content_type=content_type, sha256=digest,
                              size_bytes=len(data), object_key=key, created_by=created_by)
        row.kind, row.description, row.filename, row.content_type = kind, description, filename, content_type
        row.sha256, row.size_bytes, row.object_key, row.updated_at = digest, len(data), key, datetime.utcnow()
        session.add(row)
        await session.commit()
        return row

    async def read_fixture(self, entry: dict) -> bytes:
        """The bytes of a fixture listed in a manifest, checked against the checksum the version pinned."""
        data = await self._io(self.store.get, entry["object_key"])
        if sha256_hex(data) != entry["sha256"]:
            raise IntegrityFailure(f"fixture {entry['fixture_key']} no longer matches the checksum its version pinned")
        return data

    # ── Gold: publish ─────────────────────────────────────────────────────────

    async def publish(self, dataset_id: UUID, version: str, *, approval: dict, published_by: Optional[UUID] = None,
                      change_summary: Optional[str] = None, case_keys: Optional[Sequence[str]] = None) -> EvalDatasetVersion:
        """Publish the approved Silver cases of a dataset as `version`. Raises LakeValidationError (nothing to publish, a
        case that no longer validates, a missing fixture...) or PublishConflict before anything is uploaded; any later
        failure marks the version failed and cleans up. See the module docstring."""
        _semver(version)
        approval = self._check_approval(approval)
        await self.ensure_ready()
        plan = await self._prepare(dataset_id, version, approval, published_by, change_summary, case_keys)
        try:
            await self._upload_and_verify(plan)
            return await self._commit(plan)
        except Exception as exc:
            await self._abort(plan, exc)
            raise

    @staticmethod
    def _check_approval(approval: dict) -> dict:
        who = (approval or {}).get("approved_by")
        if not isinstance(who, str) or not who.strip():
            raise LakeValidationError("a published version must record who approved it (approval.approved_by)")
        return {"approved_by": who.strip(), "approved_at": approval.get("approved_at") or datetime.utcnow().isoformat() + "Z",
                "note": approval.get("note")}

    async def _prepare(self, dataset_id: UUID, version: str, approval: dict, published_by: Optional[UUID],
                       change_summary: Optional[str], case_keys: Optional[Sequence[str]]) -> _Plan:
        async with self.session_factory() as s:
            dataset = (await s.exec(select(EvalDataset).where(EvalDataset.id == dataset_id).with_for_update())).first()
            if dataset is None:
                raise LakeValidationError("dataset not found")
            if dataset.status != "active":
                raise LakeValidationError("an archived dataset cannot be published")
            now = datetime.utcnow()
            versions = (await s.exec(select(EvalDatasetVersion).where(EvalDatasetVersion.dataset_id == dataset.id))).all()
            for v in versions:
                if v.state == "publishing":
                    stuck = v.started_at < now - timedelta(minutes=self.settings.publish_stale_minutes)
                    raise PublishConflict(f"version {v.version} is {'stuck (run reconcile)' if stuck else 'still being published'}")
                if v.state == "published" and v.version == version:
                    raise PublishConflict(f"version {version} is already published and cannot be changed; publish a higher version")
            published = [v for v in versions if v.state == "published"]
            latest = max(published, key=lambda v: _semver(v.version)) if published else None
            if latest is not None and _semver(version) <= _semver(latest.version):
                raise LakeValidationError(f"the version must be higher than the latest published version, {latest.version}")

            stmt = select(EvalCase).where(EvalCase.dataset_id == dataset.id, EvalCase.tier == "silver", EvalCase.status == "approved")
            if case_keys:
                stmt = stmt.where(EvalCase.case_key.in_(list(case_keys)))
            rows = (await s.exec(stmt.order_by(EvalCase.case_key))).all()
            problems: List[str] = []
            if case_keys:
                problems += [f"{k}: not an approved, validated case of this dataset" for k in sorted(set(case_keys) - {r.case_key for r in rows})]
            if not rows:
                raise LakeValidationError("no approved cases to publish", problems)

            frozen: List[dict] = []
            entries: List[dict] = []
            for r in rows:
                case, errors = validate_case(r.content)
                if case is None:
                    problems.append(f"{r.case_key}: no longer passes validation ({errors[0]['loc']}: {errors[0]['msg']})")
                    continue
                if content_hash(r.content) != r.content_sha256:
                    problems.append(f"{r.case_key}: its content changed outside the lake (checksum mismatch)")
                    continue
                if r.approved_by is None or r.approved_at is None:
                    problems.append(f"{r.case_key}: approved without a recorded approver")
                    continue
                case["approval"] = {"status": "approved", "approved_by": str(r.approved_by), "approved_at": r.approved_at.isoformat() + "Z",
                                    "notes": r.approval_note}
                frozen.append(case)
                entries.append({"case_id": case["case_id"], "revision": r.revision, "sha256": content_hash(case), "category": case["category"],
                                "difficulty": case["difficulty"], "severity": case["severity"], "scenario_type": case["scenario_type"],
                                "verification": case["source"]["verification"]})

            refs = sorted({ref for c in frozen for ref in c["input"]["fixture_refs"]})
            fixtures: List[dict] = []
            if refs:
                have = {f.fixture_key: f for f in (await s.exec(select(EvalFixture).where(
                    EvalFixture.dataset_id == dataset.id, EvalFixture.fixture_key.in_(refs)))).all()}
                for ref in refs:
                    f = have.get(ref)
                    if f is None:
                        problems.append(f"fixture {ref!r} is referenced by a case but does not exist")
                        continue
                    info = await self._io(self.store.head, f.object_key)
                    if info is None or (info.sha256 is not None and info.sha256 != f.sha256):
                        problems.append(f"fixture {ref!r}: its stored object is missing or does not match its checksum")
                        continue
                    fixtures.append({"fixture_key": f.fixture_key, "kind": f.kind, "filename": f.filename, "object_key": f.object_key,
                                     "sha256": f.sha256, "size_bytes": f.size_bytes, "content_type": f.content_type})
            if problems:
                raise LakeValidationError("cannot publish", problems)

            # Everything checks out: clear what an earlier failed attempt at this same version left behind.
            for old in [v for v in versions if v.state == "failed" and v.version == version]:
                await self._purge_attempt(s, old)

            cases_key = keys.gold_cases_key(dataset.workflow, dataset.slug, version)
            manifest_key = keys.gold_manifest_key(dataset.workflow, dataset.slug, version)
            cases_bytes = to_jsonl(frozen)
            cases_sha = sha256_hex(cases_bytes)
            stats = {
                "case_count": len(frozen),
                "by_category": _count(entries, "category"), "by_difficulty": _count(entries, "difficulty"),
                "by_severity": _count(entries, "severity"), "by_scenario_type": _count(entries, "scenario_type"),
                "by_verification": _count(entries, "verification"),
                "pending_domain_approval": sum(1 for e in entries if e["verification"] == "pending_domain_approval"),
            }
            dataset_sha = _dataset_fingerprint(entries, fixtures)
            manifest = {
                "manifest_version": "1.0",
                "dataset": {"id": str(dataset.id), "slug": dataset.slug, "name": dataset.name, "workflow": dataset.workflow,
                            "turn_mode": dataset.turn_mode},
                "version": version, "parent_version": latest.version if latest else None, "schema_version": SCHEMA_VERSION,
                "created_at": now.isoformat() + "Z", "published_by": str(published_by) if published_by else None,
                "approval": {**approval, "approved_cases": len(frozen)}, "change_summary": change_summary,
                "storage": {"bucket": self.settings.bucket, "layer": "gold"},
                "files": [{"name": "cases.jsonl", "object_key": cases_key, "sha256": cases_sha, "size_bytes": len(cases_bytes),
                           "line_count": len(frozen), "content_type": CONTENT_TYPES["jsonl"]}],
                "fixtures": fixtures, "cases": entries, "stats": stats, "dataset_sha256": dataset_sha,
            }
            manifest_bytes = _pretty(manifest)
            manifest_sha = sha256_hex(manifest_bytes)

            version_row = EvalDatasetVersion(
                dataset_id=dataset.id, version=version, state="publishing", schema_version=SCHEMA_VERSION, case_count=len(frozen),
                fixture_count=len(fixtures), snapshot_key=cases_key, snapshot_sha256=cases_sha, snapshot_size_bytes=len(cases_bytes),
                manifest_key=manifest_key, manifest_sha256=manifest_sha, dataset_sha256=dataset_sha,
                parent_version=latest.version if latest else None, change_summary=change_summary,
                approval={**approval, "approved_cases": len(frozen)}, stats=stats, published_by=published_by, started_at=now)
            s.add(version_row)
            try:
                await s.flush()
            except IntegrityError as exc:
                await s.rollback()
                raise PublishConflict(f"version {version} is already being published or exists") from exc
            for key_, data, sha, ctype, kind in ((cases_key, cases_bytes, cases_sha, CONTENT_TYPES["jsonl"], "cases"),
                                                 (manifest_key, manifest_bytes, manifest_sha, "application/json", "manifest")):
                await self._register(s, key=key_, layer="gold", kind=kind, sha256=sha, size=len(data), content_type=ctype,
                                     dataset_id=dataset.id, version_id=version_row.id, state="pending")
            await s.commit()
            return _Plan(version_id=version_row.id, dataset_id=dataset.id, version=version, cases_key=cases_key, manifest_key=manifest_key,
                         cases_bytes=cases_bytes, manifest_bytes=manifest_bytes, cases_sha=cases_sha, manifest_sha=manifest_sha,
                         manifest=manifest, frozen_cases=frozen, fixtures=fixtures)

    async def _purge_attempt(self, s: AsyncSession, failed: EvalDatasetVersion) -> None:
        """Remove what a failed attempt left in the lake, so the same version can be published again."""
        objects = (await s.exec(select(EvalStorageObject).where(
            EvalStorageObject.version_id == failed.id, EvalStorageObject.layer == "gold", EvalStorageObject.state != "deleted"))).all()
        for obj in objects:
            try:
                await self._io(self.store.delete, obj.object_key)
            except ObjectLocked as exc:
                raise PublishConflict(f"{obj.object_key}, left by a failed attempt, is under retention; publish a higher version") from exc
            obj.state = "deleted"
            s.add(obj)
        await s.flush()

    async def _upload_and_verify(self, plan: _Plan) -> None:
        store, settings = self.store, self.settings

        def work() -> None:
            for key_, data, sha, ctype in ((plan.cases_key, plan.cases_bytes, plan.cases_sha, CONTENT_TYPES["jsonl"]),
                                           (plan.manifest_key, plan.manifest_bytes, plan.manifest_sha, "application/json")):   # manifest last
                if store.put_if_absent(key_, data, content_type=ctype, sha256=sha).created:
                    plan.created_keys.append(key_)
            for key_, sha, size in ((plan.cases_key, plan.cases_sha, len(plan.cases_bytes)), (plan.manifest_key, plan.manifest_sha, len(plan.manifest_bytes))):
                info = store.head(key_)
                if info is None or info.size != size or (info.sha256 is not None and info.sha256 != sha):
                    raise IntegrityFailure(f"{key_} was uploaded but does not match what was sent")
                if sha256_hex(store.get(key_)) != sha:
                    raise IntegrityFailure(f"{key_} reads back with a different checksum")
            for f in plan.fixtures:
                info = store.head(f["object_key"])
                if info is None or info.sha256 != f["sha256"]:
                    raise IntegrityFailure(f"fixture {f['fixture_key']} changed or disappeared during publication")
            until = datetime.now(timezone.utc) + timedelta(days=settings.retention_days)
            for key_ in [plan.cases_key, plan.manifest_key] + [f["object_key"] for f in plan.fixtures]:
                store.retain(key_, until)
            plan.retain_until = until if settings.locks_objects else None

        await self._io(work)
        plan.locked = self.settings.locks_objects

    async def _commit(self, plan: _Plan) -> EvalDatasetVersion:
        async with self.session_factory() as s:
            v = (await s.exec(select(EvalDatasetVersion).where(EvalDatasetVersion.id == plan.version_id).with_for_update())).one()
            if v.state != "publishing":
                raise PublishConflict(f"version {v.version} is {v.state}; it was changed while it was being published")
            await self._finalize(s, v, plan.manifest, plan.frozen_cases, plan.retain_until)
            await s.commit()
            return v

    async def _finalize(self, s: AsyncSession, v: EvalDatasetVersion, manifest: dict, cases: List[dict],
                        retain_until: Optional[datetime]) -> None:
        """The database half of publishing: the case index, the registry, the dataset's latest version, then the state flip."""
        now = datetime.utcnow()
        for line_no, entry in enumerate(manifest["cases"], start=1):
            s.add(EvalVersionCase(version_id=v.id, case_key=entry["case_id"], revision=entry["revision"], content_sha256=entry["sha256"],
                                  line_no=line_no, category=entry["category"], scenario_type=entry["scenario_type"],
                                  difficulty=entry["difficulty"], severity=entry["severity"], verification=entry["verification"]))
        await s.flush()
        until = _naive_utc(retain_until)
        for obj in (await s.exec(select(EvalStorageObject).where(EvalStorageObject.object_key.in_(
                [v.snapshot_key, v.manifest_key] + [f["object_key"] for f in manifest["fixtures"]])))).all():
            obj.state, obj.verified_at, obj.retain_until = "verified", now, until
            if obj.layer == "gold":
                obj.version_id = v.id
            s.add(obj)
        revisions = {e["case_id"]: e["revision"] for e in manifest["cases"]}
        for row in (await s.exec(select(EvalCase).where(EvalCase.dataset_id == v.dataset_id, EvalCase.case_key.in_(list(revisions))))).all():
            row.last_published_version, row.last_published_revision = v.version, revisions[row.case_key]
            s.add(row)
        dataset = (await s.exec(select(EvalDataset).where(EvalDataset.id == v.dataset_id))).one()
        dataset.latest_version, dataset.updated_at = v.version, now
        s.add(dataset)
        v.state, v.published_at, v.failure_reason = "published", now, None
        s.add(v)

    async def _abort(self, plan: _Plan, exc: Exception) -> None:
        if plan.locked:
            # The objects are verified and under retention; only the database write failed. Leave the version 'publishing'
            # so reconcile() completes it instead of throwing away a good snapshot.
            log.error("publication of %s stopped after the upload; reconcile() will finish it: %s", plan.version, exc)
            return
        reason = f"{type(exc).__name__}: {exc}"[:2000]
        log.warning("publication of %s failed: %s", plan.version, reason)
        removed: List[str] = []
        for key_ in plan.created_keys:
            try:
                await self._io(self.store.delete, key_)
                removed.append(key_)
            except Exception:                          # noqa: BLE001 - best effort; reconcile and the next attempt retry it
                log.warning("could not remove %s after the failed publication", key_, exc_info=True)
        try:
            async with self.session_factory() as s:
                v = (await s.exec(select(EvalDatasetVersion).where(EvalDatasetVersion.id == plan.version_id))).first()
                if v is not None and v.state == "publishing":
                    v.state, v.failure_reason = "failed", reason
                    s.add(v)
                    for obj in (await s.exec(select(EvalStorageObject).where(EvalStorageObject.version_id == plan.version_id))).all():
                        if obj.object_key in removed:
                            obj.state = "deleted"
                            s.add(obj)
                    await s.commit()
        except Exception:                              # noqa: BLE001
            log.exception("could not record the failure of %s; reconcile() will", plan.version)

    # ── Gold: read, verify, reconcile ─────────────────────────────────────────

    async def get_version(self, session: AsyncSession, dataset_slug: str, version: str) -> EvalDatasetVersion:
        dataset = await self.get_dataset(session, dataset_slug)
        v = (await session.exec(select(EvalDatasetVersion).where(
            EvalDatasetVersion.dataset_id == dataset.id, EvalDatasetVersion.version == version, EvalDatasetVersion.state == "published"))).first()
        if v is None:
            raise LakeValidationError(f"{dataset_slug} has no published version {version}")
        return v

    def _read_and_check(self, v: EvalDatasetVersion) -> Tuple[Optional[dict], Optional[List[dict]], List[str]]:
        """Fetch a version's manifest and snapshot and compare every checksum. Blocking: run it in a thread."""
        problems: List[str] = []
        try:
            manifest_bytes = self.store.get(v.manifest_key)
        except ObjectMissing:
            return None, None, [f"the manifest {v.manifest_key} is missing"]
        if sha256_hex(manifest_bytes) != v.manifest_sha256:
            return None, None, [f"the manifest {v.manifest_key} does not match its recorded checksum"]
        manifest = json.loads(manifest_bytes)
        try:
            cases_bytes = self.store.get(v.snapshot_key)
        except ObjectMissing:
            return manifest, None, [f"the snapshot {v.snapshot_key} is missing"]
        file_entry = next((f for f in manifest.get("files", []) if f.get("object_key") == v.snapshot_key), None)
        if sha256_hex(cases_bytes) != v.snapshot_sha256 or (file_entry and file_entry["sha256"] != v.snapshot_sha256):
            return manifest, None, [f"the snapshot {v.snapshot_key} does not match its recorded checksum"]
        cases: List[dict] = []
        for line, value, error in parse_jsonl(cases_bytes):
            if error:
                problems.append(f"snapshot line {line}: {error}")
            else:
                cases.append(value)
        index = {e["case_id"]: e["sha256"] for e in manifest["cases"]}
        if len(cases) != v.case_count or len(index) != v.case_count:
            problems.append(f"the snapshot holds {len(cases)} cases but the version records {v.case_count}")
        for case in cases:
            if index.get(case.get("case_id")) != content_hash(case):
                problems.append(f"case {case.get('case_id')!r} does not match the checksum in the manifest")
        if _dataset_fingerprint(manifest["cases"], manifest["fixtures"]) != v.dataset_sha256:
            problems.append("the dataset fingerprint does not match")
        return manifest, cases, problems

    async def load_version(self, version: EvalDatasetVersion) -> LoadedVersion:
        """The cases of a published version, after checking the manifest, the snapshot and every case against their
        checksums. Raises IntegrityFailure if anything differs: an evaluation must never run on altered data."""
        if version.state != "published":
            raise LakeValidationError(f"version {version.version} is {version.state}, not published")
        manifest, cases, problems = await self._io(self._read_and_check, version)
        if problems or manifest is None or cases is None:
            raise IntegrityFailure(f"dataset version {version.version} failed its integrity check: " + "; ".join(problems))
        return LoadedVersion(dataset_slug=manifest["dataset"]["slug"], version=version.version, manifest=manifest, cases=cases)

    async def export_version(self, version: EvalDatasetVersion, fmt: str) -> bytes:
        loaded = await self.load_version(version)
        return serialize_cases(loaded.cases, fmt)

    async def verify_version(self, version: EvalDatasetVersion, *, deep: bool = False) -> VerifyReport:
        """Check a published version and report instead of raising. `deep` also re-reads every fixture and re-hashes it."""
        def work():
            manifest, cases, problems = self._read_and_check(version)
            checked = 2 if manifest is not None else 1
            for f in (manifest or {}).get("fixtures", []):
                info = self.store.head(f["object_key"])
                checked += 1
                if info is None:
                    problems.append(f"fixture {f['fixture_key']} is missing")
                elif info.sha256 != f["sha256"] or info.size != f["size_bytes"]:
                    problems.append(f"fixture {f['fixture_key']} does not match its pinned checksum")
                elif deep and sha256_hex(self.store.get(f["object_key"])) != f["sha256"]:
                    problems.append(f"fixture {f['fixture_key']} reads back with a different checksum")
            return problems, checked

        problems, checked = await self._io(work)
        state = "verified" if not problems else "corrupt"
        async with self.session_factory() as s:        # the registry is a log of what was last seen, not part of the version
            for obj in (await s.exec(select(EvalStorageObject).where(EvalStorageObject.version_id == version.id))).all():
                obj.state, obj.verified_at = state, datetime.utcnow()
                s.add(obj)
            await s.commit()
        return VerifyReport(version_id=version.id, version=version.version, ok=not problems, problems=problems, objects_checked=checked)

    async def reconcile(self) -> ReconcileReport:
        """Settle every publication that has been 'publishing' for longer than the stale limit: finish it if its objects
        verify, otherwise mark it failed and remove what it left. Safe to run at any time and as often as you like."""
        report = ReconcileReport()
        await self.ensure_ready()
        cutoff = datetime.utcnow() - timedelta(minutes=self.settings.publish_stale_minutes)
        async with self.session_factory() as s:
            stale_ids = [v.id for v in (await s.exec(select(EvalDatasetVersion).where(
                EvalDatasetVersion.state == "publishing", EvalDatasetVersion.started_at < cutoff))).all()]
            for version_id in stale_ids:
                v = await s.get(EvalDatasetVersion, version_id)
                if v is None or v.state != "publishing":
                    continue
                label = f"{v.dataset_id}:{v.version}"
                manifest, cases, problems = await self._io(self._read_and_check, v)
                if not problems and manifest is not None and cases is not None:
                    until = datetime.now(timezone.utc) + timedelta(days=self.settings.retention_days)
                    keys_ = [v.snapshot_key, v.manifest_key] + [f["object_key"] for f in manifest["fixtures"]]
                    try:
                        for key_ in keys_:
                            await self._io(self.store.retain, key_, until)
                        await self._finalize(s, v, manifest, cases, until)
                        await s.commit()
                        report.finalized.append(label)
                        continue
                    except Exception:                  # noqa: BLE001
                        await s.rollback()
                        log.exception("could not finish publication %s", label)
                        report.skipped.append(label)
                        continue
                try:
                    await self._purge_attempt(s, v)
                except PublishConflict:
                    report.skipped.append(label)
                    await s.rollback()
                    continue
                v.state, v.failure_reason = "failed", "interrupted before the upload was complete: " + ("; ".join(problems) or "no objects")
                s.add(v)
                await s.commit()
                report.failed.append(label)
        return report


def _count(entries: Sequence[dict], field_name: str) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for e in entries:
        out[e[field_name]] = out.get(e[field_name], 0) + 1
    return dict(sorted(out.items()))


def _safe_hash(record: dict) -> str:
    try:
        return content_hash(record)
    except ValueError:
        return sha256_hex(repr(record).encode("utf-8"))
