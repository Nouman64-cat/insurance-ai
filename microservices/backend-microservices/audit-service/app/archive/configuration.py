"""Versioned, audited runtime controls. No credentials or mutable global Settings."""
import asyncio
import json
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator
from sqlalchemy import text

from app import db
from app.config import Settings
from app.services import audit_service
from shared.audit.schema import AuditIntent

LOCK_ID = 74_210_382


class ArchiveControls(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    hot_retention_months: int = Field(default=6, ge=0, le=1200)
    archiving_enabled: StrictBool = True
    archive_schedule: Literal["monthly", "continuous"] = "monthly"
    archive_compression: Literal["zstd", "none"] = "zstd"
    auto_hot_cleanup: StrictBool = False
    cleanup_mode: Literal["detach", "drop"] = "detach"
    cleanup_safety_days: float = Field(default=7, ge=0, le=3650)
    archive_test_mode: StrictBool = False
    archive_test_hot_seconds: float = Field(default=120, ge=1, le=86400)
    archive_interval_seconds: int = Field(default=300, ge=5, le=86400)
    lock_mode: Literal["GOVERNANCE", "COMPLIANCE"] = "GOVERNANCE"
    lock_days: int = Field(default=30, ge=0, le=36500)
    environment_label: str = Field(default="local-dev", min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9 _.-]+$")

    @model_validator(mode="after")
    def local_testing_only(self):
        if self.archive_test_mode and self.environment_label != "local-dev":
            raise ValueError("Archive test mode requires the local-dev environment label")
        return self

    @classmethod
    def bootstrap(cls, base: Settings):
        return cls.model_validate({key: getattr(base, key) for key in cls.model_fields})

    def effective(self, base: Settings) -> Settings:
        return replace(base, **self.model_dump())


class ArchiveUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)
    settings: ArchiveControls
    confirmation: str | None = None


async def latest(conn):
    row = (await conn.execute(text("SELECT * FROM archive_configuration_versions ORDER BY revision DESC LIMIT 1"))).mappings().first()
    if row is None:
        raise HTTPException(503, "Audit runtime configuration has not been initialized.")
    return dict(row)


def public(row):
    return {**row, "propagation_seconds": 5}


async def _default_retention(conn, months):
    # Only system-managed defaults follow the global control. Explicit category/tenant policies win.
    rows = (await conn.execute(text("""SELECT * FROM retention_policies WHERE tenant_id IS NULL
        AND superseded_at IS NULL AND NOT approved AND created_by IN ('system', 'archive-configuration')
        AND hot_retention_months <> :m FOR UPDATE"""), {"m": months})).mappings().all()
    for row in rows:
        await conn.execute(text("UPDATE retention_policies SET superseded_at = now() WHERE policy_id = :id"), {"id": row["policy_id"]})
        await conn.execute(text("""INSERT INTO retention_policies
            (tenant_id, category, hot_retention_months, cold_retention_years, allow_hot_cleanup, approved, notes, created_by)
            VALUES (NULL, :category, :months, :cold, :cleanup, FALSE, :notes, 'archive-configuration')"""),
            {"category": row["category"], "months": months, "cold": row["cold_retention_years"],
             "cleanup": row["allow_hot_cleanup"], "notes": "System default managed by Audit Configuration; explicit category and tenant policies override it."})


async def _append(conn, controls, revision, actor, old=None):
    values = controls.model_dump()
    await _default_retention(conn, controls.hot_retention_months)
    await conn.execute(text("""INSERT INTO archive_configuration_versions (revision, settings, updated_by, source)
        VALUES (:r, CAST(:s AS jsonb), :u, :source)"""),
        {"r": revision, "s": json.dumps(values), "u": actor.requester if actor else "system",
         "source": "superadmin" if actor else "environment-bootstrap"})
    await audit_service.append_to_chain(conn, [AuditIntent(
        source_service="audit-service", source_event_id=f"archive-config-{uuid.uuid4().hex}", tenant_id=None,
        actor_id=str(actor.user_id) if actor else None, actor_type="USER" if actor else "SYSTEM",
        actor_role=actor.role if actor else None, module="audit", action="archive.configuration.updated" if actor else "archive.configuration.initialized",
        entity_type="archive_configuration", entity_id=str(revision), previous_value=old, new_value=values,
        metadata={"configuration_revision": revision})])
    return await latest(conn)


async def initialize(base):
    await audit_service.ensure_partition(datetime.now(timezone.utc))
    async with db.transaction() as conn:
        await conn.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": LOCK_ID})
        present = (await conn.execute(text("SELECT 1 FROM archive_configuration_versions LIMIT 1"))).first()
        if not present:
            controls = ArchiveControls.bootstrap(base)
            await _append(conn, controls, 1, None)
            await conn.execute(text("""UPDATE archive_jobs SET plan = plan || jsonb_build_object('runtime_settings', CAST(:s AS jsonb), 'configuration_revision', 1)
                WHERE NOT (plan ? 'runtime_settings') AND state NOT IN ('ARCHIVED', 'HOT_CLEANUP_ELIGIBLE', 'HOT_CLEANUP_COMPLETED')"""),
                {"s": json.dumps(controls.model_dump())})


async def read():
    async with db.engine().connect() as conn:
        return await latest(conn)


async def update(body: ArchiveUpdate, identity):
    await audit_service.ensure_partition(datetime.now(timezone.utc))
    async with db.transaction() as conn:
        await conn.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": LOCK_ID})
        old = await latest(conn)
        if old["revision"] != body.expected_revision:
            raise HTTPException(409, "Audit configuration changed. Reload before saving.")
        new = body.settings
        dangerous = new.auto_hot_cleanup and new.cleanup_mode == "drop"
        was_dangerous = old["settings"]["auto_hot_cleanup"] and old["settings"]["cleanup_mode"] == "drop"
        if dangerous and not was_dangerous and body.confirmation != "ENABLE-AUTOMATIC-DROP":
            raise HTTPException(422, "Confirm ENABLE-AUTOMATIC-DROP before enabling permanent automatic PostgreSQL cleanup.")
        if new.model_dump() == old["settings"]:
            return old
        return await _append(conn, new, old["revision"] + 1, identity, old["settings"])


class RuntimeArchive:
    """Rebuild immutable service snapshots at revision boundaries; in-flight work keeps its snapshot."""
    def __init__(self, base, signer, instance_id):
        self.base, self.signer, self.instance_id = base, signer, instance_id
        self.changed = asyncio.Event()
        self._revision, self._services = None, None

    async def snapshot(self):
        from app.archive.service import build
        row = await read()
        controls = ArchiveControls.model_validate(row["settings"])
        effective = controls.effective(self.base)
        if self._revision != row["revision"]:
            self._services = build(effective, self.signer, self.instance_id)
            self._services.worker.configuration_revision = row["revision"]
            self._services.worker.runtime_read = read
            self._services.cleanup.configuration_revision = row["revision"]
            self._services.cleanup.runtime_read = read
            self._revision = row["revision"]
        return row, effective, self._services
