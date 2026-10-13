-- Request Management: initial schema.
-- Applied by app/migrate.py as the schema owner (REQUEST_MGMT_MIGRATION_DATABASE_URL), inside one transaction,
-- recorded in request_management.schema_migrations. Never edit an applied migration: add a new numbered file.
-- External ids (tenants, users, customers, earnings, branches) are plain UUIDs: no foreign keys leave this schema.

SET search_path TO request_management;

-- ── Routing configuration ────────────────────────────────────────────────────
CREATE TABLE routing_rules (
    id              UUID PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    request_type    TEXT NOT NULL,
    branch_id       UUID NULL,                      -- NULL: every branch
    target_kind     TEXT NOT NULL CHECK (target_kind IN ('USER', 'ROLE')),
    target_user_id  UUID NULL,
    target_role     TEXT NULL,
    target_label    TEXT NOT NULL,                  -- display snapshot ("Ayesha Khan", "Underwriter queue")
    sla_hours       INTEGER NOT NULL DEFAULT 72 CHECK (sla_hours BETWEEN 1 AND 2160),
    description     TEXT NOT NULL DEFAULT '',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    version         INTEGER NOT NULL DEFAULT 1,
    created_by      UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by      UUID NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((target_kind = 'USER' AND target_user_id IS NOT NULL AND target_role IS NULL)
        OR (target_kind = 'ROLE' AND target_role IS NOT NULL AND target_user_id IS NULL))
);
-- At most one active rule per tenant, type and branch (tenant-wide counts as one "branch").
CREATE UNIQUE INDEX uq_routing_active ON routing_rules
    (tenant_id, request_type, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE is_active;
CREATE INDEX ix_routing_tenant ON routing_rules (tenant_id, request_type);

-- ── Requests ─────────────────────────────────────────────────────────────────
CREATE TABLE request_counters (
    tenant_id   UUID NOT NULL,
    year        INTEGER NOT NULL,
    last_no     INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, year)
);

CREATE TABLE requests (
    id                      UUID PRIMARY KEY,
    tenant_id               UUID NOT NULL,
    reference_no            TEXT NOT NULL,
    request_type            TEXT NOT NULL,
    title                   TEXT NOT NULL,
    priority                TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
    review_status           TEXT NOT NULL DEFAULT 'DRAFT' CHECK (review_status IN
                                ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'CANCELLED')),
    execution_status        TEXT NOT NULL DEFAULT 'NOT_APPLICABLE' CHECK (execution_status IN
                                ('NOT_APPLICABLE', 'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    requester_id            UUID NOT NULL,
    requester_name          TEXT NOT NULL,
    requester_role          TEXT NOT NULL,
    branch_id               UUID NULL,
    subject_kind            TEXT NOT NULL DEFAULT 'NONE' CHECK (subject_kind IN ('NONE', 'CUSTOMER', 'COMMISSION_EARNING', 'POLICY', 'CASE')),
    subject_id              UUID NULL,
    subject_label           TEXT NULL,              -- display snapshot, e.g. the customer's name
    current_revision_no     INTEGER NOT NULL DEFAULT 1,
    submitted_revision_no   INTEGER NULL,           -- the revision under review / decided
    assignee_user_id        UUID NULL,
    assignee_name           TEXT NULL,
    queue_role              TEXT NULL,              -- the team that owns it when routed to a role
    routing_rule_id         UUID NULL,
    routing_snapshot        JSONB NULL,
    due_at                  TIMESTAMPTZ NULL,
    submitted_at            TIMESTAMPTZ NULL,
    decided_at              TIMESTAMPTZ NULL,
    decided_by              UUID NULL,
    decision_reason         TEXT NULL,
    closed_reason           TEXT NULL,              -- cancellation reason
    last_reminder_at        TIMESTAMPTZ NULL,
    create_key              TEXT NULL,              -- idempotency key of the create call
    version                 INTEGER NOT NULL DEFAULT 1,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, reference_no),
    UNIQUE (tenant_id, requester_id, create_key),
    -- An open request always has an accountable owner.
    CHECK (review_status IN ('DRAFT', 'CANCELLED', 'APPROVED', 'REJECTED') OR assignee_user_id IS NOT NULL OR queue_role IS NOT NULL)
);
CREATE INDEX ix_requests_tenant_status ON requests (tenant_id, review_status, updated_at DESC);
CREATE INDEX ix_requests_requester ON requests (tenant_id, requester_id, updated_at DESC);
CREATE INDEX ix_requests_assignee ON requests (tenant_id, assignee_user_id) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX ix_requests_queue ON requests (tenant_id, queue_role) WHERE queue_role IS NOT NULL;
CREATE INDEX ix_requests_due ON requests (due_at) WHERE review_status IN ('SUBMITTED', 'IN_REVIEW');
CREATE INDEX ix_requests_subject ON requests (tenant_id, subject_kind, subject_id);

