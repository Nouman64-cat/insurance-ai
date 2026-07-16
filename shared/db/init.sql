-- ─────────────────────────────────────────────────────────────────────────────
-- Bootstrap script executed once when the PostgreSQL container first starts.
-- Table schema is managed by SQLModel (create_all) / Alembic — not here.
-- ─────────────────────────────────────────────────────────────────────────────

-- Create the insurance database if it doesn't exist
CREATE DATABASE insurance;

-- Connect to the insurance database and create extensions
\c insurance

-- Required for gen_random_uuid() used by SQLModel default columns
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
