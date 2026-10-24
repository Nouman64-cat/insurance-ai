"""Editable templates (Proposal and Illustration): the content format, the rules a template must meet, differences between versions, and the
first versions. Pure: no database, no network.

A template's content is plain data a Super Admin edits in the Templates tab:

    {"title": str, "intro": str,
     "sections": [{"id", "title", "description", "stores_in", "fields": [FIELD, ...]}],
     "disclaimers": [str, ...]}

    FIELD = {"id", "label", "type", "required", "help", "locked", "options": [{"id","label","value"}], "columns": [{"id","label","type"}],
             "detail_fields": [{"id","label","type"}], "show_if": {"field": id, "equals": value}}

Types: text, textarea, number, date, phone, checkbox (a single tick), yes_no, select, checklist, table, statement, display.
  display    a value the system fills in (from the case, the plan or the premium quote); shown, not asked
  statement  wording the person confirms (a declaration)
  checklist  a list of items to tick, each with optional detail fields (the medical conditions)
  table      repeated rows (hospital stays, family history, existing policies)

`binding` says where the answer is stored: {"store": "profile", "key": "mobile_number"} is a field of the customer profile the API already accepts;
{"store": "details"} (the default for a field added in the Templates tab) is kept with the customer under `details.custom.<field id>`.
An option's `value` is what is stored (and what the API expects); its `label` is what people read, so a label can be reworded without changing stored data.
A field that is `required` in the seeded lead form is also locked, because the API refuses a lead without it.

`locked` marks a field the product depends on. Its wording may change, but a published template may not remove it or change its type: the
check compares a new version with the last published one. Everything else can be added, removed, renamed and reordered.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from typing import Any, Dict, List, Optional

FIELD_TYPES = ("text", "textarea", "number", "date", "phone", "checkbox", "yes_no", "select", "checklist", "table", "statement", "display")
SLUG = re.compile(r"^[a-z][a-z0-9_]{0,59}$")
BINDING_STORES = ("profile", "details")
MAX_SECTIONS, MAX_FIELDS, MAX_OPTIONS, MAX_TEXT = 30, 80, 60, 2000
ACQUISITION_SOURCES = [("AGENT", "Agent"), ("BROKER", "Broker"), ("BANCASSURANCE", "Bancassurance"), ("CORPORATE_AGENT", "Corporate agent"),
                       ("DIRECT", "Walk-in (direct)"), ("DIGITAL", "Digital")]


def content_hash(content: Any) -> str:
    return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def _field_problems(f: Any, where: str, ids_before: set, in_table: bool = False) -> List[str]:
    out: List[str] = []
    if not isinstance(f, dict):
        return [f"{where}: a field must be an object"]
    fid, ftype = f.get("id"), f.get("type")
    if not isinstance(fid, str) or not SLUG.match(fid):
        out.append(f"{where}: field id {fid!r} must be lowercase letters, digits and underscores, starting with a letter")
    if ftype not in FIELD_TYPES or (in_table and ftype in ("table", "checklist", "statement", "display")):
        out.append(f"{where}: field {fid!r} has type {ftype!r}, which is not allowed here")
    if not isinstance(f.get("label"), str) or not f["label"].strip():
        out.append(f"{where}: field {fid!r} needs a label")
    for key in ("label", "help"):
        if isinstance(f.get(key), str) and len(f[key]) > MAX_TEXT:
            out.append(f"{where}: field {fid!r} {key} is longer than {MAX_TEXT} characters")
    if ftype in ("select", "checklist"):
        opts = f.get("options")
        if not isinstance(opts, list) or not opts or len(opts) > MAX_OPTIONS:
            out.append(f"{where}: field {fid!r} needs between 1 and {MAX_OPTIONS} options")
        else:
            seen = set()
            for o in opts:
                if not isinstance(o, dict) or not isinstance(o.get("id"), str) or not SLUG.match(o["id"]) or not str(o.get("label", "")).strip():
                    out.append(f"{where}: field {fid!r} has an option without a valid id and label")
                elif o["id"] in seen:
                    out.append(f"{where}: field {fid!r} repeats the option {o['id']!r}")
                else:
                    seen.add(o["id"])
    if ftype in ("table", "checklist"):
        sub = f.get("columns") if ftype == "table" else f.get("detail_fields", [])
        if ftype == "table" and (not isinstance(sub, list) or not sub):
            out.append(f"{where}: table {fid!r} needs at least one column")
        for i, c in enumerate(sub or []):
            out += _field_problems(c, f"{where} / {fid} column {i + 1}", set(), in_table=True)
        ids = [c.get("id") for c in (sub or []) if isinstance(c, dict)]
        if len(ids) != len(set(ids)):
            out.append(f"{where}: {fid!r} repeats a column id")
    binding = f.get("binding")
    if binding is not None and (not isinstance(binding, dict) or binding.get("store") not in BINDING_STORES
                                or (binding["store"] == "profile" and not (isinstance(binding.get("key"), str) and SLUG.match(binding["key"])))):
        out.append(f"{where}: field {fid!r} has a storage setting that is not valid")
    if isinstance(f.get("max_length"), int) and not (1 <= f["max_length"] <= 5000):
        out.append(f"{where}: field {fid!r} max_length must be between 1 and 5000")
    cond = f.get("show_if")
    if cond is not None:
        if not isinstance(cond, dict) or cond.get("field") not in ids_before:
            out.append(f"{where}: field {fid!r} is shown only if {cond.get('field') if isinstance(cond, dict) else cond!r}, which must be an earlier field")
    return out


def problems(content: Any) -> List[str]:
    """Everything wrong with a template's content, in plain words. An empty list means it can be saved and published."""
    if not isinstance(content, dict):
        return ["the template must be an object"]
    out: List[str] = []
    if not isinstance(content.get("title"), str) or not content["title"].strip():
        out.append("the template needs a title")
    sections = content.get("sections")
    if not isinstance(sections, list) or not sections:
        return out + ["the template needs at least one section"]
    if len(sections) > MAX_SECTIONS:
        out.append(f"at most {MAX_SECTIONS} sections")
    section_ids: set = set()
    earlier: set = set()
    for si, s in enumerate(sections):
        where = f"section {si + 1}"
        if not isinstance(s, dict) or not isinstance(s.get("id"), str) or not SLUG.match(s["id"]):
            out.append(f"{where}: needs an id (lowercase letters, digits, underscores)")
            continue
        where = f"section '{s['id']}'"
        if s["id"] in section_ids:
            out.append(f"{where}: the id is used twice")
        section_ids.add(s["id"])
        if not isinstance(s.get("title"), str) or not s["title"].strip():
            out.append(f"{where}: needs a title")
        fields = s.get("fields")
        if not isinstance(fields, list) or len(fields) > MAX_FIELDS:
            out.append(f"{where}: needs a list of at most {MAX_FIELDS} fields")
            continue
        for f in fields:
            out += _field_problems(f, where, earlier)
            fid = f.get("id") if isinstance(f, dict) else None
            if isinstance(fid, str):
                if fid in earlier:
                    out.append(f"{where}: the field id {fid!r} is used twice in this template")
                earlier.add(fid)
    disclaimers = content.get("disclaimers", [])
    if not isinstance(disclaimers, list) or any(not isinstance(d, str) for d in disclaimers):
        out.append("disclaimers must be a list of text")
    return out


