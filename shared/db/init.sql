-- ─────────────────────────────────────────────────────────────────────────────
-- Manual bootstrap for the external Postgres instance (no longer auto-run by
-- Docker — Postgres is not containerized in this project).
-- Table schema is managed by SQLModel (create_all) / Alembic — not here.
-- Run against your local/external Postgres server, e.g.:
--   psql -h host.docker.internal -U postgres -d postgres -f shared/db/init.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Create the database if it doesn't exist
CREATE DATABASE "insurance-ai";

-- Connect to the database and create extensions
\c "insurance-ai"

-- Required for gen_random_uuid() used by SQLModel default columns
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
