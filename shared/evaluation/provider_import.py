"""Reading a provider's usage export, and finding WHERE it differs from what the platform recorded. Pure logic, no database.

A provider's usage page can be exported as a CSV: one row per day (and usually per model) with tokens and cost. Providers name the columns differently and change them, so the reader
recognises each column by a list of names it is known by, tells you which columns it used, and skips (and counts) any row it cannot read instead of guessing. Nothing is filled in:
an export with no cost column gives no billed figure, and the person is asked to type one.

`compare_days` then lines the export up with the recorded cost lines day by day and model by model, so a difference on the bill points at the days and models that explain it:
usage the provider billed on a day when the platform recorded none was not made by an evaluation (or was not attributed to one).
"""
from __future__ import annotations

import csv
import io
import re
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

MAX_BYTES = 5_000_000
MAX_ROWS = 50_000
ALIASES: Dict[str, Tuple[str, ...]] = {
    "day": ("date", "day", "usage_date", "date_utc", "time", "timestamp", "start_time", "start_time_iso", "start_date", "aggregation_timestamp", "period_start"),
    "model": ("model", "model_name", "snapshot_id", "model_id", "line_item", "sku", "description"),
    "input": ("input_tokens", "n_context_tokens_total", "prompt_tokens", "input", "tokens_in", "input_uncached_tokens", "context_tokens"),
    "output": ("output_tokens", "n_generated_tokens_total", "completion_tokens", "output", "tokens_out", "generated_tokens"),
    "cached": ("cached_tokens", "input_cached_tokens", "n_cached_tokens_total", "cache_read_tokens", "cache_read_input_tokens"),
    "usd": ("cost", "amount", "amount_value", "usd", "total_cost", "cost_usd", "spend", "amount_usd", "line_item_cost"),
}


def _norm(h: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", h.strip().lower()).strip("_")


def model_family(name: Optional[str]) -> str:
    """The model without its dated suffix, so the provider's `gpt-4.1-2025-04-14` and the platform's `gpt-4.1` are the same model."""
    return re.sub(r"-(\d{4}-\d{2}-\d{2}|\d{8})$", "", (name or "unknown").strip().lower())


def _day(value: str) -> Optional[date]:
    v = value.strip().strip('"')
    if not v:
        return None
    if re.fullmatch(r"\d{9,13}", v):
        n = int(v)
        return datetime.fromtimestamp(n / 1000 if n > 10**11 else n, tz=timezone.utc).date()
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).astimezone(timezone.utc).date() if ("T" in v or " " in v) else date.fromisoformat(v)
    except ValueError:
        for fmt in ("%m/%d/%Y", "%d/%m/%Y", "%Y/%m/%d"):
            try:
                return datetime.strptime(v, fmt).date()
            except ValueError:
                continue
    return None


def _num(value: Optional[str]) -> Optional[float]:
    v = (value or "").strip().replace(",", "").replace("$", "")
    if v == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def parse_csv(text: str) -> Dict[str, Any]:
    """A usage export read into per-day and per-model totals, with what was recognised and what was left out."""
    if len(text.encode("utf-8", "ignore")) > MAX_BYTES:
        return {"ok": False, "error": f"The file is larger than {MAX_BYTES // 1_000_000} MB."}
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t") if sample.count("\n") else csv.excel
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    try:
        header = next(reader)
    except StopIteration:
        return {"ok": False, "error": "The file is empty."}
    cols = {_norm(h): i for i, h in enumerate(header)}
    used: Dict[str, str] = {}
    idx: Dict[str, int] = {}
    for field, names in ALIASES.items():
        for n in names:
            if n in cols:
                used[field], idx[field] = header[cols[n]], cols[n]
                break
    if "day" not in idx:
        return {"ok": False, "error": "No date column was recognised (looked for: " + ", ".join(ALIASES["day"][:6]) + "…). Columns found: " + ", ".join(header[:12]) + "."}
    if not ({"usd", "input", "output"} & set(idx)):
        return {"ok": False, "error": "No cost or token columns were recognised. Columns found: " + ", ".join(header[:12]) + "."}
    by_day: Dict[str, Dict[str, Any]] = {}
    by_model: Dict[str, Dict[str, Any]] = {}
    skipped: List[Dict[str, Any]] = []
    n_rows = used_rows = 0
    saw_cost = False
    for line_no, row in enumerate(reader, start=2):
        if not any(c.strip() for c in row):
            continue
        n_rows += 1
        if n_rows > MAX_ROWS:
            return {"ok": False, "error": f"More than {MAX_ROWS:,} rows: export a shorter period."}
        get = lambda f: row[idx[f]] if f in idx and idx[f] < len(row) else ""
        d = _day(get("day"))
        if d is None:
            skipped.append({"line": line_no, "reason": f"the date '{get('day')[:30]}' could not be read"})
            continue
        usd, tin, tout, tcached = _num(get("usd")), _num(get("input")), _num(get("output")), _num(get("cached"))
        if usd is None and tin is None and tout is None:
            skipped.append({"line": line_no, "reason": "no cost and no tokens on this row"})
            continue
        used_rows += 1
        saw_cost = saw_cost or usd is not None
        fam = model_family(get("model")) if "model" in idx else "all models"
        for bucket in (by_day.setdefault(d.isoformat(), {"usd": 0.0, "input": 0, "output": 0, "cached": 0}), by_model.setdefault(fam, {"usd": 0.0, "input": 0, "output": 0, "cached": 0})):
            bucket["usd"] += usd or 0.0
            bucket["input"] += int(tin or 0)
            bucket["output"] += int(tout or 0)
            bucket["cached"] += int(tcached or 0)
    if used_rows == 0:
        return {"ok": False, "error": "No row could be read.", "skipped": skipped[:10]}
    days = sorted(by_day)
    tokens = {k: sum(v[k] for v in by_day.values()) for k in ("input", "output", "cached")}
    warnings = []
    if "usd" not in idx:
        warnings.append("This export has no cost column, so it gives no billed amount: type the billed total from the provider's page.")
    if "input" not in idx and "output" not in idx:
        warnings.append("This export has no token columns, so tokens cannot be compared.")
    if "model" not in idx:
        warnings.append("This export has no model column, so the comparison cannot be split by model.")
    if skipped:
        warnings.append(f"{len(skipped)} row(s) could not be read and were left out.")
    return {"ok": True, "columns": used, "rows": n_rows, "rows_used": used_rows, "skipped": skipped[:20], "skipped_count": len(skipped), "period_start": days[0], "period_end": days[-1],
            "billed_usd": round(sum(v["usd"] for v in by_day.values()), 6) if saw_cost else None, "tokens": tokens if ("input" in idx or "output" in idx) else None,
            "by_day": {d: {k: (round(v, 6) if k == "usd" else int(v)) for k, v in by_day[d].items()} for d in days},
            "by_model": {m: {k: (round(v, 6) if k == "usd" else int(v)) for k, v in by_model[m].items()} for m in sorted(by_model)}, "warnings": warnings}