-- Each revision is what the requester proposed at one point. Frozen at submission: a submitted revision never
-- changes again (trigger below), so a decision always points at exactly what the reviewer saw.
CREATE TABLE request_revisions (
    id              UUID PRIMARY KEY,
    request_id      UUID NOT NULL REFERENCES requests (id),
    tenant_id       UUID NOT NULL,
    revision_no     INTEGER NOT NULL,
    payload         JSONB NOT NULL,
    subject_snapshot JSONB NULL,                    -- "before" values captured at submission
    content_hash    TEXT NULL,
    created_by      UUID NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    frozen_at       TIMESTAMPTZ NULL,
    UNIQUE (request_id, revision_no)
);

CREATE FUNCTION forbid_frozen_revision_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.frozen_at IS NOT NULL THEN RAISE EXCEPTION 'submitted revisions are immutable'; END IF;
        RETURN OLD;
    END IF;
    IF OLD.frozen_at IS NOT NULL THEN
        RAISE EXCEPTION 'submitted revisions are immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_revisions_immutable BEFORE UPDATE OR DELETE ON request_revisions
    FOR EACH ROW EXECUTE FUNCTION forbid_frozen_revision_change();

-- ── Assignment, decisions, discussion ────────────────────────────────────────
CREATE TABLE assignments (
    id                  UUID PRIMARY KEY,
    request_id          UUID NOT NULL REFERENCES requests (id),
    tenant_id           UUID NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN ('ROUTED', 'CLAIMED', 'RELEASED', 'REASSIGNED')),
    assignee_user_id    UUID NULL,
    assignee_name       TEXT NULL,
    queue_role          TEXT NULL,
    assigned_by         UUID NULL,                  -- NULL: the routing engine
    reason              TEXT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_assignments_request ON assignments (request_id, created_at);

