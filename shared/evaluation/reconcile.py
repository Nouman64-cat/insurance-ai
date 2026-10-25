"""Reconciling what the platform recorded with what a provider billed. Pure logic, no database.

A person types in what a provider billed for a period (and, if the provider's page shows them, the token totals). The platform adds up its own cost lines for that
provider and period and compares:

  matched          the two agree within the tolerance: the recorded amounts of that period are CONFIRMED by the provider
  under_recorded   the provider billed more than was recorded, and every line was priced: usage reached the provider without being attributed to an execution
                   (another caller on the same key, or calls the runner did not record)
  over_recorded    more was recorded than billed: the prices used are out of date, or a discount (cached input, batch) was not applied
  incomplete       the provider billed more, and some lines could not be priced, so the gap may be explained by them

The bill is the authority on money; the lines are the authority on WHICH execution caused it. Where the token totals are also given, they say which of the two is
off: tokens that agree while dollars differ point to the prices; tokens the provider counted and we did not point to missing attribution.

Each line is then CONFIRMED (its provider's period matched), ESTIMATED (priced from tokens and a recorded price, not matched to a statement) or UNKNOWN (cannot be priced).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional

STATUSES = ("matched", "under_recorded", "over_recorded", "incomplete")
DEFAULT_TOLERANCE_PCT = 5.0
DEFAULT_TOLERANCE_USD = 0.05
TOKEN_TOLERANCE_PCT = 2.0
TOKEN_FIELDS = ("input", "output", "cached")


def allowed_difference(billed_usd: float, tolerance_pct: float = DEFAULT_TOLERANCE_PCT, tolerance_usd: float = DEFAULT_TOLERANCE_USD) -> float:
    """The most the two may differ and still match: a percentage of the bill, but never less than a small fixed amount (a $0.40 bill may differ by cents)."""
    return max(float(tolerance_usd), float(billed_usd) * float(tolerance_pct) / 100.0)


def compare_tokens(billed: Optional[Dict[str, Optional[int]]], recorded: Dict[str, int]) -> Optional[Dict[str, Any]]:
    """Per field the provider's page showed: billed, recorded, the difference and whether they agree. None when no token total was given."""
    given = {k: v for k, v in (billed or {}).items() if k in TOKEN_FIELDS and v is not None}
    if not given:
        return None
    out: Dict[str, Any] = {}
    for k, b in given.items():
        r = int(recorded.get(k) or 0)
        diff = int(b) - r
        pct = (diff / b * 100.0) if b else (0.0 if r == 0 else 100.0)
        out[k] = {"billed": int(b), "recorded": r, "difference": diff, "difference_pct": round(pct, 2), "matches": abs(pct) <= TOKEN_TOLERANCE_PCT}
    out["all_match"] = all(v["matches"] for v in out.values() if isinstance(v, dict))
    return out


def compare(*, billed_usd: float, recorded_usd: float, unknown_lines: int, line_count: int, tolerance_pct: float = DEFAULT_TOLERANCE_PCT,
            tolerance_usd: float = DEFAULT_TOLERANCE_USD, billed_tokens: Optional[Dict[str, Optional[int]]] = None, recorded_tokens: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    """The verdict on one statement. `recorded_usd` is the sum of the priced lines; `unknown_lines` counts the lines that could not be priced (their cost is in no total)."""
    diff = round(float(billed_usd) - float(recorded_usd), 6)
    allowed = allowed_difference(billed_usd, tolerance_pct, tolerance_usd)
    pct = round(diff / billed_usd * 100.0, 2) if billed_usd else (0.0 if not recorded_usd else -100.0)
    tokens = compare_tokens(billed_tokens, recorded_tokens or {})
    why: List[str] = []
    if abs(diff) <= allowed:
        status = "matched"
        why.append(f"the provider billed ${billed_usd:.4f} and ${recorded_usd:.4f} was recorded: within the allowed ${allowed:.4f}")
        if unknown_lines:
            why.append(f"{unknown_lines} line(s) have an unknown cost, so the recorded figure is a lower bound; it still agrees with the bill")
    elif diff > 0:
        if unknown_lines:
            status = "incomplete"
            why.append(f"the provider billed ${diff:.4f} more than was recorded, and {unknown_lines} line(s) could not be priced: they may account for it")
        else:
            status = "under_recorded"
            why.append(f"the provider billed ${diff:.4f} ({abs(pct):.1f}%) more than was recorded, and every recorded line was priced: some usage was not attributed to an execution, "
                       "or the key is also used by something other than evaluations" + (" (no usage at all was recorded for this provider in the period)" if line_count == 0 else ""))
    else:
        status = "over_recorded"
        why.append(f"${-diff:.4f} ({abs(pct):.1f}%) more was recorded than the provider billed: the prices used may be out of date, or a discount (cached input, batch) was not applied")
    if tokens is not None and status != "matched":
        if tokens["all_match"]:
            why.append("the token totals agree, so the difference is in the prices used, not in missing usage")
        else:
            more = [k for k in TOKEN_FIELDS if isinstance(tokens.get(k), dict) and tokens[k]["difference"] > 0 and not tokens[k]["matches"]]
            fewer = [k for k in TOKEN_FIELDS if isinstance(tokens.get(k), dict) and tokens[k]["difference"] < 0 and not tokens[k]["matches"]]
            if more:
                why.append("the provider counted more " + ", ".join(more) + " tokens than were attributed: calls outside evaluations, or calls that were not recorded")
            if fewer:
                why.append("more " + ", ".join(fewer) + " tokens were attributed than the provider counted")
    return {"status": status, "billed_usd": round(float(billed_usd), 6), "recorded_usd": round(float(recorded_usd), 6), "difference_usd": diff, "difference_pct": pct, "allowed_usd": round(allowed, 6),
            "tolerance_pct": tolerance_pct, "tolerance_usd": tolerance_usd, "unknown_lines": int(unknown_lines), "line_count": int(line_count), "tokens": tokens, "explanation": why,
            "confirms": status == "matched"}


def overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
    return a_start <= b_end and b_start <= a_end


def classify_line(provider: Optional[str], at: Optional[datetime], usd: Optional[float], matched_periods: Iterable[Dict[str, Any]]) -> str:
    """confirmed | estimated | unknown for one cost line. `matched_periods` are the periods of statements that match right now: {provider, start, end}."""
    if usd is None:
        return "unknown"
    if provider and at is not None:
        for p in matched_periods:
            if p["provider"] == provider and p["start"] <= at <= p["end"]:
                return "confirmed"
    return "estimated"
