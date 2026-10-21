-- Stage 3, step 1: monthly time partitions for audit.events (hot storage lifecycle).
--
-- WHY: hot storage keeps ~6 months; older months leave PostgreSQL by detaching/dropping a whole monthly partition, which is
-- instant and reclaims space (row deletes are impossible by design: the append-only triggers forbid them).
--
-- WHAT DOES NOT CHANGE: every column, every event, every hash, sequence number, chain head and checkpoint. Nothing is
-- re-hashed or re-sequenced; the copied rows are byte-identical (verified below, in the same transaction).
--
-- WHAT CHANGES, and how the guarantees are kept:
--   * A partitioned table can only enforce uniqueness per partition (the key must include recorded_at). The two global
--     Stage 1 uniqueness guarantees therefore move to a small non-partitioned table, audit.event_sources, filled by the same
--     insert trigger: UNIQUE (service_name, source_event_id)  [idempotency, also for events whose partition is long gone]
--                      UNIQUE (chain_id, sequence_number)      [no duplicate sequence, in any month]
--     (the trigger also still enforces sequence = head+1 and previous_hash = head under the chain row lock).
--   * The primary key becomes (event_id, recorded_at).
--
-- SAFETY / ROLLBACK:
--   * The whole migration is ONE transaction under an ACCESS EXCLUSIVE lock on events: if the validation at the end finds any
--     difference (row count, per-chain head/count, a checksum over every event hash) it raises and everything rolls back.
--   * The original table is KEPT as events_legacy_v1 (its append-only triggers intact, no application access). Remove it only
--     after you are satisfied:  DROP TABLE audit.events_legacy_v1;   (see migrations/optional/).
--   * migrations/rollback/0003_unpartition_events.sql restores an unpartitioned events table from the partitioned data.
--   * Downtime: ingestion waits on the lock for the duration of the copy (seconds per million events). Schedule accordingly.
SET search_path TO audit;

LOCK TABLE events IN ACCESS EXCLUSIVE MODE;

-- ── the global uniqueness index ────────────────────────────────────────────────────────────────────────
CREATE TABLE event_sources (
    service_name    TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    event_id        UUID NOT NULL,
    chain_id        TEXT NOT NULL REFERENCES chains (chain_id),
    sequence_number BIGINT NOT NULL,
    current_hash    TEXT NOT NULL CHECK (current_hash ~ '^[0-9a-f]{64}$'),
    recorded_at     TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (service_name, source_event_id)
);
CREATE UNIQUE INDEX event_sources_chain_sequence ON event_sources (chain_id, sequence_number);
CREATE UNIQUE INDEX event_sources_event ON event_sources (event_id);

INSERT INTO event_sources (service_name, source_event_id, event_id, chain_id, sequence_number, current_hash, recorded_at)
    SELECT service_name, source_event_id, event_id, chain_id, sequence_number, current_hash, recorded_at FROM events;

-- ── set the original aside ────────────────────────────────────────────────────────────────────────────
ALTER TABLE events RENAME TO events_legacy_v1;
ALTER TABLE events_legacy_v1 RENAME CONSTRAINT events_pkey TO events_legacy_v1_pkey;
ALTER TABLE events_legacy_v1 RENAME CONSTRAINT events_chain_id_sequence_number_key TO events_legacy_v1_chain_seq_key;
ALTER TABLE events_legacy_v1 RENAME CONSTRAINT events_service_name_source_event_id_key TO events_legacy_v1_source_key;
ALTER INDEX events_tenant_time RENAME TO events_legacy_v1_tenant_time;
ALTER INDEX events_time RENAME TO events_legacy_v1_time;
ALTER INDEX events_module RENAME TO events_legacy_v1_module;
ALTER INDEX events_action RENAME TO events_legacy_v1_action;
ALTER INDEX events_entity RENAME TO events_legacy_v1_entity;
ALTER INDEX events_actor RENAME TO events_legacy_v1_actor;
ALTER INDEX events_case RENAME TO events_legacy_v1_case;
ALTER INDEX events_correlation RENAME TO events_legacy_v1_correlation;
REVOKE ALL ON events_legacy_v1 FROM PUBLIC;

-- ── the partitioned table ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE events (
    event_id        UUID NOT NULL,
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
    PRIMARY KEY (event_id, recorded_at)
) PARTITION BY RANGE (recorded_at);

