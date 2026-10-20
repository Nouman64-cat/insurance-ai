-- Audit Service ledger (schema audit).
--
-- What the database itself enforces, independent of the application code:
--   * chain identity   a chain is exactly one (environment, tenant) pair, or the environment's platform chain, and its
--                      genesis hash is derived from its id;
--   * sequencing       an event is accepted only as head+1 and only if previous_hash equals the chain head's hash, so
--                      committed gaps, duplicates and forks cannot be written; the head is advanced by the same
--                      trigger, never by the application;
--   * isolation        an event can only be stored in the chain of its own tenant and environment;
--   * append-only      UPDATE, DELETE and TRUNCATE on events, chains and verification history are rejected;
--   * least privilege  the application role (see app/migrate.py: apply_grants) can SELECT, INSERT events and call
--                      two functions; it has no UPDATE, DELETE or DDL rights anywhere.
-- A superuser or the schema owner can still disable triggers; SHA-256 chaining detects edits made that way but cannot
-- prevent a privileged attacker from rewriting a whole chain and its head (see README: Security limits, Stage 2).
SET search_path TO audit;

-- One row: this database's identity. Two independently initialised databases get different environment ids and so
-- different chain ids and genesis hashes.
CREATE TABLE environment (
    singleton      BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    environment_id UUID NOT NULL DEFAULT gen_random_uuid(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO environment DEFAULT VALUES;

CREATE TABLE chains (
    chain_id       TEXT PRIMARY KEY,
    scope          TEXT NOT NULL CHECK (scope IN ('TENANT', 'PLATFORM')),
    tenant_id      UUID,
    environment_id UUID NOT NULL,
    genesis_hash   TEXT NOT NULL CHECK (genesis_hash ~ '^[0-9a-f]{64}$'),
    head_sequence  BIGINT NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
    head_hash      TEXT NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((scope = 'TENANT' AND tenant_id IS NOT NULL) OR (scope = 'PLATFORM' AND tenant_id IS NULL))
);
CREATE UNIQUE INDEX chains_identity ON chains (environment_id, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE events (
    event_id        UUID PRIMARY KEY,
    chain_id        TEXT NOT NULL REFERENCES chains (chain_id),
    sequence_number BIGINT NOT NULL CHECK (sequence_number >= 1),
    tenant_id       UUID,
    environment_id  UUID NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL,
    actor_id        TEXT,
    actor_type      TEXT NOT NULL,
    actor_role      TEXT,
    service_name    TEXT NOT NULL,
    module          TEXT NOT NULL,
    action          TEXT NOT NULL,
    entity_type     TEXT NOT NULL,
    entity_id       TEXT,
    case_id         TEXT,
    correlation_id  TEXT,
    source_event_id TEXT NOT NULL,
    previous_value  JSONB,
    new_value       JSONB,
    outcome         TEXT NOT NULL,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    previous_hash   TEXT NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
    current_hash    TEXT NOT NULL CHECK (current_hash ~ '^[0-9a-f]{64}$'),
    hash_version    SMALLINT NOT NULL CHECK (hash_version >= 1),
    UNIQUE (chain_id, sequence_number),
    -- Event-level idempotency: one ledger event per source event, whatever the delivery count.
    UNIQUE (service_name, source_event_id)
);
CREATE INDEX events_tenant_time ON events (tenant_id, recorded_at DESC, sequence_number DESC);
CREATE INDEX events_time ON events (recorded_at DESC, sequence_number DESC);
CREATE INDEX events_module ON events (module, recorded_at DESC);
CREATE INDEX events_action ON events (action, recorded_at DESC);
CREATE INDEX events_entity ON events (entity_type, entity_id);
CREATE INDEX events_actor ON events (actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX events_case ON events (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX events_correlation ON events (correlation_id) WHERE correlation_id IS NOT NULL;

-- Messages that could not be turned into ledger events (malformed, or reusing a source id across chains). Kept for
-- inspection; the consumer moves on so one poison message never blocks the topic.
CREATE TABLE dead_letters (
    id           BIGSERIAL PRIMARY KEY,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    topic        TEXT NOT NULL,
    partition_id INTEGER NOT NULL,
    msg_offset   BIGINT NOT NULL,
    message_key  TEXT,
    raw_value    TEXT,
    error_code   TEXT NOT NULL,
    error_detail TEXT,
    UNIQUE (topic, partition_id, msg_offset)
);

-- History of verification runs (one row per finished run).
CREATE TABLE verification_runs (
    run_id                 UUID PRIMARY KEY,
    chain_id               TEXT NOT NULL REFERENCES chains (chain_id),
    tenant_id              UUID,
    trigger                TEXT NOT NULL CHECK (trigger IN ('SCHEDULED', 'ON_DEMAND')),
    requested_by           TEXT,
    started_at             TIMESTAMPTZ NOT NULL,
    finished_at            TIMESTAMPTZ NOT NULL,
    duration_ms            INTEGER NOT NULL,
    status                 TEXT NOT NULL CHECK (status IN ('VALID', 'INVALID')),
    from_sequence          BIGINT NOT NULL,
    to_sequence            BIGINT,
    head_sequence          BIGINT NOT NULL,
    total_events_checked   BIGINT NOT NULL,
    first_invalid_sequence BIGINT,
    reason                 TEXT,
    details                JSONB NOT NULL DEFAULT '{}'::jsonb,
    head_checked           BOOLEAN NOT NULL
);
CREATE INDEX verification_runs_chain ON verification_runs (chain_id, finished_at DESC);

-- ── Functions ────────────────────────────────────────────────────────────────

-- Rejects the statement. Used for every table that must never change after insertion.
CREATE FUNCTION reject_change() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
    RAISE EXCEPTION 'audit records are append-only: % on % is not permitted', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION chain_genesis_hash(p_chain_id TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path FROM CURRENT AS $$
    SELECT encode(sha256(convert_to('insurance-ai/audit-genesis/v1', 'UTF8') || '\x00'::bytea || convert_to(p_chain_id, 'UTF8')), 'hex')
$$;

-- A chain is created only with its derived identity and an empty head.
CREATE FUNCTION chains_guard_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE env UUID;
BEGIN
    SELECT environment_id INTO env FROM environment;
    IF NEW.environment_id <> env THEN
        RAISE EXCEPTION 'audit: chain belongs to another environment' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.chain_id <> env::text || ':' || COALESCE(NEW.tenant_id::text, 'platform') THEN
        RAISE EXCEPTION 'audit: chain id does not match its environment and tenant' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.head_sequence <> 0 OR NEW.genesis_hash <> NEW.head_hash OR NEW.genesis_hash <> chain_genesis_hash(NEW.chain_id) THEN
        RAISE EXCEPTION 'audit: a new chain must start at its genesis hash' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END $$;

-- The head moves only when an event is appended (the events trigger below updates it, one trigger level deep).
CREATE FUNCTION chains_guard_update() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
    IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'audit: a chain head can only advance by appending an event' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.chain_id <> OLD.chain_id OR NEW.scope <> OLD.scope OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.environment_id <> OLD.environment_id OR NEW.genesis_hash <> OLD.genesis_hash THEN
        RAISE EXCEPTION 'audit: chain identity is immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$;

-- Accepts an event only as the next link of its own chain, then advances the head.
CREATE FUNCTION events_guard_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE c chains%ROWTYPE;
BEGIN
    SELECT * INTO c FROM chains WHERE chain_id = NEW.chain_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'audit: unknown chain %', NEW.chain_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM c.tenant_id OR NEW.environment_id <> c.environment_id THEN
        RAISE EXCEPTION 'audit: event does not belong to this chain (tenant or environment mismatch)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.sequence_number <> c.head_sequence + 1 THEN
        RAISE EXCEPTION 'audit: sequence % is not the next sequence of chain % (head is %)', NEW.sequence_number, NEW.chain_id, c.head_sequence
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.previous_hash <> c.head_hash THEN
        RAISE EXCEPTION 'audit: previous_hash does not equal the head of chain %', NEW.chain_id USING ERRCODE = 'check_violation';
    END IF;
    UPDATE chains SET head_sequence = NEW.sequence_number, head_hash = NEW.current_hash, updated_at = now()
        WHERE chain_id = NEW.chain_id;
    RETURN NEW;
END $$;

-- The application role calls these two instead of touching the chains table.
CREATE FUNCTION ensure_chain(p_tenant_id UUID) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE env UUID; cid TEXT;
BEGIN
    SELECT environment_id INTO env FROM environment;
    cid := env::text || ':' || COALESCE(p_tenant_id::text, 'platform');
    INSERT INTO chains (chain_id, scope, tenant_id, environment_id, genesis_hash, head_sequence, head_hash)
        VALUES (cid, CASE WHEN p_tenant_id IS NULL THEN 'PLATFORM' ELSE 'TENANT' END, p_tenant_id, env,
                chain_genesis_hash(cid), 0, chain_genesis_hash(cid))
        ON CONFLICT (chain_id) DO NOTHING;
    RETURN cid;
END $$;

-- Takes the chain's row lock (held to the end of the transaction) and returns its head: the serialisation point.
CREATE FUNCTION lock_chain(p_chain_id TEXT)
RETURNS TABLE (head_sequence BIGINT, head_hash TEXT, tenant_id UUID, environment_id UUID)
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$
    SELECT c.head_sequence, c.head_hash, c.tenant_id, c.environment_id FROM chains c WHERE c.chain_id = p_chain_id FOR UPDATE
$$;

-- ── Triggers ─────────────────────────────────────────────────────────────────

CREATE TRIGGER environment_immutable BEFORE UPDATE OR DELETE ON environment FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER environment_no_truncate BEFORE TRUNCATE ON environment FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TRIGGER chains_insert BEFORE INSERT ON chains FOR EACH ROW EXECUTE FUNCTION chains_guard_insert();
CREATE TRIGGER chains_update BEFORE UPDATE ON chains FOR EACH ROW EXECUTE FUNCTION chains_guard_update();
CREATE TRIGGER chains_no_delete BEFORE DELETE ON chains FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER chains_no_truncate BEFORE TRUNCATE ON chains FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TRIGGER events_insert BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION events_guard_insert();
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TRIGGER dead_letters_immutable BEFORE UPDATE OR DELETE ON dead_letters FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER dead_letters_no_truncate BEFORE TRUNCATE ON dead_letters FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TRIGGER verification_runs_immutable BEFORE UPDATE OR DELETE ON verification_runs FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER verification_runs_no_truncate BEFORE TRUNCATE ON verification_runs FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Nothing here is callable by PUBLIC; app/migrate.py grants EXECUTE on ensure_chain and lock_chain to the app role.
REVOKE ALL ON FUNCTION ensure_chain(UUID), lock_chain(TEXT) FROM PUBLIC;
