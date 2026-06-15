-- ─────────────────────────────────────────────────────────────────────────────
-- Bootstrap script executed once when the PostgreSQL container first starts.
-- Table schema is managed by SQLModel (create_all) / Alembic — not here.
-- ─────────────────────────────────────────────────────────────────────────────

-- Required for gen_random_uuid() used by SQLModel default columns
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
