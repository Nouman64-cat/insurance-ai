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

from sqlalchemy import JSON, BigInteger, Boolean, CheckConstraint, Column, Float, Index, Text, UniqueConstraint, text
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
RUN_STATES = ("ingesting", "complete", "failed")
RESULT_STATUSES = ("passed", "failed", "blocked", "skipped", "infrastructure_error")
RUN_KINDS = ("suite", "benchmark_agent", "benchmark_direct")
JOB_STATES = ("queued", "running", "cancel_requested", "finished", "failed", "cancelled")
REGISTRY_TYPES = ("plan", "calc", "rule", "workflow", "gate", "access", "message", "template", "form")
DRIFT_STATES = ("open", "in_review", "accepted", "rejected", "dismissed", "cleared")
DRIFT_DECIDED = ("accepted", "rejected", "dismissed")


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


class EvalRun(SQLModel, table=True):
    """One evaluation run: which published dataset version was run, how, and the totals. The isolated evaluation worker writes a
    run folder; the platform ingests it here and in MinIO (shared/evaluation/runs.py). 'ingesting' while the rows are written, then
    'complete' for good: the triggers in shared/evaluation/ddl.py refuse any change to a complete run and its results."""

    __tablename__ = "eval_runs"
    __table_args__ = (Index("ix_eval_runs_dataset_started", "dataset_slug", "started_at"),)

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    run_id: str = Field(unique=True, index=True, max_length=60)             # the worker's own id: <timestamp>-<random>
    dataset_id: Optional[UUID] = Field(default=None, foreign_key="eval_datasets.id", index=True)
    version_id: Optional[UUID] = Field(default=None, foreign_key="eval_dataset_versions.id", index=True)
    dataset_slug: Optional[str] = Field(default=None, max_length=80)
    dataset_version: Optional[str] = Field(default=None, max_length=20)
    snapshot_sha256: Optional[str] = Field(default=None, max_length=64)
    dataset_sha256: Optional[str] = Field(default=None, max_length=64)
    data_verified: bool = False                                              # the worker re-checked the bundle against the published manifest
    suite: str = Field(default="technical", max_length=20)
    repetitions: int = 1
    model_label: Optional[str] = Field(default=None, max_length=120)         # provider/model under test, when the run used one
    synthetic_model: bool = False                                            # the model was a scripted stand-in: not a quality result
    state: str = Field(default="ingesting", index=True, max_length=20)
    cancelled: bool = False
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    selected_cases: int = 0
    executions: int = 0
    passed: int = 0
    failed: int = 0
    blocked: int = 0
    skipped: int = 0
    infrastructure_errors: int = 0
    pass_rate: Optional[float] = None
    known_cost_usd: float = 0.0
    unknown_cost_executions: int = 0
    budget_usd: Optional[float] = None
    summary: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False))
    # Step 7 to 9: what was run and with what. Recorded exactly, so two runs can be compared fairly.
    kind: str = Field(default="suite", max_length=20)                        # suite | benchmark_agent | benchmark_direct
    group_id: Optional[str] = Field(default=None, index=True, max_length=60)  # runs compared together (a benchmark, a skills on/off pair)
    config: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))
    provider: Optional[str] = Field(default=None, max_length=30)
    model_id: Optional[str] = Field(default=None, index=True, max_length=120)
    skills_enabled: Optional[bool] = None
    prompt_version: Optional[str] = Field(default=None, max_length=60)
    judge_model: Optional[str] = Field(default=None, max_length=120)
    pricing_version_id: Optional[UUID] = Field(default=None, foreign_key="eval_pricing_versions.id")
    estimated_usd: Optional[float] = None                                    # the pre-run estimate; the actual cost is computed from usage
    job_id: Optional[UUID] = Field(default=None, index=True)
    summary_key: Optional[str] = Field(default=None, max_length=600)
    report_key: Optional[str] = Field(default=None, max_length=600)
    results_key: Optional[str] = Field(default=None, max_length=600)
    ingested_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    ingested_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EvalCaseResult(SQLModel, table=True):
    """One execution of one case in a run (a case run three times has three rows). `cost_usd` is None when a model was used but its
    cost could not be established; it is never 0 for "not measured"."""

    __tablename__ = "eval_case_results"
    __table_args__ = (UniqueConstraint("run_row_id", "case_key", "repetition", name="uq_eval_case_result"),)

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    run_row_id: UUID = Field(foreign_key="eval_runs.id", index=True)
    case_key: str = Field(index=True, max_length=80)
    category: Optional[str] = Field(default=None, index=True, max_length=60)
    operation: Optional[str] = Field(default=None, max_length=60)
    verification: Optional[str] = Field(default=None, max_length=30)
    repetition: int = 1
    status: str = Field(index=True, max_length=24)
    reason: Optional[str] = Field(default=None, max_length=200)
    latency_ms: Optional[int] = None
    score: Optional[float] = None
    cost_usd: Optional[float] = None
    cost_known: bool = True
    usage: Optional[dict] = Field(default=None, sa_column=Column(JSONB, nullable=True))
    assertion_counts: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False))
    error: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    artifact_key: Optional[str] = Field(default=None, max_length=600)
    artifact_sha256: Optional[str] = Field(default=None, max_length=64)
    # Step 7 to 9
    model_id: Optional[str] = Field(default=None, max_length=120)
    input_tokens: Optional[int] = None                                        # None = not measured (never 0 for unknown)
    output_tokens: Optional[int] = None
    cached_tokens: Optional[int] = None
    llm_calls: Optional[int] = None
    judge_cost_usd: Optional[float] = None
    retry_usage: Optional[list] = Field(default=None, sa_column=Column(JSONB, nullable=True))     # the ledger usage of the earlier attempts that failed and were run again
    ttft_ms: Optional[int] = None                                             # time to first token, where the stream reports it
    turns: Optional[int] = None
    critical_failed: bool = False
    layer_scores: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))
    verdict: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))
    trace_summary: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))
    trace_key: Optional[str] = Field(default=None, max_length=600)
    trace_sha256: Optional[str] = Field(default=None, max_length=64)


