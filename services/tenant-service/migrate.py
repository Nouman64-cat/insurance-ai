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
import json
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
    # ── Pre-underwriting gates 5 & 6 + post-underwriting reinsurance ──────────
    # insurance_history_checks, panel_clinics, medical_exam_orders, reinsurers
    # and reinsurance_referrals are brand-new tables — create_all() builds them
    # and _create_enums_idempotent() creates their enum types. The only existing
    # table touched is `policies`: demo_bypass_flags now carries a fourth flag
    # (ReinsuranceBypassed) and the comma-joined list no longer fits in 50 chars.
    (
        "v38 — widen policies.demo_bypass_flags for the reinsurance bypass flag",
        "ALTER TABLE policies ALTER COLUMN demo_bypass_flags TYPE VARCHAR(200)",
    ),
    # ── Async evaluation results ─────────────────────────────────────────────
    # POST /evaluate publishes to Kafka and the result now lands via
    # api-gateway/risk_result_worker.py. Kafka is at-least-once, so the worker
    # keys on RiskEvaluatedEvent.correlation_id to avoid writing the same
    # assessment twice on redelivery. NULL for rows written by /evaluate/stream.
    (
        "v39a — add correlation_id to risk_assessments (Kafka idempotency key)",
        "ALTER TABLE risk_assessments ADD COLUMN IF NOT EXISTS correlation_id UUID",
    ),
    (
        "v39b — index risk_assessments.correlation_id for the dedupe lookup",
        "CREATE INDEX IF NOT EXISTS ix_risk_assessments_correlation_id "
        "ON risk_assessments (correlation_id)",
    ),
    (
        "v40a — add verified_at to customer_e_applications",
        "ALTER TABLE customer_e_applications ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE",
    ),
    (
        "v40b — add verified_by to customer_e_applications",
        "ALTER TABLE customer_e_applications ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES users(id)",
    ),
    (
        "v40c-enum — add VERIFIED to eapplicationstatusenum",
        "ALTER TYPE eapplicationstatusenum ADD VALUE IF NOT EXISTS 'VERIFIED'",
    ),
    (
        "v40d — add invite_token to customer_e_applications",
        "ALTER TABLE customer_e_applications ADD COLUMN IF NOT EXISTS invite_token VARCHAR(255)",
    ),
    (
        "v41a — add code to business_rules",
        "ALTER TABLE business_rules ADD COLUMN IF NOT EXISTS code VARCHAR(100)",
    ),
    (
        "v41b — add description to business_rules",
        "ALTER TABLE business_rules ADD COLUMN IF NOT EXISTS description VARCHAR(1000)",
    ),
    (
        "v41c — add category to business_rules",
        "ALTER TABLE business_rules ADD COLUMN IF NOT EXISTS category VARCHAR(255)",
    ),
    (
        "v41d — add subcategory to business_rules",
        "ALTER TABLE business_rules ADD COLUMN IF NOT EXISTS subcategory VARCHAR(255)",
    ),
    (
        "v41e — add eligibility_criteria to business_rules",
        "ALTER TABLE business_rules ADD COLUMN IF NOT EXISTS eligibility_criteria VARCHAR(1000)",
    ),
    (
        "v42 — add REINSURANCE to ruledomainenum",
        "ALTER TYPE ruledomainenum ADD VALUE IF NOT EXISTS 'REINSURANCE'",
    ),
    # ── Rule engine v2.1 — 6-tier hierarchy, typed impacts, grouped criteria ──
    # New columns are added nullable here; _migrate_rule_engine_v2() backfills
    # them from the old flat schema (domain/code/conditions/outcome_payload/
    # etc, still present at this point); POST_DATA_MIGRATIONS then enforces
    # NOT NULL and drops the old columns. See run_migrations() for ordering.
    (
        "v43a — rule_sets: add hierarchy + scope columns (nullable, backfilled)",
        "ALTER TABLE rule_sets "
        "ADD COLUMN IF NOT EXISTS scope_type scopetypeenum, "
        "ADD COLUMN IF NOT EXISTS subcategory_id UUID REFERENCES rule_subcategories(id), "
        "ADD COLUMN IF NOT EXISTS eligibility_id UUID REFERENCES eligibility_profiles(id), "
        "ADD COLUMN IF NOT EXISTS rule_code VARCHAR(100)",
    ),
    (
        "v43b — rule_versions: add version_number (nullable, backfilled)",
        "ALTER TABLE rule_versions ADD COLUMN IF NOT EXISTS version_number VARCHAR(20)",
    ),
    (
        "v43c — add ARCHIVED to ruleversionstatusenum (replaces RETIRED going forward)",
        "ALTER TYPE ruleversionstatusenum ADD VALUE IF NOT EXISTS 'ARCHIVED'",
    ),
    (
        "v43d — business_rules: add v2.1 columns (nullable, backfilled)",
        "ALTER TABLE business_rules "
        "ADD COLUMN IF NOT EXISTS version_id UUID REFERENCES rule_versions(id), "
        "ADD COLUMN IF NOT EXISTS rule_code VARCHAR(100), "
        "ADD COLUMN IF NOT EXISTS is_active BOOLEAN, "
        "ADD COLUMN IF NOT EXISTS affected_from TIMESTAMP WITH TIME ZONE, "
        "ADD COLUMN IF NOT EXISTS affected_to TIMESTAMP WITH TIME ZONE, "
        "ADD COLUMN IF NOT EXISTS impact_type impacttypeenum, "
        "ADD COLUMN IF NOT EXISTS impact_data JSON",
    ),
    (
        "v43e — rule_evaluation_logs: add v2.1 columns (nullable, backfilled)",
        "ALTER TABLE rule_evaluation_logs "
        "ADD COLUMN IF NOT EXISTS proposal_id VARCHAR(100), "
        "ADD COLUMN IF NOT EXISTS customer_cnic VARCHAR(20), "
        "ADD COLUMN IF NOT EXISTS category_code VARCHAR(50), "
        "ADD COLUMN IF NOT EXISTS subcategory_code VARCHAR(50), "
        "ADD COLUMN IF NOT EXISTS channel_code VARCHAR(50), "
        "ADD COLUMN IF NOT EXISTS version_number VARCHAR(20), "
        "ADD COLUMN IF NOT EXISTS input_context_snapshot JSON, "
        "ADD COLUMN IF NOT EXISTS tsar_accumulated DOUBLE PRECISION, "
        "ADD COLUMN IF NOT EXISTS matched_rule_codes JSON, "
        "ADD COLUMN IF NOT EXISTS final_impacts JSON, "
        "ADD COLUMN IF NOT EXISTS execution_duration_ms DOUBLE PRECISION",
    ),
    (
        "v44 — token_usage: per-tenant attribution, cache hits, model and thread",
        "ALTER TABLE token_usage "
        "ADD COLUMN IF NOT EXISTS cached_tokens INTEGER NOT NULL DEFAULT 0, "
        "ADD COLUMN IF NOT EXISTS tenant_id UUID, "
        "ADD COLUMN IF NOT EXISTS model_name VARCHAR(100), "
        "ADD COLUMN IF NOT EXISTS thread_id VARCHAR(100)",
    ),
    (
        "v44a — token_usage: index tenant_id for chargeback queries",
        "CREATE INDEX IF NOT EXISTS ix_token_usage_tenant_id ON token_usage (tenant_id)",
    ),
    (
        "v44b — token_usage: index thread_id for per-conversation cost",
        "CREATE INDEX IF NOT EXISTS ix_token_usage_thread_id ON token_usage (thread_id)",
    ),
    # ── Claims Management module ────────────────────────────────────────────────
    (
        "v45a-enum — create claimstatusenum type if not exists",
        "DO $$ BEGIN "
        "  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'claimstatusenum') THEN "
        "    CREATE TYPE claimstatusenum AS ENUM ("
        "      'New', 'Triaged', 'Under Investigation', 'Pending Documents', "
        "      'Approved', 'Partial Approval', 'Declined', 'Referred to Manager', "
        "      'Reinsurance Referred', 'Settled', 'Closed'"
        "    ); "
        "  END IF; "
        "END $$;",
    ),
    (
        "v45b — add claim_number to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_number VARCHAR(50)",
    ),
    (
        "v45c — index claims.claim_number",
        "CREATE INDEX IF NOT EXISTS ix_claims_claim_number ON claims (claim_number)",
    ),
    (
        "v45d — add case_id to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS case_id UUID REFERENCES cases(caseld)",
    ),
    (
        "v45e — add incident_date to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS incident_date DATE",
    ),
    (
        "v45f — add reported_date to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS reported_date DATE DEFAULT CURRENT_DATE",
    ),
    (
        "v45g — add assigned_adjuster_id to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS assigned_adjuster_id UUID REFERENCES users(id)",
    ),
    (
        "v45h — add reinsurance_referral_id to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS reinsurance_referral_id UUID REFERENCES reinsurance_referrals(id)",
    ),
    (
        "v45i — add settlement_amount to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS settlement_amount DOUBLE PRECISION",
    ),
    (
        "v45j — add settled_at to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS settled_at TIMESTAMP",
    ),
    (
        "v45k — add closed_at to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP",
    ),
    (
        "v46a — add is_contestable to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS is_contestable BOOLEAN DEFAULT FALSE",
    ),
    (
        "v46b — add underwriting_referral_reason to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS underwriting_referral_reason TEXT",
    ),
    (
        "v46c — add underwriting_decision_notes to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS underwriting_decision_notes TEXT",
    ),
    (
        "v46d-enum — add REUNDERWRITING_REQUIRED to claimstatusenum",
        "ALTER TYPE claimstatusenum ADD VALUE IF NOT EXISTS 'REUNDERWRITING_REQUIRED'",
    ),
    (
        # SourceChannelEnum.PORTAL was added to the model but never to the
        # Postgres type, so routers/claims.py's FNOL intake — which stamps every
        # linked SLA case with PORTAL — failed with
        # "invalid input value for enum sourcechannelenum" on every call.
        "v46e-enum — add PORTAL to sourcechannelenum",
        "ALTER TYPE sourcechannelenum ADD VALUE IF NOT EXISTS 'PORTAL'",
    ),
    (
        "v47a — add claimant_type to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS claimant_type VARCHAR(50) DEFAULT 'SELF'",
    ),
    (
        "v47b — add claimant_name to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS claimant_name VARCHAR(255)",
    ),
    (
        "v47c — add claimant_cnic to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS claimant_cnic VARCHAR(20)",
    ),
    (
        "v47d — add claimant_relationship to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS claimant_relationship VARCHAR(50)",
    ),
    (
        "v47e — add claimant_phone to claims",
        "ALTER TABLE claims ADD COLUMN IF NOT EXISTS claimant_phone VARCHAR(50)",
    ),
    (
        "v47f — add extracted_metadata to artifacts",
        "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS extracted_metadata JSON",
    ),
]