def locked_fields(content: Dict[str, Any]) -> Dict[str, str]:
    return {f["id"]: f["type"] for s in content.get("sections", []) for f in s.get("fields", []) if f.get("locked")}


def publish_problems(new: Dict[str, Any], previous: Optional[Dict[str, Any]]) -> List[str]:
    """What stops a template from being published: it must be valid, and it may not drop a locked field or change its type. A locked field stays
    locked even if the new draft forgot the flag."""
    out = problems(new)
    if previous is None:
        return out
    now = {f["id"]: f for s in new.get("sections", []) if isinstance(s, dict) for f in s.get("fields", []) if isinstance(f, dict)}
    for fid, ftype in locked_fields(previous).items():
        if fid not in now:
            out.append(f"'{fid}' is locked because the product depends on it, so it cannot be removed")
        elif now[fid].get("type") != ftype:
            out.append(f"'{fid}' is locked: its type must stay {ftype!r}")
        elif not now[fid].get("locked"):
            out.append(f"'{fid}' is locked and must stay locked")
    return out


def _flat(content: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {"title": content.get("title"), "intro": content.get("intro"), "disclaimers": list(content.get("disclaimers", []))}
    for si, s in enumerate(content.get("sections", [])):
        out[f"section:{s['id']}"] = {"title": s.get("title"), "description": s.get("description"), "position": si}
        for fi, f in enumerate(s.get("fields", [])):
            out[f"field:{f['id']}"] = {**{k: v for k, v in f.items() if k != "id"}, "section": s["id"], "position": fi}
    return out


def diff(old: Dict[str, Any], new: Dict[str, Any]) -> List[Dict[str, Any]]:
    """What changed between two versions, in terms a person reads: sections and fields added, removed, moved or edited."""
    a, b = _flat(old), _flat(new)
    out: List[Dict[str, Any]] = []
    for key in sorted(set(a) | set(b)):
        if key not in a:
            out.append({"change": "added", "what": key, "after": b[key]})
        elif key not in b:
            out.append({"change": "removed", "what": key, "before": a[key]})
        elif a[key] != b[key]:
            if isinstance(a[key], dict) and isinstance(b[key], dict):
                fields = sorted(k for k in set(a[key]) | set(b[key]) if a[key].get(k) != b[key].get(k))
                out.append({"change": "moved" if fields == ["position"] else "edited", "what": key, "fields": fields,
                            "before": {k: a[key].get(k) for k in fields}, "after": {k: b[key].get(k) for k in fields}})
            else:
                out.append({"change": "edited", "what": key, "before": a[key], "after": b[key]})
    return out


def _is_added(f: Dict[str, Any]) -> bool:
    """A field added in the Templates tab says so (`binding.store == "details"`). Anything else (the seeded fields) is part of the form itself."""
    return (f.get("binding") or {}).get("store") == "details"


def _visible(f: Dict[str, Any], values: Dict[str, Any]) -> bool:
    cond = f.get("show_if")
    if not cond:
        return True
    v = values.get(cond.get("field"))
    shown = "Yes" if v is True else "No" if v is False else "" if v is None else str(v)
    return shown == cond.get("equals")


def validate_answers(content: Optional[Dict[str, Any]], answers: Any, *, enforce_required: bool = True,
                     keep: Optional[Dict[str, Any]] = None) -> "tuple[Dict[str, Any], List[str]]":
    """Check the answers given to the fields ADDED in the Templates tab (stored under `details.custom`) and return (clean answers, problems).

    Unknown keys are dropped, except keys already stored with the customer (`keep`): an answer to a field that was later removed is never lost.
    A hidden field's answer is dropped. Each value must fit its field: text within its length, a number a number, a date an ISO date, a tick
    box true or false, a choice one of the field's options (stored as the option's value). Required, visible fields must be answered when
    `enforce_required` is set (a new record); an old record is not locked out by a field that became required later."""
    problems: List[str] = []
    clean: Dict[str, Any] = {}
    bad: set = set()
    if content is None:
        return dict(keep or {}), problems
    if answers is None:
        answers = {}
    if not isinstance(answers, dict):
        return dict(keep or {}), ["the answers must be an object"]
    fields = {f["id"]: f for sec in content.get("sections", []) for f in sec.get("fields", []) if _is_added(f)}
    if len(answers) > 200:
        return dict(keep or {}), ["too many answers"]
    for fid, f in fields.items():
        if fid not in answers or not _visible(f, answers):
            continue
        v, label = answers[fid], f.get("label", fid)
        t = f.get("type")
        try:
            if v is None or v == "":
                continue
            if t in ("text", "textarea", "phone"):
                if not isinstance(v, (str, int, float)) or isinstance(v, bool):
                    raise ValueError("must be text")
                v = str(v).strip()
                if len(v) > int(f.get("max_length") or MAX_TEXT):
                    raise ValueError(f"is longer than {f.get('max_length') or MAX_TEXT} characters")
            elif t == "number":
                if isinstance(v, bool) or not isinstance(v, (int, float, str)):
                    raise ValueError("must be a number")
                try:
                    v = float(v)
                except ValueError:
                    raise ValueError("must be a number")
                v = int(v) if v == int(v) else v
            elif t == "date":
                from datetime import date as _date
                try:
                    v = _date.fromisoformat(str(v)).isoformat()
                except ValueError:
                    raise ValueError("must be a date (year-month-day)")
            elif t in ("checkbox", "yes_no"):
                if not isinstance(v, bool):
                    raise ValueError("must be yes or no")
            elif t == "select":
                opts = f.get("options") or []
                match = next((o for o in opts if v in (o.get("value"), o.get("label"), o.get("id"))), None)
                if match is None:
                    raise ValueError("must be one of its options")
                v = match.get("value") or match.get("label")
            else:
                raise ValueError("is a kind of field this form cannot take yet")
        except (ValueError, TypeError) as exc:
            problems.append(f"{label}: {exc}" if str(exc) else f"{label}: is not valid")
            bad.add(fid)
            continue
        clean[fid] = v
    if enforce_required:
        for fid, f in fields.items():
            if fid in bad:
                continue
            if f.get("required") and _visible(f, {**answers, **clean}) and (fid not in clean or clean[fid] is False and f.get("type") == "checkbox"):
                problems.append(f"{f.get('label', fid)}: is required")
    for k, v in (keep or {}).items():
        clean.setdefault(k, v)
    return clean, problems


def field_ids(content: Dict[str, Any]) -> List[str]:
    return [f["id"] for s in content.get("sections", []) for f in s.get("fields", [])]


# ── the first versions ─────────────────────────────────────────────────────────────────────────────────────────────────

def _f(fid: str, label: str, ftype: str = "text", **kw: Any) -> Dict[str, Any]:
    return {"id": fid, "label": label, "type": ftype, "required": kw.pop("required", False), **kw}


def _yn(fid: str, label: str, **kw: Any) -> Dict[str, Any]:
    return _f(fid, label, "yes_no", **kw)


def _opts(*pairs: str) -> List[Dict[str, str]]:
    return [{"id": re.sub(r"[^a-z0-9]+", "_", p.lower()).strip("_"), "label": p} for p in pairs]


CONDITIONS = ["High Blood Pressure / Hypertension", "Diabetes (Type 1 or Type 2)", "Heart Disease / Cardiovascular Condition", "Cancer / Malignancy",
              "Respiratory Disease (Asthma, COPD)", "Kidney or Liver Disorder", "Neurological Condition (Stroke, Epilepsy)",
              "Mental Health Condition (Depression, Anxiety)", "HIV / AIDS", "Any Other Chronic Illness Requiring Ongoing Treatment"]
CONDITION_KEYS = ["hypertension", "diabetes", "heart_disease", "cancer", "respiratory", "kidney_liver", "neurological", "mental_health", "hiv_aids", "other_chronic"]
STAY = [{"id": "date", "label": "Date", "type": "text"}, {"id": "reason_or_type", "label": "Reason or type", "type": "text"},
        {"id": "hospital", "label": "Hospital", "type": "text"}, {"id": "duration", "label": "Duration", "type": "text"}]


def seed_proposal() -> Dict[str, Any]:
    """The customer e-application as the live form asks it today (frontend/app/e-application/[token]/page.tsx and routers/e_application.py)."""
    return {
        "title": "Life insurance proposal (customer e-application)",
        "intro": "Seeded from the live e-application form. Review each section: the questions below are what customers are asked today.",
        "sections": [
            {"id": "confirm_details", "title": "Confirm details", "description": "Filled from the case; the customer checks it.", "stores_in": None, "fields": [
                _f("full_name", "Full name", "display", locked=True), _f("cnic", "CNIC", "display", locked=True), _f("plan", "Plan", "display"),
                _f("coverage_amount", "Coverage amount", "display"), _f("policy_term", "Policy term", "display")]},
            {"id": "medical", "title": "Medical questionnaire", "stores_in": "medical_questionnaire", "fields": [
                _f("height_cm", "Height (cm)", "number", required=True, locked=True), _f("weight_kg", "Weight (kg)", "number", required=True, locked=True),
                _yn("tobacco_use", "Do you use tobacco?", required=True), _f("tobacco_frequency", "How often?", show_if={"field": "tobacco_use", "equals": "Yes"}),
                _yn("alcohol_use", "Do you drink alcohol?", required=True), _f("alcohol_units_per_week", "Units per week", "number", show_if={"field": "alcohol_use", "equals": "Yes"}),
                _yn("drug_use", "Do you use recreational drugs?", required=True), _f("drug_use_details", "Please give details", "textarea", show_if={"field": "drug_use", "equals": "Yes"}),
                _f("conditions", "Do you have, or have you had, any of these conditions?", "checklist",
                   options=[{"id": k, "label": l} for k, l in zip(CONDITION_KEYS, CONDITIONS)],
                   detail_fields=[_f("year_of_diagnosis", "Year of diagnosis"), _yn("under_treatment", "Under treatment now?"), _f("medications", "Medications"),
                                  _f("physician_name", "Physician name"), _f("physician_clinic", "Physician clinic"), _f("physician_phone", "Physician phone"),
                                  _f("last_consultation_date", "Last consultation", "date")]),
                _yn("has_hospitalizations", "Hospital stays in the last 5 years?"), _f("hospitalizations", "Hospital stays", "table", columns=STAY, show_if={"field": "has_hospitalizations", "equals": "Yes"}),
                _yn("has_surgeries", "Surgeries in the last 5 years?"), _f("surgeries", "Surgeries", "table", columns=STAY, show_if={"field": "has_surgeries", "equals": "Yes"}),
                _yn("physical_deformity", "Are you or any family member suffering, or have suffered, from any physical deformity?"),
                _yn("congenital_defect", "Do you or any family member have, or have had, any congenital abnormality or birth defect?"),
                _yn("mental_disorder", "Do you or any family member suffer, or have suffered, from any mental, psychiatric or nervous disorder not already listed?"),
                _yn("pregnancy", "Are you, or is your spouse, currently pregnant? If yes, how many months?"),
                _yn("family_not_healthy", "Is there anything about your or your family's health you have not already disclosed?")]},
            {"id": "family_history", "title": "Family history", "stores_in": "family_history", "fields": [
                _f("family_members", "Family members with a medical condition", "table", columns=[
                    {"id": "relation", "label": "Relation", "type": "text"}, {"id": "name", "label": "Name", "type": "text"}, {"id": "age", "label": "Age", "type": "number"},
                    {"id": "is_alive", "label": "Alive?", "type": "yes_no"}, {"id": "condition", "label": "Condition", "type": "text"},
                    {"id": "age_at_onset", "label": "Age at onset", "type": "number"}])]},
            {"id": "lifestyle", "title": "Lifestyle and habits", "stores_in": "lifestyle_habits", "fields": [
                _f("occupation_hazard_level", "Occupation hazard level", "select", options=_opts("Low", "Medium", "High")),
                _yn("has_hazardous_hobby", "I take part in hazardous hobbies or sports"), _f("hazardous_hobby_details", "Please give details", "textarea", show_if={"field": "has_hazardous_hobby", "equals": "Yes"}),
                _yn("frequent_foreign_travel", "I travel abroad frequently"), _f("foreign_travel_details", "Countries and frequency", show_if={"field": "frequent_foreign_travel", "equals": "Yes"}),
                _yn("road_travel_frequent", "I travel long distances by road regularly"), _f("road_trips_per_month", "Road trips per month", "number", show_if={"field": "road_travel_frequent", "equals": "Yes"}),
                _f("road_trip_hours", "Typical trip length (hours)", "number", show_if={"field": "road_travel_frequent", "equals": "Yes"}),
                _f("road_travel_details", "Routes and vehicle", "textarea", show_if={"field": "road_travel_frequent", "equals": "Yes"}),
                _f("moving_violations_past_3_years", "Moving traffic violations (past 3 years)", "number"),
                _yn("dui_dwi_history", "I have a DUI/DWI history"), _yn("criminal_record", "I have a criminal record or a pending case")]},
            {"id": "existing_insurance", "title": "Existing insurance", "stores_in": "existing_insurance", "fields": [
                _yn("has_existing_policies", "I have existing life insurance policies with any insurer"),
                _f("policies", "Existing policies", "table", show_if={"field": "has_existing_policies", "equals": "Yes"}, columns=[
                    {"id": "insurer_name", "label": "Insurer name", "type": "text"}, {"id": "policy_number", "label": "Policy number", "type": "text"},
                    {"id": "sum_assured", "label": "Sum assured (PKR)", "type": "number"}, {"id": "status", "label": "Status", "type": "select", "options": _opts("Active", "Lapsed", "Surrendered")}]),
                _yn("applied_last_2_years", "I applied for life insurance in the last 2 years"), _yn("was_declined_or_deferred", "That application was deferred, declined or rated"),
                _f("declined_details", "Please give details", "textarea", show_if={"field": "was_declined_or_deferred", "equals": "Yes"})]},
            {"id": "declaration", "title": "Declaration and signature", "stores_in": "declaration", "fields": [
                _f("confirms_accurate", "I confirm that all information provided is true and complete to the best of my knowledge.", "statement", required=True, locked=True),
                _f("authorizes_records_access", "I authorize the insurer to obtain any medical, financial, or other records needed for underwriting.", "statement", required=True, locked=True),
                _f("not_signed_blank", "I have not signed a blank form, and I understand all my answers form part of the insurance contract.", "statement", required=True, locked=True),
                _f("understood_terms", "I have received and understood the policy benefits, exclusions, and free-look/cooling-off period terms.", "statement", required=True, locked=True),
                _f("signature_name", "Type your full legal name as your electronic signature", "text", required=True, locked=True)]},
            {"id": "employment_income", "title": "Employment and income", "stores_in": "financial_profile", "fields": [
                _f("employment_type", "Employment type"), _f("occupation", "Occupation / job title"), _f("employer_or_business", "Employer or business name"),
                _f("years_in_role", "Years in this role", "number"), _f("annual_income", "Annual income (PKR)", "number", required=True),
                _f("income_basis", "This amount is", "select", options=_opts("Gross", "Net")), _f("other_income_sources", "Other income sources (rent, investments, business), if any"),
                _f("other_income_amount", "Other income per year (PKR)", "number")]},
            {"id": "commitments_assets", "title": "Commitments and assets", "stores_in": "financial_profile", "fields": [
                _f("monthly_household_expenses", "Monthly household expenses (PKR)", "number"), _f("dependants", "People financially dependent on you", "number"),
                _yn("has_loans", "I have loans or other debts (home, car, personal, business, credit cards)"), _f("loan_details", "Loan details (lender, type, amount outstanding)", "textarea", show_if={"field": "has_loans", "equals": "Yes"}),
                _f("monthly_loan_repayments", "Total monthly repayments (PKR)", "number", show_if={"field": "has_loans", "equals": "Yes"}),
                _f("savings_and_investments", "Savings and investments (PKR)", "number"), _yn("owns_property", "I own property"),
                _f("property_details", "Property details (type, city, approximate value)", show_if={"field": "owns_property", "equals": "Yes"}), _f("other_assets", "Other significant assets, if any")]},
            {"id": "premium_purpose", "title": "Premium and purpose", "stores_in": "financial_profile", "fields": [
                _f("premium_payer", "Who will pay the premium?"), _f("premium_source", "From which source?"), _f("purpose_of_cover", "Main purpose of this cover"),
                _f("purpose_details", "Anything else we should know (optional)", "textarea")]},
        ],
        "disclaimers": [],
    }


def seed_lead_acquisition() -> Dict[str, Any]:
    """The lead form exactly as the live form defines it (customer-portal/lib/walkinForm.ts): generated by evals/tools/extract_lead_form.py."""
    import os
    path = os.path.join(os.path.dirname(__file__), "doc_templates_data", "lead_acquisition.json")
    with open(path, encoding="utf-8") as fh:
        content = json.load(fh)
    for section in content["sections"]:
        for f in section["fields"]:
            if f.get("required"):
                f["locked"] = True                                      # the API refuses a lead without it
    return content


def seed_templates() -> List[Dict[str, Any]]:
    out = [
        {"template_key": "lead_acquisition", "kind": "lead", "group_key": None, "title": "Lead acquisition (Add New Customer)",
         "description": "The form an agent, a branch or a walk-in customer completes to create a lead, in 8 tabs.", "content": seed_lead_acquisition()},
        {"template_key": "proposal", "kind": "proposal", "group_key": None, "title": "Proposal (customer e-application)",
         "description": "The questionnaire a customer completes for a life insurance application.", "content": seed_proposal()},
    ]
    for t in out:
        assert not problems(t["content"]), (t["template_key"], problems(t["content"]))
    return copy.deepcopy(out)
