"""Model prices, to turn the token ledger's counts into money. Per million tokens: (input, cached input, output), US dollars.

The prices are the ones the Token Economy page shows (frontend/app/super-admin/tokens/page.tsx). A model not in the table has an
UNKNOWN cost: `cost_of` returns None, never 0, and callers keep the tokens so the cost can be filled in later. Model names in the
ledger carry a date suffix ("gpt-4o-mini-2024-07-18"): the longest listed name that prefixes the ledger's name is used.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, Optional, Tuple

PRICING_VERSION = "builtin-2026-10-22"          # the label of the table below; a database price version (eval_pricing_versions) has its own
PRICES: Dict[str, Tuple[float, float, float]] = {
    "gpt-4o-mini": (0.15, 0.075, 0.60),
    "gpt-4o": (2.50, 1.25, 10.0),
    "gpt-4.1": (2.0, 0.5, 8.0),
    "claude-haiku-4-5": (1.0, 0.1, 5.0),
    "claude-sonnet-4-5": (3.0, 0.3, 15.0),
    "gemini-2.5-flash": (0.30, 0.03, 2.50),
    "gemini-2.5-pro": (1.25, 0.125, 10.0),
    "gemini-embedding": (0.15, 0.15, 0.0),          # an embedding is billed on input tokens only (published list price per million: check it against the provider bill)
    "mock-": (0.0, 0.0, 0.0),            # the scripted stand-in models of the evaluation stack: no money is spent, and the run says so (synthetic)
}


class PriceTable:
    """A versioned set of per-million-token rates. `label` says which version priced a cost, so a figure can be traced and, if the
    rates change later, recomputed from the stored tokens."""

    def __init__(self, label: str, prices: Dict[str, Tuple[float, float, float]]) -> None:
        self.label, self.prices = label, prices

    @classmethod
    def builtin(cls) -> "PriceTable":
        return cls(PRICING_VERSION, dict(PRICES))

    @classmethod
    def from_rates(cls, label: str, rates: Dict[str, Dict[str, float]], *, fallback: Optional["PriceTable"] = None) -> "PriceTable":
        """From the Evaluation Costs module's stored rates: {"gpt-4o-mini": {"input": .15, "cached": .075, "output": .6}}."""
        table = cls(label, {m: (float(r["input"]), float(r.get("cached", r["input"])), float(r["output"])) for m, r in (rates or {}).items()})
        if fallback:
            for model, price in fallback.prices.items():
                table.prices.setdefault(model, price)           # a model missing from the stored version keeps its built-in price
        return table

    def price_of(self, model: Optional[str]) -> Optional[Tuple[float, float, float]]:
        name = (model or "").lower()
        best = max((k for k in self.prices if name.startswith(k.lower())), key=len, default=None)
        return self.prices[best] if best else None

    def cost_of(self, row: Dict[str, Any]) -> Optional[float]:
        """Dollars for one ledger-style row (input_tokens includes the cached part), or None when the model has no price."""
        price = self.price_of(row.get("model_name") or row.get("model"))
        if price is None:
            return None
        inp, cached, out = (int(row.get(k) or 0) for k in ("input_tokens", "cached_tokens", "output_tokens"))
        cached = min(cached, inp)
        return ((inp - cached) * price[0] + cached * price[1] + out * price[2]) / 1_000_000


_BUILTIN = PriceTable.builtin()


def price_of(model: Optional[str]) -> Optional[Tuple[float, float, float]]:
    return _BUILTIN.price_of(model)


def cost_of(row: Dict[str, Any], table: Optional[PriceTable] = None) -> Optional[float]:
    return (table or _BUILTIN).cost_of(row)


def cost_of_rows(rows: Iterable[Dict[str, Any]], table: Optional[PriceTable] = None) -> Tuple[float, int]:
    """(known dollars, number of rows whose cost is unknown)."""
    known, unknown = 0.0, 0
    for r in rows:
        c = cost_of(r, table)
        if c is None:
            unknown += 1
        else:
            known += c
    return known, unknown
