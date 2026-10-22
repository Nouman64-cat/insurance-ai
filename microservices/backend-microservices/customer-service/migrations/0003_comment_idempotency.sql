ALTER TABLE customer_service.events ADD COLUMN idempotency_key UUID;
CREATE UNIQUE INDEX events_operation_key ON customer_service.events(ticket_id, actor_id, kind, idempotency_key) WHERE idempotency_key IS NOT NULL
