"""Re-score a finished layer-2 run with the CURRENT checks, without any API call.

    python scripts/replay_layer2.py                       # data/layer2_run vs data/layer2_testset
    python scripts/replay_layer2.py --run data/layer2_run --out data/layer2_replay

It feeds each saved model reply back through the pipeline. Use it to see the effect of a change to the checks,
thresholds or severities for free. Limits, stated so the output is not over-read:
  * the model is not asked again, so changes to PROMPTS cannot be tested this way (only a new run can);
  * a second read ("confirm") is answered as it was in the live run (agreed, or disagreed) using the saved notes;
  * the visual inspection is replayed from its saved reply when there is one, else the saved finding is re-graded.
Runs saved before raw replies were kept are converted from the parsed extraction (a faithful but lossy copy).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from docforensics.gemini_client import GeminiClient, Reply, Settings  # noqa: E402
from docforensics.layer2 import Options, run_layer2  # noqa: E402
from docforensics.layer2.schema import Extraction, parse_extraction  # noqa: E402
from docforensics.report import Severity  # noqa: E402
from run_layer2_test import FLAGGED, load_results, print_summary, score, summarize  # noqa: E402

_KEY = re.compile(r"^(?P<name>[a-z_]+)(?:\[(?P<i>\d+)\])?(?:\.(?P<attr>[a-z_]+))?$")


def dump_to_model_json(d: dict) -> dict:
    """Turn a saved dataclass dump of an Extraction back into the JSON shape the model replies with."""
    return {
        "doc_type": d.get("doc_type"), "currency": d.get("currency"), "issuer": d.get("issuer"), "customer": d.get("customer"),
        "legibility": d.get("legibility"),
        "dates": [{"label": x["label"], "printed": x["printed"], "iso": x["iso"]} for x in d.get("dates", [])],
        "period": {"start": d.get("period_start"), "end": d.get("period_end")},
        "line_items": [{k: x.get(k) for k in ("description", "qty", "unit_price", "amount", "discount_percent")} for x in d.get("items", [])],
        **{k: d.get(k) for k in ("subtotal", "discount", "tax", "total", "opening_balance", "closing_balance", "total_credits",
                                 "total_debits", "gross_pay", "total_deductions", "net_pay")},
        "adjustments": d.get("adjustments", []), "earnings": d.get("earnings", []), "deductions": d.get("deductions", []),
        "transactions": [{k: x.get(k) for k in ("date", "description", "debit", "credit", "balance")} for x in d.get("txns", [])],
        "identifiers": [{"label": a, "value": b} for a, b in d.get("identifiers", [])],
    }


def resolve(ex: Extraction, key: str):
    """The value a second read would report for a key such as 'total', 'items[2].amount' or 'earnings[0]'."""
    m = _KEY.match(key)
    if not m:
        return None
    name, i, attr = m["name"], m["i"], m["attr"]
    if i is None:
        return getattr(ex, name, None)
    rows = {"items": ex.items, "txns": ex.txns, "earnings": ex.earnings, "deductions": ex.deductions}.get(name)
    if rows is None or int(i) >= len(rows):
        return None
    row = rows[int(i)]
    return getattr(row, attr or "amount", None)


_QUOTED = re.compile(r"the value '(.*?)':")


def regrade_old_visual(old: dict, new_findings: list[dict]) -> dict:
    """Runs saved before raw visual replies were kept: apply the current rule (MEDIUM only when corroborated) to the saved finding."""
    from docforensics.layer2.runner import _quoted_numbers

    quoted = _quoted_numbers((_QUOTED.search(old["detail"]) or [None, ""])[1])
    flagged = set()
    for f in new_findings:
        flagged |= {abs(Decimal(v)) for v in (f.get("involved") or {}).values()}
    return {**old, "severity": "MEDIUM" if quoted & flagged else "LOW"}


class ReplayTransport:
    """Answers 'extract' with the saved reply, 'confirm' from the saved extraction (an agreeing second read), and
    'visual' with the saved visual reply when there is one."""

    def __init__(self, raw: dict, visual: dict | None = None, second_read_agreed: bool = True):
        self.raw, self.visual, self.agreed = raw, visual, second_read_agreed
        self.ex = parse_extraction(raw)

    def __call__(self, request, settings):
        if request.purpose == "extract":
            return Reply(json.dumps(self.raw))
        if request.purpose == "visual" and self.visual is not None:
            return Reply(json.dumps(self.visual))
        if request.purpose == "confirm":
            keys = re.findall(r'^- "([^"]+)":', request.prompt, re.M)
            if not self.agreed:  # the live second read disagreed: reproduce that, do not invent an agreement
                return Reply(json.dumps({"values": {k: None for k in keys}}))
            return Reply(json.dumps({"values": {k: (None if resolve(self.ex, k) is None else str(resolve(self.ex, k))) for k in keys}}))
        raise RuntimeError(f"replay does not support the '{request.purpose}' call")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", default=str(ROOT / "data" / "layer2_run"))
    ap.add_argument("--testset", default=str(ROOT / "data" / "layer2_testset"))
    ap.add_argument("--out", help="write the replayed records (JSONL) here")
    args = ap.parse_args(argv)

    run_dir, set_dir = Path(args.run), Path(args.testset)
    manifest = json.loads((set_dir / "manifest.json").read_text(encoding="utf-8"))
    saved = load_results(run_dir / "results.jsonl")
    records, changes = [], []
    for entry in manifest:
        old = saved.get(entry["id"])
        if not old or old["status"] not in ("ok", "partial"):
            continue
        raw_path, dump_path = run_dir / "extractions" / f"{entry['id']}.raw.json", run_dir / "extractions" / f"{entry['id']}.json"
        if raw_path.exists():
            raw = json.loads(raw_path.read_text(encoding="utf-8"))
        elif dump_path.exists():
            raw = dump_to_model_json(json.loads(dump_path.read_text(encoding="utf-8")))
        else:
            continue
        path = set_dir / entry["path"]
        file_type = "pdf" if path.suffix.lower() == ".pdf" else "png"
        visual_path = run_dir / "extractions" / f"{entry['id']}.visual.json"
        visual_raw = json.loads(visual_path.read_text(encoding="utf-8")) if visual_path.exists() else None
        agreed = not any("figures differed" in n for n in old.get("notes", []))  # as in the live run
        client = GeminiClient(Settings(min_interval_s=0, max_retries=0), transport=ReplayTransport(raw, visual_raw, agreed),
                              sleep=lambda s: None)
        result = run_layer2(path.read_bytes(), path.name, file_type, entry["doc_type"], client=client,
                            options=Options(visual=visual_raw is not None))
        rec = score(entry, result)
        if visual_raw is None:  # old run: re-grade the saved visual finding under the current rule
            rec["findings"] += [regrade_old_visual(f, rec["findings"]) for f in old["findings"] if f["code"] == "CONTENT_VISUAL_INCONSISTENCY"]
            rec["visual_flag"] = any(f["code"] == "CONTENT_VISUAL_INCONSISTENCY" for f in rec["findings"])
            from docforensics.report import Finding, Category, verdict_from_findings

            graded = [Finding(f["code"], Severity[f["severity"]], Category.TAMPERING, f["title"], f["detail"]) for f in rec["findings"]]
            rec["verdict"] = verdict_from_findings(graded).value if result.status != "failed" else rec["verdict"]
        records.append(rec)
        before = [(f["code"].replace("CONTENT_", ""), f["severity"]) for f in old["findings"]]
        after = [(f["code"].replace("CONTENT_", ""), f["severity"]) for f in rec["findings"]]
        changes.append((entry["id"], entry["label"], old["verdict"], rec["verdict"], before, after))

    print(f"Replayed {len(records)} saved documents with the current checks (no API calls).\n")
    print(f"{'document':44s} {'truth':8s} {'before':12s} {'after':12s}")
    for doc_id, label, was, now, before, after in changes:
        flag = "" if was == now else "   <-- changed"
        print(f"{doc_id:44s} {label:8s} {was:12s} {now:12s}{flag}")
        if before != after:
            print(f"      before: {before}\n      after : {after}")
    summary = summarize(records, len(manifest))
    print_summary(summary, records)
    print("\nNote: the 'API calls' above were REPLAYED from saved replies. No request was sent and no quota was used.")
    if args.out:
        Path(args.out).write_text("\n".join(json.dumps(r) for r in records), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