class EvalAssertionResult(SQLModel, table=True):
    """The outcome of one assertion of one execution (all of them, taken from the stored artifact)."""

    __tablename__ = "eval_assertion_results"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    result_id: UUID = Field(foreign_key="eval_case_results.id", index=True)
    assertion_id: str = Field(max_length=60)
    kind: str = Field(max_length=30)
    target: Optional[str] = Field(default=None, max_length=300)
    severity: str = Field(max_length=10)
    status: str = Field(index=True, max_length=10)                          # passed | failed | error
    method: str = Field(default="exact", max_length=12)
    message: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    expected: Optional[dict] = Field(default=None, sa_column=Column(JSONB, nullable=True))   # {"value": ...}: JSONB holds any JSON value
    actual: Optional[dict] = Field(default=None, sa_column=Column(JSONB, nullable=True))


class EvalMetricScore(SQLModel, table=True):
    """One DeepEval (or deterministic) metric score of one execution, with the judge that produced it. Immutable with its run."""

    __tablename__ = "eval_metric_scores"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    result_id: UUID = Field(foreign_key="eval_case_results.id", index=True)
    metric: str = Field(max_length=40)                                         # correctness | faithfulness | relevance | hallucination | ...
    layer: Optional[str] = Field(default=None, max_length=4)
    criterion_id: Optional[str] = Field(default=None, max_length=60)
    score: Optional[float] = None                                              # None: the judge could not score (blocked), never a made-up 0
    threshold: Optional[float] = None
    passed: Optional[bool] = None
    status: str = Field(default="scored", max_length=20)                       # scored | blocked_missing_credentials | judge_error
    reason: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    judge_model: Optional[str] = Field(default=None, max_length=120)
    judge_cost_usd: Optional[float] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None


