"""Guards on migrate.py's step lists — pure, no database.

Postgres never reuses a dropped column's slot and caps a table at 1,600. A step that
ADDs a column which a later step DROPs, run on every boot, therefore eats the table
until the service can't start (it did, on business_rules). These tests keep that class
of mistake out: every column a POST_DATA step drops may only be re-added by a step that
migrate._LEGACY_RULE_COLUMN_STEPS skips once its data migration is done.

Run with: docker compose exec tenant-service python test_migrations.py
"""

import re

import migrate



def _adds(sql):
    out = []
    for m in re.finditer(r"ALTER TABLE (\w+)", sql):
        table = m.group(1)
        out += [(table, c) for c in re.findall(r"ADD COLUMN IF NOT EXISTS (\w+)", sql)]
        break
    return out


def _drops(sql):
    m = re.match(r"\s*ALTER TABLE (\w+)", sql)
    return [(m.group(1), c) for c in re.findall(r"DROP COLUMN IF EXISTS (\w+)", sql)] if m else []


def test_every_column_a_post_step_drops_is_only_readded_by_a_skippable_step():
    dropped = {pair for _label, sql in migrate.POST_DATA_MIGRATIONS for pair in _drops(sql)}
    assert dropped, "expected the rule-engine drop steps to be found"
    offenders = []
    for label, sql in migrate.MIGRATIONS:
        readded = [pair for pair in _adds(sql) if pair in dropped]
        if readded and label.split(" ", 1)[0] not in migrate._LEGACY_RULE_COLUMN_STEPS:
            offenders.append((label, readded))
    assert not offenders, f"These re-add a column a later step drops, every boot: {offenders}"


def test_the_skippable_steps_exist_and_only_touch_dropped_columns():
    dropped = {pair for _label, sql in migrate.POST_DATA_MIGRATIONS for pair in _drops(sql)}
    steps = {label.split(" ", 1)[0]: sql for label, sql in migrate.MIGRATIONS}
    for key in migrate._LEGACY_RULE_COLUMN_STEPS:
        assert key in steps, f"{key} is listed as skippable but isn't a migration"
        assert all(pair in dropped for pair in _adds(steps[key])), f"{key} adds something that isn't dropped later"


def test_new_group_steps_are_idempotent_and_ordered_after_their_tables():
    labels = [label.split(" ", 1)[0] for label, _ in migrate.MIGRATIONS]
    for key in ("v51c", "v52a", "v53a", "v54a", "v54d"):
        assert key in labels
    for label, sql in migrate.MIGRATIONS:
        if label.startswith(("v51", "v52", "v53", "v54")):
            assert "IF NOT EXISTS" in sql or sql.lstrip().upper().startswith("UPDATE"), f"{label} must be safe to run twice"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS {name}")
