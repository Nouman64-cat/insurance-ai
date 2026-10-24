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



# Phase 6: the change registry and the review queue. History is append-only; the review rules are also CHECK constraints on the table
# (shared/models/evaluation.py). Every step is safe to run again. Applied by migrate.py as v74NN.
_APPEND_ONLY_TABLES = ("eval_registry_versions", "eval_drift_scans", "eval_drift_events")
EVAL_DRIFT_DDL = [
    ("eval_guard_append_only: function",
     "CREATE OR REPLACE FUNCTION eval_guard_append_only() RETURNS trigger AS $$ "
     "BEGIN RAISE EXCEPTION '% is append-only: a row is never changed or removed', TG_TABLE_NAME USING ERRCODE = '23514'; END; $$ LANGUAGE plpgsql"),
] + [
    step
    for table in _APPEND_ONLY_TABLES
    for step in (
        (f"{table}: drop old trigger", f"DROP TRIGGER IF EXISTS trg_{table}_append_only ON {table}"),
        (f"{table}: append-only trigger",
         f"CREATE TRIGGER trg_{table}_append_only BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION eval_guard_append_only()"),
    )
] + [
    # A CHECK passes when it evaluates to NULL, so a value with no source would have slipped through the first version of this rule.
    ("eval_drift_items: replace the expected-value rule", "ALTER TABLE eval_drift_items DROP CONSTRAINT IF EXISTS ck_eval_drift_expected_is_reviewers"),
    ("eval_drift_items: the expected value is always the reviewer's",
     "ALTER TABLE eval_drift_items ADD CONSTRAINT ck_eval_drift_expected_is_reviewers CHECK (expected IS NULL OR COALESCE(expected_source, '') = 'reviewer')"),
    ("eval_drift_items: drop old trigger", "DROP TRIGGER IF EXISTS trg_eval_drift_items_no_delete ON eval_drift_items"),
    ("eval_drift_items: no delete",
     "CREATE TRIGGER trg_eval_drift_items_no_delete BEFORE DELETE ON eval_drift_items FOR EACH ROW EXECUTE FUNCTION eval_guard_append_only()"),
]


# Editable templates (shared/models/templates.py): a published version never changes; a draft can be edited and discarded.
TEMPLATE_DDL = [
    ("document_template_versions: guard function",
     "CREATE OR REPLACE FUNCTION document_template_guard() RETURNS trigger AS $$ "
     "BEGIN "
     "IF TG_OP = 'DELETE' THEN "
     "  IF OLD.state <> 'draft' THEN RAISE EXCEPTION 'a published template version is never deleted' USING ERRCODE = '23514'; END IF; RETURN OLD; END IF; "
     "IF OLD.state <> 'draft' THEN "
     "  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.version <> OLD.version OR NEW.template_id <> OLD.template_id OR NEW.change_note IS DISTINCT FROM OLD.change_note "
     "     OR NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.published_at IS DISTINCT FROM OLD.published_at "
     "  THEN RAISE EXCEPTION 'a published template version is immutable' USING ERRCODE = '23514'; END IF; "
     "  IF NOT (OLD.state = NEW.state OR (OLD.state = 'published' AND NEW.state = 'superseded')) "
     "  THEN RAISE EXCEPTION 'a published template version can only become superseded' USING ERRCODE = '23514'; END IF; "
     "END IF; RETURN NEW; END; $$ LANGUAGE plpgsql"),
    ("document_template_versions: drop old trigger", "DROP TRIGGER IF EXISTS trg_document_template_guard ON document_template_versions"),
    ("document_template_versions: trigger",
     "CREATE TRIGGER trg_document_template_guard BEFORE UPDATE OR DELETE ON document_template_versions FOR EACH ROW EXECUTE FUNCTION document_template_guard()"),
]


# Phase 7: cost lines, budgets, exchange rates and provider statements are append-only (a correction is a new row).
_COST_APPEND_ONLY = ("eval_cost_lines", "eval_budget_limits", "eval_exchange_rates", "eval_provider_statements")
EVAL_COST_DDL = [
    ("eval_guard_append_only: function",
     "CREATE OR REPLACE FUNCTION eval_guard_append_only() RETURNS trigger AS $$ "
     "BEGIN RAISE EXCEPTION '% is append-only: a row is never changed or removed', TG_TABLE_NAME USING ERRCODE = '23514'; END; $$ LANGUAGE plpgsql"),
] + [
    step
    for table in _COST_APPEND_ONLY
    for step in (
        (f"{table}: drop old trigger", f"DROP TRIGGER IF EXISTS trg_{table}_append_only ON {table}"),
        (f"{table}: append-only trigger",
         f"CREATE TRIGGER trg_{table}_append_only BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION eval_guard_append_only()"),
    )
]