class EvalJob(SQLModel, table=True):
    """A requested evaluation run. Mutable while it lives (queued, running, cancel_requested); the immutable record of what it
    produced is the EvalRun it ends with. The isolated evaluation stack never talks to the platform: a worker on the host claims
    jobs here, drives the stack, streams progress back as EvalJobEvent rows and hands the finished run folder to the ingestion."""

    __tablename__ = "eval_jobs"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    state: str = Field(default="queued", index=True, max_length=20)
    config: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False))
    estimate: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))
    progress: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))
    cancel_requested: bool = False
    run_id: Optional[str] = Field(default=None, max_length=60)
    error: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    worker_id: Optional[str] = Field(default=None, max_length=80)
    heartbeat_at: Optional[datetime] = None
    created_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None


class EvalJobEvent(SQLModel, table=True):
    """The live log of a job: what the monitor streams. Append-only."""

    __tablename__ = "eval_job_events"
    __table_args__ = (UniqueConstraint("job_id", "seq", name="uq_eval_job_event_seq"),)

    id: Optional[int] = Field(default=None, sa_column=Column(BigInteger, primary_key=True, autoincrement=True))
    job_id: UUID = Field(foreign_key="eval_jobs.id", index=True)
    seq: int
    at: datetime = Field(default_factory=datetime.utcnow)
    kind: str = Field(max_length=20)                                           # log | case | progress | cost | state
    message: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    data: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))


# ── Tables that belong to the Evaluation Costs module. Mapped here exactly as they exist in the platform database (no column
# added or changed), so the run ingestion can price a run with the active versioned rates and write per-case cost records. ──

class EvalPricingVersion(SQLModel, table=True):
    __tablename__ = "eval_pricing_versions"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    label: str = Field(max_length=200)
    rates: dict = Field(sa_column=Column(JSON, nullable=False))             # {"gpt-4o-mini": {"input": 0.15, "cached": 0.075, "output": 0.6}} per million tokens
    default_rate: dict = Field(sa_column=Column(JSON, nullable=False))
    source_notes: Optional[str] = Field(default=None, max_length=1000)
    content_hash: str = Field(max_length=64)
    is_active: bool = Field(default=False, sa_column=Column(Boolean, nullable=False))
    created_by: Optional[UUID] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EvalCostRecord(SQLModel, table=True):
    __tablename__ = "eval_cost_records"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    run_id: str = Field(max_length=100)
    case_id: str = Field(max_length=100)
    models: list = Field(sa_column=Column(JSON, nullable=False))
    tokens: dict = Field(sa_column=Column(JSON, nullable=False))
    judge_tokens: dict = Field(sa_column=Column(JSON, nullable=False))
    calls: int = 0
    llm_cost_usd: float = 0.0
    judge_cost_usd: float = 0.0
    total_cost_usd: float = 0.0
    pricing_version_id: UUID = Field(foreign_key="eval_pricing_versions.id")
    cost_basis: str = Field(max_length=12)       # as the table exists in the platform database: calculated | none | unknown
    created_by: Optional[UUID] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


# ── Phase 5: the model registry and benchmarks ──

MODEL_PROVIDERS = ("openai", "gemini", "anthropic", "mock")
MODEL_STATUSES = ("active", "deprecated", "disabled")
MODEL_ROLES = ("candidate", "judge")
BENCHMARK_MODES = ("agent", "direct")


