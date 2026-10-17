-- Walk-in customers: a visitor who proves control of an email address with a one-time code gets a RESTRICTED identity that can
-- only browse plans, submit one interest request and follow it. It is deliberately separate from `accounts` (full portal
-- logins for policyholders): a walk-in token is signed for a different audience and can never open a policy, claim or payment.
-- The request itself (the lead) lives in tenant-service; this schema only holds who proved which email, and when.
CREATE TABLE walk_in_identities (
    id            UUID PRIMARY KEY,
    tenant_id     UUID        NOT NULL,
    email         TEXT        NOT NULL,              -- lower-case, verified
    display_name  TEXT        NOT NULL DEFAULT '',
    language      TEXT        NOT NULL DEFAULT 'en',
    handed_off_at TIMESTAMPTZ,                       -- first time we saw that a full portal account exists for their customer
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

CREATE TABLE walk_in_otps (
    id          UUID PRIMARY KEY,
    tenant_id   UUID        NOT NULL,
    email       TEXT        NOT NULL,
    code_hash   TEXT        NOT NULL,                -- keyed hash, the code itself is never stored
    ip_hash     TEXT,
    attempts    INTEGER     NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX walk_in_otps_email ON walk_in_otps (tenant_id, email, created_at DESC);
CREATE INDEX walk_in_otps_ip ON walk_in_otps (ip_hash, created_at DESC);

CREATE TABLE walk_in_sessions (
    id          UUID PRIMARY KEY,
    identity_id UUID        NOT NULL REFERENCES walk_in_identities (id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ
);
CREATE INDEX walk_in_sessions_identity ON walk_in_sessions (identity_id);
