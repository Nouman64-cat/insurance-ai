CREATE TABLE customer_service.tickets (
 id UUID PRIMARY KEY, tenant_id UUID NOT NULL, requester_id UUID NOT NULL,
 requester_name TEXT NOT NULL, customer_id UUID, policy_id UUID,
 title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
 priority TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN', assignee_id UUID,
 assignee_name TEXT, due_at TIMESTAMPTZ NOT NULL, resolution TEXT,
 version INTEGER NOT NULL DEFAULT 1, idempotency_key UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(tenant_id, requester_id, idempotency_key));
CREATE INDEX tickets_queue ON customer_service.tickets(tenant_id,status,created_at DESC);
CREATE TABLE customer_service.events (
 id BIGSERIAL PRIMARY KEY, ticket_id UUID NOT NULL REFERENCES customer_service.tickets(id),
 actor_id UUID NOT NULL, actor_name TEXT NOT NULL, kind TEXT NOT NULL,
 body TEXT NOT NULL, internal BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX events_ticket ON customer_service.events(ticket_id,id);
