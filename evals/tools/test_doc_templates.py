"""Unit tests of shared/doc_templates.py: the seeded templates are valid, bad edits are refused with a plain reason, locked fields cannot be
dropped, and a difference between two versions says what was added, removed, edited or moved. Pure."""
from __future__ import annotations

import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from shared import doc_templates as t  # noqa: E402


def seeded():
    return {x["template_key"]: x for x in t.seed_templates()}


def test_the_seeds_are_the_lead_form_and_the_proposal_and_valid() -> None:
    s = seeded()
    assert set(s) == {"lead_acquisition", "proposal"}
    assert all(t.problems(x["content"]) == [] for x in s.values())


def test_the_lead_template_is_exactly_the_live_lead_form() -> None:
    c = seeded()["lead_acquisition"]["content"]
    titles = [x["title"] for x in c["sections"]]
    assert titles == ["Identity & Contact", "CNIC & Docs", "Occupation & Income", "Medical & Lifestyle", "Habit Check", "Financial Profile", "Nominee Details", "Insurance Plan"], titles
    assert [len(x["fields"]) for x in c["sections"]] == [12, 2, 8, 6, 9, 5, 5, 2] and len(t.field_ids(c)) == 49
    by = {f["id"]: f for x in c["sections"] for f in x["fields"]}
    assert by["mobile_number"]["type"] == "phone" and by["is_smoker"]["type"] == "checkbox" and by["date_of_birth"]["type"] == "date" and by["declared_annual_income"]["type"] == "number"
    assert [o["value"] for o in by["employment_type"]["options"]] == ["Salaried", "Self-Employed", "Business", "Unemployed", "Retired", "Student"], "the stored value is kept"
    assert by["employment_type"]["options"][1]["label"] == "Self-employed" and by["smoking_status"]["options"][0]["value"] == "Non-smoker"
    assert all(f["binding"] == {"store": "profile", "key": f["id"]} for f in by.values()), "every seeded field says where it is stored"
    assert by["cnic"]["max_length"] == 15 and by["cnic"]["placeholder"] == "35201-1234567-1"


def test_the_required_lead_fields_are_locked() -> None:
    c = seeded()["lead_acquisition"]["content"]
    required = {f["id"] for x in c["sections"] for f in x["fields"] if f.get("required")}
    assert required == {"first_name", "last_name", "date_of_birth", "gender", "mobile_number", "city"}
    assert required == set(t.locked_fields(c))


def test_the_proposal_carries_the_real_questions_of_the_live_form() -> None:
    ids = set(t.field_ids(seeded()["proposal"]["content"]))
    assert {"height_cm", "weight_kg", "tobacco_use", "conditions", "hospitalizations", "family_members", "occupation_hazard_level", "dui_dwi_history", "policies",
            "confirms_accurate", "signature_name", "annual_income", "monthly_household_expenses", "premium_payer"} <= ids
    conditions = next(f for sec in seeded()["proposal"]["content"]["sections"] for f in sec["fields"] if f["id"] == "conditions")
    assert len(conditions["options"]) == 10 and any(d["id"] == "physician_phone" for d in conditions["detail_fields"])


def test_a_storage_setting_must_be_valid() -> None:
    c = seeded()["lead_acquisition"]["content"]
    bad = copy.deepcopy(c); bad["sections"][0]["fields"][0]["binding"] = {"store": "elsewhere"}
    assert any("storage setting" in p for p in t.problems(bad))
    ok = copy.deepcopy(c); ok["sections"][0]["fields"].append({"id": "blood_group", "label": "Blood group", "type": "text", "binding": {"store": "details"}})
    assert t.problems(ok) == []


def test_bad_edits_are_refused_with_the_reason() -> None:
    base = seeded()["proposal"]["content"]
    def edit(fn):
        c = copy.deepcopy(base); fn(c); return " | ".join(t.problems(c))
    assert "needs a title" in edit(lambda c: c.update(title=" "))
    assert "needs a label" in edit(lambda c: c["sections"][1]["fields"][0].update(label=""))
    assert "is used twice" in edit(lambda c: c["sections"][1]["fields"].append(copy.deepcopy(c["sections"][1]["fields"][0])))
    assert "not allowed here" in edit(lambda c: c["sections"][1]["fields"][0].update(type="slider"))
    assert "needs between 1 and" in edit(lambda c: c["sections"][3]["fields"][0].update(options=[]))
    assert "must be an earlier field" in edit(lambda c: c["sections"][1]["fields"][1].update(show_if={"field": "nope", "equals": "Yes"}))
    assert "lowercase" in edit(lambda c: c["sections"][1]["fields"][0].update(id="Height CM"))
    assert t.problems("x") == ["the template must be an object"] and t.problems({"title": "x", "sections": []}) == ["the template needs at least one section"]


def test_a_locked_field_cannot_be_removed_retyped_or_unlocked() -> None:
    prev = seeded()["proposal"]["content"]
    assert t.publish_problems(prev, prev) == []
    def without(fid):
        c = copy.deepcopy(prev)
        for s in c["sections"]:
            s["fields"] = [f for f in s["fields"] if f["id"] != fid]
        return c
    assert any("'signature_name' is locked" in p and "removed" in p for p in t.publish_problems(without("signature_name"), prev))
    retyped = copy.deepcopy(prev); next(f for s in retyped["sections"] for f in s["fields"] if f["id"] == "height_cm")["type"] = "text"
    assert any("type must stay 'number'" in p for p in t.publish_problems(retyped, prev))
    unlocked = copy.deepcopy(prev); next(f for s in unlocked["sections"] for f in s["fields"] if f["id"] == "height_cm").pop("locked")
    assert any("must stay locked" in p for p in t.publish_problems(unlocked, prev))
    free = without("tobacco_frequency")
    assert t.publish_problems(free, prev) == [], "an ordinary field can be removed"