class EvalModel(SQLModel, table=True):
    """A model the evaluation platform knows about: who provides it, what it can do, how it is configured, and (through its price history
    and the benchmarks that used it) what it costs and how it performed. `mock` models are scripted stand-ins of the evaluation stack
    (synthetic): they exist so the harness can be tested, and never carry a quality claim."""

    __tablename__ = "eval_models"
    __table_args__ = (UniqueConstraint("provider", "model_id", name="uq_eval_models_provider_model"),)

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    provider: str = Field(max_length=20, index=True)
    model_id: str = Field(max_length=120)
    display_name: str = Field(max_length=160)
    status: str = Field(default="active", max_length=12, index=True)
    synthetic: bool = False
    roles: list = Field(default_factory=lambda: ["candidate"], sa_column=Column(JSONB, nullable=False, server_default=text("'[\"candidate\"]'::jsonb")))
    capabilities: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))
    configuration: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))
    notes: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    created_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class EvalModelPrice(SQLModel, table=True):
    """Price history of a model, per million tokens. Append-only: a change of price is a new row with its own effective date and source,
    so an old run can always be priced with the rates of its day."""

    __tablename__ = "eval_model_prices"
    __table_args__ = (Index("ix_eval_model_prices_model_effective", "model_row_id", "effective_from"),)

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    model_row_id: UUID = Field(foreign_key="eval_models.id", index=True)
    input_per_m: float
    cached_per_m: float
    output_per_m: float
    effective_from: datetime = Field(default_factory=datetime.utcnow)
    source: str = Field(max_length=300)                                       # where the figure comes from; a price without a source is refused
    created_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EvalBenchmark(SQLModel, table=True):
    """A benchmark: the same cases, fixtures, prompts and permissions run against several models. The runs are `eval_runs` rows sharing the
    benchmark's `group_id`; this row is the comparison itself, with the exact configuration it was run under and the evidence behind any
    claim that one model is better."""

    __tablename__ = "eval_benchmarks"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    benchmark_id: str = Field(unique=True, index=True, max_length=60)        # also the group_id of its runs
    mode: str = Field(max_length=10)                                          # agent | direct
    dataset_slug: Optional[str] = Field(default=None, max_length=80)
    dataset_version: Optional[str] = Field(default=None, max_length=20)
    models: list = Field(default_factory=list, sa_column=Column(JSONB, nullable=False, server_default=text("'[]'::jsonb")))
    repetitions: int = 1
    judge_model: Optional[str] = Field(default=None, max_length=120)
    judge_version: Optional[str] = Field(default=None, max_length=60)
    synthetic: bool = False
    complete: bool = True                                                     # false when some model was blocked or the run was cancelled
    config: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))
    summary: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))
    report_key: Optional[str] = Field(default=None, max_length=600)
    created_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)


# ── Phase 6: the change registry and the review queue (docs/evaluation/phase-6-change-registry-plan.md) ─────────────────────

class EvalRegistryItem(SQLModel, table=True):
    """Something a golden case depends on, and which can change: a plan, a calculation, a rule, a workflow, a template. One row per item;
    its history is the `eval_registry_versions` rows."""

    __tablename__ = "eval_registry_items"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    item_key: str = Field(unique=True, index=True, max_length=160)           # for example plan:term-life-secure, template:proposal
    item_type: str = Field(index=True, max_length=20)
    title: str = Field(max_length=200)
    source: Optional[str] = Field(default=None, max_length=300)              # where it is read from, so a reviewer can find it
    status: str = Field(default="active", max_length=12)                     # active | retired
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EvalRegistryVersion(SQLModel, table=True):
    """One recorded state of a registry item. Append-only: history is never edited or deleted (trigger in shared/evaluation/ddl.py). A new row
    is written only when the fingerprint differs from the last one."""

    __tablename__ = "eval_registry_versions"
    __table_args__ = (UniqueConstraint("item_id", "version", name="uq_eval_registry_item_version"),)

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    item_id: UUID = Field(foreign_key="eval_registry_items.id", index=True)
    version: int
    fingerprint: str = Field(max_length=64)
    previous_fingerprint: Optional[str] = Field(default=None, max_length=64)
    summary: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))   # a readable rendering, for the difference view
    captured_from: str = Field(default="scan", max_length=20)                # scan | publish | manual
    captured_at: datetime = Field(default_factory=datetime.utcnow)


class EvalCaseDependency(SQLModel, table=True):
    """What a case of a published dataset version depends on (its `depends_on` list), indexed so that a changed item finds its cases without
    reading the lake."""

    __tablename__ = "eval_case_dependencies"
    __table_args__ = (UniqueConstraint("dataset_slug", "dataset_version", "case_key", "item_key", name="uq_eval_case_dependency"),
                      Index("ix_eval_case_dependencies_item", "item_key"))

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    dataset_slug: str = Field(max_length=80)
    dataset_version: str = Field(max_length=20)
    case_key: str = Field(max_length=80)
    item_key: str = Field(max_length=160)


