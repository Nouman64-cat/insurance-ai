-- OPTIONAL, run by an administrator once the partition migration has been validated in production (counts and a verification run
-- are already checked inside the migration itself). Not applied automatically.
-- Drops the original, unpartitioned copy kept by 0003 as events_legacy_v1. It is a copy: no data is lost, but you can no longer
-- fall back to it without the rollback script rebuilding a table from the partitions.
--   psql -U audit_owner -d <db> -f migrations/optional/0003_drop_legacy_events.sql
SET search_path TO audit;
DROP TABLE IF EXISTS events_legacy_v1;
