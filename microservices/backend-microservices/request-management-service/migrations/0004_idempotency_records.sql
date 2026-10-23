-- Service-owned durable operation receipts; existing legacy keys remain intact.

CREATE TABLE idempotency_records (
	id UUID NOT NULL, 
	scope_id VARCHAR(160) NOT NULL, 
	idempotency_key VARCHAR(128) NOT NULL, 
	operation VARCHAR(160) NOT NULL, 
	request_hash VARCHAR(64) NOT NULL, 
	status VARCHAR(16) NOT NULL, 
	http_status INTEGER, 
	response_json JSONB, 
	resource_type VARCHAR(80), 
	resource_id VARCHAR(128), 
	attempt_count INTEGER DEFAULT '1' NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	completed_at TIMESTAMP WITH TIME ZONE, 
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	last_error_code VARCHAR(80), 
	lease_token UUID, 
	lease_expires_at TIMESTAMP WITH TIME ZONE, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_idempotency_operation UNIQUE (scope_id, operation, idempotency_key), 
	CONSTRAINT ck_idempotency_status CHECK (status IN ('PROCESSING','COMPLETED','FAILED','UNKNOWN')), 
	CONSTRAINT ck_idempotency_attempts CHECK (attempt_count > 0)
)

;
CREATE INDEX ix_idempotency_expiry ON idempotency_records (expires_at);
CREATE INDEX ix_idempotency_recovery ON idempotency_records (status, lease_expires_at);
