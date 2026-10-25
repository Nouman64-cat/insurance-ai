"""What layer 2 extracts from a document, and strict validation of the model's reply.

The model is an untrusted reader: its reply may be the wrong shape, contain
strings where numbers belong, or be partly invented. ``parse_extraction``
accepts anything and returns either a clean ``Extraction`` or ``None``; every
value it cannot trust becomes ``None`` and is noted in ``warnings``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

MAX_ITEMS = 500
MAX_TXNS = 1500
MAX_ABS = Decimal("1e13")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CURRENCY = re.compile(r"[^\d.,\-()+\s]")
DOC_TYPES = ("invoice", "receipt", "bank_statement", "payslip", "other")


@dataclass
class Item:
    description: str
    qty: Decimal | None
    unit_price: Decimal | None
    amount: Decimal | None
    discount_percent: Decimal | None = None  # a per-line "Disc.%" column, when the table has one


@dataclass
class Txn:
    date: str | None
    description: str
    debit: Decimal | None
    credit: Decimal | None
    balance: Decimal | None


@dataclass
class LabeledAmount:
    label: str
    amount: Decimal


@dataclass
class DateItem:
    label: str
    printed: str
    iso: str | None


@dataclass
class Extraction:
    doc_type: str = "other"
    currency: str | None = None
    legibility: str = "good"
    issuer: str = ""
    customer: str = ""
    dates: list[DateItem] = field(default_factory=list)
    period_start: str | None = None
    period_end: str | None = None
    items: list[Item] = field(default_factory=list)
    subtotal: Decimal | None = None
    discount: Decimal | None = None
    tax: Decimal | None = None
    adjustments: list[LabeledAmount] = field(default_factory=list)
    total: Decimal | None = None
    opening_balance: Decimal | None = None
    closing_balance: Decimal | None = None
    total_credits: Decimal | None = None
    total_debits: Decimal | None = None
    txns: list[Txn] = field(default_factory=list)
    earnings: list[LabeledAmount] = field(default_factory=list)
    gross_pay: Decimal | None = None
    deductions: list[LabeledAmount] = field(default_factory=list)
    total_deductions: Decimal | None = None
    net_pay: Decimal | None = None
    identifiers: list[tuple[str, str]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def has_content(self) -> bool:
        """True when anything with an arithmetic or date relationship was read."""
        scalars = (self.subtotal, self.total, self.opening_balance, self.closing_balance, self.gross_pay,
                   self.net_pay, self.total_deductions, self.total_credits, self.total_debits)
        return bool(self.items or self.txns or self.earnings or self.deductions or self.dates
                    or any(v is not None for v in scalars))

    def text_fields(self) -> list[str]:
        out = [self.issuer, self.customer]
        out += [i.description for i in self.items] + [t.description for t in self.txns]
        out += [a.label for a in self.earnings + self.deductions + self.adjustments]
        out += [v for _, v in self.identifiers]
        return [s for s in out if s]


# ---------------------------------------------------------------------------
# Coercion helpers
# ---------------------------------------------------------------------------

def to_decimal(value: Any) -> Decimal | None:
    """A plain number, or text such as '(1,234.50)', '$1 234,50' or '12.5-'. None when it cannot be trusted."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            d = Decimal(str(value))
        except InvalidOperation:
            return None
    elif isinstance(value, str):
        d = _parse_text_number(value)
        if d is None:
            return None
    else:
        return None
    if not d.is_finite() or abs(d) > MAX_ABS:
        return None
    return d


def _parse_text_number(text: str) -> Decimal | None:
    s = _CURRENCY.sub("", text).strip()
    if not s or not re.search(r"\d", s):
        return None
    negative = s.startswith("(") and s.endswith(")") or s.startswith("-") or s.endswith("-")
    s = s.strip("()+- ").replace(" ", "")
    last_dot, last_comma = s.rfind("."), s.rfind(",")
    if last_dot >= 0 and last_comma >= 0:
        decimal_sep = "." if last_dot > last_comma else ","
    elif last_comma >= 0:
        decimal_sep = "," if len(s) - last_comma - 1 in (1, 2) and s.count(",") == 1 else None
    else:
        decimal_sep = "." if last_dot >= 0 and s.count(".") == 1 else None
    if decimal_sep == ",":
        s = s.replace(".", "").replace(",", ".")
    elif decimal_sep == ".":
        s = s.replace(",", "")
    else:
        s = s.replace(",", "").replace(".", "")
    try:
        d = Decimal(s)
    except InvalidOperation:
        return None
    return -d if negative else d


