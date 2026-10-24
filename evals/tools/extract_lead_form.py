"""Read the live lead / walk-in form definition (customer-portal/lib/walkinForm.ts and its English labels) and write it as the seed of the
"Lead acquisition" template. Nothing is typed by hand: the tabs, field keys, kinds, required flags, option lists and labels come from the files
the form is built from, so the template starts out exactly equal to the form.

    python evals/tools/extract_lead_form.py            (writes shared/doc_templates_data/lead_acquisition.json)
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PORTAL = ROOT / "microservices/frontend-microservices/customer-portal/lib"
OUT = ROOT / "shared/doc_templates_data/lead_acquisition.json"
KINDS = {"text": "text", "tel": "phone", "date": "date", "number": "number", "select": "select", "bool": "checkbox"}


def main() -> int:
    ts = (PORTAL / "walkinForm.ts").read_text(encoding="utf-8")
    en = (PORTAL / "i18n/en.ts").read_text(encoding="utf-8")
    label = lambda k: (re.search(r'"' + re.escape(k) + r'":\s*"([^"]*)"', en) or [None, None])[1]   # noqa: E731
    consts = {m.group(1): re.findall(r'"([^"]+)"', m.group(2)) for m in re.finditer(r"const (\w+) = \[(.*?)\] as const", ts, re.S)}
    tabs = re.search(r"export const TABS = \[(.*?)\] as const", ts, re.S).group(1)
    tab_ids = re.findall(r'"(\w+)"', tabs)
    fields_block = ts.split("export const FIELDS")[1].split("] as const")[0]
    sections = {t: {"id": t, "title": label(f"walkin.tab.{t}"), "stores_in": "profile", "fields": []} for t in tab_ids}
    for line in fields_block.splitlines():
        m = re.search(r"\{\s*name:\s*\"(\w+)\",\s*tab:\s*\"(\w+)\",\s*kind:\s*\"(\w+)\"(.*)\}", line)
        if not m:
            continue
        name, tab, kind, rest = m.groups()
        f = {"id": name, "label": label(f"walkin.f.{name}") or name, "type": KINDS[kind], "required": "required: true" in rest, "binding": {"store": "profile", "key": name}}
        mo = re.search(r"options:\s*(\[[^\]]*\]|\w+)", rest)
        if mo:
            raw = consts.get(mo.group(1)) if not mo.group(1).startswith("[") else re.findall(r'"([^"]+)"', mo.group(1))
            f["options"] = [{"id": re.sub(r"[^a-z0-9]+", "_", v.lower()).strip("_"), "value": v, "label": label("walkin.o." + re.sub(r"[^A-Za-z0-9]", "", v)) or v} for v in raw]
        if (mm := re.search(r"max:\s*(\d+)", rest)):
            f["max_length"] = int(mm.group(1))
        if (mp := re.search(r'placeholder:\s*"([^"]*)"', rest)):
            f["placeholder"] = mp.group(1)
        sections[tab]["fields"].append(f)
    content = {"title": "Lead acquisition (Add New Customer)", "intro": "The form an agent, a branch or a walk-in customer completes to create a lead. Seeded exactly from the live form.",
               "sections": [sections[t] for t in tab_ids], "disclaimers": []}
    OUT.write_text(json.dumps(content, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    n = sum(len(s["fields"]) for s in content["sections"])
    print(f"{len(content['sections'])} tabs, {n} fields -> {OUT}")
    for s in content["sections"]:
        print(f"  {s['title']}: {len(s['fields'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
