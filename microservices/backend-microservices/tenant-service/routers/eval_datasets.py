"""Golden dataset manager — SuperAdmin only.

Read: the evaluation datasets in the data lake, their cases (the working copy in Silver), their published Gold versions and
the differences between two versions.
Write: create a dataset, upload cases, edit or add a case, review and approve cases, retire a case, load fixtures and publish
a new version. A published (Gold) version is never edited: a change is made in Silver and published as a higher version.
Every write is recorded in the audit trail.
"""
import json
import mimetypes
import re
from contextlib import contextmanager
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlmodel import func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from routers.auth import _get_current_user, oauth2_scheme, verify_superadmin
from services.audit_capture import record_standalone
from services.eval_lake import get_lake
from shared.evaluation import case_schema
from shared.evaluation.formats import FORMATS
from shared.evaluation.lake import LakeValidationError, PublishConflict
from shared.evaluation.object_store import IntegrityFailure, LakeError, LakeNotReady
from shared.models.core import User
from shared.models.evaluation import EvalCase, EvalDataset, EvalDatasetVersion, EvalFixture, EvalVersionCase

router = APIRouter(prefix="/eval/datasets", tags=["Evaluation datasets"], dependencies=[Depends(verify_superadmin)])
_SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


async def _actor(token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)) -> User:
    """The signed-in SuperAdmin (the router already refused anyone else)."""
    return await _get_current_user(token, session)


@contextmanager
def _lake_errors():
    """Turn the lake's errors into answers the page can show."""
    try:
        yield
    except LakeValidationError as exc:
        raise HTTPException(status_code=422, detail={"message": str(exc), "problems": exc.problems})
    except PublishConflict as exc:
        raise HTTPException(status_code=409, detail={"message": str(exc), "problems": []})
    except LakeNotReady as exc:
        raise HTTPException(status_code=503, detail={"message": f"The data lake is not reachable: {exc}", "problems": []})
    except LakeError as exc:
        raise HTTPException(status_code=502, detail={"message": str(exc), "problems": []})


async def _audit(actor: User, action: str, slug: str, **metadata: Any) -> None:
    """Record a dataset change. A failure to record is counted by the audit module and never blocks the change."""
    await record_standalone(module="administration", action=f"eval.dataset.{action}", entity_type="eval_dataset", entity_id=slug,
                            tenant_id=actor.tenant_id, actor_id=str(actor.id), actor_type="USER", actor_role="SuperAdmin",
                            metadata=metadata)


def _next_version(latest: Optional[str]) -> str:
    m = _SEMVER.match(latest or "")
    return f"{m.group(1)}.{m.group(2)}.{int(m.group(3)) + 1}" if m else "1.0.0"

_TITLE = EvalCase.content["title"].astext
_UNPUBLISHED = or_(EvalCase.last_published_revision.is_(None), EvalCase.last_published_revision != EvalCase.revision)


async def _dataset(session: AsyncSession, slug: str) -> EvalDataset:
    dataset = (await session.exec(select(EvalDataset).where(EvalDataset.slug == slug))).first()
    if dataset is None:
        raise HTTPException(status_code=404, detail=f"No dataset '{slug}'.")
    return dataset


def _version_out(v: EvalDatasetVersion) -> Dict[str, Any]:
    return {
        "version": v.version, "state": v.state, "case_count": v.case_count, "fixture_count": v.fixture_count,
        "parent_version": v.parent_version, "change_summary": v.change_summary, "approval": v.approval, "stats": v.stats,
        "snapshot_sha256": v.snapshot_sha256, "published_at": v.published_at, "started_at": v.started_at,
        "failure_reason": v.failure_reason,
    }