class EvalDriftScan(SQLModel, table=True):
    """One scan of a dataset: what was compared, how many findings, and where the full report is. Append-only."""

    __tablename__ = "eval_drift_scans"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    scan_id: str = Field(unique=True, index=True, max_length=60)
    dataset_slug: Optional[str] = Field(default=None, max_length=80)
    dataset_version: Optional[str] = Field(default=None, max_length=20)
    source: str = Field(default="published", max_length=12)                  # published | working
    compared: Optional[dict] = Field(default=None, sa_column=Column(JSONB, nullable=True))     # {baseline_run, current_run} when two runs were compared
    counts: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))
    summary: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))
    report_key: Optional[str] = Field(default=None, max_length=600)
    job_id: Optional[UUID] = Field(default=None, index=True)
    created_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EvalDriftItem(SQLModel, table=True):
    """A review item: a finding (or a suggested case) and what a person decided about it. The same problem found by two scans is one row
    (`finding_key`). The database enforces the review rules: a decision needs a named person and a written reason, and an item whose
    acceptance produces a new case needs an expected value written by that person."""

    __tablename__ = "eval_drift_items"
    __table_args__ = (
        CheckConstraint("state IN ('open','in_review','accepted','rejected','dismissed','cleared')", name="ck_eval_drift_state"),
        CheckConstraint("state NOT IN ('accepted','rejected','dismissed') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_note IS NOT NULL "
                        "AND length(btrim(decision_note)) > 0)", name="ck_eval_drift_decision_needs_person_and_reason"),
        CheckConstraint("state <> 'accepted' OR kind NOT IN ('proposal','rule_changed','unconfirmed','coverage_gap') OR expected IS NOT NULL",
                        name="ck_eval_drift_accept_needs_expected"),
        CheckConstraint("expected IS NULL OR COALESCE(expected_source, '') = 'reviewer'", name="ck_eval_drift_expected_is_reviewers"),   # NULL would pass a plain =, so it is coalesced
        Index("ix_eval_drift_items_state_kind", "state", "kind"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    finding_key: str = Field(unique=True, index=True, max_length=80)
    kind: str = Field(max_length=24)
    severity: str = Field(default="medium", max_length=10)
    state: str = Field(default="open", max_length=12)
    summary: str = Field(sa_column=Column(Text, nullable=False))
    dataset_slug: Optional[str] = Field(default=None, max_length=80)
    affected_cases: list = Field(default_factory=list, sa_column=Column(JSONB, nullable=False, server_default=text("'[]'::jsonb")))
    detail: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))
    registry_item_key: Optional[str] = Field(default=None, max_length=160)
    from_version: Optional[int] = None
    to_version: Optional[int] = None
    first_scan_id: Optional[str] = Field(default=None, max_length=60)
    last_scan_id: Optional[str] = Field(default=None, max_length=60)
    times_seen: int = 1
    opened_at: datetime = Field(default_factory=datetime.utcnow)
    last_seen_at: datetime = Field(default_factory=datetime.utcnow)
    cleared_at: Optional[datetime] = None
    assigned_to: Optional[UUID] = Field(default=None, foreign_key="users.id")
    decided_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    decided_at: Optional[datetime] = None
    decision_note: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    expected: Optional[dict] = Field(default=None, sa_column=Column(JSONB(none_as_null=True), nullable=True))     # none_as_null: no value is SQL NULL, not the JSON text null
    expected_source: Optional[str] = Field(default=None, max_length=12)      # always 'reviewer': the system never writes an expected value


class EvalDriftEvent(SQLModel, table=True):
    """Every change of a review item: who, when, from which state to which, and why. Append-only: it is the audit trail of the review."""

    __tablename__ = "eval_drift_events"

    id: Optional[int] = Field(default=None, sa_column=Column(BigInteger, primary_key=True, autoincrement=True))
    drift_item_id: UUID = Field(foreign_key="eval_drift_items.id", index=True)
    at: datetime = Field(default_factory=datetime.utcnow)
    from_state: Optional[str] = Field(default=None, max_length=12)
    to_state: str = Field(max_length=12)
    actor_kind: str = Field(default="user", max_length=8)                   # user | system (a scan opening, reopening or clearing an item)
    actor_id: Optional[UUID] = Field(default=None, foreign_key="users.id")
    note: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    data: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))