def test_adding_removing_editing_and_moving_are_reported() -> None:
    prev = seeded()["proposal"]["content"]
    new = copy.deepcopy(prev)
    new["sections"][1]["fields"].append({"id": "blood_group", "label": "Blood group", "type": "text", "required": False})
    new["sections"][1]["fields"] = [f for f in new["sections"][1]["fields"] if f["id"] != "drug_use_details"]
    next(f for f in new["sections"][1]["fields"] if f["id"] == "height_cm")["label"] = "Height in centimetres"
    new["sections"].append(new["sections"].pop(2))
    d = {(x["change"], x["what"]) for x in t.diff(prev, new)}
    assert ("added", "field:blood_group") in d and ("removed", "field:drug_use_details") in d and ("edited", "field:height_cm") in d and ("moved", "section:family_history") in d, d
    assert t.diff(prev, prev) == []


def test_the_hash_ignores_key_order() -> None:
    assert t.content_hash({"a": 1, "b": 2}) == t.content_hash({"b": 2, "a": 1}) and t.content_hash({"a": 1}) != t.content_hash({"a": 2})


def _lead_with_added():
    c = copy.deepcopy(seeded()["lead_acquisition"]["content"])
    c["sections"][0]["fields"] += [
        {"id": "blood_group", "label": "Blood group", "type": "select", "required": True, "binding": {"store": "details"}, "options": [{"id": "o", "label": "O positive", "value": "O+"}]},
        {"id": "visit_note", "label": "Visit note", "type": "text", "max_length": 10, "binding": {"store": "details"}},
        {"id": "callback", "label": "Call back", "type": "checkbox", "required": True, "binding": {"store": "details"}},
        {"id": "callback_time", "label": "Call back time", "type": "text", "required": True, "binding": {"store": "details"}, "show_if": {"field": "callback", "equals": "Yes"}},
        {"id": "age_guess", "label": "Age guess", "type": "number", "binding": {"store": "details"}},
        {"id": "met_on", "label": "Met on", "type": "date", "binding": {"store": "details"}}]
    return c


def test_answers_are_checked_cleaned_and_required_ones_enforced() -> None:
    c = _lead_with_added()
    ok, problems = t.validate_answers(c, {"blood_group": "O positive", "visit_note": " hi ", "callback": True, "callback_time": "5pm", "age_guess": "42", "met_on": "2026-10-23",
                                           "first_name": "Smuggled", "gone": "x"})
    assert problems == [] and ok == {"blood_group": "O+", "visit_note": "hi", "callback": True, "callback_time": "5pm", "age_guess": 42, "met_on": "2026-10-23"}, (ok, problems)
    assert "first_name" not in ok and "gone" not in ok, "built-in and unknown keys are dropped"


def test_bad_answers_are_refused_with_the_field_named() -> None:
    c = _lead_with_added()
    _, p = t.validate_answers(c, {"blood_group": "Z", "visit_note": "x" * 11, "callback": "yes", "age_guess": "many", "met_on": "yesterday"})
    joined = " | ".join(p)
    for needle in ("Blood group: must be one of its options", "Visit note: is longer than 10", "Call back: must be yes or no", "Age guess: must be a number", "Met on:"):
        assert needle in joined, (needle, joined)


def test_required_and_conditionally_required_fields() -> None:
    c = _lead_with_added()
    _, p = t.validate_answers(c, {})
    assert "Blood group: is required" in p and "Call back: is required" in p and not any("Call back time" in x for x in p), p
    _, p2 = t.validate_answers(c, {"blood_group": "O+", "callback": True})
    assert p2 == ["Call back time: is required"], p2
    ok, p3 = t.validate_answers(c, {"blood_group": "O+", "callback": True, "callback_time": "5pm"}, enforce_required=True)
    assert p3 == [] and ok["callback_time"] == "5pm"
    _, p4 = t.validate_answers(c, {}, enforce_required=False)
    assert p4 == [], "an old record is not locked out by a field that became required later"


def test_a_hidden_field_leaves_no_answer_and_a_removed_fields_answer_is_kept() -> None:
    c = _lead_with_added()
    ok, _ = t.validate_answers(c, {"blood_group": "O+", "callback": False, "callback_time": "stale"}, enforce_required=False, keep={"old_removed_field": "kept"})
    assert "callback_time" not in ok and ok["old_removed_field"] == "kept" and ok["callback"] is False, ok
    assert t.validate_answers(None, {"x": 1}, keep={"a": 1})[0] == {"a": 1}, "with no template nothing new is accepted and nothing stored is lost"


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]

if __name__ == "__main__":
    failed = 0
    for fn in TESTS:
        try:
            fn(); print(f"ok   {fn.__name__}")
        except AssertionError as exc:
            failed += 1; print(f"FAIL {fn.__name__}: {exc}")
    print(f"{'PASS' if not failed else 'FAILED'}: {len(TESTS)} template tests, {failed} failed")
    sys.exit(1 if failed else 0)