CREATE INDEX events_chain_sequence ON events (chain_id, sequence_number);
CREATE INDEX events_tenant_time ON events (tenant_id, recorded_at DESC, sequence_number DESC);
CREATE INDEX events_time ON events (recorded_at DESC, sequence_number DESC);
CREATE INDEX events_module ON events (module, recorded_at DESC);
CREATE INDEX events_action ON events (action, recorded_at DESC);
CREATE INDEX events_entity ON events (entity_type, entity_id);
CREATE INDEX events_actor ON events (actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX events_case ON events (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX events_correlation ON events (correlation_id) WHERE correlation_id IS NOT NULL;

-- Creates the partition for the month containing p_at (idempotent). The application role has no DDL rights; it calls this.
CREATE FUNCTION ensure_event_partition(p_at TIMESTAMPTZ) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
    month_start TIMESTAMP := date_trunc('month', p_at AT TIME ZONE 'UTC');
    part_name   TEXT := 'events_p' || to_char(date_trunc('month', p_at AT TIME ZONE 'UTC'), 'YYYYMM');
BEGIN
    IF to_regclass(part_name) IS NOT NULL THEN
        RETURN part_name;
    END IF;
    PERFORM pg_advisory_xact_lock(74210380);
    IF to_regclass(part_name) IS NULL THEN
        EXECUTE format('CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)', part_name,
                       month_start AT TIME ZONE 'UTC', (month_start + interval '1 month') AT TIME ZONE 'UTC');
    END IF;
    RETURN part_name;
END $$;
REVOKE ALL ON FUNCTION ensure_event_partition(TIMESTAMPTZ) FROM PUBLIC;

-- a partition for every month that has data, plus the current month and the next two
DO $$
DECLARE first_month TIMESTAMP; last_month TIMESTAMP := date_trunc('month', now() AT TIME ZONE 'UTC') + interval '2 months'; m TIMESTAMP;
BEGIN
    SELECT date_trunc('month', min(recorded_at) AT TIME ZONE 'UTC') INTO first_month FROM events_legacy_v1;
    m := COALESCE(first_month, date_trunc('month', now() AT TIME ZONE 'UTC'));
    WHILE m <= last_month LOOP
        PERFORM ensure_event_partition(m AT TIME ZONE 'UTC');
        m := m + interval '1 month';
    END LOOP;
END $$;

-- ── copy (the guard triggers are not on the new table yet, so nothing is re-sequenced, re-hashed or double-counted) ──
INSERT INTO events (event_id, chain_id, sequence_number, tenant_id, environment_id, occurred_at, recorded_at, actor_id, actor_type, actor_role,
                    service_name, module, action, entity_type, entity_id, case_id, correlation_id, source_event_id, previous_value, new_value,
                    outcome, metadata, previous_hash, current_hash, hash_version)
    SELECT event_id, chain_id, sequence_number, tenant_id, environment_id, occurred_at, recorded_at, actor_id, actor_type, actor_role,
           service_name, module, action, entity_type, entity_id, case_id, correlation_id, source_event_id, previous_value, new_value,
           outcome, metadata, previous_hash, current_hash, hash_version
    FROM events_legacy_v1;

-- ── validate; any difference aborts and rolls the whole migration back ───────────────────────────────────
DO $$
DECLARE legacy_n BIGINT; new_n BIGINT; sources_n BIGINT;
BEGIN
    SELECT count(*) INTO legacy_n FROM events_legacy_v1;
    SELECT count(*) INTO new_n FROM events;
    SELECT count(*) INTO sources_n FROM event_sources;
    IF legacy_n <> new_n OR legacy_n <> sources_n THEN
        RAISE EXCEPTION 'partition migration aborted: row counts differ (legacy %, partitioned %, sources %)', legacy_n, new_n, sources_n;
    END IF;
    IF EXISTS (SELECT 1 FROM chains c LEFT JOIN (SELECT chain_id, max(sequence_number) AS top, count(*) AS n FROM events GROUP BY chain_id) e USING (chain_id)
               WHERE c.head_sequence <> COALESCE(e.top, 0) OR c.head_sequence <> COALESCE(e.n, 0)) THEN
        RAISE EXCEPTION 'partition migration aborted: a chain head does not match its events';
    END IF;
    IF (SELECT md5(COALESCE(string_agg(event_id::text || previous_hash || current_hash || sequence_number::text || recorded_at::text, '|' ORDER BY event_id), '')) FROM events_legacy_v1)
       IS DISTINCT FROM
       (SELECT md5(COALESCE(string_agg(event_id::text || previous_hash || current_hash || sequence_number::text || recorded_at::text, '|' ORDER BY event_id), '')) FROM events) THEN
        RAISE EXCEPTION 'partition migration aborted: copied events differ from the originals';
    END IF;
END $$;

-- ── guards on the new table (same rules as Stage 1, plus the global uniqueness index) ──────────────────────
CREATE OR REPLACE FUNCTION events_guard_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
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
    -- global idempotency and sequence uniqueness, across every month (including months already archived and removed)
    INSERT INTO event_sources (service_name, source_event_id, event_id, chain_id, sequence_number, current_hash, recorded_at)
        VALUES (NEW.service_name, NEW.source_event_id, NEW.event_id, NEW.chain_id, NEW.sequence_number, NEW.current_hash, NEW.recorded_at);
    UPDATE chains SET head_sequence = NEW.sequence_number, head_hash = NEW.current_hash, updated_at = now() WHERE chain_id = NEW.chain_id;
    RETURN NEW;
END $$;

CREATE TRIGGER events_insert BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION events_guard_insert();
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TRIGGER event_sources_immutable BEFORE UPDATE OR DELETE ON event_sources FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER event_sources_no_truncate BEFORE TRUNCATE ON event_sources FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
