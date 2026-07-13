"""
Idempotent schema migration runner for the tenant-service.

SQLModel's create_all handles brand-new tables. This file handles the harder
case: adding columns to tables that already exist in production. Every entry in
MIGRATIONS must be safe to run multiple times (IF NOT EXISTS / IF EXISTS guards).

Called automatically from the FastAPI lifespan on every uvicorn reload.
Can also be run standalone:

    docker compose exec tenant-service python migrate.py
"""

import asyncio
import logging
import os

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel import SQLModel

log = logging.getLogger(__name__)

DATABASE_URL: str = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:asdf456nouM$@host.docker.internal:5432/insurance-ai",
)

_engine = create_async_engine(DATABASE_URL, echo=False, future=True)

# ── Migration list ────────────────────────────────────────────────────────────
# Append new entries at the bottom. Never edit or remove existing ones.
# create_all handles NEW tables; only column/index changes on EXISTING tables
# belong here.

MIGRATIONS: list[tuple[str, str]] = [
    (
        "v1 — add is_active to tenants",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE",
    ),
    (
        "v2a — add username to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255)",
    ),
    (
        "v2b — backfill username",
        "UPDATE users SET username = email WHERE username IS NULL",
    ),
    (
        "v2c — set username not null",
        "ALTER TABLE users ALTER COLUMN username SET NOT NULL",
    ),
    (
        "v2d — drop constraint if exists",
        "ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_username",
    ),
    (
        "v2e — add unique constraint",
        "ALTER TABLE users ADD CONSTRAINT uq_users_username UNIQUE (username)",
    ),
    (
        "v2f — add user_type_id to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS user_type_id UUID REFERENCES user_types(id)",
    ),
    (
        "v2g — add status to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE'",
    ),
    (
        "v2h — add is_verified to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE",
    ),
    (
        "v2i — add failed_login_count to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0",
    ),
    (
        "v2j — add last_login to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP WITH TIME ZONE",
    ),
    (
        "v2k — add is_deleted to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE",
    ),
    (
        "v2l — add updated_at to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()",
    ),
    (
        "v3 — add details to applicants",
        "ALTER TABLE applicants ADD COLUMN IF NOT EXISTS details JSON",
    ),
    (
        "v4a — add case_id to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS case_id UUID REFERENCES cases(caseld)",
    ),
    (
        "v4b — add uploaded_by to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES users(id)",
    ),
    (
        "v4c — add file_name to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS file_name VARCHAR(255)",
    ),
    (
        "v4d — add file_size to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS file_size INTEGER",
    ),
    (
        "v4e — add file_type to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS file_type VARCHAR(100)",
    ),
    (
        "v4f — add storage_url to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS storage_url VARCHAR(1000)",
    ),
    (
        "v4g — add ocr_result to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS ocr_result TEXT",
    ),
    (
        "v4h — set default for ocr_confidence_score",
        "ALTER TABLE artifacts ALTER COLUMN ocr_confidence_score SET DEFAULT 0.0",
    ),
    (
        "v4i — set default for authenticity_score",
        "ALTER TABLE artifacts ALTER COLUMN authenticity_score SET DEFAULT 1.0",
    ),
    (
        "v4j — set default for quality_score",
        "ALTER TABLE artifacts ALTER COLUMN quality_score SET DEFAULT 1.0",
    ),
    (
        "v4k — set default for status",
        "ALTER TABLE artifacts ALTER COLUMN status SET DEFAULT 'Processing'",
    ),
    (
        "v5a — add composite_risk_score to risk_assessments",
        "ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS composite_risk_score INTEGER",
    ),
    (
        "v5b — add case_id to risk_assessments",
        "ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS case_id UUID REFERENCES cases(caseld)",
    ),
    (
        "v5c — add ai_summary to risk_assessments",
        "ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS ai_summary TEXT",
    ),
    (
        "v6a — add code to tenants",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS code VARCHAR(50)",
    ),
    (
        "v6b — backfill code from name",
        "UPDATE tenants SET code = upper(left(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g'), 50)) WHERE code IS NULL",
    ),
    (
        "v6c — set code not null",
        "ALTER TABLE tenants ALTER COLUMN code SET NOT NULL",
    ),
    (
        "v6d — drop constraint if exists",
        "ALTER TABLE tenants DROP CONSTRAINT IF EXISTS uq_tenants_code",
    ),
    (
        "v6e — add unique constraint",
        "ALTER TABLE tenants ADD CONSTRAINT uq_tenants_code UNIQUE (code)",
    ),
    (
        "v7a — add insurance_type to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS insurance_type VARCHAR(50)",
    ),
    (
        "v7b — backfill insurance_type",
        "UPDATE policies SET insurance_type = 'TERM_LIFE' WHERE insurance_type IS NULL",
    ),
    (
        "v7c — set insurance_type not null",
        "ALTER TABLE policies ALTER COLUMN insurance_type SET NOT NULL",
    ),
    (
        "v7d — add dependent_name to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS dependent_name VARCHAR(255)",
    ),
    (
        "v7e — add dependent_dob to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS dependent_dob DATE",
    ),
    (
        "v7f — add policy_id to risk_assessments",
        "ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS policy_id UUID REFERENCES policies(id)",
    ),
    (
        # Postgres enum types don't auto-grow when a Python Enum gains a new
        # member — _create_enums_idempotent() only CREATEs a type if it's
        # missing entirely, so an existing insurancetypeenum from an earlier
        # run needs this explicit ALTER to accept the new GROUP_LIFE value.
        "v8a-enum — add GROUP_LIFE to insurancetypeenum",
        "ALTER TYPE insurancetypeenum ADD VALUE IF NOT EXISTS 'GROUP_LIFE'",
    ),
    (
        "v8a — add organization_id to applicants",
        "ALTER TABLE applicants ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id)",
    ),
    (
        "v8b — add master_policy_id to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS master_policy_id UUID REFERENCES master_policies(id)",
    ),
    (
        # Same reasoning as v8a-enum: SAVINGS / SINGLE_PREMIUM / HEALTH_CASH
        # were added to InsuranceTypeEnum for the real Adamjee Life catalog.
        "v9a-enum — add SAVINGS to insurancetypeenum",
        "ALTER TYPE insurancetypeenum ADD VALUE IF NOT EXISTS 'SAVINGS'",
    ),
    (
        "v9b-enum — add SINGLE_PREMIUM to insurancetypeenum",
        "ALTER TYPE insurancetypeenum ADD VALUE IF NOT EXISTS 'SINGLE_PREMIUM'",
    ),
    (
        "v9c-enum — add HEALTH_CASH to insurancetypeenum",
        "ALTER TYPE insurancetypeenum ADD VALUE IF NOT EXISTS 'HEALTH_CASH'",
    ),
    (
        "v9d — add product_category to insurance_plans",
        "ALTER TABLE insurance_plans ADD COLUMN IF NOT EXISTS product_category productcategoryenum",
    ),
    (
        # Postgres enum labels are the Python enum *member name* (e.g.
        # CONVENTIONAL), not its .value ("Conventional") — SQLAlchemy's
        # default Enum type stores/reads by name, same as every other enum
        # column in this schema (see plancategoryenum: INDIVIDUAL/GROUP).
        "v9e — backfill product_category",
        "UPDATE insurance_plans SET product_category = 'CONVENTIONAL' WHERE product_category IS NULL",
    ),
    (
        "v9f — set default for product_category",
        "ALTER TABLE insurance_plans ALTER COLUMN product_category SET DEFAULT 'CONVENTIONAL'",
    ),
    (
        "v9g — set product_category not null",
        "ALTER TABLE insurance_plans ALTER COLUMN product_category SET NOT NULL",
    ),
    (
        "v9h — add partner_bank to insurance_plans",
        "ALTER TABLE insurance_plans ADD COLUMN IF NOT EXISTS partner_bank VARCHAR(255)",
    ),
    (
        # Phase 1 of the Rating/Pricing Engine data contract: promote
        # is_smoker/height_cm/weight_kg out of the freeform `details` JSON
        # blob into strongly-typed, mandatory columns on applicants.
        "v10a — add is_smoker to applicants",
        "ALTER TABLE applicants ADD COLUMN IF NOT EXISTS is_smoker BOOLEAN",
    ),
    (
        # Legacy rows stored this in details->medical_history->is_smoker (a
        # frontend-only convention, never enforced) — backfill via a safe
        # string comparison rather than a ::boolean cast, so a malformed or
        # missing value can never abort this migration.
        "v10b — backfill is_smoker from legacy details JSON",
        "UPDATE applicants SET is_smoker = CASE "
        "WHEN details->'medical_history'->>'is_smoker' IN ('true','t','1','yes') THEN TRUE "
        "ELSE FALSE END "
        "WHERE is_smoker IS NULL",
    ),
    (
        "v10c — set is_smoker not null",
        "ALTER TABLE applicants ALTER COLUMN is_smoker SET NOT NULL",
    ),
    (
        "v10d — add height_cm to applicants",
        "ALTER TABLE applicants ADD COLUMN IF NOT EXISTS height_cm DOUBLE PRECISION",
    ),
    (
        # Legacy rows stored this in details->lifestyle->height_cm — backfill
        # only when the value is genuinely numeric (regex guard instead of a
        # bare cast) so a malformed value can never abort this migration.
        # 0 means "not recorded" for pre-existing rows; new rows must supply
        # a real value per the now-mandatory ApplicantCreate schema field.
        "v10e — backfill height_cm from legacy details JSON",
        r"UPDATE applicants SET height_cm = CASE "
        r"WHEN details->'lifestyle'->>'height_cm' ~ '^[0-9]+(\.[0-9]+)?$' "
        r"THEN (details->'lifestyle'->>'height_cm')::double precision "
        r"ELSE 0 END "
        r"WHERE height_cm IS NULL",
    ),
    (
        "v10f — set height_cm not null",
        "ALTER TABLE applicants ALTER COLUMN height_cm SET NOT NULL",
    ),
    (
        "v10g — add weight_kg to applicants",
        "ALTER TABLE applicants ADD COLUMN IF NOT EXISTS weight_kg DOUBLE PRECISION",
    ),
    (
        # Same defensive backfill approach as height_cm above.
        "v10h — backfill weight_kg from legacy details JSON",
        r"UPDATE applicants SET weight_kg = CASE "
        r"WHEN details->'lifestyle'->>'weight_kg' ~ '^[0-9]+(\.[0-9]+)?$' "
        r"THEN (details->'lifestyle'->>'weight_kg')::double precision "
        r"ELSE 0 END "
        r"WHERE weight_kg IS NULL",
    ),
    (
        "v10i — set weight_kg not null",
        "ALTER TABLE applicants ALTER COLUMN weight_kg SET NOT NULL",
    ),
    (
        # Phase 1 pricing framework fields on insurance_plans — neutral
        # defaults (0 rate / 1.0x factor) so existing seeded plans stay valid
        # until real rates are loaded.
        "v10j — add base_premium_rate to insurance_plans",
        "ALTER TABLE insurance_plans ADD COLUMN IF NOT EXISTS base_premium_rate DOUBLE PRECISION NOT NULL DEFAULT 0",
    ),
    (
        "v10k — add smoker_factor to insurance_plans",
        "ALTER TABLE insurance_plans ADD COLUMN IF NOT EXISTS smoker_factor DOUBLE PRECISION NOT NULL DEFAULT 1",
    ),
    (
        "v10l — add rate_version to insurance_plans",
        "ALTER TABLE insurance_plans ADD COLUMN IF NOT EXISTS rate_version VARCHAR(50) NOT NULL DEFAULT 'v1'",
    ),
    # Note: the new `premium_quotes` table needs no migration entry here —
    # it's a brand-new table, so create_all() (which runs before this list)
    # creates it automatically from the PremiumQuote SQLModel.
    (
        "v11a — add nominee_name to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS nominee_name VARCHAR(255)",
    ),
    (
        "v11b — add nominee_relationship to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS nominee_relationship VARCHAR(100)",
    ),
    # Phase 2 of the Rating/Pricing Engine: backfill real v1 placeholder rates
    # for every plan still sitting at the neutral 0.0 default from v10j — i.e.
    # every tenant's catalog seeded before real rates existed. Guarded by
    # `base_premium_rate = 0` so a tenant admin's manually-tuned rate (via the
    # Plans edit UI) is never overwritten. Rates are PKR per 1,000 sum assured
    # per year — reasonable v1 estimates (same spirit as underwriting_rules.py
    # bands), not a regulatory filing.
    (
        "v12a — backfill TERM_LIFE rate",
        "UPDATE insurance_plans SET base_premium_rate = 3.5, smoker_factor = 1.6 "
        "WHERE insurance_type = 'TERM_LIFE' AND base_premium_rate = 0",
    ),
    (
        "v12b — backfill WHOLE_LIFE rate",
        "UPDATE insurance_plans SET base_premium_rate = 5.5, smoker_factor = 1.5 "
        "WHERE insurance_type = 'WHOLE_LIFE' AND base_premium_rate = 0",
    ),
    (
        "v12c — backfill ENDOWMENT rate",
        "UPDATE insurance_plans SET base_premium_rate = 6.0, smoker_factor = 1.4 "
        "WHERE insurance_type = 'ENDOWMENT' AND base_premium_rate = 0",
    ),
    (
        "v12d — backfill SAVINGS rate",
        "UPDATE insurance_plans SET base_premium_rate = 6.0, smoker_factor = 1.4 "
        "WHERE insurance_type = 'SAVINGS' AND base_premium_rate = 0",
    ),
    (
        "v12e — backfill SINGLE_PREMIUM rate",
        "UPDATE insurance_plans SET base_premium_rate = 4.0, smoker_factor = 1.3 "
        "WHERE insurance_type = 'SINGLE_PREMIUM' AND base_premium_rate = 0",
    ),
    (
        "v12f — backfill HEALTH_CASH rate",
        "UPDATE insurance_plans SET base_premium_rate = 8.0, smoker_factor = 1.2 "
        "WHERE insurance_type = 'HEALTH_CASH' AND base_premium_rate = 0",
    ),
    (
        "v12g — backfill CHILD_EDUCATION_MARRIAGE rate",
        "UPDATE insurance_plans SET base_premium_rate = 5.0, smoker_factor = 1.0 "
        "WHERE insurance_type = 'CHILD_EDUCATION_MARRIAGE' AND base_premium_rate = 0",
    ),
    # GROUP_LIFE intentionally left at the neutral 0.0/1.0 default — group
    # pricing is negotiated per-MasterPolicy and is not served by the
    # per-applicant /quote endpoint (see shared/pricing/calculator.py).
]

