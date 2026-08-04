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
    "postgresql+asyncpg://postgres:1122@host.docker.internal:5432/insurance_ai",
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
        "v3 — add details to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS details JSON",
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
        "v8a — add organization_id to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id)",
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
        # blob into strongly-typed, mandatory columns on customers.
        "v10a — add is_smoker to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_smoker BOOLEAN",
    ),
    (
        # Legacy rows stored this in details->medical_history->is_smoker (a
        # frontend-only convention, never enforced) — backfill via a safe
        # string comparison rather than a ::boolean cast, so a malformed or
        # missing value can never abort this migration.
        "v10b — backfill is_smoker from legacy details JSON",
        "UPDATE customers SET is_smoker = CASE "
        "WHEN details->'medical_history'->>'is_smoker' IN ('true','t','1','yes') THEN TRUE "
        "ELSE FALSE END "
        "WHERE is_smoker IS NULL",
    ),
    (
        "v10c — set is_smoker not null",
        "ALTER TABLE customers ALTER COLUMN is_smoker SET NOT NULL",
    ),
    (
        "v10d — add height_cm to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS height_cm DOUBLE PRECISION",
    ),
    (
        # Legacy rows stored this in details->lifestyle->height_cm — backfill
        # only when the value is genuinely numeric (regex guard instead of a
        # bare cast) so a malformed value can never abort this migration.
        # 0 means "not recorded" for pre-existing rows; new rows must supply
        # a real value per the now-mandatory CustomerCreate schema field.
        "v10e — backfill height_cm from legacy details JSON",
        r"UPDATE customers SET height_cm = CASE "
        r"WHEN details->'lifestyle'->>'height_cm' ~ '^[0-9]+(\.[0-9]+)?$' "
        r"THEN (details->'lifestyle'->>'height_cm')::double precision "
        r"ELSE 0 END "
        r"WHERE height_cm IS NULL",
    ),
    (
        "v10f — set height_cm not null",
        "ALTER TABLE customers ALTER COLUMN height_cm SET NOT NULL",
    ),
    (
        "v10g — add weight_kg to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS weight_kg DOUBLE PRECISION",
    ),
    (
        # Same defensive backfill approach as height_cm above.
        "v10h — backfill weight_kg from legacy details JSON",
        r"UPDATE customers SET weight_kg = CASE "
        r"WHEN details->'lifestyle'->>'weight_kg' ~ '^[0-9]+(\.[0-9]+)?$' "
        r"THEN (details->'lifestyle'->>'weight_kg')::double precision "
        r"ELSE 0 END "
        r"WHERE weight_kg IS NULL",
    ),
    (
        "v10i — set weight_kg not null",
        "ALTER TABLE customers ALTER COLUMN weight_kg SET NOT NULL",
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
    # per-customer /quote endpoint (see shared/pricing/calculator.py).

    # v13: Policy lifecycle status + Case→Policy linkage, so a quote's journey
    # from indicative price through underwriting to issuance is traceable
    # instead of one undifferentiated Policy row per quote.
    (
        "v13a — add status to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'Quoted'",
    ),
    (
        "v13b — add policy_id to cases",
        "ALTER TABLE cases ADD COLUMN IF NOT EXISTS policy_id UUID REFERENCES policies(id)",
    ),
    # v13a seeded policies.status with the enum *value* ('Quoted'). SQLAlchemy's
    # Enum type round-trips Python Enum <-> DB string via the member *name*
    # (confirmed against this DB's existing users.status/cases.caseStatus
    # columns, which store 'ACTIVE'/'NEW' etc, not 'Active'/'New') — so every
    # ORM read of a 'Quoted' row raised LookupError. Correct the stored value
    # and the column default to the name form; the Customer/User pattern
    # elsewhere in this file never needed this because those columns were
    # only ever written through the ORM, never seeded via raw SQL.
    (
        "v13c — fix policies.status value to match SQLAlchemy Enum name storage",
        # status::text so the 'Quoted' literal is never cast to the enum type
        # (whose labels are the name-form 'QUOTED' on a fresh DB) — a legacy
        # value-form column is TEXT and still matches; a fresh enum column is
        # name-form and this is a safe no-op instead of a hard cast error.
        "UPDATE policies SET status = 'QUOTED' WHERE status::text = 'Quoted'",
    ),
    (
        "v13d — align policies.status column default with enum name storage",
        "ALTER TABLE policies ALTER COLUMN status SET DEFAULT 'QUOTED'",
    ),
    # v14: Tenant company-profile fields (SuperAdmin onboarding now captures
    # registration/license numbers, head office address, and contact info) plus
    # the new tenant-scoped `branches` table for regional offices/branch codes.
    # Note: `branches` itself needs no migration entry — it's a brand-new table,
    # so create_all() (which runs before this list) creates it automatically.
    (
        "v14a — add registration_number to tenants",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS registration_number VARCHAR(100)",
    ),
    (
        "v14b — add license_number to tenants",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS license_number VARCHAR(100)",
    ),
    (
        "v14c — add head_office_address to tenants",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS head_office_address VARCHAR(500)",
    ),
    (
        "v14d — add city to tenants",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS city VARCHAR(100)",
    ),
    (
        "v14e — add province to tenants",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS province VARCHAR(100)",
    ),
    (
        "v14f — add contact_person to tenants",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contact_person VARCHAR(255)",
    ),
    (
        "v14g — add contact_email to tenants",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255)",
    ),
    (
        "v14h — add contact_phone to tenants",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(50)",
    ),
    (
        "v14i — add website to tenants",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS website VARCHAR(255)",
    ),
    (
        "v14j — add established_date to tenants",
        "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS established_date DATE",
    ),
    # v15: Users are now scoped to a branch within their tenant — an Admin is
    # created against one branch, and every User that Admin subsequently
    # creates inherits that same branch (see routers/users.py create_user).
    (
        "v15a — add branch_id to users",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id)",
    ),
    # v16: Persist the per-category XAI reasons alongside the flat `reasons`
    # array so the underwriting UI can always render the Medical / Financial /
    # Fraud explainability breakdown for a stored assessment.
    (
        "v16a — add medical_reasons to risk_assessments",
        "ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS medical_reasons JSON",
    ),
    (
        "v16b — add financial_reasons to risk_assessments",
        "ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS financial_reasons JSON",
    ),
    (
        "v16c — add fraud_reasons to risk_assessments",
        "ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS fraud_reasons JSON",
    ),
    (
        "v16a-enum — add MaritalStatus",
        "DO $$ BEGIN CREATE TYPE maritalstatus AS ENUM ('Single', 'Married', 'Divorced', 'Widowed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;",
    ),
    (
        "v16b — add marital_status to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS marital_status maritalstatus",
    ),
    # v17: track who brought the customer (agent/broker/bank/etc). The new
    # `acquisition_sources` table itself needs no migration entry — it's a
    # brand-new table, so create_all() (which runs before this list) creates
    # it automatically from the AcquisitionSource SQLModel, and its enum type
    # is created by _create_enums_idempotent(). Only the FK column added to the
    # pre-existing `customers` table needs an ALTER here.
    (
        "v17a — add acquisition_source_id to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS acquisition_source_id UUID REFERENCES acquisition_sources(id)",
    ),
    (
        "v18a — add free_cover_limit to master_policies",
        "ALTER TABLE master_policies ADD COLUMN IF NOT EXISTS free_cover_limit DOUBLE PRECISION",
    ),
    (
        # Postgres enum types don't auto-grow — same reasoning as v8a-enum for GROUP_LIFE.
        "v19a-enum — add FAMILY_FLOATER to insurancetypeenum",
        "ALTER TYPE insurancetypeenum ADD VALUE IF NOT EXISTS 'FAMILY_FLOATER'",
    ),
    (
        # Enum labels are the Python member NAME ('FAMILY'), not .value ('Family').
        "v19b-enum — add FAMILY to plancategoryenum",
        "ALTER TYPE plancategoryenum ADD VALUE IF NOT EXISTS 'FAMILY'",
    ),
    (
        "v19c — add family_group_id to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS family_group_id UUID REFERENCES family_groups(id)",
    ),
    (
        "v19d — add family_relationship to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS family_relationship VARCHAR(50)",
    ),
    (
        "v19e — add family_policy_id to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS family_policy_id UUID REFERENCES family_policies(id)",
    ),
    (
        "v20a-enum — add profilestatusenum",
        "DO $$ BEGIN CREATE TYPE profilestatusenum AS ENUM ('LEAD', 'PROSPECT', 'UNDERWRITING_READY'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;",
    ),
    (
        "v20b — add profile_status to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS profile_status profilestatusenum NOT NULL DEFAULT 'LEAD'",
    ),
    (
        "v20c — alter cnic drop not null",
        "ALTER TABLE customers ALTER COLUMN cnic DROP NOT NULL",
    ),
    (
        "v20d — alter dob drop not null",
        "ALTER TABLE customers ALTER COLUMN dob DROP NOT NULL",
    ),
    (
        "v20e — alter gender drop not null",
        "ALTER TABLE customers ALTER COLUMN gender DROP NOT NULL",
    ),
    (
        "v20f — alter occupation drop not null",
        "ALTER TABLE customers ALTER COLUMN occupation DROP NOT NULL",
    ),
    (
        "v20g — alter declared_income drop not null",
        "ALTER TABLE customers ALTER COLUMN declared_income DROP NOT NULL",
    ),
    (
        "v20h — alter is_smoker drop not null",
        "ALTER TABLE customers ALTER COLUMN is_smoker DROP NOT NULL",
    ),
    (
        "v20i — alter height_cm drop not null",
        "ALTER TABLE customers ALTER COLUMN height_cm DROP NOT NULL",
    ),
    (
        "v20j — alter weight_kg drop not null",
        "ALTER TABLE customers ALTER COLUMN weight_kg DROP NOT NULL",
    ),
    (
        # Lets Admins mark a lead/prospect as disqualified (declined the offer,
        # unreachable, etc.) — same reasoning as v8a-enum for growing an
        # existing Postgres enum type in place.
        "v21a-enum — add NOT_INTERESTED to profilestatusenum",
        "ALTER TYPE profilestatusenum ADD VALUE IF NOT EXISTS 'NOT_INTERESTED'",
    ),
    (
        "v22a-enum — add POLICYHOLDER to profilestatusenum",
        "ALTER TYPE profilestatusenum ADD VALUE IF NOT EXISTS 'POLICYHOLDER'",
    ),
    (
        "v22b — add cnic to user_profiles",
        "ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS cnic VARCHAR(15)",
    ),
    (
        "v22c — add location to user_profiles",
        "ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS location VARCHAR(255)",
    ),
    (
        "v22d — add profile_status to family_groups",
        "ALTER TABLE family_groups ADD COLUMN IF NOT EXISTS profile_status VARCHAR(50) NOT NULL DEFAULT 'LEAD'",
    ),
    (
        "v22e — add profile_status to organizations",
        "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS profile_status VARCHAR(50) NOT NULL DEFAULT 'LEAD'",
    ),
    (
        "v23a — add cnic to acquisition_sources",
        "ALTER TABLE acquisition_sources ADD COLUMN IF NOT EXISTS cnic VARCHAR(15)",
    ),
    (
        "v23b — add location to acquisition_sources",
        "ALTER TABLE acquisition_sources ADD COLUMN IF NOT EXISTS location VARCHAR(255)",
    ),
    (
        "v24a — add branch_id to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id)",
    ),
    (
        "v24b — add assigned_agent_id to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS assigned_agent_id UUID REFERENCES users(id)",
    ),
    (
        "v24c — add city to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS city VARCHAR(100)",
    ),
    (
        "v24d — add province to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS province VARCHAR(100)",
    ),
    (
        "v24e — add branch_id to family_groups",
        "ALTER TABLE family_groups ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id)",
    ),
    (
        "v24f — add assigned_agent_id to family_groups",
        "ALTER TABLE family_groups ADD COLUMN IF NOT EXISTS assigned_agent_id UUID REFERENCES users(id)",
    ),
    (
        "v24g — add city to family_groups",
        "ALTER TABLE family_groups ADD COLUMN IF NOT EXISTS city VARCHAR(100)",
    ),
    (
        "v24h — add province to family_groups",
        "ALTER TABLE family_groups ADD COLUMN IF NOT EXISTS province VARCHAR(100)",
    ),
    (
        "v24i — add branch_id to organizations",
        "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id)",
    ),
    (
        "v24j — add assigned_agent_id to organizations",
        "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS assigned_agent_id UUID REFERENCES users(id)",
    ),
    (
        "v24k — add city to organizations",
        "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS city VARCHAR(100)",
    ),
    (
        "v24l — add province to organizations",
        "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS province VARCHAR(100)",
    ),
    (
        "v25a — ALTER TABLE policies ADD COLUMN IF NOT EXISTS effective_date DATE",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS effective_date DATE",
    ),
    (
        "v25b — ALTER TABLE policies ADD COLUMN IF NOT EXISTS assigned_underwriter_id UUID REFERENCES users(id)",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS assigned_underwriter_id UUID REFERENCES users(id)",
    ),
    (
        "v25c — ALTER TABLE policies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()",
    ),
    (
        "v25d-enum — ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'INFORMATION_REQUESTED'",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'INFORMATION_REQUESTED'",
    ),

    # ── v26: Policy Issuance & Renewals module ───────────────────────────────
    # New PolicyStatusEnum values for post-underwriting lifecycle stages.
    (
        "v26a-enum — add AcceptedWithLoadings to policystatusenum",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'AcceptedWithLoadings'",
    ),
    (
        "v26b-enum — add Active to policystatusenum",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'Active'",
    ),
    (
        "v26c-enum — add GracePeriod to policystatusenum",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'GracePeriod'",
    ),
    (
        "v26d-enum — add Cancelled to policystatusenum",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'Cancelled'",
    ),

    # New columns on the existing policies table — added at issuance time.
    (
        "v26e — add policy_number to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS policy_number VARCHAR(50)",
    ),
    (
        "v26f — add expiry_date to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS expiry_date DATE",
    ),
    (
        "v26g — add grace_period_end_date to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS grace_period_end_date DATE",
    ),
    (
        "v26h — add current_version_id to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS current_version_id UUID",
    ),

    # ── v27: Enum types for the new Issuance/Renewals tables ─────────────────
    # These are brand-new tables so create_all() builds them; but their enum
    # types must exist in Postgres BEFORE create_all runs. We create them here
    # so _create_enums_idempotent() picks them up on the first run and the
    # DO/EXCEPTION guard makes subsequent runs a no-op.
    (
        "v27a-enum — billingfrequencyenum",
        "DO $$ BEGIN CREATE TYPE billingfrequencyenum AS ENUM "
        "('Annual','SemiAnnual','Quarterly','Monthly'); "
        "EXCEPTION WHEN duplicate_object THEN NULL; END $$;",
    ),
    (
        "v27b-enum — premiumschedulestatusenum",
        "DO $$ BEGIN CREATE TYPE premiumschedulestatusenum AS ENUM "
        "('Pending','Paid','Overdue','Waived'); "
        "EXCEPTION WHEN duplicate_object THEN NULL; END $$;",
    ),
    (
        "v27c-enum — renewalstatusenum",
        "DO $$ BEGIN CREATE TYPE renewalstatusenum AS ENUM "
        "('Initiated','UnderwritingReview','Quoted','Bound','Lapsed'); "
        "EXCEPTION WHEN duplicate_object THEN NULL; END $$;",
    ),
    (
        "v27d-enum — policydocumenttypeenum",
        "DO $$ BEGIN CREATE TYPE policydocumenttypeenum AS ENUM "
        "('PolicySchedule','CertificateOfInsurance','PolicyWording','RenewalNotice'); "
        "EXCEPTION WHEN duplicate_object THEN NULL; END $$;",
    ),
    # v28: PENDING_PAYMENT intermediate state for clean Phase-2 payment gateway
    # integration. The issuance flow: APPROVED → PENDING_PAYMENT → ACTIVE.
    # Phase 1 auto-transitions from PENDING_PAYMENT → ACTIVE immediately (mock pay-to-bind).
    (
        "v28a-enum — add PendingPayment to policystatusenum",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT'",
    ),
    # v29: Stage A pre-issuance. CounterOffer is the new revised-terms gate;
    # NotTakenUp is the decline/expiry outcome. Postponed / ReinsurerReferred
    # were in the state machine's enum but never added to the DB type — add them
    # now so those transitions can persist. All stored as enum NAMES (see the
    # existing rows: 'APPROVED', 'PENDING_PAYMENT', ...).
    (
        "v29a-enum — add CounterOffer to policystatusenum",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'COUNTER_OFFER'",
    ),
    (
        "v29b-enum — add NotTakenUp to policystatusenum",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'NOT_TAKEN_UP'",
    ),
    (
        "v29c-enum — add Postponed to policystatusenum",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'POSTPONED'",
    ),
    (
        "v29d-enum — add ReinsurerReferred to policystatusenum",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'REINSURER_REFERRED'",
    ),
    (
        "v30-enum — add PremiumNotice to policydocumenttypeenum",
        "ALTER TYPE policydocumenttypeenum ADD VALUE IF NOT EXISTS 'PREMIUM_NOTICE'",
    ),
    (
        "v31a-enum-fix — add ACCEPTED_WITH_LOADINGS to policystatusenum",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'ACCEPTED_WITH_LOADINGS'",
    ),
    (
        "v31b-enum-fix — add ACTIVE to policystatusenum",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'ACTIVE'",
    ),
    (
        "v31c-enum-fix — add GRACE_PERIOD to policystatusenum",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'GRACE_PERIOD'",
    ),
    (
        "v31d-enum-fix — add CANCELLED to policystatusenum",
        "ALTER TYPE policystatusenum ADD VALUE IF NOT EXISTS 'CANCELLED'",
    ),
    (
        "v32-enum-draft — add DRAFT to profilestatusenum",
        "ALTER TYPE profilestatusenum ADD VALUE IF NOT EXISTS 'DRAFT'",
    ),
    # ── Stage A hardening (pre Stage B) ──────────────────────────────────────
    # Free-look anchor + demo-bypass audit on the existing policies table.
    # (beneficiary_versions is a brand-new table → create_all handles it.)
    (
        "v33a — add delivery_date to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS delivery_date DATE",
    ),
    (
        "v33b — add free_look_end_date to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS free_look_end_date DATE",
    ),
    (
        "v33c — add demo_bypass_flags to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS demo_bypass_flags VARCHAR(50) DEFAULT 'NotFlagged'",
    ),
    # ── Stage B step 2 — Welcome & Onboarding ────────────────────────────────
    # Policyholder / client number on the existing customers table.
    # (customer_portal_accounts & policy_onboarding are brand-new tables →
    # create_all builds them; their status columns are plain VARCHAR, so no new
    # native enum types are introduced.)
    (
        "v34a — add policyholder_id to customers",
        "ALTER TABLE customers ADD COLUMN IF NOT EXISTS policyholder_id VARCHAR(50)",
    ),
    (
        "v34b — index policyholder_id",
        "CREATE INDEX IF NOT EXISTS ix_customers_policyholder_id ON customers (policyholder_id)",
    ),
    # ── Stage B step 3 — Recurring Premium Collection ────────────────────────
    (
        "v35a — add installment_no to premium_schedules",
        "ALTER TABLE premium_schedules ADD COLUMN IF NOT EXISTS installment_no INTEGER NOT NULL DEFAULT 1",
    ),
    (
        "v35b — add reminder_count to premium_schedules",
        "ALTER TABLE premium_schedules ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0",
    ),
    (
        "v35c — add last_reminder_at to premium_schedules",
        "ALTER TABLE premium_schedules ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMP",
    ),
    (
        "v35d — add autopay_enabled to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS autopay_enabled BOOLEAN NOT NULL DEFAULT FALSE",
    ),
    # ── Policy issuance formalities ──────────────────────────────────────────
    (
        "v36a — add maturity_date to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS maturity_date DATE",
    ),
    (
        "v36b — add issued_by to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS issued_by VARCHAR(255)",
    ),
    (
        "v36c — add issued_at to policies",
        "ALTER TABLE policies ADD COLUMN IF NOT EXISTS issued_at TIMESTAMP",
    ),
    # NOTE: The renewal scheduler (renewal_scheduler.py) MUST run in a single-worker
    # deployment to avoid duplicate RenewalTransactions. Enforce via:
    #   CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
    # in the Dockerfile. A pg_try_advisory_lock(42) guard in the scheduler provides
    # a second line of defence if workers=1 is ever accidentally removed.
    # Note: policy_versions, premium_schedules, renewal_transactions, policy_documents
    # are brand-new tables — create_all() auto-creates them from SQLModel metadata.
    # No ALTER TABLE entries needed here for those tables.
    (
        "v37a — add terms_explained_to_proposer to agent_confidential_reports",
        "ALTER TABLE agent_confidential_reports ADD COLUMN IF NOT EXISTS terms_explained_to_proposer BOOLEAN",
    ),
    (
        "v37b — add identity_verified_kyc to agent_confidential_reports",
        "ALTER TABLE agent_confidential_reports ADD COLUMN IF NOT EXISTS identity_verified_kyc BOOLEAN",
    ),
    (
        "v37c — add signature_obtained_in_presence to agent_confidential_reports",
        "ALTER TABLE agent_confidential_reports ADD COLUMN IF NOT EXISTS signature_obtained_in_presence BOOLEAN",
    ),
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