async def _case_counts(session: AsyncSession, dataset_ids: List[UUID]) -> Dict[UUID, Dict[str, Any]]:
    """Per dataset: Silver cases by status, and how many differ from what the latest Gold version holds."""
    out: Dict[UUID, Dict[str, Any]] = {i: {"by_status": {}, "unpublished_changes": 0} for i in dataset_ids}
    if not dataset_ids:
        return out
    rows = (await session.exec(select(EvalCase.dataset_id, EvalCase.status, func.count())
                               .where(EvalCase.dataset_id.in_(dataset_ids), EvalCase.tier == "silver")
                               .group_by(EvalCase.dataset_id, EvalCase.status))).all()
    for dataset_id, status, n in rows:
        out[dataset_id]["by_status"][status] = n
    rows = (await session.exec(select(EvalCase.dataset_id, func.count())
                               .where(EvalCase.dataset_id.in_(dataset_ids), EvalCase.tier == "silver", _UNPUBLISHED)
                               .group_by(EvalCase.dataset_id))).all()
    for dataset_id, n in rows:
        out[dataset_id]["unpublished_changes"] = n
    return out


@router.get("")
async def list_datasets(session: AsyncSession = Depends(get_session)):
    datasets = (await session.exec(select(EvalDataset).order_by(EvalDataset.slug))).all()
    counts = await _case_counts(session, [d.id for d in datasets])
    return [{"slug": d.slug, "name": d.name, "workflow": d.workflow, "turn_mode": d.turn_mode, "status": d.status,
             "latest_version": d.latest_version, "updated_at": d.updated_at, **counts[d.id]} for d in datasets]


@router.get("/_schema")
async def case_json_schema():
    """The JSON Schema every case must satisfy, plus the allowed values the editor offers (the name starts with an
    underscore so it can never be a dataset slug)."""
    return case_schema.json_schema()


@router.get("/{slug}")
async def get_dataset(slug: str, session: AsyncSession = Depends(get_session)):
    d = await _dataset(session, slug)
    versions = (await session.exec(select(EvalDatasetVersion).where(EvalDatasetVersion.dataset_id == d.id)
                                   .order_by(EvalDatasetVersion.started_at.desc()))).all()
    facets = {}
    for name, column in (("category", EvalCase.category), ("scenario_type", EvalCase.scenario_type)):
        facets[name] = sorted(v for v in (await session.exec(select(column).where(EvalCase.dataset_id == d.id).distinct())).all() if v)
    return {"slug": d.slug, "name": d.name, "description": d.description, "workflow": d.workflow, "turn_mode": d.turn_mode,
            "facets": facets,
            "status": d.status, "latest_version": d.latest_version, "suggested_version": _next_version(d.latest_version),
            "schema_version": d.schema_version,
            "created_at": d.created_at, "updated_at": d.updated_at, **(await _case_counts(session, [d.id]))[d.id],
            "versions": [_version_out(v) for v in versions]}


