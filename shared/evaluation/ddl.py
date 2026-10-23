"""SQL that makes published dataset versions and finished evaluation runs immutable in the database itself (triggers), whatever code or person runs the UPDATE.

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
    # Finished evaluation runs: a run is written while 'ingesting', then flipped to 'complete'; after that nothing about it changes.
    ("eval_runs: complete rows cannot change (function)",
     "CREATE OR REPLACE FUNCTION eval_guard_complete_run() RETURNS trigger AS $$ "
     "BEGIN "
     "IF OLD.state = 'complete' THEN "
     "RAISE EXCEPTION 'A finished evaluation run is immutable (run %)', OLD.run_id; "
     "END IF; "
     "IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; "
     "RETURN NEW; "
     "END; $$ LANGUAGE plpgsql"),
    ("eval_runs: drop old trigger", "DROP TRIGGER IF EXISTS trg_eval_guard_complete_run ON eval_runs"),
    ("eval_runs: trigger",
     "CREATE TRIGGER trg_eval_guard_complete_run BEFORE UPDATE OR DELETE ON eval_runs "
     "FOR EACH ROW EXECUTE FUNCTION eval_guard_complete_run()"),
    ("eval_case_results: rows of a complete run cannot change (function)",
     "CREATE OR REPLACE FUNCTION eval_guard_run_results() RETURNS trigger AS $$ "
     "DECLARE v_state text; "
     "BEGIN "
     "IF TG_TABLE_NAME = 'eval_case_results' THEN "
     "IF TG_OP = 'INSERT' THEN SELECT state INTO v_state FROM eval_runs WHERE id = NEW.run_row_id; "
     "ELSE SELECT state INTO v_state FROM eval_runs WHERE id = OLD.run_row_id; END IF; "
     "ELSE "
     "IF TG_OP = 'INSERT' THEN SELECT r.state INTO v_state FROM eval_case_results c JOIN eval_runs r ON r.id = c.run_row_id WHERE c.id = NEW.result_id; "
     "ELSE SELECT r.state INTO v_state FROM eval_case_results c JOIN eval_runs r ON r.id = c.run_row_id WHERE c.id = OLD.result_id; END IF; "
     "END IF; "
     "IF v_state = 'complete' THEN "
     "RAISE EXCEPTION 'The results of a finished evaluation run are immutable'; "
     "END IF; "
     "IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; "
     "RETURN NEW; "
     "END; $$ LANGUAGE plpgsql"),
    ("eval_case_results: drop old trigger", "DROP TRIGGER IF EXISTS trg_eval_guard_case_results ON eval_case_results"),
    ("eval_case_results: trigger",
     "CREATE TRIGGER trg_eval_guard_case_results BEFORE INSERT OR UPDATE OR DELETE ON eval_case_results "
     "FOR EACH ROW EXECUTE FUNCTION eval_guard_run_results()"),
    ("eval_assertion_results: drop old trigger", "DROP TRIGGER IF EXISTS trg_eval_guard_assertion_results ON eval_assertion_results"),
    ("eval_assertion_results: trigger",
     "CREATE TRIGGER trg_eval_guard_assertion_results BEFORE INSERT OR UPDATE OR DELETE ON eval_assertion_results "
     "FOR EACH ROW EXECUTE FUNCTION eval_guard_run_results()"),
]

# Columns added to eval_runs / eval_case_results after their first version (create_all never alters an existing table), and the
# immutability trigger for the metric scores. Every step is safe to run again. Applied by migrate.py as v73NN.
_RUN_COLUMNS = [
    ("kind", "VARCHAR(20) NOT NULL DEFAULT 'suite'"), ("group_id", "VARCHAR(60)"), ("config", "JSONB NOT NULL DEFAULT '{}'::jsonb"),
    ("provider", "VARCHAR(30)"), ("model_id", "VARCHAR(120)"), ("skills_enabled", "BOOLEAN"), ("prompt_version", "VARCHAR(60)"),
    ("judge_model", "VARCHAR(120)"), ("pricing_version_id", "UUID REFERENCES eval_pricing_versions(id)"), ("estimated_usd", "DOUBLE PRECISION"),
    ("job_id", "UUID"),
]
_RESULT_COLUMNS = [
    ("model_id", "VARCHAR(120)"), ("input_tokens", "INTEGER"), ("output_tokens", "INTEGER"), ("cached_tokens", "INTEGER"), ("llm_calls", "INTEGER"),
    ("judge_cost_usd", "DOUBLE PRECISION"), ("ttft_ms", "INTEGER"), ("turns", "INTEGER"), ("critical_failed", "BOOLEAN NOT NULL DEFAULT FALSE"),
    ("layer_scores", "JSONB NOT NULL DEFAULT '{}'::jsonb"), ("verdict", "JSONB NOT NULL DEFAULT '{}'::jsonb"),
    ("trace_summary", "JSONB NOT NULL DEFAULT '{}'::jsonb"), ("trace_key", "VARCHAR(600)"), ("trace_sha256", "VARCHAR(64)"),
]
EVAL_RUN_COLUMNS_DDL = (
    [(f"eval_runs.{c}", f"ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS {c} {t}") for c, t in _RUN_COLUMNS]
    + [("eval_runs.group_id index", "CREATE INDEX IF NOT EXISTS ix_eval_runs_group_id ON eval_runs (group_id)"),
       ("eval_runs.model_id index", "CREATE INDEX IF NOT EXISTS ix_eval_runs_model_id ON eval_runs (model_id)"),
       ("eval_runs.job_id index", "CREATE INDEX IF NOT EXISTS ix_eval_runs_job_id ON eval_runs (job_id)")]
    + [(f"eval_case_results.{c}", f"ALTER TABLE eval_case_results ADD COLUMN IF NOT EXISTS {c} {t}") for c, t in _RESULT_COLUMNS]
    + [("eval_metric_scores: drop old trigger", "DROP TRIGGER IF EXISTS trg_eval_guard_metric_scores ON eval_metric_scores"),
       ("eval_metric_scores: trigger",
        "CREATE TRIGGER trg_eval_guard_metric_scores BEFORE INSERT OR UPDATE OR DELETE ON eval_metric_scores "
        "FOR EACH ROW EXECUTE FUNCTION eval_guard_run_results()")]
)