async def _create_vector_extension(conn) -> None:
    await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector;"))
    log.info("vector extension created/verified")


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


async def _rename_applicant_to_customer(conn) -> None:
    """Rename the legacy `applicants` table + `applicant_id` columns to the
    `customers` / `customer_id` naming.

    MUST run before create_all: otherwise create_all sees no `customers` table
    on an existing DB and creates an empty one, orphaning the real data still
    sitting in `applicants`. Every statement is wrapped in a DO/EXCEPTION
    block so it is a no-op on a fresh DB (nothing to rename) and on an
    already-renamed DB (rename already applied) — i.e. fully idempotent.
    """
    # Each rename is wrapped in a DO/EXCEPTION block: the exception fires when
    # the object is already renamed (or never existed), making every statement
    # a safe no-op on a fresh DB and on an already-migrated DB. (An
    # information_schema guard is unreliable here — it does not reflect an
    # earlier RENAME made in the same open transaction.)

    # Table: applicants -> customers
    await conn.execute(text("""
        DO $$ BEGIN
            ALTER TABLE applicants RENAME TO customers;
        EXCEPTION
            WHEN undefined_table THEN NULL;   -- already renamed / absent
            WHEN duplicate_table THEN NULL;   -- customers already exists
        END $$;
    """))

    # FK columns: applicant_id -> customer_id on every table that carries one.
    for table_name in ("policies", "risk_assessments", "artifacts", "cases"):
        await conn.execute(text(f"""
            DO $$ BEGIN
                ALTER TABLE {table_name} RENAME COLUMN applicant_id TO customer_id;
            EXCEPTION
                WHEN undefined_column THEN NULL;
                WHEN undefined_table THEN NULL;
            END $$;
        """))

    # Unique constraint name on the (now) customers table.
    await conn.execute(text("""
        DO $$ BEGIN
            ALTER TABLE customers
                RENAME CONSTRAINT uq_applicant_cnic_per_tenant
                TO uq_customer_cnic_per_tenant;
        EXCEPTION
            WHEN undefined_object THEN NULL;
            WHEN undefined_table THEN NULL;
        END $$;
    """))
    log.info("applicant->customer rename verified")


async def run_migrations() -> None:
    # Check if database supports pgvector extension before registering models
    try:
        async with _engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector;"))
        log.info("pgvector extension created/verified in database.")
    except Exception as e:
        log.warning("pgvector extension is not supported by the database: %s. Disabling vector features.", e)
        os.environ["DISABLE_PGVECTOR"] = "true"

    import shared.models.core  # noqa: F401 — registers all SQLModel metadata

    async with _engine.begin() as conn:
        # 0. Rename legacy applicants table/columns BEFORE create_all so it does
        #    not create a fresh empty `customers` table alongside the real data.
        await _rename_applicant_to_customer(conn)

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