def to_iso(value: Any) -> str | None:
    if not isinstance(value, str) or not _ISO.match(value.strip()):
        return None
    try:
        date.fromisoformat(value.strip())
    except ValueError:
        return None
    return value.strip()


def _text(value: Any, limit: int = 120) -> str:
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return ""
    return re.sub(r"[\x00-\x1f\x7f]+", " ", str(value)).strip()[:limit]


def _list(value: Any, cap: int) -> list:
    return value[:cap] if isinstance(value, list) else []


def _labeled(raw: Any, warnings: list[str], what: str) -> list[LabeledAmount]:
    out = []
    for row in _list(raw, MAX_ITEMS):
        if not isinstance(row, dict):
            continue
        amount = to_decimal(row.get("amount"))
        if amount is None:
            if row.get("amount") is not None:
                warnings.append(f"{what}: unreadable amount {row.get('amount')!r}")
            continue
        out.append(LabeledAmount(_text(row.get("label")), amount))
    return out


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_extraction(raw: Any) -> Extraction | None:
    """Validate the model's reply. Returns None when it is not a JSON object."""
    if not isinstance(raw, dict):
        return None
    w: list[str] = []
    ex = Extraction()
    doc_type = _text(raw.get("doc_type")).lower().replace(" ", "_")
    ex.doc_type = doc_type if doc_type in DOC_TYPES else "other"
    ex.currency = _text(raw.get("currency"), 12) or None
    ex.legibility = "poor" if _text(raw.get("legibility")).lower() == "poor" else "good"
    ex.issuer, ex.customer = _text(raw.get("issuer")), _text(raw.get("customer"))

    for d in _list(raw.get("dates"), 60):
        if isinstance(d, dict):
            ex.dates.append(DateItem(_text(d.get("label")), _text(d.get("printed") or d.get("value")), to_iso(d.get("iso"))))
    period = raw.get("period") if isinstance(raw.get("period"), dict) else {}
    ex.period_start, ex.period_end = to_iso(period.get("start")), to_iso(period.get("end"))

    for row in _list(raw.get("line_items"), MAX_ITEMS):
        if isinstance(row, dict):
            ex.items.append(Item(_text(row.get("description")), to_decimal(row.get("qty")),
                                 to_decimal(row.get("unit_price")), to_decimal(row.get("amount")),
                                 to_decimal(row.get("discount_percent"))))
    for name in ("subtotal", "discount", "tax", "total", "opening_balance", "closing_balance", "total_credits",
                 "total_debits", "gross_pay", "total_deductions", "net_pay"):
        value = to_decimal(raw.get(name))
        if value is None and raw.get(name) is not None:
            w.append(f"{name}: unreadable value {raw.get(name)!r}")
        setattr(ex, name, value)
    ex.adjustments = _labeled(raw.get("adjustments"), w, "adjustments")
    ex.earnings = _labeled(raw.get("earnings"), w, "earnings")
    ex.deductions = _labeled(raw.get("deductions"), w, "deductions")

    for row in _list(raw.get("transactions"), MAX_TXNS):
        if isinstance(row, dict):
            ex.txns.append(Txn(to_iso(row.get("date")), _text(row.get("description")), to_decimal(row.get("debit")),
                               to_decimal(row.get("credit")), to_decimal(row.get("balance"))))
    for row in _list(raw.get("identifiers"), 40):
        if isinstance(row, dict) and _text(row.get("value"), 60):
            ex.identifiers.append((_text(row.get("label"), 40), _text(row.get("value"), 60)))
    ex.warnings = w
    return ex
