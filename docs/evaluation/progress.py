"""Computes the progress of Steps 6 to 9 from the checkboxes in implementation-progress.md.

    python docs/evaluation/progress.py          # the update in the agreed format
    python docs/evaluation/progress.py --json

A criterion counts only when ticked [x]. [~] in progress and [!] blocked count as not done. Each step is worth 25% of the total.
"""
import json
import re
import sys
from pathlib import Path

TRACKER = Path(__file__).with_name("implementation-progress.md")
BOX = re.compile(r"^- \[(?P<mark>[ x~!])\] \((?P<tag>impl|integ|test|fe)\) (?P<text>.*)$")


def parse(text: str):
    steps, step, task = {}, None, None
    for line in text.splitlines():
        if line.startswith("## Step "):
            step = line[3:].split(":")[0]
            steps[step] = {"title": line[3:], "items": []}
        elif line.startswith("## "):
            step = None
        elif step and line.startswith("### "):
            task = line[4:]
        elif step:
            m = BOX.match(line)
            if m:
                steps[step]["items"].append({"task": task, **m.groupdict()})
    return steps


def main() -> int:
    steps = parse(TRACKER.read_text(encoding="utf-8"))
    report, total = {}, 0.0
    for name, s in steps.items():
        items = s["items"]
        done = sum(1 for i in items if i["mark"] == "x")
        pct = 100 * done / len(items) if items else 0.0
        by_tag = {t: [sum(1 for i in items if i["tag"] == t and i["mark"] == "x"), sum(1 for i in items if i["tag"] == t)] for t in ("impl", "integ", "test", "fe")}
        report[name] = {"percent": pct, "done": done, "total": len(items), "in_progress": [i["text"][:70] for i in items if i["mark"] == "~"],
                        "blocked": [i["text"][:90] for i in items if i["mark"] == "!"], "by_tag": by_tag}
        total += pct / len(steps)
    if "--json" in sys.argv:
        print(json.dumps({"overall": total, "steps": report}, indent=1))
        return 0
    print(f"Overall Progress: {total:.0f}%" + ("" if total < 100 else "  (all criteria verified)"))
    print("  |  ".join(f"{n}: {r['percent']:.0f}% ({r['done']}/{r['total']})" for n, r in report.items()))
    for n, r in report.items():
        tags = "  ".join(f"{t} {d}/{tt}" for t, (d, tt) in r["by_tag"].items())
        print(f"  {n}: {tags}" + (f"  | blocked {len(r['blocked'])}" if r["blocked"] else "") + (f"  | in progress {len(r['in_progress'])}" if r["in_progress"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
