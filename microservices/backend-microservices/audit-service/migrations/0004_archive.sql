-- Stage 3, step 2: archive catalog, archive jobs (durable state machine), retention policies, legal holds, verification history,
-- retrieval staging, and the guarded removal of old monthly partitions from hot storage.
--
-- Trust note (same as Stage 2): this database is NOT the root of trust for archives. The authoritative anchors are the signed archive
-- manifests kept in the signer's protected store (outside PostgreSQL) and the encrypted archives in object storage. The catalog is an
-- index for finding things quickly; verification cross-checks it against the independent copies.
SET search_path TO audit;

-- ── retention policies ─────────────────────────────────────────────────────────────────────────────────
-- Versioned and tenant-aware: a tenant-specific row overrides the platform default (tenant_id NULL) for its category. Rows are never
-- edited: a change inserts a new row and supersedes the old one, so what applied when is always reconstructable.
-- NOTHING here is a legal retention period: the defaults keep archives indefinitely (cold_retention_years NULL) until the
-- organisation's compliance team approves real periods (approved = true).
CREATE TABLE retention_policies (
    policy_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID,
    category             TEXT NOT NULL CHECK (category IN ('underwriting_policy', 'claims', 'financial', 'administration', 'ai_decisions', 'operational')),
    hot_retention_months INTEGER NOT NULL CHECK (hot_retention_months >= 0),
    cold_retention_years INTEGER CHECK (cold_retention_years IS NULL OR cold_retention_years > 0),   -- NULL: keep indefinitely
    allow_hot_cleanup    BOOLEAN NOT NULL DEFAULT TRUE,
    approved             BOOLEAN NOT NULL DEFAULT FALSE,
    approved_by          TEXT,
    approved_at          TIMESTAMPTZ,
    notes                TEXT,
    created_by           TEXT NOT NULL DEFAULT 'system',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    superseded_at        TIMESTAMPTZ,
    CHECK (NOT approved OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX retention_policies_current ON retention_policies (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), category)
    WHERE superseded_at IS NULL;

INSERT INTO retention_policies (tenant_id, category, hot_retention_months, cold_retention_years, allow_hot_cleanup, approved, notes)
SELECT NULL, c, 6, NULL, TRUE, FALSE, 'Platform default: 6 months hot, archived indefinitely. NOT a legal retention period: compliance must approve real periods.'
FROM unnest(ARRAY['underwriting_policy', 'claims', 'financial', 'administration', 'ai_decisions', 'operational']) AS c;

-- ── legal holds ────────────────────────────────────────────────────────────────────────────────────────
-- A hold on a tenant (or one chain) blocks removal of its events from hot storage and any deletion review of its archives.
CREATE TABLE legal_holds (
    hold_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID,                       -- NULL = the platform chain
    chain_id         TEXT REFERENCES chains (chain_id),   -- optional: only this chain
    reason           TEXT NOT NULL,
    case_reference   TEXT,
    placed_by        TEXT NOT NULL,
    placed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at      TIMESTAMPTZ,
    released_by      TEXT,
    release_reason   TEXT,
    CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE INDEX legal_holds_active ON legal_holds (tenant_id) WHERE released_at IS NULL;

-- ── archive jobs: the durable state machine ─────────────────────────────────────────────────────────────
CREATE TABLE archive_jobs (
    job_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chain_id          TEXT NOT NULL REFERENCES chains (chain_id),
    tenant_id         UUID,
    archive_number    INTEGER NOT NULL CHECK (archive_number >= 1),
    start_sequence    BIGINT NOT NULL CHECK (start_sequence >= 1),
    end_sequence      BIGINT NOT NULL,
    event_count       BIGINT NOT NULL,
    state             TEXT NOT NULL CHECK (state IN ('ELIGIBLE', 'VERIFYING', 'EXPORTING', 'UPLOADING', 'VALIDATING', 'ARCHIVED',
                                                    'HOT_CLEANUP_ELIGIBLE', 'HOT_CLEANUP_COMPLETED', 'FAILED')),
    resume_state      TEXT,                       -- where a FAILED job continues from
    attempts          INTEGER NOT NULL DEFAULT 0,
    lease_owner       TEXT,
    lease_until       TIMESTAMPTZ,
    next_attempt_at   TIMESTAMPTZ,
    last_error_code   TEXT,
    last_error        TEXT,
    plan              JSONB NOT NULL DEFAULT '{}'::jsonb,
    result            JSONB NOT NULL DEFAULT '{}'::jsonb,
    history           JSONB NOT NULL DEFAULT '[]'::jsonb,
    trigger           TEXT NOT NULL CHECK (trigger IN ('SCHEDULED', 'MANUAL')),
    requested_by      TEXT,
    cleanup_after     TIMESTAMPTZ,                -- end of the safety period before hot cleanup may be considered
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ,
    UNIQUE (chain_id, archive_number),
    UNIQUE (chain_id, start_sequence),
    CHECK (end_sequence >= start_sequence AND event_count = end_sequence - start_sequence + 1)
);
CREATE INDEX archive_jobs_work ON archive_jobs (state, next_attempt_at);

-- Jobs move forward only (or to FAILED and back to the state they failed in); nothing is ever deleted.
CREATE FUNCTION archive_jobs_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE order_old INT; order_new INT; states TEXT[] := ARRAY['ELIGIBLE', 'VERIFYING', 'EXPORTING', 'UPLOADING', 'VALIDATING', 'ARCHIVED',
                                                           'HOT_CLEANUP_ELIGIBLE', 'HOT_CLEANUP_COMPLETED'];
BEGIN
    IF (NEW.job_id, NEW.chain_id, NEW.archive_number, NEW.start_sequence, NEW.end_sequence, NEW.event_count, NEW.trigger)
       IS DISTINCT FROM (OLD.job_id, OLD.chain_id, OLD.archive_number, OLD.start_sequence, OLD.end_sequence, OLD.event_count, OLD.trigger) THEN
        RAISE EXCEPTION 'audit: an archive job''s identity and range are immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.state = OLD.state THEN
        RETURN NEW;
    END IF;
    IF OLD.state = 'HOT_CLEANUP_COMPLETED' THEN
        RAISE EXCEPTION 'audit: job % is finished', OLD.job_id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'FAILED' THEN
        RETURN NEW;
    END IF;
    IF OLD.state = 'FAILED' THEN
        IF NEW.state <> OLD.resume_state THEN
            RAISE EXCEPTION 'audit: a failed job resumes at % only', OLD.resume_state USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    order_old := array_position(states, OLD.state);
    order_new := array_position(states, NEW.state);
    IF order_new IS NULL OR order_new <> order_old + 1 THEN
        RAISE EXCEPTION 'audit: illegal archive job transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER archive_jobs_transitions BEFORE UPDATE ON archive_jobs FOR EACH ROW EXECUTE FUNCTION archive_jobs_guard();
CREATE TRIGGER archive_jobs_no_delete BEFORE DELETE ON archive_jobs FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER archive_jobs_no_truncate BEFORE TRUNCATE ON archive_jobs FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE FUNCTION archive_genesis_hash(p_chain_id TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path FROM CURRENT AS $$
    SELECT encode(sha256(convert_to('insurance-ai/audit-archive-genesis/v1', 'UTF8') || '\x00'::bytea || convert_to(p_chain_id, 'UTF8')), 'hex')
$$;

-- ── the catalog: one row per completed archive ─────────────────────────────────────────────────────────────
CREATE TABLE archive_catalog (
    archive_id               UUID PRIMARY KEY,
    job_id                   UUID NOT NULL REFERENCES archive_jobs (job_id),
    chain_id                 TEXT NOT NULL REFERENCES chains (chain_id),
    tenant_id                UUID,
    environment_id           UUID NOT NULL,
    archive_number           INTEGER NOT NULL CHECK (archive_number >= 1),
    archive_version          INTEGER NOT NULL,
    start_sequence           BIGINT NOT NULL CHECK (start_sequence >= 1),
    end_sequence             BIGINT NOT NULL,
    event_count              BIGINT NOT NULL CHECK (event_count = end_sequence - start_sequence + 1),
    first_previous_hash      TEXT NOT NULL CHECK (first_previous_hash ~ '^[0-9a-f]{64}$'),
    last_event_hash          TEXT NOT NULL CHECK (last_event_hash ~ '^[0-9a-f]{64}$'),
    previous_archive_hash    TEXT NOT NULL CHECK (previous_archive_hash ~ '^[0-9a-f]{64}$'),
    manifest_hash            TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    archive_checksum         TEXT NOT NULL CHECK (archive_checksum ~ '^[0-9a-f]{64}$'),
    size_bytes               BIGINT NOT NULL,
    uncompressed_bytes       BIGINT NOT NULL,
    compression_algorithm    TEXT NOT NULL,
    encryption_algorithm     TEXT NOT NULL,
    kek_id                   TEXT NOT NULL,
    object_prefix            TEXT NOT NULL,
    data_key                 TEXT NOT NULL,
    manifest_key             TEXT NOT NULL,
    signature_key            TEXT NOT NULL,
    checkpoints_key          TEXT NOT NULL,
    data_version_id          TEXT,
    lock_mode                TEXT,
    lock_retain_until        TIMESTAMPTZ,
    covered_checkpoints      JSONB NOT NULL,
    first_occurred_at        TIMESTAMPTZ NOT NULL,
    last_occurred_at         TIMESTAMPTZ NOT NULL,
    first_recorded_at        TIMESTAMPTZ NOT NULL,
    last_recorded_at         TIMESTAMPTZ NOT NULL,
    modules                  TEXT[] NOT NULL,
    actions                  TEXT[] NOT NULL,
    entity_types             TEXT[] NOT NULL,
    bloom                    BYTEA NOT NULL,
    bloom_bits               INTEGER NOT NULL,
    bloom_hashes             INTEGER NOT NULL,
    retention_policy_id      UUID REFERENCES retention_policies (policy_id),
    retention_until          DATE,                       -- NULL: keep indefinitely
    cleanup_approved_at      TIMESTAMPTZ,                -- set once, when the hot-cleanup gate passed
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (chain_id, archive_number),
    UNIQUE (chain_id, start_sequence),
    UNIQUE (job_id)
);
CREATE INDEX archive_catalog_time ON archive_catalog (tenant_id, first_occurred_at, last_occurred_at);
CREATE INDEX archive_catalog_chain_end ON archive_catalog (chain_id, end_sequence);

-- An archive is accepted only as the next contiguous link of its chain: numbered, starting right after the previous archive and
-- linked to it by hash. Archived history can therefore have no gap and no fork.
CREATE FUNCTION archive_catalog_guard_insert() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE c chains%ROWTYPE; prev archive_catalog%ROWTYPE;
BEGIN
    SELECT * INTO c FROM chains WHERE chain_id = NEW.chain_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'audit: unknown chain %', NEW.chain_id USING ERRCODE = 'foreign_key_violation'; END IF;
    IF NEW.tenant_id IS DISTINCT FROM c.tenant_id OR NEW.environment_id <> c.environment_id THEN
        RAISE EXCEPTION 'audit: archive does not belong to this chain (tenant or environment mismatch)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.cleanup_approved_at IS NOT NULL THEN
        RAISE EXCEPTION 'audit: cleanup can only be approved after the archive exists' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO prev FROM archive_catalog WHERE chain_id = NEW.chain_id ORDER BY archive_number DESC LIMIT 1;
    IF NOT FOUND THEN
        IF NEW.archive_number <> 1 OR NEW.start_sequence <> 1 OR NEW.previous_archive_hash <> archive_genesis_hash(NEW.chain_id)
           OR NEW.first_previous_hash <> chain_genesis_hash(NEW.chain_id) THEN
            RAISE EXCEPTION 'audit: the first archive of a chain must be number 1, start at sequence 1 and follow the genesis hashes' USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        IF NEW.archive_number <> prev.archive_number + 1 OR NEW.start_sequence <> prev.end_sequence + 1
           OR NEW.previous_archive_hash <> prev.manifest_hash OR NEW.first_previous_hash <> prev.last_event_hash THEN
            RAISE EXCEPTION 'audit: archive % does not follow archive % of chain %', NEW.archive_number, prev.archive_number, NEW.chain_id USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF NEW.end_sequence > c.head_sequence THEN
        RAISE EXCEPTION 'audit: archive ends at % but the chain has only % events', NEW.end_sequence, c.head_sequence USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER archive_catalog_insert BEFORE INSERT ON archive_catalog FOR EACH ROW EXECUTE FUNCTION archive_catalog_guard_insert();

-- Only one thing may ever change: cleanup_approved_at, once, from NULL.
CREATE FUNCTION archive_catalog_guard_update() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
    IF OLD.cleanup_approved_at IS NULL AND NEW.cleanup_approved_at IS NOT NULL
       AND (to_jsonb(NEW) - 'cleanup_approved_at') = (to_jsonb(OLD) - 'cleanup_approved_at') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit: an archive catalog entry is immutable (cleanup approval aside)' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER archive_catalog_update BEFORE UPDATE ON archive_catalog FOR EACH ROW EXECUTE FUNCTION archive_catalog_guard_update();
CREATE TRIGGER archive_catalog_no_delete BEFORE DELETE ON archive_catalog FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER archive_catalog_no_truncate BEFORE TRUNCATE ON archive_catalog FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- ── verification history, scheduler runs ─────────────────────────────────────────────────────────────────
CREATE TABLE archive_verifications (
    verification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    archive_id      UUID NOT NULL REFERENCES archive_catalog (archive_id),
    kind            TEXT NOT NULL CHECK (kind IN ('INTAKE', 'DEEP', 'SAMPLE', 'CLEANUP_GATE', 'RETRIEVAL')),
    state           TEXT NOT NULL CHECK (state IN ('VERIFIED', 'FAILED')),
    code            TEXT,
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_by    TEXT,
    duration_ms     INTEGER,
    verified_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX archive_verifications_archive ON archive_verifications (archive_id, verified_at DESC);

CREATE TABLE archive_runs (
    run_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trigger      TEXT NOT NULL CHECK (trigger IN ('SCHEDULED', 'MANUAL')),
    dry_run      BOOLEAN NOT NULL DEFAULT FALSE,
    requested_by TEXT,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    jobs_created INTEGER NOT NULL DEFAULT 0,
    summary      JSONB NOT NULL DEFAULT '{}'::jsonb,
    error        TEXT
);
CREATE INDEX archive_runs_time ON archive_runs (started_at DESC);

-- ── retrieval: archived events restored to STAGING, never into the live chain ─────────────────────────────
CREATE TABLE archive_retrievals (
    retrieval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID,
    chain_id     TEXT REFERENCES chains (chain_id),
    requested_by TEXT NOT NULL,
    criteria     JSONB NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('PENDING', 'RUNNING', 'READY', 'FAILED', 'EXPIRED')),
    archives     JSONB NOT NULL DEFAULT '[]'::jsonb,
    event_count  INTEGER NOT NULL DEFAULT 0,
    verified     BOOLEAN,
    verification JSONB NOT NULL DEFAULT '{}'::jsonb,
    error        TEXT,
    lease_owner  TEXT,
    lease_until  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX archive_retrievals_state ON archive_retrievals (state, created_at);

CREATE TABLE archive_staging (
    retrieval_id    UUID NOT NULL REFERENCES archive_retrievals (retrieval_id),
    archive_id      UUID NOT NULL,
    event_id        UUID NOT NULL,
    chain_id        TEXT NOT NULL,
    sequence_number BIGINT NOT NULL,
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
    previous_hash   TEXT NOT NULL,
    current_hash    TEXT NOT NULL,
    hash_version    SMALLINT NOT NULL,
    PRIMARY KEY (retrieval_id, event_id)
);
CREATE INDEX archive_staging_order ON archive_staging (retrieval_id, recorded_at DESC, sequence_number DESC);

-- ── removing events from hot storage: only whole monthly partitions, only when provably archived ────────────
-- The function re-checks everything in SQL, so even a faulty or compromised application cannot use it to lose unarchived history:
--   * the month is entirely in the past;
--   * for EVERY chain with events in the partition, a catalog entry (archived, signed, cleanup-approved) covers all of them;
--   * no active legal hold applies to any such chain or tenant.
-- p_mode 'detach' (default) keeps the partition as a standalone table (reversible: re-attach it); 'drop' removes it.
CREATE FUNCTION remove_event_partition(p_month DATE, p_mode TEXT DEFAULT 'detach') RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
    part_name TEXT := 'events_p' || to_char(p_month, 'YYYYMM');
    hi TIMESTAMPTZ := ((date_trunc('month', p_month::timestamp) + interval '1 month') AT TIME ZONE 'UTC');
    removed BIGINT; r record;
BEGIN
    IF p_mode NOT IN ('detach', 'drop') THEN RAISE EXCEPTION 'audit: unknown cleanup mode %', p_mode; END IF;
    IF to_regclass(part_name) IS NULL THEN RAISE EXCEPTION 'audit: partition % does not exist', part_name; END IF;
    IF hi > now() THEN RAISE EXCEPTION 'audit: partition % is not entirely in the past', part_name USING ERRCODE = 'check_violation'; END IF;
    PERFORM pg_advisory_xact_lock(74210380);
    EXECUTE format('SELECT count(*) FROM %I', part_name) INTO removed;
    FOR r IN EXECUTE format('SELECT chain_id, tenant_id, max(sequence_number) AS top FROM %I GROUP BY chain_id, tenant_id', part_name) LOOP
        IF NOT EXISTS (SELECT 1 FROM archive_catalog a WHERE a.chain_id = r.chain_id AND a.end_sequence >= r.top AND a.cleanup_approved_at IS NOT NULL) THEN
            RAISE EXCEPTION 'audit: events of chain % up to sequence % are not archived and approved for cleanup; partition % stays', r.chain_id, r.top, part_name
                USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM legal_holds h WHERE h.released_at IS NULL AND h.tenant_id IS NOT DISTINCT FROM r.tenant_id AND (h.chain_id IS NULL OR h.chain_id = r.chain_id)) THEN
            RAISE EXCEPTION 'audit: a legal hold applies to chain %; partition % stays', r.chain_id, part_name USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;
    EXECUTE format('ALTER TABLE events DETACH PARTITION %I', part_name);
    IF p_mode = 'drop' THEN
        EXECUTE format('DROP TABLE %I', part_name);
    ELSE
        EXECUTE format('ALTER TABLE %I RENAME TO %I', part_name, 'detached_' || part_name);
        EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', 'detached_' || part_name);
    END IF;
    RETURN removed;
END $$;
REVOKE ALL ON FUNCTION remove_event_partition(DATE, TEXT) FROM PUBLIC;

CREATE FUNCTION list_event_partitions() RETURNS TABLE (partition_name TEXT, month_start DATE, row_count BIGINT, total_bytes BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE r record; n BIGINT;
BEGIN
    FOR r IN SELECT c.relname AS name, c.oid FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'events'::regclass ORDER BY c.relname LOOP
        EXECUTE format('SELECT count(*) FROM %I', r.name) INTO n;
        partition_name := r.name;
        month_start := to_date(substr(r.name, 9, 6), 'YYYYMM');
        row_count := n;
        total_bytes := pg_total_relation_size(r.oid);
        RETURN NEXT;
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION list_event_partitions() FROM PUBLIC;

-- ── policy / hold history guards ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION retention_policies_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
    IF OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL AND (to_jsonb(NEW) - 'superseded_at') = (to_jsonb(OLD) - 'superseded_at') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit: a retention policy is never edited: supersede it with a new one' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER retention_policies_update BEFORE UPDATE ON retention_policies FOR EACH ROW EXECUTE FUNCTION retention_policies_guard();
CREATE TRIGGER retention_policies_no_delete BEFORE DELETE ON retention_policies FOR EACH ROW EXECUTE FUNCTION reject_change();

CREATE FUNCTION legal_holds_guard() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
    IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
       AND (to_jsonb(NEW) - 'released_at' - 'released_by' - 'release_reason') = (to_jsonb(OLD) - 'released_at' - 'released_by' - 'release_reason') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit: a legal hold can only be released, never edited or deleted' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER legal_holds_update BEFORE UPDATE ON legal_holds FOR EACH ROW EXECUTE FUNCTION legal_holds_guard();
CREATE TRIGGER legal_holds_no_delete BEFORE DELETE ON legal_holds FOR EACH ROW EXECUTE FUNCTION reject_change();

CREATE TRIGGER archive_verifications_immutable BEFORE UPDATE OR DELETE ON archive_verifications FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER archive_verifications_no_truncate BEFORE TRUNCATE ON archive_verifications FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE TRIGGER archive_runs_no_delete BEFORE DELETE ON archive_runs FOR EACH ROW EXECUTE FUNCTION reject_change();
