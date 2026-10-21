"""SQL that makes published dataset versions immutable in the database itself (triggers), whatever code or person runs the UPDATE.

Kept apart from the models so tenant-service/migrate.py can list these steps without importing the whole model registry.
Applied by migrate.py on every start, and by the tests (which build their schema with create_all). Each entry is one
statement and safe to run again.
"""

EVAL_IMMUTABILITY_DDL = [
    ("eval_dataset_versions: published rows cannot change (function)",
     "CREATE OR REPLACE FUNCTION eval_guard_published_version() RETURNS trigger AS $$ "
     "BEGIN "
     "IF OLD.state = 'published' THEN "
     "RAISE EXCEPTION 'A published dataset version is immutable (version %)', OLD.version; "
     "END IF; "
     "IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; "
     "RETURN NEW; "
     "END; $$ LANGUAGE plpgsql"),
    ("eval_dataset_versions: drop old trigger",
     "DROP TRIGGER IF EXISTS trg_eval_guard_published_version ON eval_dataset_versions"),
    ("eval_dataset_versions: trigger",
     "CREATE TRIGGER trg_eval_guard_published_version BEFORE UPDATE OR DELETE ON eval_dataset_versions "
     "FOR EACH ROW EXECUTE FUNCTION eval_guard_published_version()"),
    ("eval_version_cases: rows of a published version cannot change (function)",
     "CREATE OR REPLACE FUNCTION eval_guard_version_cases() RETURNS trigger AS $$ "
     "DECLARE v_state text; "
     "BEGIN "
     "IF TG_OP = 'INSERT' THEN "
     "SELECT state INTO v_state FROM eval_dataset_versions WHERE id = NEW.version_id; "
     "ELSE "
     "SELECT state INTO v_state FROM eval_dataset_versions WHERE id = OLD.version_id; "
     "END IF; "
     "IF v_state = 'published' THEN "
     "RAISE EXCEPTION 'The cases of a published dataset version are immutable'; "
     "END IF; "
     "IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; "
     "RETURN NEW; "
     "END; $$ LANGUAGE plpgsql"),
    ("eval_version_cases: drop old trigger",
     "DROP TRIGGER IF EXISTS trg_eval_guard_version_cases ON eval_version_cases"),
    ("eval_version_cases: trigger",
     "CREATE TRIGGER trg_eval_guard_version_cases BEFORE INSERT OR UPDATE OR DELETE ON eval_version_cases "
     "FOR EACH ROW EXECUTE FUNCTION eval_guard_version_cases()"),
]