CREATE TABLE decisions (
    id              UUID PRIMARY KEY,
    request_id      UUID NOT NULL REFERENCES requests (id),
    tenant_id       UUID NOT NULL,
    revision_no     INTEGER NOT NULL,
    decision        TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED', 'NEEDS_INFORMATION')),
    reason          TEXT NOT NULL,
    resolution      TEXT NULL,                      -- e.g. a commission dispute's outcome category
    decided_by      UUID NOT NULL,
    decided_by_name TEXT NOT NULL,
    decided_by_role TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One final decision per reviewed revision, whatever the race.
CREATE UNIQUE INDEX uq_final_decision ON decisions (request_id, revision_no) WHERE decision IN ('APPROVED', 'REJECTED');

CREATE TABLE comments (
    id              UUID PRIMARY KEY,
    request_id      UUID NOT NULL REFERENCES requests (id),
    tenant_id       UUID NOT NULL,
    author_id       UUID NULL,                      -- NULL: the system
    author_name     TEXT NOT NULL,
    visibility      TEXT NOT NULL CHECK (visibility IN ('REQUESTER', 'INTERNAL')),
    body            TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_comments_request ON comments (request_id, created_at);

CREATE TABLE attachments (
    id              UUID PRIMARY KEY,
    request_id      UUID NOT NULL REFERENCES requests (id),
    tenant_id       UUID NOT NULL,
    uploaded_by     UUID NOT NULL,
    uploaded_by_name TEXT NOT NULL,
    visibility      TEXT NOT NULL CHECK (visibility IN ('REQUESTER', 'INTERNAL')),
    file_name       TEXT NOT NULL,
    content_type    TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL CHECK (size_bytes > 0),
    sha256          TEXT NOT NULL,
    storage_key     TEXT NOT NULL UNIQUE,           -- always generated by the service, never by the client
    revision_no     INTEGER NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ NULL
);
CREATE INDEX ix_attachments_request ON attachments (request_id);

-- ── Audit (append-only) ──────────────────────────────────────────────────────
CREATE TABLE audit_events (
    id                      UUID PRIMARY KEY,
    tenant_id               UUID NOT NULL,
    request_id              UUID NULL,              -- NULL: tenant-level events (routing changes)
    event_type              TEXT NOT NULL,
    actor_id                UUID NULL,              -- NULL: the system
    actor_name              TEXT NOT NULL,
    actor_role              TEXT NULL,
    revision_no             INTEGER NULL,
    from_review_status      TEXT NULL,
    to_review_status        TEXT NULL,
    from_execution_status   TEXT NULL,
    to_execution_status     TEXT NULL,
    reason                  TEXT NULL,
    data                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_request ON audit_events (request_id, created_at);
CREATE INDEX ix_audit_tenant ON audit_events (tenant_id, created_at);

CREATE FUNCTION forbid_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit events are append-only';
END $$;
CREATE TRIGGER trg_audit_append_only BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();

-- ── Execution ────────────────────────────────────────────────────────────────
CREATE TABLE executions (
    id                  UUID PRIMARY KEY,
    request_id          UUID NOT NULL REFERENCES requests (id),
    tenant_id           UUID NOT NULL,
    revision_no         INTEGER NOT NULL,
    execution_key       TEXT NOT NULL UNIQUE,       -- sent to the domain service as its idempotency key
    operation           TEXT NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    attempts            INTEGER NOT NULL DEFAULT 0,
    max_attempts        INTEGER NOT NULL DEFAULT 5,
    next_attempt_at     TIMESTAMPTZ NULL,           -- a retry waiting for its time; NULL once dispatched
    lease_until         TIMESTAMPTZ NULL,           -- RUNNING attempts past this are presumed crashed
    last_error_code     TEXT NULL,
    last_error          TEXT NULL,
    result              JSONB NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ NULL
);
CREATE INDEX ix_executions_request ON executions (request_id);
CREATE INDEX ix_executions_due ON executions (next_attempt_at) WHERE status = 'PENDING' AND next_attempt_at IS NOT NULL;

CREATE TABLE execution_attempts (
    id              UUID PRIMARY KEY,
    execution_id    UUID NOT NULL REFERENCES executions (id),
    tenant_id       UUID NOT NULL,
    attempt_no      INTEGER NOT NULL,
    triggered_by    UUID NULL,                      -- a user's manual retry, or NULL for the worker
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ NULL,
    outcome         TEXT NULL CHECK (outcome IN ('SUCCEEDED', 'RETRYABLE_ERROR', 'FAILED', 'CONFLICT')),
    error_code      TEXT NULL,
    error_message   TEXT NULL,
    UNIQUE (execution_id, attempt_no)
);

-- ── Reliability: idempotency, outbox, consumer deduplication ─────────────────
CREATE TABLE idempotency_keys (
    tenant_id       UUID NOT NULL,
    actor_id        UUID NOT NULL,
    scope           TEXT NOT NULL,                  -- e.g. "submit:<request id>"
    key             TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    response_body   JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, actor_id, scope, key)
);

CREATE TABLE outbox_events (
    id                  UUID PRIMARY KEY,           -- the event_id consumers deduplicate on
    tenant_id           UUID NOT NULL,
    request_id          UUID NULL,
    event_type          TEXT NOT NULL,
    payload             JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at        TIMESTAMPTZ NULL,
    publish_attempts    INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT NULL
);
CREATE INDEX ix_outbox_unpublished ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE processed_messages (
    consumer        TEXT NOT NULL,
    event_id        UUID NOT NULL,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
);

-- ── In-app notifications ─────────────────────────────────────────────────────
CREATE TABLE notifications (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    recipient_user_id   UUID NOT NULL,
    request_id          UUID NULL,
    event_id            UUID NOT NULL,
    kind                TEXT NOT NULL,
    title               TEXT NOT NULL,
    body                TEXT NOT NULL,
    read_at             TIMESTAMPTZ NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (event_id, recipient_user_id)            -- a redelivered event never notifies twice
);
CREATE INDEX ix_notifications_recipient ON notifications (tenant_id, recipient_user_id, created_at DESC);