# ── Post-data-migration list ───────────────────────────────────────────────────
# Runs after _migrate_rule_engine_v2() has backfilled the columns added above.
# Enforces NOT NULL / uniqueness and drops the old columns it read from.
POST_DATA_MIGRATIONS: list[tuple[str, str]] = [
    (
        "v44a — rule_sets: enforce NOT NULL on scope_type/subcategory_id/rule_code",
        "ALTER TABLE rule_sets "
        "ALTER COLUMN scope_type SET NOT NULL, "
        "ALTER COLUMN subcategory_id SET NOT NULL, "
        "ALTER COLUMN rule_code SET NOT NULL",
    ),
    (
        "v44b — rule_sets: drop legacy domain/code columns",
        "ALTER TABLE rule_sets DROP COLUMN IF EXISTS domain, DROP COLUMN IF EXISTS code",
    ),
    (
        "v44c — rule_sets: unique index on rule_code",
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_rule_sets_rule_code ON rule_sets (rule_code)",
    ),
    (
        "v44d — rule_sets: index on scope_type",
        "CREATE INDEX IF NOT EXISTS ix_rule_sets_scope_type ON rule_sets (scope_type)",
    ),
    (
        "v44e — rule_sets: index on subcategory_id",
        "CREATE INDEX IF NOT EXISTS ix_rule_sets_subcategory_id ON rule_sets (subcategory_id)",
    ),
    (
        "v44f — rule_versions: enforce NOT NULL on version_number, drop version_no",
        "ALTER TABLE rule_versions "
        "ALTER COLUMN version_number SET NOT NULL, "
        "DROP COLUMN IF EXISTS version_no",
    ),
    (
        "v44g — business_rules: enforce NOT NULL on v2.1 columns",
        "ALTER TABLE business_rules "
        "ALTER COLUMN version_id SET NOT NULL, "
        "ALTER COLUMN rule_code SET NOT NULL, "
        "ALTER COLUMN is_active SET NOT NULL, "
        "ALTER COLUMN affected_from SET NOT NULL, "
        "ALTER COLUMN impact_type SET NOT NULL, "
        "ALTER COLUMN impact_data SET NOT NULL",
    ),
    (
        "v44h — business_rules: drop legacy columns",
        "ALTER TABLE business_rules "
        "DROP COLUMN IF EXISTS rule_version_id, "
        "DROP COLUMN IF EXISTS description, "
        "DROP COLUMN IF EXISTS category, "
        "DROP COLUMN IF EXISTS subcategory, "
        "DROP COLUMN IF EXISTS eligibility_criteria, "
        "DROP COLUMN IF EXISTS condition_operator, "
        "DROP COLUMN IF EXISTS conditions, "
        "DROP COLUMN IF EXISTS outcome_payload, "
        "DROP COLUMN IF EXISTS code, "
        "DROP COLUMN IF EXISTS is_enabled",
    ),
    (
        "v44i — business_rules: index on rule_code",
        "CREATE INDEX IF NOT EXISTS ix_business_rules_rule_code ON business_rules (rule_code)",
    ),
    (
        "v44j — business_rules: index on impact_type",
        "CREATE INDEX IF NOT EXISTS ix_business_rules_impact_type ON business_rules (impact_type)",
    ),
    (
        "v44k — business_rules: composite index on active/affected window",
        "CREATE INDEX IF NOT EXISTS ix_business_rules_active_window "
        "ON business_rules (is_active, affected_from, affected_to)",
    ),
    (
        "v44l — rule_versions: composite index on status/effective window",
        "CREATE INDEX IF NOT EXISTS ix_rule_versions_status_window "
        "ON rule_versions (status, effective_from, effective_to)",
    ),
    (
        "v44m — rule_evaluation_logs: enforce NOT NULL on backfilled v2.1 columns",
        "ALTER TABLE rule_evaluation_logs "
        "ALTER COLUMN version_number SET NOT NULL, "
        "ALTER COLUMN input_context_snapshot SET NOT NULL, "
        "ALTER COLUMN tsar_accumulated SET NOT NULL, "
        "ALTER COLUMN matched_rule_codes SET NOT NULL, "
        "ALTER COLUMN final_impacts SET NOT NULL, "
        "ALTER COLUMN execution_duration_ms SET NOT NULL",
    ),
    (
        "v44n — rule_evaluation_logs: drop legacy columns",
        "ALTER TABLE rule_evaluation_logs "
        "DROP COLUMN IF EXISTS case_id, "
        "DROP COLUMN IF EXISTS rule_version_no, "
        "DROP COLUMN IF EXISTS input_context, "
        "DROP COLUMN IF EXISTS outcome",
    ),
    (
        "v44o — rule_evaluation_logs: index on proposal_id",
        "CREATE INDEX IF NOT EXISTS ix_rule_evaluation_logs_proposal_id ON rule_evaluation_logs (proposal_id)",
    ),
    (
        "v44p — rule_evaluation_logs: index on customer_cnic",
        "CREATE INDEX IF NOT EXISTS ix_rule_evaluation_logs_customer_cnic ON rule_evaluation_logs (customer_cnic)",
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


def _as_obj(val, default):
    """Raw-SQL JSON columns come back from asyncpg as strings, not
    dict/list — normalize either shape."""
    if val is None:
        return default
    if isinstance(val, (dict, list)):
        return val
    if isinstance(val, str):
        try:
            return json.loads(val)
        except Exception:
            return default
    return default


def _to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _eq_kwargs(value):
    if isinstance(value, bool):
        return {"value_string": "true" if value else "false"}
    if isinstance(value, (int, float)):
        return {"value_numeric": float(value)}
    return {"value_string": str(value)}


def _map_condition_operator(op, value):
    """Maps an old {field, operator, value} condition (rule_evaluator.py's
    original fixed operator set) to the new ComparisonOperatorEnum value plus
    the RuleCriteria value_* kwargs to populate."""
    op = str(op or "eq").lower().strip()

    if op in ("gt", ">"):
        return "gt", {"value_numeric": _to_float(value)}
    if op in ("gte", ">="):
        return "gte", {"value_numeric": _to_float(value)}
    if op in ("lt", "<"):
        return "lt", {"value_numeric": _to_float(value)}
    if op in ("lte", "<="):
        return "lte", {"value_numeric": _to_float(value)}
    if op in ("ne", "!=", "not_equals"):
        return "neq", _eq_kwargs(value)
    if op in ("in", "is_one_of", "not_in", "is_not_one_of"):
        # `not_in`/`is_not_one_of` had zero real usages in the seeded data —
        # mapped to in_set rather than adding an unused NOT_IN operator.
        items = value if isinstance(value, list) else [value]
        return "in_set", {"value_list": items}
    if op in ("contains", "has"):
        return "contains", {"value_string": str(value)}
    if op in ("between", "range"):
        if isinstance(value, (list, tuple)) and len(value) == 2:
            return "between", {"value_range_min": _to_float(value[0]), "value_range_max": _to_float(value[1])}
        return "between", {"value_range_min": None, "value_range_max": None}
    if op in ("boolean", "is"):
        truthy = value if isinstance(value, bool) else str(value).lower() in ("true", "1", "yes")
        return "eq", {"value_string": "true" if truthy else "false"}
    # eq / == / equals / unrecognized -> eq (safe default)
    return "eq", _eq_kwargs(value)


_IMPACT_TYPE_VALUES = {
    "AUTO_APPROVE", "REQUIRE_MEDICAL", "APPLY_LOADING", "EXCLUSION_CLAUSE",
    "FINANCIAL_JUSTIFICATION", "REFER_TO_UNDERWRITER", "REINSURANCE_FACULTATIVE", "DECLINE",
}


def _map_outcome_to_impact(action_outcome, outcome_payload):
    """Best-effort mapping from the old free-text action_outcome/outcome_payload
    pair to the new typed (impact_type, ActuarialImpactDetail dict). Exact
    ImpactTypeEnum matches pass through unchanged; anything else is classified
    by keyword, defaulting to AUTO_APPROVE for procedural pass/gate outcomes
    (six_gates / eligibility rules aren't actuarial — see plan conflict #5)."""
    outcome_payload = outcome_payload or {}
    label = str(action_outcome or "").upper()

    if label in _IMPACT_TYPE_VALUES:
        impact_type = label
    elif "DECLIN" in label or "REJECT" in label:
        impact_type = "DECLINE"
    elif "MEDICAL" in label:
        impact_type = "REQUIRE_MEDICAL"
    elif "REFER" in label:
        impact_type = "REFER_TO_UNDERWRITER"
    elif "EXCLU" in label:
        impact_type = "EXCLUSION_CLAUSE"
    elif "JUSTIF" in label:
        impact_type = "FINANCIAL_JUSTIFICATION"
    elif "FACULTATIVE" in label or "REINSUR" in label:
        impact_type = "REINSURANCE_FACULTATIVE"
    elif "LOAD" in label or "COMMISSION" in label or "RATE" in label or "TAX" in label:
        impact_type = "APPLY_LOADING"
    else:
        impact_type = "AUTO_APPROVE"

    impact_data = {
        "extra_mortality_pct": float(outcome_payload.get("extra_mortality_pct") or outcome_payload.get("loading_pct") or 0),
        "flat_extra_per_thousand": float(outcome_payload.get("flat_extra_per_thousand") or 0),
        "medical_profile_codes": outcome_payload.get("medical_profile_codes") or outcome_payload.get("tests") or [],
        "hlv_max_multiple": outcome_payload.get("hlv_max_multiple") or outcome_payload.get("hlv_multiple") or outcome_payload.get("multiple"),
        "reinsurance_retention_limit": (
            outcome_payload.get("reinsurance_retention_limit") or outcome_payload.get("retention_limit")
        ),
        "underwriter_authority_level": outcome_payload.get("underwriter_authority_level"),
        "exclusion_riders": outcome_payload.get("exclusion_riders") or [],
        "is_terminal": bool(outcome_payload.get("terminal")),
        "commission_pct": outcome_payload.get("commission_pct") or outcome_payload.get("rate_pct"),
        "withholding_tax_pct": outcome_payload.get("withholding_tax_pct") or outcome_payload.get("wht_pct"),
    }
    return impact_type, impact_data


# Old rule_set code -> (category_code, subcategory_code, subcategory_name, scope_type, channel_code)
_RULE_SET_MAP: dict[str, tuple] = {
    "medical.nml_grid": ("MEDICAL_NML", "NON_MEDICAL_LIMITS", "Non-Medical Limits", "CHANNEL_PRODUCT", "AGENCY_DIRECT"),
    "pricing.base_loading": ("PRICING", "BMI_SMOKING", "BMI & Smoking Loadings", "GLOBAL", None),
    "pricing.occupational_loading": ("PRICING", "OCCUPATIONAL_HAZARD", "Occupational Hazard Loadings", "GLOBAL", None),
    "eligibility.proposal_gates": ("ELIGIBILITY", "POLICY_LIMITS", "Policy Limits", "CHANNEL_PRODUCT", "AGENCY_DIRECT"),
    "underwriting.six_gates": ("UNDERWRITING_GATES", "PRE_UW_GATES", "Pre-Underwriting Gates", "GLOBAL", None),
    "compliance.secp_aml": ("COMPLIANCE_AML", "SANCTIONS_PEP_AML", "Sanctions, PEP & AML", "GLOBAL", None),
    "history.hlv_ceiling": ("INSURANCE_HISTORY", "HLV_CEILING", "Human Life Value Ceiling", "GLOBAL", None),
    "history.score_bands": ("INSURANCE_HISTORY", "SCORE_BANDS", "Insurance History Score Bands", "GLOBAL", None),
    "commission.secp_rate_card": ("COMMISSION_SECP", "STATUTORY_RATES", "SECP Statutory Rates", "GLOBAL", None),
    "rbac.action_role_matrix": ("RBAC_AUTHORIZATION", "ACTION_ROLE_MATRIX", "Action / Role Matrix", "GLOBAL", None),
    "ai.composite_decision_bands": ("AI_DECISION_BANDS", "STANDARD_BANDS", "Standard Decision Bands", "GLOBAL", None),
    "reinsurance.retention_grid": ("REINSURANCE", "SELF_RETENTION", "Self-Retention Grid", "GLOBAL", None),
    "reinsurance.referral_decision": ("REINSURANCE", "FACULTATIVE_REFERRAL", "Facultative Referral", "GLOBAL", None),
}

# category_code -> display name (Category rows, 1:1 with the old RuleDomainEnum values)
_CATEGORY_SEED: list[tuple] = [
    ("ELIGIBILITY", "Eligibility & Policy Limits"),
    ("PRICING", "Pricing & Risk Loadings"),
    ("UNDERWRITING_GATES", "Pre-Underwriting Clearance Gates"),
    ("COMPLIANCE_AML", "AML & Sanctions Compliance"),
    ("MEDICAL_NML", "Medical Examination Limits"),
    ("INSURANCE_HISTORY", "Insurance & Financial History"),
    ("COMMISSION_SECP", "SECP Statutory Commission Rates"),
    ("RBAC_AUTHORIZATION", "Role Authorization Rules"),
    ("AI_DECISION_BANDS", "AI Underwriting Risk Bands"),
    ("REINSURANCE", "Reinsurance & Retention"),
]

# channel_code -> (min_entry_age, max_entry_age, max_maturity_age, min_sum_assured)
# Real seeded partner banks (services/tenant-service/seeds/insurance_plans_seed.py) —
# there is no "Faysal Bank" in this repo's data, so it is not seeded here.
_ELIGIBILITY_SEED: dict[str, tuple] = {
    "AGENCY_DIRECT": (18, 65, 75, 500000.0),
    "BANCASSURANCE_MCB": (18, 60, 70, 500000.0),
    "BANCASSURANCE_ALFALAH": (18, 60, 70, 500000.0),
    "BANCASSURANCE_KHUSHHALI": (18, 59, 65, 100000.0),
    "BANCASSURANCE_MOBILINK": (18, 59, 65, 100000.0),
    "WINDOW_TAKAFUL": (18, 65, 75, 500000.0),
}


async def _migrate_rule_engine_v2(conn) -> None:
    """v43/v44 — populates the rule-engine v2.1 hierarchy (Category ->
    SubCategory -> EligibilityProfile) and backfills RuleSet/RuleVersion/
    ActualRule/RuleEvaluationLog v2.1 columns from the old flat schema,
    exploding each old rule's `conditions` list into RuleCriteria rows.

    MUST run after the v43* ADD COLUMN migrations (new columns must exist)
    and before POST_DATA_MIGRATIONS (old columns — domain/code/conditions/
    outcome_payload/case_id/input_context/outcome/etc — must still exist to
    read from). Idempotent: guarded on whether rule_sets.domain still exists;
    once POST_DATA_MIGRATIONS drops it this function is a no-op.
    """
    from uuid import uuid4

    has_domain = (await conn.execute(text(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name='rule_sets' AND column_name='domain'"
    ))).first()
    if not has_domain:
        log.info("rule engine v2 data migration: already applied, skipping")
        return

    # ── 1. Categories ──────────────────────────────────────────────────────
    category_ids: dict[str, str] = {}
    for code, name in _CATEGORY_SEED:
        row = (await conn.execute(text("SELECT id FROM rule_categories WHERE code=:c"), {"c": code})).first()
        if row:
            category_ids[code] = str(row[0])
        else:
            cid = str(uuid4())
            await conn.execute(text(
                "INSERT INTO rule_categories (id, code, name, description) VALUES (:id, :c, :n, '')"
            ), {"id": cid, "c": code, "n": name})
            category_ids[code] = cid

    subcategory_ids: dict[tuple, str] = {}

    async def _get_or_create_subcategory(category_code: str, sub_code: str, sub_name: str) -> str:
        key = (category_code, sub_code)
        if key in subcategory_ids:
            return subcategory_ids[key]
        row = (await conn.execute(text(
            "SELECT id FROM rule_subcategories WHERE category_id=:cid AND code=:code"
        ), {"cid": category_ids[category_code], "code": sub_code})).first()
        if row:
            sid = str(row[0])
        else:
            sid = str(uuid4())
            await conn.execute(text(
                "INSERT INTO rule_subcategories (id, category_id, code, name) VALUES (:id, :cid, :code, :name)"
            ), {"id": sid, "cid": category_ids[category_code], "code": sub_code, "name": sub_name})
        subcategory_ids[key] = sid
        return sid

    eligibility_ids: dict[tuple, str] = {}

    async def _get_or_create_eligibility(subcategory_id: str, channel_code: str) -> str:
        key = (subcategory_id, channel_code)
        if key in eligibility_ids:
            return eligibility_ids[key]
        row = (await conn.execute(text(
            "SELECT id FROM eligibility_profiles WHERE subcategory_id=:sid AND channel_code=:cc"
        ), {"sid": subcategory_id, "cc": channel_code})).first()
        if row:
            eid = str(row[0])
        else:
            band = _ELIGIBILITY_SEED.get(channel_code, _ELIGIBILITY_SEED["AGENCY_DIRECT"])
            eid = str(uuid4())
            await conn.execute(text(
                "INSERT INTO eligibility_profiles "
                "(id, subcategory_id, channel_code, min_entry_age, max_entry_age, max_maturity_age, min_sum_assured) "
                "VALUES (:id, :sid, :cc, :mina, :maxa, :maxm, :minsa)"
            ), {"id": eid, "sid": subcategory_id, "cc": channel_code,
                "mina": band[0], "maxa": band[1], "maxm": band[2], "minsa": band[3]})
        eligibility_ids[key] = eid
        return eid

    # ── 2. Walk every existing rule_set -> version -> rule -> condition ──────
    rule_sets = (await conn.execute(text("SELECT id, code FROM rule_sets"))).all()

    total_rules = 0
    total_criteria = 0

    for rs_id, rs_code in rule_sets:
        rs_id = str(rs_id)
        mapping = _RULE_SET_MAP.get(rs_code, ("ELIGIBILITY", "UNSPECIFIED", "Unspecified", "GLOBAL", None))
        category_code, sub_code, sub_name, scope_type, channel_code = mapping
        subcategory_id = await _get_or_create_subcategory(category_code, sub_code, sub_name)
        eligibility_id = None
        if scope_type == "CHANNEL_PRODUCT" and channel_code:
            eligibility_id = await _get_or_create_eligibility(subcategory_id, channel_code)

        await conn.execute(text(
            "UPDATE rule_sets SET subcategory_id=:sid, scope_type=:st, eligibility_id=:eid, rule_code=:rc "
            "WHERE id=:id"
        ), {"sid": subcategory_id, "st": scope_type, "eid": eligibility_id, "rc": rs_code, "id": rs_id})

        versions = (await conn.execute(text(
            "SELECT id, version_no, status FROM rule_versions WHERE rule_set_id=:id"
        ), {"id": rs_id})).all()

        for v_id, version_no, status in versions:
            v_id = str(v_id)
            new_status = "ARCHIVED" if str(status) == "RETIRED" else str(status)
            await conn.execute(text(
                "UPDATE rule_versions SET version_number=:vn, status=:st WHERE id=:id"
            ), {"vn": f"{version_no}.0.0", "st": new_status, "id": v_id})

            rules = (await conn.execute(text(
                "SELECT id, code, condition_operator, conditions, action_outcome, outcome_payload, is_enabled "
                "FROM business_rules WHERE rule_version_id=:vid"
            ), {"vid": v_id})).all()

            for (r_id, r_code, cond_op, conditions, action_outcome, outcome_payload, is_enabled) in rules:
                r_id = str(r_id)
                rule_code = r_code or f"RULE-{r_id[:8]}"
                impact_type, impact_data = _map_outcome_to_impact(
                    action_outcome, _as_obj(outcome_payload, {})
                )

                await conn.execute(text(
                    "UPDATE business_rules SET version_id=:vid, rule_code=:rc, is_active=:ia, "
                    "affected_from=COALESCE(created_at, now()), impact_type=:it, impact_data=:idata "
                    "WHERE id=:id"
                ), {"vid": v_id, "rc": rule_code, "ia": bool(is_enabled), "it": impact_type,
                    "idata": json.dumps(impact_data), "id": r_id})
                total_rules += 1

                conditions = _as_obj(conditions, [])
                is_any = str(cond_op or "ALL").upper() == "ANY"
                for idx, cond in enumerate(conditions):
                    group_id = (idx + 1) if is_any else 1
                    field = cond.get("field")
                    new_op, kwargs = _map_condition_operator(cond.get("operator", "eq"), cond.get("value"))
                    value_list = kwargs.get("value_list")
                    await conn.execute(text(
                        "INSERT INTO rule_criteria "
                        "(id, rule_id, group_id, field_name, operator, value_numeric, value_string, "
                        "value_range_min, value_range_max, value_list, target_field_name, target_multiplier) "
                        "VALUES (:id, :rid, :gid, :field, :op, :vn, :vs, :vrmin, :vrmax, :vlist, NULL, 1.0)"
                    ), {
                        "id": str(uuid4()), "rid": r_id, "gid": group_id, "field": field, "op": new_op,
                        "vn": kwargs.get("value_numeric"), "vs": kwargs.get("value_string"),
                        "vrmin": kwargs.get("value_range_min"), "vrmax": kwargs.get("value_range_max"),
                        "vlist": json.dumps(value_list) if value_list is not None else None,
                    })
                    total_criteria += 1

    # ── 3. Backfill rule_evaluation_logs (rename/default, no per-row fan-out) ─
    await conn.execute(text("""
        UPDATE rule_evaluation_logs SET
            proposal_id = case_id,
            version_number = COALESCE(rule_version_no::text, '1') || '.0.0',
            input_context_snapshot = COALESCE(input_context, '{}'::json),
            tsar_accumulated = 0,
            matched_rule_codes = '[]'::json,
            final_impacts = COALESCE(outcome, '{}'::json),
            execution_duration_ms = 0
        WHERE version_number IS NULL
    """))

    log.info(
        "rule engine v2 migration: %d rule sets, %d rules, %d criteria migrated",
        len(rule_sets), total_rules, total_criteria,
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

    # 2b. Rule engine v2.1 data migration — must run after the v43* ADD COLUMN
    #     entries above (new columns must exist) and before POST_DATA_MIGRATIONS
    #     below (old columns it reads from must still exist).
    async with _engine.begin() as conn:
        await _migrate_rule_engine_v2(conn)

    # 2c. Enforce NOT NULL / uniqueness and drop the old rule-engine columns
    #     now that _migrate_rule_engine_v2 has backfilled everything.
    for label, sql in POST_DATA_MIGRATIONS:
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
