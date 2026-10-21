CREATE TABLE customer_service.audit_outbox (
 id UUID PRIMARY KEY,
 tenant_id UUID,
 payload JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 published_at TIMESTAMPTZ,
 publish_attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT);
CREATE INDEX audit_outbox_pending ON customer_service.audit_outbox(created_at) WHERE published_at IS NULL
