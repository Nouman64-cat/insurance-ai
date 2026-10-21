-- ROLLBACK of 0003_partition_events.sql: rebuild a single, unpartitioned audit.events from the partitioned data.
-- Run manually, as the schema owner (audit_owner), with the audit service STOPPED. Nothing is lost: events appended since the
-- migration are copied too. The partitioned table is kept as events_partitioned_v1 until you drop it.
--
--   docker compose stop audit-service
--   psql -U audit_owner -d <db> -f migrations/rollback/0003_unpartition_events.sql
--
-- (Run it together with the matching older application code: current code deduplicates through event_sources, which this script leaves behind but stops filling.)
-- After this, the schema looks like Stage 1/2 (UNIQUE constraints on events again). The schema_migrations row for 0003 is NOT
-- removed, so the migration runner will not re-apply it; if you want to partition again later, restore from this state manually
-- (re-run the body of 0003 after renaming the tables back) rather than via the runner.
SET search_path TO audit;
BEGIN;
LOCK TABLE events IN ACCESS EXCLUSIVE MODE;

ALTER TABLE events RENAME TO events_partitioned_v1;
DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT indexname FROM pg_indexes WHERE schemaname = 'audit' AND tablename = 'events_partitioned_v1' LOOP
        EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname, 'p1_' || r.indexname);
    END LOOP;
END $$;

CREATE TABLE events (LIKE events_partitioned_v1 INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE events ADD CONSTRAINT events_pkey PRIMARY KEY (event_id);
ALTER TABLE events ADD CONSTRAINT events_chain_id_fkey FOREIGN KEY (chain_id) REFERENCES chains (chain_id);
ALTER TABLE events ADD CONSTRAINT events_chain_id_sequence_number_key UNIQUE (chain_id, sequence_number);
ALTER TABLE events ADD CONSTRAINT events_service_name_source_event_id_key UNIQUE (service_name, source_event_id);
CREATE INDEX events_tenant_time ON events (tenant_id, recorded_at DESC, sequence_number DESC);
CREATE INDEX events_time ON events (recorded_at DESC, sequence_number DESC);
CREATE INDEX events_module ON events (module, recorded_at DESC);
CREATE INDEX events_action ON events (action, recorded_at DESC);
CREATE INDEX events_entity ON events (entity_type, entity_id);
CREATE INDEX events_actor ON events (actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX events_case ON events (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX events_correlation ON events (correlation_id) WHERE correlation_id IS NOT NULL;

INSERT INTO events SELECT * FROM events_partitioned_v1;

DO $$ BEGIN
    IF (SELECT count(*) FROM events) <> (SELECT count(*) FROM events_partitioned_v1) THEN RAISE EXCEPTION 'rollback aborted: row counts differ'; END IF;
    IF EXISTS (SELECT 1 FROM chains c LEFT JOIN (SELECT chain_id, count(*) n, max(sequence_number) m FROM events GROUP BY chain_id) e USING (chain_id)
               WHERE c.head_sequence <> COALESCE(e.m, 0) + 0 AND c.head_sequence <> COALESCE(e.n, 0)) THEN
        RAISE NOTICE 'some chains have archived (removed) prefixes; their heads are larger than the rows present: that is expected after Stage 3 archival';
    END IF;
END $$;

-- The Stage 1 guards, exactly as migration 0001 defined them.
CREATE OR REPLACE FUNCTION events_guard_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE c chains%ROWTYPE;
BEGIN
    SELECT * INTO c FROM chains WHERE chain_id = NEW.chain_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'audit: unknown chain %', NEW.chain_id USING ERRCODE = 'foreign_key_violation'; END IF;
    IF NEW.tenant_id IS DISTINCT FROM c.tenant_id OR NEW.environment_id <> c.environment_id THEN
        RAISE EXCEPTION 'audit: event does not belong to this chain (tenant or environment mismatch)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    IF NEW.sequence_number <> c.head_sequence + 1 THEN
        RAISE EXCEPTION 'audit: sequence % is not the next sequence of chain % (head is %)', NEW.sequence_number, NEW.chain_id, c.head_sequence USING ERRCODE = 'check_violation'; END IF;
    IF NEW.previous_hash <> c.head_hash THEN
        RAISE EXCEPTION 'audit: previous_hash does not equal the head of chain %', NEW.chain_id USING ERRCODE = 'check_violation'; END IF;
    UPDATE chains SET head_sequence = NEW.sequence_number, head_hash = NEW.current_hash, updated_at = now() WHERE chain_id = NEW.chain_id;
    RETURN NEW;
END $$;
CREATE TRIGGER events_insert BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION events_guard_insert();
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
COMMIT;
