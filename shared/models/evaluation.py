"""Evaluation data lake tables: datasets, their working cases, raw imports, fixtures, published versions.

Three layers (see docs/evaluation/architecture.md):
  Bronze  raw imports and candidates: the raw file lives in MinIO, each record is an `eval_cases` row with tier 'bronze'.
  Silver  records that passed schema validation, cleaning and de-duplication: `eval_cases` rows with tier 'silver'.
  Gold    approved, immutable, versioned snapshots: `eval_dataset_versions` + the snapshot objects in MinIO.

PostgreSQL holds what people edit (case content as JSONB), the indexes and the audit trail. MinIO is the canonical copy of
a published version. `eval_dataset_versions` rows and their `eval_version_cases` index rows can no longer change once a
version is published; the triggers in shared/evaluation/ddl.py enforce that in the database itself.
"""
from datetime import datetime
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import BigInteger, Column, Index, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

TURN_MODES = ("single_turn", "multi_turn")
DATASET_STATUSES = ("active", "archived")
CASE_TIERS = ("bronze", "silver")
CASE_STATUSES = ("draft", "in_review", "approved", "rejected", "archived")
VERSION_STATES = ("publishing", "published", "failed")
OBJECT_LAYERS = ("bronze", "silver", "gold", "fixtures", "artifacts")
OBJECT_STATES = ("pending", "stored", "verified", "missing", "corrupt", "deleted")
INGESTION_STATUSES = ("stored", "promoted", "failed")


class EvalDataset(SQLModel, table=True):
    """A named collection of test cases for one workflow, either single-turn or multi-turn."""

    __tablename__ = "eval_datasets"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    slug: str = Field(unique=True, index=True, max_length=80)
    name: str = Field(max_length=255)
    workflow: str = Field(index=True, max_length=60)          # e.g. individual-insurance
    turn_mode: str = Field(max_length=20)                      # single_turn | multi_turn
    description: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    status: str = Field(default="active", max_length=20)
    schema_version: str = Field(default="1.0", max_length=10)
    latest_version: Optional[str] = Field(default=None, max_length=20)
    created_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    archived_at: Optional[datetime] = None


