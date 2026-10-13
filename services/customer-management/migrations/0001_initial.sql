-- Customer Management: accounts, sessions, throttling, audit, notification state, idempotency, payment attempts.
-- Every table lives in the customer_management schema (search_path is set per connection). No foreign keys to
-- other services' tables: tenant_id / customer_id / policy_id are opaque identifiers owned by tenant-service.

CREATE TABLE accounts (
    id                    UUID PRIMARY KEY,
    tenant_id             UUID        NOT NULL,
    tenant_code           TEXT        NOT NULL,
    customer_id           UUID        NOT NULL,
    username              TEXT        NOT NULL,
    password_hash         TEXT        NOT NULL,
    display_name          TEXT        NOT NULL DEFAULT '',
    state                 TEXT        NOT NULL DEFAULT 'PROVISIONED'
                          CHECK (state IN ('PROVISIONED', 'ACTIVE', 'SUSPENDED', 'CLOSED')),
    must_change_password  BOOLEAN     NOT NULL DEFAULT TRUE,
    credential_expires_at TIMESTAMPTZ,
    language              TEXT        NOT NULL DEFAULT 'en',
    failed_count          INTEGER     NOT NULL DEFAULT 0,
    locked_until          TIMESTAMPTZ,
    password_changed_at   TIMESTAMPTZ,
    activated_at          TIMESTAMPTZ,
    last_login_at         TIMESTAMPTZ,
    suspended_reason      TEXT,
    source                TEXT        NOT NULL DEFAULT 'provisioning',
    version               INTEGER     NOT NULL DEFAULT 1,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, customer_id)
);
-- One login per username inside a tenant (policyholder IDs are minted per tenant).
CREATE UNIQUE INDEX accounts_username_per_tenant ON accounts (tenant_id, lower(username));
CREATE INDEX accounts_username_lookup ON accounts (lower(username));

CREATE TABLE sessions (
    id                   UUID PRIMARY KEY,
    account_id           UUID        NOT NULL REFERENCES accounts (id),
    scope                TEXT        NOT NULL CHECK (scope IN ('full', 'pwd_change')),
    refresh_hash         TEXT        NOT NULL UNIQUE,
    prev_refresh_hash    TEXT,
    ip_hash              TEXT,
    user_agent_hash      TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    idle_expires_at      TIMESTAMPTZ NOT NULL,
    absolute_expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at           TIMESTAMPTZ,
    revoke_reason        TEXT
);
CREATE INDEX sessions_account ON sessions (account_id) WHERE revoked_at IS NULL;

-- Failed and successful sign-in attempts, keyed by the typed username (whether or not it exists) and by IP, so
-- throttling cannot be used to find out which usernames are real.
CREATE TABLE login_attempts (
    id           BIGSERIAL PRIMARY KEY,
    username_key TEXT        NOT NULL,
    ip_hash      TEXT        NOT NULL,
    account_id   UUID,
    outcome      TEXT        NOT NULL,
    at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_user ON login_attempts (username_key, at DESC);
CREATE INDEX login_attempts_ip ON login_attempts (ip_hash, at DESC);

-- Append-only security trail (sign-ins, lockouts, password changes, provisioning). Never holds secrets.
CREATE TABLE security_events (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  UUID,
    account_id UUID,
    kind       TEXT        NOT NULL,
    detail     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    ip_hash    TEXT,
    at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX security_events_account ON security_events (account_id, at DESC);

CREATE TABLE notification_state (
    account_id UUID        NOT NULL REFERENCES accounts (id),
    notice_key TEXT        NOT NULL,
    read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, notice_key)
);

-- Replay protection for state-changing calls (claim submission, document upload, payments).
CREATE TABLE idempotency_keys (
    account_id    UUID        NOT NULL REFERENCES accounts (id),
    scope         TEXT        NOT NULL,
    key           TEXT        NOT NULL,
    request_hash  TEXT        NOT NULL,
    status_code   INTEGER,
    response      JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, scope, key)
);

-- One row per premium payment the customer started. The payment itself is SIMULATED (mock gateway).
CREATE TABLE payment_attempts (
    id               UUID PRIMARY KEY,
    account_id       UUID          NOT NULL REFERENCES accounts (id),
    tenant_id        UUID          NOT NULL,
    policy_id        UUID          NOT NULL,
    schedule_id      UUID          NOT NULL,
    amount           NUMERIC(14,2) NOT NULL,
    method           TEXT          NOT NULL,
    status           TEXT          NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
    simulated        BOOLEAN       NOT NULL DEFAULT TRUE,
    gateway_reference TEXT         NOT NULL,
    idempotency_key  TEXT          NOT NULL,
    receipt_no       TEXT,
    failure_code     TEXT,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    UNIQUE (account_id, idempotency_key),
    UNIQUE (gateway_reference)
);
CREATE INDEX payment_attempts_schedule ON payment_attempts (schedule_id, status);
