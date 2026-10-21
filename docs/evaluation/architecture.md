# AI Evaluation Platform: architecture

The platform evaluates the agents of the Individual Insurance workflow against versioned Golden Datasets and compares
LLMs on the same data. It is built stage by stage; this note records what exists and how Stage 1 (the data lake) works.

## What was in the repository before Stage 1

| Area | Finding |
|---|---|
| Evaluation code | None. `evals/`, `docs/evaluation/` and `super-admin/evaluation-costs/` were empty folders left by a revert. |
| MinIO / DeepEval | Not present anywhere. Object storage was AWS S3 through boto3, with a local-disk fallback (`routers/artifacts.py`). |
| Reusable | tenant-service migrations (`migrate.py`), shared models (`shared/models`), SuperAdmin auth (`require_roles`), gateway proxies, token metering (`token_usage`, `services/usage_meter.py`), the chat agent's skills ON/OFF switch (`PlatformAgentConfig`), unittest conventions, the Super Admin sidebar. |
| Agents under test | `chat-agent` (LangGraph: coordinator, specialists, skills, tools, permission gate), `risk-engine`, `ocr-engine`, `text-summarizer`. Model choice and fallback come from the SuperAdmin LLM configuration. |

## Where each stage lives

| Stage | Lives in |
|---|---|
| 1. Data lake (this stage) | `shared/evaluation/` (library), `shared/models/evaluation.py` (tables), `tenant-service/services/eval_lake.py`, `eval_lake_cli.py`, the `minio` service |
| 2. Golden cases | Data in PostgreSQL and MinIO, created through the lake. Generation and verification utilities in Python, never the records. |
| 3. Dataset Manager | tenant-service routers under `/platform/evaluation/...` (proxied by the gateway) and Super Admin pages in `frontend` |
| 4-5. Harness and benchmarking | An evaluation runner using the lake to load a published version; DeepEval metrics; results and traces back into PostgreSQL and MinIO `artifacts/` |
| 6-8. Drift, cost, Evaluation Center | Built on the same tables and the existing token usage records |

## Stage 1: the data lake

**Layers.** Bronze is what came in, untouched. Silver is what passed validation. Gold is what was approved and published.

| Layer | PostgreSQL | MinIO |
|---|---|---|
| Bronze | `eval_ingestions`; each record is an `eval_cases` row with `tier = bronze` | `bronze/<source>/<yyyy>/<mm>/<dd>/<ingestion>/raw/<file>` and `report.json` |
| Silver | `eval_cases` rows with `tier = silver` (JSONB content, checksum, input fingerprint) | `silver/<workflow>/<dataset>/<batch>/cases.jsonl`, `rejects.json`, `report.json` |
| Gold | `eval_dataset_versions`, `eval_version_cases` (index) | `gold/<workflow>/<dataset>/<version>/cases.jsonl` and `manifest.json` |
| Fixtures | `eval_fixtures` | `fixtures/<sha256[:2]>/<sha256>/<file>`, addressed by content |
| Artifacts | later stages | `artifacts/<run>/<name>` |

`eval_storage_objects` registers every object with the checksum it must keep. Single-turn and multi-turn cases are
separate datasets (`eval_datasets.turn_mode`). Workflows and their categories are listed in `workflows.py`.

**Formats.** JSONL is the exchange and snapshot format (one canonical case per line). JSON accepts an array or
`{"cases": [...]}`. CSV keeps identifying fields as columns and structured fields as JSON text, so it round-trips.
Draft content is JSONB. Cell values that look like spreadsheet formulas are guarded on CSV export.

**The case document** is `shared/evaluation/case_schema.py` (schema 1.0; `eval_lake_cli.py schema` prints the JSON
Schema). Message text and payloads are kept exactly as written, since adversarial input is the point of many cases. Each
case records its `source.verification`: `code_verified`, `independently_verified`, `business_approved` or
`pending_domain_approval`. Whatever a file says about approval is ignored; approval comes from the review record.

**Bronze to Silver.** Identifying fields are tidied, the document is validated against the schema, must match the
dataset's workflow and turn mode, must be filed under its own id, and must not send the same input as another case
(case and spacing ignored). Failures stay Bronze with their errors. Editing a case sends it back to Bronze and draft.

**Publishing** (`DataLake.publish`), because MinIO and PostgreSQL cannot commit together:

1. One transaction with the dataset row locked: re-check every approved case (schema, checksum, approver), check fixtures
   exist, build the snapshot and manifest in memory, and record the version as `publishing` with the checksums it must have.
2. Upload `cases.jsonl`, then `manifest.json`. Nothing is overwritten; identical existing content is adopted. Both are read
   back and compared, fixtures are checked, and every object is put under object lock.
3. One transaction: add the case index, mark the version `published`, set the dataset's latest version.

A failure before step 3 marks the version `failed` and removes what the attempt created, so the same version number can be
tried again. A crash after the objects are locked leaves it `publishing`; `reconcile()` (also run at tenant-service
start) completes it if the objects verify, or fails it and cleans up. Versions must increase (`1.0.0`, `1.1.0`...).

**Immutability, three ways.** MinIO object lock (governance mode by default) on gold objects and the fixtures they pin;
write-once puts that refuse to replace different content; and database triggers (`shared/evaluation/ddl.py`) that reject
any UPDATE or DELETE of a published version or its case index. `load_version` re-checks the manifest, snapshot and every
case against their checksums and raises if anything differs, so an evaluation never runs on altered data.

## Configuration

`.env` (see `.env.example`): `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `EVAL_LAKE_BUCKET`, `EVAL_LAKE_RETENTION_MODE`
(`GOVERNANCE`, `COMPLIANCE` or `NONE`), `EVAL_LAKE_RETENTION_DAYS`. The bucket is created with object lock and
versioning on first use. Object lock can only be enabled when a bucket is created, so choose the mode before first start.
The MinIO image tag can be overridden with `MINIO_IMAGE`.

## Commands and tests

```
docker compose up -d minio
docker compose up -d --build tenant-service
docker compose exec tenant-service python eval_lake_cli.py init
docker compose exec tenant-service python eval_lake_cli.py smoke

docker compose exec -T tenant-service python test_eval_lake_pure.py
docker compose exec -T tenant-service python test_eval_lake_publish.py
docker compose exec -T tenant-service python test_migrations.py
```

The full command list is in the header of `eval_lake_cli.py`.
