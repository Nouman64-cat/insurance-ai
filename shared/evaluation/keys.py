"""Where each object lives in the bucket.

  bronze/<source>/<yyyy>/<mm>/<dd>/<ingestion_id>/raw/<file>      raw import, stored as received
  bronze/<source>/.../<ingestion_id>/report.json                   what could not be read
  silver/<workflow>/<dataset>/<batch_id>/cases.jsonl               cleaned, validated cases of one promotion run
  silver/<workflow>/<dataset>/<batch_id>/rejects.json
  silver/<workflow>/<dataset>/<batch_id>/report.json
  gold/<workflow>/<dataset>/<version>/cases.jsonl                  the published snapshot
  gold/<workflow>/<dataset>/<version>/manifest.json                written last: its presence marks a complete snapshot
  fixtures/<sha256[:2]>/<sha256>/<file>                            synthetic fixtures, addressed by content
  artifacts/<run_id>/<name>                                        large execution artifacts (traces, outputs)
"""
from __future__ import annotations

import re
from datetime import datetime
from uuid import UUID

_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$")
_VERSION = re.compile(r"^\d+\.\d+\.\d+$")


def check_slug(value: str, what: str = "name") -> str:
    if not isinstance(value, str) or not _SLUG.match(value):
        raise ValueError(f"{what} {value!r} must be 3-80 lower-case letters, digits or hyphens, starting and ending with a letter or digit")
    return value


def safe_name(name: str) -> str:
    """A file name safe to put in an object key: letters, digits, dot, dash and underscore only."""
    base = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", base).lstrip(".")
    cleaned = cleaned[:120]
    if not cleaned:
        raise ValueError("file name is empty after cleaning")
    return cleaned


def bronze_prefix(source_type: str, ingestion_id: UUID, at: datetime) -> str:
    check_slug(source_type, "source type")
    return f"bronze/{source_type}/{at:%Y}/{at:%m}/{at:%d}/{ingestion_id}/"


def bronze_raw_key(source_type: str, ingestion_id: UUID, at: datetime, filename: str) -> str:
    return f"{bronze_prefix(source_type, ingestion_id, at)}raw/{safe_name(filename)}"


def bronze_report_key(source_type: str, ingestion_id: UUID, at: datetime) -> str:
    return f"{bronze_prefix(source_type, ingestion_id, at)}report.json"


def silver_prefix(workflow: str, slug: str, batch_id: UUID) -> str:
    return f"silver/{check_slug(workflow, 'workflow')}/{check_slug(slug, 'dataset')}/{batch_id}/"


def gold_prefix(workflow: str, slug: str, version: str) -> str:
    if not _VERSION.match(version):
        raise ValueError(f"version {version!r} must look like 1.0.0")
    return f"gold/{check_slug(workflow, 'workflow')}/{check_slug(slug, 'dataset')}/{version}/"


def gold_cases_key(workflow: str, slug: str, version: str) -> str:
    return gold_prefix(workflow, slug, version) + "cases.jsonl"


def gold_manifest_key(workflow: str, slug: str, version: str) -> str:
    return gold_prefix(workflow, slug, version) + "manifest.json"


def fixture_key(sha256: str, filename: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise ValueError("fixture checksum must be a 64-character lower-case hex SHA-256")
    return f"fixtures/{sha256[:2]}/{sha256}/{safe_name(filename)}"


def artifact_key(run_id: UUID, name: str) -> str:
    return f"artifacts/{run_id}/{safe_name(name)}"