@router.get("/{slug}/cases")
async def list_cases(
    slug: str,
    tier: str = Query("silver", pattern="^(bronze|silver)$"),
    status: Optional[str] = Query(None, pattern="^(draft|in_review|approved|rejected|archived)$"),
    category: Optional[str] = None,
    scenario_type: Optional[str] = None,
    difficulty: Optional[str] = None,
    severity: Optional[str] = None,
    changed_only: bool = Query(False, description="Only cases that differ from the latest published version"),
    q: Optional[str] = Query(None, max_length=100, description="Matches the case id or title"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    session: AsyncSession = Depends(get_session),
):
    d = await _dataset(session, slug)
    where = [EvalCase.dataset_id == d.id, EvalCase.tier == tier]
    for column, value in ((EvalCase.status, status), (EvalCase.category, category), (EvalCase.scenario_type, scenario_type),
                          (EvalCase.difficulty, difficulty), (EvalCase.severity, severity)):
        if value:
            where.append(column == value)
    if changed_only:
        where.append(_UNPUBLISHED)
    if q:
        like = f"%{q.strip()}%"
        where.append(or_(EvalCase.case_key.ilike(like), _TITLE.ilike(like)))
    total = (await session.exec(select(func.count()).select_from(EvalCase).where(*where))).one()
    rows = (await session.exec(select(EvalCase.case_key, _TITLE, EvalCase.tier, EvalCase.status, EvalCase.revision, EvalCase.category,
                                      EvalCase.scenario_type, EvalCase.difficulty, EvalCase.severity, EvalCase.approved_at,
                                      EvalCase.last_published_version, EvalCase.last_published_revision, EvalCase.updated_at)
                               .where(*where).order_by(EvalCase.case_key).offset(offset).limit(limit))).all()
    items = [{"case_key": r[0], "title": r[1], "tier": r[2], "status": r[3], "revision": r[4], "category": r[5],
              "scenario_type": r[6], "difficulty": r[7], "severity": r[8], "approved_at": r[9],
              "last_published_version": r[10], "changed_since_publish": r[11] is None or r[11] != r[4], "updated_at": r[12]}
             for r in rows]
    return {"total": total, "limit": limit, "offset": offset, "items": items}


@router.get("/{slug}/cases/{case_key}")
async def get_case(slug: str, case_key: str, tier: str = Query("silver", pattern="^(bronze|silver)$"),
                   session: AsyncSession = Depends(get_session)):
    d = await _dataset(session, slug)
    c = (await session.exec(select(EvalCase).where(EvalCase.dataset_id == d.id, EvalCase.case_key == case_key,
                                                    EvalCase.tier == tier))).first()
    if c is None:
        raise HTTPException(status_code=404, detail=f"No {tier} case '{case_key}' in {slug}.")
    approver = await session.get(User, c.approved_by) if c.approved_by else None
    # Every published version that holds this case, with the revision it held: the case's history in Gold.
    history = (await session.exec(select(EvalDatasetVersion.version, EvalVersionCase.revision, EvalVersionCase.content_sha256,
                                         EvalVersionCase.verification, EvalDatasetVersion.published_at)
                                  .join(EvalVersionCase, EvalVersionCase.version_id == EvalDatasetVersion.id)
                                  .where(EvalDatasetVersion.dataset_id == d.id, EvalDatasetVersion.state == "published",
                                         EvalVersionCase.case_key == case_key)
                                  .order_by(EvalDatasetVersion.published_at))).all()
    return {"case_key": c.case_key, "tier": c.tier, "status": c.status, "revision": c.revision, "content": c.content,
            "content_sha256": c.content_sha256, "validation_errors": c.validation_errors,
            "approval": {"approved_by": approver.email if approver else None, "approved_at": c.approved_at, "note": c.approval_note},
            "last_published_version": c.last_published_version, "changed_since_publish": c.last_published_revision != c.revision,
            "updated_at": c.updated_at,
            "published_in": [{"version": h[0], "revision": h[1], "content_sha256": h[2], "verification": h[3], "published_at": h[4]}
                             for h in history]}


async def _published(session: AsyncSession, dataset_id: UUID, version: str) -> EvalDatasetVersion:
    v = (await session.exec(select(EvalDatasetVersion).where(
        EvalDatasetVersion.dataset_id == dataset_id, EvalDatasetVersion.version == version, EvalDatasetVersion.state == "published"))).first()
    if v is None:
        raise HTTPException(status_code=404, detail=f"No published version '{version}'.")
    return v


async def _index(session: AsyncSession, version_id: UUID) -> Dict[str, EvalVersionCase]:
    return {r.case_key: r for r in (await session.exec(select(EvalVersionCase).where(EvalVersionCase.version_id == version_id))).all()}


@router.get("/{slug}/versions/{version}")
async def get_version(slug: str, version: str, session: AsyncSession = Depends(get_session)):
    d = await _dataset(session, slug)
    v = await _published(session, d.id, version)
    cases = sorted((await _index(session, v.id)).values(), key=lambda r: r.line_no)
    return {**_version_out(v), "cases": [{"case_key": r.case_key, "revision": r.revision, "category": r.category,
                                          "scenario_type": r.scenario_type, "difficulty": r.difficulty, "severity": r.severity,
                                          "verification": r.verification} for r in cases]}


@router.get("/{slug}/diff")
async def diff_versions(slug: str, from_version: str = Query(..., alias="from"), to_version: str = Query(..., alias="to"),
                        session: AsyncSession = Depends(get_session)):
    """What changed between two published versions: cases added, removed, or whose content differs, with the fields that
    differ. The approval block is left out of the comparison: every publish writes a new one, so it would flag every case."""
    d = await _dataset(session, slug)
    a, b = await _published(session, d.id, from_version), await _published(session, d.id, to_version)
    lake = get_lake()
    try:
        old, new = await lake.load_version(a), await lake.load_version(b)
    except (IntegrityFailure, LakeError) as exc:
        raise HTTPException(status_code=502, detail=f"Could not read the versions from the data lake: {exc}")
    before, after = {c["case_id"]: c for c in old.cases}, {c["case_id"]: c for c in new.cases}
    changed = []
    for key in sorted(before.keys() & after.keys()):
        fields = sorted(f for f in (before[key].keys() | after[key].keys()) - {"approval"} if before[key].get(f) != after[key].get(f))
        if fields:
            changed.append({"case_key": key, "fields": fields})
    return {"from": from_version, "to": to_version,
            "added": sorted(after.keys() - before.keys()), "removed": sorted(before.keys() - after.keys()), "changed": changed,
            "unchanged": len(before.keys() & after.keys()) - len(changed)}


@router.get("/{slug}/fixtures")
async def list_fixtures(slug: str, session: AsyncSession = Depends(get_session)):
    d = await _dataset(session, slug)
    rows = (await session.exec(select(EvalFixture).where(EvalFixture.dataset_id == d.id).order_by(EvalFixture.fixture_key))).all()
    return [{"fixture_key": f.fixture_key, "kind": f.kind, "filename": f.filename, "content_type": f.content_type,
             "size_bytes": f.size_bytes, "sha256": f.sha256, "description": f.description, "updated_at": f.updated_at} for f in rows]


@router.get("/{slug}/versions/{version}/export")
async def export_version(slug: str, version: str, format: str = Query("jsonl"), session: AsyncSession = Depends(get_session)):
    if format not in FORMATS:
        raise HTTPException(status_code=422, detail=f"format must be one of {', '.join(FORMATS)}")
    d = await _dataset(session, slug)
    v = await _published(session, d.id, version)
    with _lake_errors():
        data = await get_lake().export_version(v, format)
    media = {"jsonl": "application/x-ndjson", "json": "application/json", "csv": "text/csv"}[format]
    return Response(content=data, media_type=media, headers={"Content-Disposition": f'attachment; filename="{slug}-{version}.{format}"'})


# ── writes ────────────────────────────────────────────────────────────────────

class DatasetCreate(BaseModel):
    slug: str = Field(min_length=3, max_length=80)
    name: str = Field(min_length=1, max_length=255)
    workflow: str = Field(min_length=1, max_length=60)
    turn_mode: Literal["single_turn", "multi_turn"]
    description: Optional[str] = Field(default=None, max_length=2000)


class CaseBody(BaseModel):
    content: Dict[str, Any]


class StatusBody(BaseModel):
    status: Literal["draft", "in_review", "approved", "rejected", "archived"]
    note: Optional[str] = Field(default=None, max_length=1000)


class ApproveBody(BaseModel):
    case_keys: Optional[List[str]] = Field(default=None, description="Only these cases; omit for every draft or in-review case")
    note: Optional[str] = Field(default=None, max_length=1000)


class PublishBody(BaseModel):
    version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    change_summary: Optional[str] = Field(default=None, max_length=2000)
    note: Optional[str] = Field(default=None, max_length=1000)
    case_keys: Optional[List[str]] = None


async def _case_row(session: AsyncSession, dataset_id: UUID, case_key: str) -> EvalCase:
    c = (await session.exec(select(EvalCase).where(EvalCase.dataset_id == dataset_id, EvalCase.case_key == case_key))).first()
    if c is None:
        raise HTTPException(status_code=404, detail=f"No case '{case_key}' in this dataset.")
    return c


def _case_result(c: EvalCase, report: Any = None) -> Dict[str, Any]:
    return {"case_key": c.case_key, "tier": c.tier, "status": c.status, "revision": c.revision,
            "validation_errors": c.validation_errors, "rejects": report.rejects if report else [], "duplicates": report.duplicates if report else 0}


@router.post("", status_code=201)
async def create_dataset(body: DatasetCreate, actor: User = Depends(_actor), session: AsyncSession = Depends(get_session)):
    with _lake_errors():
        try:
            d = await get_lake().create_dataset(session, slug=body.slug, name=body.name, workflow=body.workflow,
                                                turn_mode=body.turn_mode, description=body.description, created_by=actor.id)
        except ValueError as exc:
            raise LakeValidationError(str(exc))
    await _audit(actor, "create", d.slug, name=d.name, workflow=d.workflow, turn_mode=d.turn_mode)
    return {"slug": d.slug, "name": d.name}


@router.post("/{slug}/ingest")
async def ingest_cases(slug: str, file: UploadFile = File(...), source_type: Literal["import", "synthetic", "trace", "manual"] = Form("import"),
                       source_ref: Optional[str] = Form(None), promote: bool = Form(True),
                       actor: User = Depends(_actor), session: AsyncSession = Depends(get_session)):
    """Upload cases (JSONL, JSON or CSV). They are kept as received (Bronze) and, unless told not to, validated into
    Silver straight away. A case already in the dataset becomes a new revision and must be approved again."""
    d = await _dataset(session, slug)
    lake = get_lake()
    data = await file.read()
    with _lake_errors():
        result = await lake.ingest_bronze(session, d, data=data, filename=file.filename or "upload", source_type=source_type,
                                          source_ref=source_ref, created_by=actor.id)
        report = await lake.promote_to_silver(session, d, ingestion_id=result.ingestion_id) if promote else None
    await _audit(actor, "ingest", slug, filename=file.filename, created=result.created, updated=result.updated,
                 rejected=result.rejected, sha256=result.sha256, promoted=report.accepted if report else None)
    return {"ingestion_id": str(result.ingestion_id), "created": result.created, "updated": result.updated,
            "rejected": result.rejected, "rejects": result.rejects[:50],
            "promoted": None if report is None else {"accepted": report.accepted, "rejected": report.rejected,
                                                      "duplicates": report.duplicates, "rejects": report.rejects[:50]}}


@router.post("/{slug}/promote")
async def promote(slug: str, actor: User = Depends(_actor), session: AsyncSession = Depends(get_session)):
    """Validate every Bronze case of the dataset (for example after an upload that was not promoted)."""
    d = await _dataset(session, slug)
    with _lake_errors():
        report = await get_lake().promote_to_silver(session, d)
    await _audit(actor, "promote", slug, accepted=report.accepted, rejected=report.rejected)
    return {"accepted": report.accepted, "rejected": report.rejected, "duplicates": report.duplicates, "rejects": report.rejects[:50]}


@router.post("/{slug}/cases", status_code=201)
async def add_case(slug: str, body: CaseBody, actor: User = Depends(_actor), session: AsyncSession = Depends(get_session)):
    d = await _dataset(session, slug)
    case_key = body.content.get("case_id")
    if not isinstance(case_key, str) or not case_key.strip():
        raise HTTPException(status_code=422, detail={"message": "The case needs a case_id.", "problems": []})
    if (await session.exec(select(EvalCase.id).where(EvalCase.dataset_id == d.id, EvalCase.case_key == case_key))).first():
        raise HTTPException(status_code=409, detail={"message": f"Case '{case_key}' already exists; edit it instead.", "problems": []})
    lake = get_lake()
    with _lake_errors():
        result = await lake.ingest_bronze(session, d, data=json.dumps(body.content).encode(), filename=f"{case_key}.json",
                                          source_type="manual", created_by=actor.id)
        report = await lake.promote_to_silver(session, d, ingestion_id=result.ingestion_id)
    c = await _case_row(session, d.id, case_key) if result.created or result.updated else None
    if c is None:
        raise HTTPException(status_code=422, detail={"message": "The case could not be read.", "problems": [r["error"] for r in result.rejects]})
    await _audit(actor, "case.add", slug, case_key=case_key, tier=c.tier)
    return _case_result(c, report)


@router.put("/{slug}/cases/{case_key}")
async def edit_case(slug: str, case_key: str, body: CaseBody, actor: User = Depends(_actor), session: AsyncSession = Depends(get_session)):
    """Replace a case as a new revision and validate it. It returns to draft and needs approving again; no published
    version changes. If it does not validate it stays in Bronze with the errors recorded."""
    d = await _dataset(session, slug)
    c = await _case_row(session, d.id, case_key)
    if body.content.get("case_id") != case_key:
        raise HTTPException(status_code=422, detail={"message": f"case_id must stay '{case_key}'; add a new case to use another id.", "problems": []})
    lake = get_lake()
    with _lake_errors():
        await lake.edit_case(session, c, body.content, actor=actor.id)
        report = await lake.promote_to_silver(session, d, case_keys=[case_key])
    await session.refresh(c)
    await _audit(actor, "case.edit", slug, case_key=case_key, revision=c.revision, tier=c.tier)
    return _case_result(c, report)


@router.post("/{slug}/cases/{case_key}/status")
async def set_case_status(slug: str, case_key: str, body: StatusBody, actor: User = Depends(_actor),
                          session: AsyncSession = Depends(get_session)):
    """Move one case: to review, approve, reject, back to draft, or retire it (archived cases are left out of the next version)."""
    d = await _dataset(session, slug)
    c = await _case_row(session, d.id, case_key)
    with _lake_errors():
        await get_lake().transition_case(session, c, body.status, actor=actor.id, note=body.note)
    await _audit(actor, f"case.{body.status}", slug, case_key=case_key, note=body.note)
    return _case_result(c)


@router.post("/{slug}/approve")
async def approve_cases(slug: str, body: ApproveBody, actor: User = Depends(_actor), session: AsyncSession = Depends(get_session)):
    """Approve every draft or in-review Silver case (or just the named ones), recording the signed-in user as approver."""
    d = await _dataset(session, slug)
    lake = get_lake()
    stmt = select(EvalCase).where(EvalCase.dataset_id == d.id, EvalCase.tier == "silver", EvalCase.status.in_(["draft", "in_review"]))
    if body.case_keys:
        stmt = stmt.where(EvalCase.case_key.in_(body.case_keys))
    rows = (await session.exec(stmt.order_by(EvalCase.case_key))).all()
    with _lake_errors():
        for row in rows:
            if row.status == "draft":
                await lake.transition_case(session, row, "in_review", actor=actor.id)
            await lake.transition_case(session, row, "approved", actor=actor.id, note=body.note)
    await _audit(actor, "approve", slug, count=len(rows), case_keys=[r.case_key for r in rows][:200], note=body.note)
    return {"approved": len(rows)}


@router.post("/{slug}/fixtures", status_code=201)
async def upload_fixture(slug: str, file: UploadFile = File(...), fixture_key: Optional[str] = Form(None), kind: str = Form("payload"),
                         description: Optional[str] = Form(None), actor: User = Depends(_actor),
                         session: AsyncSession = Depends(get_session)):
    """Add or replace a fixture. A published version keeps the checksum it pinned; the change shows in the next version."""
    d = await _dataset(session, slug)
    name = file.filename or ""
    key = (fixture_key or name).strip()
    content_type = file.content_type if file.content_type and file.content_type != "application/octet-stream" else (mimetypes.guess_type(name)[0] or "application/octet-stream")
    with _lake_errors():
        row = await get_lake().put_fixture(session, d, fixture_key=key, data=await file.read(), filename=name or key,
                                           content_type=content_type, kind=kind, description=description, created_by=actor.id)
    await _audit(actor, "fixture.put", slug, fixture_key=key, sha256=row.sha256, size_bytes=row.size_bytes)
    return {"fixture_key": row.fixture_key, "sha256": row.sha256, "size_bytes": row.size_bytes}


@router.post("/{slug}/publish")
async def publish_version(slug: str, body: PublishBody, actor: User = Depends(_actor), session: AsyncSession = Depends(get_session)):
    """Publish the approved Silver cases as a new, immutable Gold version. The signed-in user is recorded as approver."""
    d = await _dataset(session, slug)
    with _lake_errors():
        v = await get_lake().publish(d.id, body.version, approval={"approved_by": actor.email, "note": body.note},
                                     published_by=actor.id, change_summary=body.change_summary, case_keys=body.case_keys)
    await _audit(actor, "publish", slug, version=v.version, case_count=v.case_count, snapshot_sha256=v.snapshot_sha256,
                 change_summary=body.change_summary)
    return _version_out(v)
