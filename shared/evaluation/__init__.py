"""The evaluation data lake: MinIO-backed Bronze / Silver / Gold datasets for the AI evaluation platform.

Modules (import what you need; nothing here connects to MinIO or the database on import):
  config        settings read from the environment
  canonical     canonical JSON, JSONL and SHA-256 helpers
  keys          the object key layout inside the bucket
  workflows     which workflows (and their categories) datasets can cover
  case_schema   the Golden case document and its validation
  formats       JSONL / JSON / CSV import and export
  validation    the Bronze -> Silver pipeline (clean, validate, de-duplicate)
  object_store  the MinIO (S3) client and an in-memory twin for tests
  lake          DataLake: ingest, promote, fixtures, publish, load, verify, reconcile

See docs/evaluation/architecture.md.
"""