# ── Runner ────────────────────────────────────────────────────────────────────

async def _create_enums_idempotent(conn) -> None:
    """Create all PostgreSQL enum types in the metadata using DO blocks.

    Using DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$
    makes this safe on both a fresh DB and a restart with an existing volume —
    the second case previously caused UniqueViolationError on casetypeenum etc.
    """
    from sqlalchemy import Enum as SAEnum

    seen: set[str] = set()
    for table in SQLModel.metadata.sorted_tables:
        for column in table.columns:
            if (
                isinstance(column.type, SAEnum)
                and column.type.name
                and column.type.name not in seen
            ):
                seen.add(column.type.name)
                values_str = ", ".join(f"'{v}'" for v in column.type.enums)
                await conn.execute(text(f"""
                    DO $$ BEGIN
                        CREATE TYPE {column.type.name} AS ENUM ({values_str});
                    EXCEPTION WHEN duplicate_object THEN NULL;
                    END $$;
                """))
    log.info("enums created/verified: %s", sorted(seen))


async def _seed_user_types(conn) -> None:
    from uuid import uuid4
    from datetime import datetime

    user_types = [
        ("Admin", "System administrator with full permissions"),
        ("Underwriter", "Insurance underwriter evaluating risk"),
        ("Agent", "Insurance agent managing clients and policies"),
        ("BancassuranceOfficer", "Bancassurance officer selling products through bank channel")
    ]
    for name, desc in user_types:
        res = await conn.execute(text("SELECT id FROM user_types WHERE type_name = :name"), {"name": name})
        row = res.first()
        if not row:
            await conn.execute(
                text("INSERT INTO user_types (id, type_name, description, is_active, created_at) "
                     "VALUES (:id, :name, :desc, true, :created_at)"),
                {"id": str(uuid4()), "name": name, "desc": desc, "created_at": datetime.utcnow()}
            )


async def run_migrations() -> None:
    import shared.models.core  # noqa: F401 — registers all SQLModel metadata

    async with _engine.begin() as conn:
        # 1. Create enum types idempotently before create_all so that restarts
        #    with an existing volume do not raise UniqueViolationError.
        await _create_enums_idempotent(conn)

        # 2. Tell SQLAlchemy the enum types already exist so create_all only
        #    issues CREATE TABLE statements (never CREATE TYPE).
        from sqlalchemy import Enum as SAEnum
        for table in SQLModel.metadata.sorted_tables:
            for column in table.columns:
                if isinstance(column.type, SAEnum):
                    column.type.create_type = False

        # 3. Create any tables that do not yet exist (fully idempotent).
        await conn.run_sync(SQLModel.metadata.create_all)
        log.info("create_all complete")

    # 2. Apply column / index changes to existing tables in individual transactions.
    for label, sql in MIGRATIONS:
        async with _engine.begin() as conn:
            await conn.execute(text(sql))
            log.info("applied: %s", label)

    # 3. Seed user types.
    async with _engine.begin() as conn:
        await _seed_user_types(conn)
        log.info("seed_user_types complete")

    log.info("all migrations complete")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
    asyncio.run(run_migrations())
