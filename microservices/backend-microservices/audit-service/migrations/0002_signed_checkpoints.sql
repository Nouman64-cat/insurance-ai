-- Stage 2: signed checkpoints, the signing-key mirror, the durable checkpoint scheduler state, alerts and anchored
-- verification history. Nothing here alters events, chains or any existing hash.
--
-- IMPORTANT: this database is *not* the root of trust. A checkpoint row is only a convenient copy; the authoritative,
-- independently stored copies are the signed files in the protected store written by the isolated signer, and the trusted
-- public keys come from the signer-maintained registry file, never from signing_keys. The triggers below keep honest
-- writers consistent (strict numbering, linkage, append-only); they cannot, and do not claim to, stop a database owner.
SET search_path TO audit;

CREATE FUNCTION checkpoint_genesis_hash(p_chain_id TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path FROM CURRENT AS $$
    SELECT encode(sha256(convert_to('insurance-ai/audit-checkpoint-genesis/v1', 'UTF8') || '\x00'::bytea || convert_to(p_chain_id, 'UTF8')), 'hex')
$$;

-- A cache of the trusted public keys (history is never deleted so old checkpoints stay verifiable).
CREATE TABLE signing_keys (
    key_id         TEXT PRIMARY KEY,
    signer_id      TEXT NOT NULL,
    key_version    INTEGER NOT NULL CHECK (key_version >= 1),
    environment_id UUID NOT NULL,
    tenant_scope   TEXT NOT NULL,
    public_key     TEXT NOT NULL,
    fingerprint    TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    algorithm      TEXT NOT NULL CHECK (algorithm = 'Ed25519'),
    status         TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
    created_at     TIMESTAMPTZ NOT NULL,
    activated_at   TIMESTAMPTZ NOT NULL,
    retired_at     TIMESTAMPTZ,
    statement      JSONB NOT NULL,
    recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (environment_id, key_version)
);

CREATE TABLE checkpoints (
    checkpoint_id            UUID PRIMARY KEY,
    chain_id                 TEXT NOT NULL REFERENCES chains (chain_id),
    tenant_id                UUID,
    environment_id           UUID NOT NULL,
    checkpoint_number        BIGINT NOT NULL CHECK (checkpoint_number >= 1),
    start_sequence           BIGINT NOT NULL CHECK (start_sequence >= 1),
    end_sequence             BIGINT NOT NULL,
    event_count              BIGINT NOT NULL,
    last_event_hash          TEXT NOT NULL CHECK (last_event_hash ~ '^[0-9a-f]{64}$'),
    previous_checkpoint_hash TEXT NOT NULL CHECK (previous_checkpoint_hash ~ '^[0-9a-f]{64}$'),
    checkpoint_hash          TEXT NOT NULL CHECK (checkpoint_hash ~ '^[0-9a-f]{64}$'),
    created_at               TIMESTAMPTZ NOT NULL,
    signer_id                TEXT NOT NULL,
    signing_key_id           TEXT NOT NULL,
    key_version              INTEGER NOT NULL,
    signature_algorithm      TEXT NOT NULL CHECK (signature_algorithm = 'Ed25519'),
    payload_version          INTEGER NOT NULL,
    canonical_payload        TEXT NOT NULL,                 -- the exact signed bytes (ASCII)
    signature                TEXT NOT NULL,                 -- base64, stored apart from the payload it signs
    storage_path             TEXT NOT NULL,                 -- the protected copy outside PostgreSQL
    protected_at             TIMESTAMPTZ NOT NULL,          -- a row exists only once signing AND protected storage succeeded
    recorded_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (chain_id, checkpoint_number),
    CHECK (end_sequence >= start_sequence AND event_count = end_sequence - start_sequence + 1)
);
CREATE INDEX checkpoints_tenant ON checkpoints (tenant_id, created_at DESC);

-- Durable scheduler state per chain: the lease that lets several Audit Service instances share the work without
-- duplicating it, and the retry/alert bookkeeping so a failed checkpoint is never silently skipped.
CREATE TABLE checkpoint_state (
    chain_id             TEXT PRIMARY KEY REFERENCES chains (chain_id),
    lease_owner          TEXT,
    lease_until          TIMESTAMPTZ,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_attempt_at      TIMESTAMPTZ,
    next_attempt_at      TIMESTAMPTZ,
    last_error_code      TEXT,
    last_error           TEXT,
    alert_open           BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE checkpoint_alerts (
    id        BIGSERIAL PRIMARY KEY,
    chain_id  TEXT,
    tenant_id UUID,
    kind      TEXT NOT NULL,         -- e.g. SIGNING_FAILED, STORAGE_FAILED, SIGNER_UNAVAILABLE, ANCHOR_MISMATCH, *_RESOLVED
    severity  TEXT NOT NULL CHECK (severity IN ('CRITICAL', 'WARNING', 'INFO')),
    message   TEXT NOT NULL,
    detail    JSONB NOT NULL DEFAULT '{}'::jsonb,
    raised_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX checkpoint_alerts_time ON checkpoint_alerts (raised_at DESC);

-- History of anchored (signature + checkpoint) verification runs.
CREATE TABLE anchor_verification_runs (
    run_id                 UUID PRIMARY KEY,
    chain_id               TEXT NOT NULL REFERENCES chains (chain_id),
    tenant_id              UUID,
    trigger                TEXT NOT NULL CHECK (trigger IN ('SCHEDULED', 'ON_DEMAND')),
    requested_by           TEXT,
    started_at             TIMESTAMPTZ NOT NULL,
    finished_at            TIMESTAMPTZ NOT NULL,
    duration_ms            INTEGER NOT NULL,
    state                  TEXT NOT NULL CHECK (state IN ('VERIFIED', 'INVALID_HASH_CHAIN', 'INVALID_SIGNATURE', 'UNTRUSTED_SIGNER',
                                                         'MISSING_CHECKPOINT', 'CHECKPOINT_MISMATCH', 'UNSIGNED_EVENTS_PENDING', 'VERIFICATION_FAILED')),
    hash_chain_valid       BOOLEAN,
    signatures_valid       BOOLEAN,
    signer_trusted         BOOLEAN,
    anchored               BOOLEAN,
    pending_events         BIGINT NOT NULL DEFAULT 0,
    checkpoints_checked    INTEGER NOT NULL DEFAULT 0,
    last_checkpoint_number INTEGER,
    findings               JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX anchor_runs_chain ON anchor_verification_runs (chain_id, finished_at DESC);

-- ── Guards ───────────────────────────────────────────────────────────────────

-- A checkpoint is accepted only as the next link of its own chain: strictly numbered, contiguous, linked to the previous
-- checkpoint, inside the recorded events, and ending on the event it names.
CREATE FUNCTION checkpoints_guard_insert() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE c chains%ROWTYPE; prev checkpoints%ROWTYPE; end_hash TEXT;
BEGIN
    SELECT * INTO c FROM chains WHERE chain_id = NEW.chain_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'audit: unknown chain %', NEW.chain_id USING ERRCODE = 'foreign_key_violation'; END IF;
    IF NEW.tenant_id IS DISTINCT FROM c.tenant_id OR NEW.environment_id <> c.environment_id THEN
        RAISE EXCEPTION 'audit: checkpoint does not belong to this chain (tenant or environment mismatch)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT * INTO prev FROM checkpoints WHERE chain_id = NEW.chain_id ORDER BY checkpoint_number DESC LIMIT 1;
    IF NOT FOUND THEN
        IF NEW.checkpoint_number <> 1 OR NEW.start_sequence <> 1 OR NEW.previous_checkpoint_hash <> checkpoint_genesis_hash(NEW.chain_id) THEN
            RAISE EXCEPTION 'audit: the first checkpoint of a chain must be number 1, start at sequence 1 and follow the checkpoint genesis'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        IF NEW.checkpoint_number <> prev.checkpoint_number + 1 OR NEW.start_sequence <> prev.end_sequence + 1
           OR NEW.previous_checkpoint_hash <> prev.checkpoint_hash THEN
            RAISE EXCEPTION 'audit: checkpoint % does not follow checkpoint % of chain %', NEW.checkpoint_number, prev.checkpoint_number, NEW.chain_id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF NEW.end_sequence > c.head_sequence THEN
        RAISE EXCEPTION 'audit: checkpoint ends at % but the chain only has % events', NEW.end_sequence, c.head_sequence USING ERRCODE = 'check_violation';
    END IF;
    SELECT current_hash INTO end_hash FROM events WHERE chain_id = NEW.chain_id AND sequence_number = NEW.end_sequence;
    IF end_hash IS DISTINCT FROM NEW.last_event_hash THEN
        RAISE EXCEPTION 'audit: last_event_hash does not match event % of chain %', NEW.end_sequence, NEW.chain_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

-- Registered keys never change, except a key being retired (ACTIVE -> RETIRED with a time).
CREATE FUNCTION signing_keys_guard_update() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
    IF OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED' AND NEW.retired_at IS NOT NULL AND OLD.retired_at IS NULL
       AND (NEW.key_id, NEW.signer_id, NEW.key_version, NEW.environment_id, NEW.tenant_scope, NEW.public_key, NEW.fingerprint, NEW.algorithm,
            NEW.created_at, NEW.activated_at, NEW.statement)
         IS NOT DISTINCT FROM
           (OLD.key_id, OLD.signer_id, OLD.key_version, OLD.environment_id, OLD.tenant_scope, OLD.public_key, OLD.fingerprint, OLD.algorithm,
            OLD.created_at, OLD.activated_at, OLD.statement) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit: a registered signing key can only be retired, never altered' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER checkpoints_insert BEFORE INSERT ON checkpoints FOR EACH ROW EXECUTE FUNCTION checkpoints_guard_insert();
CREATE TRIGGER checkpoints_immutable BEFORE UPDATE OR DELETE ON checkpoints FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER checkpoints_no_truncate BEFORE TRUNCATE ON checkpoints FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TRIGGER signing_keys_update BEFORE UPDATE ON signing_keys FOR EACH ROW EXECUTE FUNCTION signing_keys_guard_update();
CREATE TRIGGER signing_keys_no_delete BEFORE DELETE ON signing_keys FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER signing_keys_no_truncate BEFORE TRUNCATE ON signing_keys FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TRIGGER checkpoint_alerts_immutable BEFORE UPDATE OR DELETE ON checkpoint_alerts FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER checkpoint_alerts_no_truncate BEFORE TRUNCATE ON checkpoint_alerts FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TRIGGER anchor_runs_immutable BEFORE UPDATE OR DELETE ON anchor_verification_runs FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER anchor_runs_no_truncate BEFORE TRUNCATE ON anchor_verification_runs FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TRIGGER checkpoint_state_no_delete BEFORE DELETE ON checkpoint_state FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER checkpoint_state_no_truncate BEFORE TRUNCATE ON checkpoint_state FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