class EvalIngestion(SQLModel, table=True):
    """One raw import or candidate batch (Bronze). The raw file is stored untouched."""

    __tablename__ = "eval_ingestions"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    dataset_id: UUID = Field(foreign_key="eval_datasets.id", index=True)
    source_type: str = Field(max_length=20)                    # import | synthetic | trace | manual
    source_ref: Optional[str] = Field(default=None, max_length=500)
    file_format: str = Field(max_length=10)                    # jsonl | json | csv
    filename: str = Field(max_length=255)
    object_key: str = Field(max_length=600)
    sha256: str = Field(max_length=64)
    size_bytes: int = Field(default=0, sa_column=Column(BigInteger, nullable=False))
    record_count: int = 0
    stored_count: int = 0
    rejected_count: int = 0
    status: str = Field(default="stored", max_length=20)
    silver_batch_id: Optional[UUID] = None
    created_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EvalCase(SQLModel, table=True):
    """A working test case. `content` is the case document (schema: shared/evaluation/case_schema.py) as JSONB, so a
    half-finished draft can be saved. Only a 'silver' case has passed validation."""

    __tablename__ = "eval_cases"
    __table_args__ = (
        UniqueConstraint("dataset_id", "case_key", name="uq_eval_case_key"),
        Index("ix_eval_cases_state", "dataset_id", "tier", "status"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    dataset_id: UUID = Field(foreign_key="eval_datasets.id", index=True)
    case_key: str = Field(max_length=80)                       # the case's own id, e.g. IND-LEAD-001
    tier: str = Field(default="bronze", max_length=10)         # bronze | silver
    status: str = Field(default="draft", max_length=20)        # draft | in_review | approved | rejected | archived
    revision: int = Field(default=1)
    content: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False))
    content_sha256: str = Field(max_length=64)
    dedupe_key: Optional[str] = Field(default=None, index=True, max_length=64)
    schema_version: Optional[str] = Field(default=None, max_length=10)
    category: Optional[str] = Field(default=None, index=True, max_length=60)
    scenario_type: Optional[str] = Field(default=None, max_length=30)
    difficulty: Optional[str] = Field(default=None, max_length=20)
    severity: Optional[str] = Field(default=None, max_length=20)
    validation_errors: Optional[list] = Field(default=None, sa_column=Column(JSONB, nullable=True))
    source_ingestion_id: Optional[UUID] = Field(default=None, foreign_key="eval_ingestions.id")
    approved_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    approved_at: Optional[datetime] = None
    approval_note: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    last_published_version: Optional[str] = Field(default=None, max_length=20)
    last_published_revision: Optional[int] = None
    created_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    updated_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class EvalFixture(SQLModel, table=True):
    """A synthetic fixture (applicant, document, payload) cases refer to by `fixture_key`. The object is stored under its
    own SHA-256, so changing a fixture adds a new object and never alters one a published version already pins."""

    __tablename__ = "eval_fixtures"
    __table_args__ = (UniqueConstraint("dataset_id", "fixture_key", name="uq_eval_fixture_key"),)

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    dataset_id: UUID = Field(foreign_key="eval_datasets.id", index=True)
    fixture_key: str = Field(max_length=120)
    kind: str = Field(default="payload", max_length=30)
    description: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    filename: str = Field(max_length=255)
    content_type: str = Field(max_length=120)
    sha256: str = Field(max_length=64)
    size_bytes: int = Field(default=0, sa_column=Column(BigInteger, nullable=False))
    object_key: str = Field(max_length=600)
    created_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class EvalDatasetVersion(SQLModel, table=True):
    """A Gold snapshot. 'publishing' while the upload runs, then 'published' for good, or 'failed' (kept for the audit
    trail; its objects are cleaned up). A published row never changes (see shared/evaluation/ddl.py)."""

    __tablename__ = "eval_dataset_versions"
    __table_args__ = (
        Index("uq_eval_dataset_version_live", "dataset_id", "version", unique=True, postgresql_where=text("state <> 'failed'")),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    dataset_id: UUID = Field(foreign_key="eval_datasets.id", index=True)
    version: str = Field(max_length=20)                        # MAJOR.MINOR.PATCH
    state: str = Field(default="publishing", max_length=20)
    schema_version: str = Field(max_length=10)
    case_count: int = 0
    fixture_count: int = 0
    snapshot_key: str = Field(max_length=600)
    snapshot_sha256: str = Field(max_length=64)
    snapshot_size_bytes: int = Field(default=0, sa_column=Column(BigInteger, nullable=False))
    manifest_key: str = Field(max_length=600)
    manifest_sha256: str = Field(max_length=64)
    dataset_sha256: str = Field(max_length=64)                 # fingerprint of every case and fixture hash
    parent_version: Optional[str] = Field(default=None, max_length=20)
    change_summary: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    approval: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False))
    stats: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False))
    published_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    started_at: datetime = Field(default_factory=datetime.utcnow)
    published_at: Optional[datetime] = None
    failure_reason: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))


class EvalVersionCase(SQLModel, table=True):
    """Index of the cases in a published version (search and filtering without reading MinIO). The case documents
    themselves are in the snapshot object."""

    __tablename__ = "eval_version_cases"
    __table_args__ = (UniqueConstraint("version_id", "case_key", name="uq_eval_version_case"),)

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    version_id: UUID = Field(foreign_key="eval_dataset_versions.id", index=True)
    case_key: str = Field(max_length=80)
    revision: int = 1
    content_sha256: str = Field(max_length=64)
    line_no: int = 0
    category: Optional[str] = Field(default=None, index=True, max_length=60)
    scenario_type: Optional[str] = Field(default=None, max_length=30)
    difficulty: Optional[str] = Field(default=None, max_length=20)
    severity: Optional[str] = Field(default=None, max_length=20)
    verification: Optional[str] = Field(default=None, max_length=30)


class EvalStorageObject(SQLModel, table=True):
    """Registry of every object the lake wrote to MinIO, with the checksum it must still have."""

    __tablename__ = "eval_storage_objects"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    object_key: str = Field(unique=True, index=True, max_length=600)
    layer: str = Field(index=True, max_length=20)              # bronze | silver | gold | fixtures | artifacts
    kind: str = Field(max_length=30)                           # raw | report | cases | manifest | fixture | artifact
    sha256: str = Field(max_length=64)
    size_bytes: int = Field(default=0, sa_column=Column(BigInteger, nullable=False))
    content_type: Optional[str] = Field(default=None, max_length=120)
    dataset_id: Optional[UUID] = Field(default=None, foreign_key="eval_datasets.id", index=True)
    version_id: Optional[UUID] = Field(default=None, foreign_key="eval_dataset_versions.id", index=True)
    ingestion_id: Optional[UUID] = Field(default=None, foreign_key="eval_ingestions.id")
    state: str = Field(default="pending", max_length=20)
    storage_version_id: Optional[str] = Field(default=None, max_length=200)
    retain_until: Optional[datetime] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    verified_at: Optional[datetime] = None
