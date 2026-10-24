SET search_path TO audit;

-- Runtime control history is append-only. Infrastructure credentials stay outside this table.
CREATE TABLE archive_configuration_versions (
    revision BIGINT PRIMARY KEY CHECK (revision > 0),
    settings JSONB NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT NOT NULL,
    source TEXT NOT NULL
);
CREATE TRIGGER archive_configuration_immutable BEFORE UPDATE OR DELETE ON archive_configuration_versions
    FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER archive_configuration_no_truncate BEFORE TRUNCATE ON archive_configuration_versions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
