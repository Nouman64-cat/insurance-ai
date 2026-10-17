-- Customer-initiated family servicing requests (add / remove / correct a member, change cover, change nominees, cancel, reinstate...).
-- The insurer's staff action them through the existing screens; the request is also written to the policy's audit trail in
-- tenant-service. This table is what the customer sees ("my requests") and can withdraw. No foreign keys to other services.
CREATE TABLE service_requests (
    id               UUID PRIMARY KEY,
    account_id       UUID        NOT NULL REFERENCES accounts (id),
    tenant_id        UUID        NOT NULL,
    family_id        UUID        NOT NULL,
    policy_id        UUID,
    policy_number    TEXT,
    kind             TEXT        NOT NULL,
    reference        TEXT        NOT NULL UNIQUE,
    summary          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    reason           TEXT,
    status           TEXT        NOT NULL DEFAULT 'SUBMITTING' CHECK (status IN ('SUBMITTING', 'SUBMITTED', 'WITHDRAWN')),
    idempotency_key  TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, idempotency_key)
);
CREATE INDEX service_requests_account ON service_requests (account_id, created_at DESC);
