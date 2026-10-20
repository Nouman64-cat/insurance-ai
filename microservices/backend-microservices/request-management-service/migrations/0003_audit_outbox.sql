-- Request Management: transactional outbox for audit intents.
-- Every audit_events row is mirrored by an intent written here in the same transaction; the audit relay publishes it
-- to Kafka (insurance.audit.events.v1) for the Audit Service's hash-chained ledger. See shared/audit/outbox.py.

SET search_path TO request_management;

CREATE TABLE audit_outbox (
    id               UUID PRIMARY KEY,
    tenant_id        UUID,
    payload          JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at     TIMESTAMPTZ,
    publish_attempts INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT
);
CREATE INDEX audit_outbox_pending ON audit_outbox (created_at) WHERE published_at IS NULL;