def compare_days(billed_by_day: Dict[str, Dict[str, Any]], billed_by_model: Dict[str, Dict[str, Any]], recorded_by_day: Dict[str, float], recorded_by_model: Dict[str, float], *,
                 tolerance_usd: float = 0.01) -> Dict[str, Any]:
    """The export against the recorded cost lines, per day and per model. A day (or a model) where the provider billed more than was recorded is where unattributed usage is:
    the platform recorded nothing there, so an evaluation did not make it, or it was not attributed to one."""
    fam_recorded: Dict[str, float] = {}
    for m, v in recorded_by_model.items():
        fam_recorded[model_family(m)] = fam_recorded.get(model_family(m), 0.0) + v

    def rows(billed: Dict[str, float], recorded: Dict[str, float]) -> List[Dict[str, Any]]:
        out = []
        for k in sorted(set(billed) | set(recorded)):
            b, r = billed.get(k, 0.0), recorded.get(k, 0.0)
            gap = round(b - r, 6)
            out.append({"key": k, "billed_usd": round(b, 6), "recorded_usd": round(r, 6), "difference_usd": gap,
                        "verdict": "matches" if abs(gap) <= tolerance_usd else "billed_not_recorded" if r == 0 else "billed_more" if gap > 0 else "recorded_more"})
        return out
    days = rows({d: v["usd"] for d, v in billed_by_day.items()}, recorded_by_day)
    models = rows({m: v["usd"] for m, v in billed_by_model.items()}, fam_recorded)
    order = lambda items: sorted(items, key=lambda x: -abs(x["difference_usd"]))
    return {"days": days, "models": models, "largest_days": [d for d in order(days) if d["verdict"] != "matches"][:8], "largest_models": [m for m in order(models) if m["verdict"] != "matches"][:8],
            "days_billed_not_recorded": [d["key"] for d in days if d["verdict"] == "billed_not_recorded"],
            "explanation": _explain(days, models)}


def _explain(days: Sequence[Dict[str, Any]], models: Sequence[Dict[str, Any]]) -> List[str]:
    out = []
    nr = [d for d in days if d["verdict"] == "billed_not_recorded"]
    if nr:
        total = sum(d["difference_usd"] for d in nr)
        out.append(f"{len(nr)} day(s) were billed (${total:.4f}) with nothing recorded by the platform: no evaluation ran then, so that usage was made by something else on the same key, or was not attributed.")
    more = [d for d in days if d["verdict"] == "billed_more"]
    if more:
        out.append(f"On {len(more)} day(s) the bill is higher than what was recorded: part of that day's usage was not attributed to an evaluation.")
    rec = [d for d in days if d["verdict"] == "recorded_more"]
    if rec:
        out.append(f"On {len(rec)} day(s) more was recorded than billed: the prices used may be out of date, or a discount was not applied.")
    mnr = [m for m in models if m["verdict"] == "billed_not_recorded"]
    if mnr:
        out.append("Billed but never recorded for model(s): " + ", ".join(m["key"] for m in mnr[:4]) + ".")
    if not out:
        out.append("Every day and every model agrees with what was recorded.")
    return out