# ── Phase 7: cost intelligence. Money is recorded once, in USD, as an append-only line that says WHAT it paid for, how sure we are, and where the
# number came from. Budgets and exchange rates are append-only too: the current one is the latest row, and every change keeps who and why. ──

COST_COMPONENTS = ("candidate_llm", "agent_llm", "subagent_llm", "judge", "ocr", "embedding", "retry", "fallback", "unattributed", "self_hosted")
COST_KINDS = ("confirmed", "estimated", "unknown")
COST_UNITS = ("tokens", "pages", "calls", "gpu_seconds", "cpu_seconds")
BUDGET_PERIODS = ("day", "month")


class EvalExchangeRate(SQLModel, table=True):
    """How many units of a currency one US dollar was worth, from a given moment, with where the number came from. Reports convert at the rate
    in force at the time the cost was incurred, never at today's rate. Append-only."""

    __tablename__ = "eval_exchange_rates"
    __table_args__ = (
        CheckConstraint("units_per_usd > 0", name="ck_eval_exchange_rate_positive"),
        CheckConstraint("currency ~ '^[A-Z]{3}$'", name="ck_eval_exchange_rate_currency"),
        CheckConstraint("length(btrim(source)) > 0", name="ck_eval_exchange_rate_source"),
        Index("ix_eval_exchange_rates_currency_from", "currency", "effective_from"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    currency: str = Field(max_length=3)
    units_per_usd: float
    effective_from: datetime
    source: str = Field(sa_column=Column(Text, nullable=False))
    recorded_by: UUID = Field(foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EvalBudgetLimit(SQLModel, table=True):
    """A spending limit for evaluations over a day or a month (UTC). `limit_usd` NULL means no limit. Append-only: a change is a new row, so the
    history of who set what, when and why is the table itself."""

    __tablename__ = "eval_budget_limits"
    __table_args__ = (
        CheckConstraint("period IN ('day','month')", name="ck_eval_budget_period"),
        CheckConstraint("limit_usd IS NULL OR limit_usd >= 0", name="ck_eval_budget_limit"),
        CheckConstraint("warn_at_pct BETWEEN 1 AND 100", name="ck_eval_budget_warn"),
        CheckConstraint("length(btrim(reason)) > 0", name="ck_eval_budget_reason"),
        Index("ix_eval_budget_limits_period_from", "period", "effective_from"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    period: str = Field(max_length=5)
    limit_usd: Optional[float] = None
    warn_at_pct: int = 80
    enforce: bool = Field(default=True, sa_column=Column(Boolean, nullable=False, server_default=text("true")))    # true: a job that would pass the limit is refused
    effective_from: datetime = Field(default_factory=datetime.utcnow)
    set_by: UUID = Field(foreign_key="users.id")
    reason: str = Field(sa_column=Column(Text, nullable=False))
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EvalCostLine(SQLModel, table=True):
    """One piece of spending: what it paid for (`component`), how much was used, what it cost, and how sure we are (`cost_kind`).
    confirmed = the provider reported or billed it; estimated = computed from usage and a recorded price; unknown = used but cannot be priced
    (usd is then NULL, never 0). A ledger row can be attributed to a component only once (`usage_ref`), which is what prevents double counting.
    Append-only: a correction is a new line, never an edit."""

    __tablename__ = "eval_cost_lines"
    __table_args__ = (
        CheckConstraint("component IN ('candidate_llm','agent_llm','subagent_llm','judge','ocr','embedding','retry','fallback','unattributed','self_hosted')", name="ck_eval_cost_component"),
        CheckConstraint("cost_kind IN ('confirmed','estimated','unknown')", name="ck_eval_cost_kind"),
        CheckConstraint("unit_kind IN ('tokens','pages','calls','gpu_seconds','cpu_seconds')", name="ck_eval_cost_unit"),
        CheckConstraint("(cost_kind = 'unknown') = (usd IS NULL)", name="ck_eval_cost_unknown_has_no_amount"),
        CheckConstraint("usd IS NULL OR usd >= 0", name="ck_eval_cost_usd"),
        Index("uq_eval_cost_line_usage", "usage_ref", "component", unique=True, postgresql_where=text("usage_ref IS NOT NULL")),
        Index("ix_eval_cost_lines_run", "run_id"),
        Index("ix_eval_cost_lines_at", "incurred_at"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    run_id: Optional[str] = Field(default=None, max_length=100)
    case_id: Optional[str] = Field(default=None, max_length=100)
    repetition: int = 1
    job_id: Optional[UUID] = None
    component: str = Field(max_length=20)
    provider: Optional[str] = Field(default=None, max_length=20)
    model: Optional[str] = Field(default=None, max_length=120)
    unit_kind: str = Field(default="tokens", max_length=12)
    input_units: float = 0
    output_units: float = 0
    cached_units: float = 0
    usd: Optional[float] = None
    cost_kind: str = Field(max_length=10)
    source: str = Field(sa_column=Column(Text, nullable=False))               # where the number came from: "ledger row + registry price v3", "provider response", ...
    usage_ref: Optional[str] = Field(default=None, max_length=80)             # a hash of what this line pays for (run, case, repetition, component, service, model, attempt): recorded once
    pricing_version_id: Optional[UUID] = None
    rate_ref: Optional[UUID] = None                                           # the exchange rate recorded for this line, when a second currency is shown
    incurred_at: datetime = Field(default_factory=datetime.utcnow)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EvalProviderStatement(SQLModel, table=True):
    """What a provider billed (or reported as used) for a period, typed in by a person, to be compared with what we recorded. Append-only: a
    correction is a new statement that names the one it replaces."""

    __tablename__ = "eval_provider_statements"
    __table_args__ = (
        CheckConstraint("billed_usd >= 0", name="ck_eval_statement_amount"),
        CheckConstraint("period_end >= period_start", name="ck_eval_statement_period"),
        CheckConstraint("length(btrim(source)) > 0", name="ck_eval_statement_source"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    provider: str = Field(max_length=20)
    period_start: datetime
    period_end: datetime
    billed_usd: float
    reference: Optional[str] = Field(default=None, max_length=120)            # invoice number, dashboard export name
    source: str = Field(sa_column=Column(Text, nullable=False))               # "typed from the OpenAI usage page", "uploaded CSV", ...
    billed_input_tokens: Optional[int] = Field(default=None, sa_column=Column(BigInteger, nullable=True))        # the token totals the provider's page shows, when it shows them
    billed_output_tokens: Optional[int] = Field(default=None, sa_column=Column(BigInteger, nullable=True))
    billed_cached_tokens: Optional[int] = Field(default=None, sa_column=Column(BigInteger, nullable=True))
    tolerance_pct: float = Field(default=5.0, sa_column=Column(Float, nullable=False, server_default=text("5")))      # how far the recorded figure may be from the bill and still match
    tolerance_usd: float = Field(default=0.05, sa_column=Column(Float, nullable=False, server_default=text("0.05")))
    supersedes_id: Optional[UUID] = Field(default=None, foreign_key="eval_provider_statements.id")
    entered_by: UUID = Field(foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)


class EvalReconciliation(SQLModel, table=True):
    """One comparison of a provider statement with the cost lines of its period, kept as it was when it was made, with who asked for it and any explanation they
    wrote. Append-only: the live comparison is always recomputed from the lines; this table is the record of what was looked at and said."""

    __tablename__ = "eval_reconciliations"
    __table_args__ = (
        CheckConstraint("status IN ('matched','under_recorded','over_recorded','incomplete')", name="ck_eval_reconciliation_status"),
        Index("ix_eval_reconciliations_statement", "statement_id", "created_at"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    statement_id: UUID = Field(foreign_key="eval_provider_statements.id")
    status: str = Field(max_length=16)
    billed_usd: float
    recorded_usd: float
    difference_usd: float
    difference_pct: float
    unknown_lines: int = 0
    line_count: int = 0
    note: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))                             # what the person says explains a difference
    detail: dict = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")))   # tokens, components, the explanation
    performed_by: UUID = Field(foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
