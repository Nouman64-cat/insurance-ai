"""Deterministic content checks over an ``Extraction``.

The model only *reads* the document; everything here is exact arithmetic with
``Decimal``. Each check returns ``Candidate`` objects. The runner then verifies
the figures behind each numeric candidate (against the PDF text layer, or a
second read) before deciding how severe the finding is.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal

from ..report import Category, Severity
from .schema import Extraction

ZERO = Decimal(0)


@dataclass
class Candidate:
    code: str
    title: str
    detail: str
    category: Category
    kind: str  # "numeric": figures get verified; "identifier": the string is checked against the text layer; else fixed
    severity: Severity  # severity once verified (numeric) or as-is (others)
    soft: bool = False  # inference with innocent explanations: never above MEDIUM
    involved: dict[str, Decimal] = field(default_factory=dict)
    describe: dict[str, str] = field(default_factory=dict)
    evidence: dict = field(default_factory=dict)
    diff: Decimal | None = None
    tolerance: Decimal = Decimal("0.05")


def _tol(n_terms: int, *values: Decimal | None) -> Decimal:
    """Rounding allowance: a cent per term, or 0.05%, whichever is larger (never below 5 cents)."""
    big = max((abs(v) for v in values if v is not None), default=ZERO)
    return max(Decimal("0.05"), Decimal("0.01") * n_terms, big * Decimal("0.0005"))


def _money(v: Decimal) -> str:
    return f"{v:,.2f}"


def _sum(values) -> Decimal:
    return sum(values, ZERO)


def _short(text: str, n: int = 40) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


# ---------------------------------------------------------------------------
# Invoices and receipts
# ---------------------------------------------------------------------------

def check_amounts(ex: Extraction) -> list[Candidate]:
    out: list[Candidate] = []
    rows = [(i, it) for i, it in enumerate(ex.items) if it.amount is not None]

    def item_keys(sel) -> tuple[dict[str, Decimal], dict[str, str]]:
        inv, desc = {}, {}
        for i, it in sel:
            key = f"items[{i}].amount"
            inv[key] = it.amount
            desc[key] = f"line item {i + 1} ({_short(it.description) or 'no description'})"
        return inv, desc

    for i, it in enumerate(ex.items):
        if it.qty is not None and it.unit_price is not None and it.amount is not None and it.qty > 0:
            expected = it.qty * it.unit_price
            if it.discount_percent is not None:
                expected = expected * (Decimal(100) - it.discount_percent) / Decimal(100)
            tol = _tol(1, it.amount, expected)
            if abs(expected - it.amount) > tol:
                keys = {f"items[{i}].qty": it.qty, f"items[{i}].unit_price": it.unit_price, f"items[{i}].amount": it.amount}
                if it.discount_percent is not None:
                    keys[f"items[{i}].discount_percent"] = it.discount_percent
                # An amount BELOW quantity x price has an innocent explanation (a discount the page does not show);
                # an amount above it does not. Only the latter is worth a MEDIUM on its own.
                reduced = it.amount < expected and it.discount_percent is None
                note = (" The amount is lower than quantity × price, which an unlisted discount would explain."
                        if reduced else " A changed amount is rarely re-derived by the forger.")
                out.append(Candidate(
                    "CONTENT_LINE_AMOUNT_MISMATCH", f"Line {i + 1}: quantity × price does not equal the amount",
                    f"Line item {i + 1} ({_short(it.description)}): {it.qty} × {_money(it.unit_price)}"
                    + (f" less {it.discount_percent}%" if it.discount_percent is not None else "")
                    + f" = {_money(expected)}, but the amount printed is {_money(it.amount)}.{note}",
                    Category.TAMPERING, "numeric", Severity.LOW if reduced else Severity.HIGH, soft=True, involved=keys,
                    describe={k: f"line item {i + 1} {k.split('.')[-1]}" for k in keys},
                    evidence={"row": i + 1, "expected": str(expected), "printed": str(it.amount)},
                    diff=it.amount - expected, tolerance=tol))

    items_sum = _sum(it.amount for _, it in rows) if len(rows) >= 2 else None
    # Receipts often list items at list price, with the discounted net printed beside or under it. The subtotal may then
    # be the sum of list prices (quantity x price) while the amounts read are the nets. Either sum can match.
    gross_sum = (_sum((it.qty * it.unit_price) if (it.qty and it.unit_price is not None and it.qty > 0) else it.amount
                      for _, it in rows) if len(rows) >= 2 else None)

    def explained_by_list_prices(target: Decimal) -> bool:
        """Subtotal/total equals the list-price sum AND the amounts are at or below list price (a discount), never above:
        a forger who raises an amount must not be excused by this reading."""
        return (gross_sum is not None and abs(gross_sum - target) <= _tol(len(rows), gross_sum, target)
                and items_sum <= gross_sum + _tol(len(rows), gross_sum))

    if items_sum is not None and ex.subtotal is not None:
        tol = _tol(len(rows), items_sum, ex.subtotal)
        if abs(items_sum - ex.subtotal) > tol and not explained_by_list_prices(ex.subtotal):
            inv, desc = item_keys(rows)
            inv["subtotal"], desc["subtotal"] = ex.subtotal, "subtotal"
            out.append(Candidate(
                "CONTENT_LINE_ITEMS_DONT_ADD_UP", "Line items do not add up to the subtotal",
                f"The {len(rows)} line items add up to {_money(items_sum)}, but the subtotal printed is "
                f"{_money(ex.subtotal)} (difference {_money(ex.subtotal - items_sum)}).",
                Category.TAMPERING, "numeric", Severity.HIGH, involved=inv, describe=desc,
                evidence={"items_sum": str(items_sum), "subtotal": str(ex.subtotal)},
                diff=ex.subtotal - items_sum, tolerance=tol))

    base = ex.subtotal if ex.subtotal is not None else items_sum
    if ex.total is not None and base is not None:
        adj = _sum(a.amount for a in ex.adjustments)
        if ex.tax is not None:
            expected = base - (ex.discount or ZERO) + ex.tax + adj
            # Documents print these figures in different ways, and each reading is a consistent document:
            #  * prices that already include tax (retail, Dutch, Indian invoices): the tax line is informational;
            #  * a discount that is already reflected in the prices ("you saved ..."): the discount line is informational.
            # Only a total that fits none of the four readings is a mismatch.
            inclusive = base - (ex.discount or ZERO) + adj
            tol = _tol(2 + len(ex.adjustments), expected, ex.total)
            readings = (expected, inclusive, expected + (ex.discount or ZERO), inclusive + (ex.discount or ZERO))
            if all(abs(r - ex.total) > tol for r in readings):
                inv, desc = {"total": ex.total, "tax": ex.tax}, {"total": "total", "tax": "tax"}
                if ex.subtotal is not None:
                    inv["subtotal"], desc["subtotal"] = ex.subtotal, "subtotal"
                else:
                    more_inv, more_desc = item_keys(rows)
                    inv.update(more_inv), desc.update(more_desc)
                if ex.discount is not None:
                    inv["discount"], desc["discount"] = ex.discount, "discount"
                parts = f"{_money(base)}" + (f" − {_money(ex.discount)} discount" if ex.discount else "") \
                    + f" + {_money(ex.tax)} tax" + (f" + {_money(adj)} other charges" if ex.adjustments else "")
                out.append(Candidate(
                    "CONTENT_TOTAL_MISMATCH", "Subtotal, tax and charges do not add up to the total",
                    f"{parts} = {_money(expected)} (or {_money(inclusive)} if the prices already include tax), "
                    f"but the total printed is {_money(ex.total)} (difference {_money(ex.total - expected)}).",
                    Category.TAMPERING, "numeric", Severity.HIGH, involved=inv, describe=desc,
                    evidence={"expected_total": str(expected), "total": str(ex.total)},
                    diff=ex.total - expected, tolerance=tol))
        elif ex.subtotal is None and items_sum is not None and ex.discount is None and not ex.adjustments:
            tol = _tol(len(rows), items_sum, ex.total)
            if abs(items_sum - ex.total) > tol and not explained_by_list_prices(ex.total):
                inv, desc = item_keys(rows)
                inv["total"], desc["total"] = ex.total, "total"
                out.append(Candidate(
                    "CONTENT_TOTAL_MISMATCH", "Line items do not add up to the total",
                    f"The {len(rows)} line items add up to {_money(items_sum)}, but the total printed is "
                    f"{_money(ex.total)}. No tax, discount or charge line explains the difference.",
                    Category.TAMPERING, "numeric", Severity.HIGH, soft=True, involved=inv, describe=desc,
                    evidence={"items_sum": str(items_sum), "total": str(ex.total)},
                    diff=ex.total - items_sum, tolerance=tol))
    return out


# ---------------------------------------------------------------------------
# Bank statements
# ---------------------------------------------------------------------------

def _move(t) -> Decimal:
    return (t.credit or ZERO) - (t.debit or ZERO)


def check_bank(ex: Extraction) -> tuple[list[Candidate], list[str]]:
    out: list[Candidate] = []
    notes: list[str] = []
    if None not in (ex.opening_balance, ex.closing_balance, ex.total_credits, ex.total_debits):
        expected = ex.opening_balance + ex.total_credits - ex.total_debits
        tol = _tol(3, expected, ex.closing_balance)
        if abs(expected - ex.closing_balance) > tol:
            keys = {"opening_balance": ex.opening_balance, "total_credits": ex.total_credits,
                    "total_debits": ex.total_debits, "closing_balance": ex.closing_balance}
            out.append(Candidate(
                "CONTENT_BALANCE_MISMATCH", "Opening balance + credits − debits does not equal the closing balance",
                f"{_money(ex.opening_balance)} + {_money(ex.total_credits)} − {_money(ex.total_debits)} = "
                f"{_money(expected)}, but the closing balance printed is {_money(ex.closing_balance)}.",
                Category.TAMPERING, "numeric", Severity.HIGH, involved=keys, describe={k: k.replace("_", " ") for k in keys},
                evidence={"expected_closing": str(expected), "closing_balance": str(ex.closing_balance)},
                diff=ex.closing_balance - expected, tolerance=tol))

    rows = [(i, t) for i, t in enumerate(ex.txns) if t.balance is not None]
    if len(rows) >= 4:
        trans = []  # (row position k, index in ex.txns, ok_forward, ok_reverse)
        for k in range(1, len(rows)):
            (_, prev), (ic, cur) = rows[k - 1], rows[k]
            tol = _tol(2, prev.balance, cur.balance)
            ok_f = abs(cur.balance - (prev.balance + _move(cur))) <= tol
            ok_r = abs(prev.balance - (cur.balance + _move(prev))) <= tol
            trans.append((k, ok_f, ok_r))
        fit_f = sum(t[1] for t in trans) / len(trans)
        fit_r = sum(t[2] for t in trans) / len(trans)
        forward = fit_f >= fit_r
        fit = fit_f if forward else fit_r
        if fit < 0.6:
            notes.append(f"transaction ledger could not be followed (best fit {fit:.0%}); running balances were not checked")
        else:
            oks = [t[1] if forward else t[2] for t in trans]
            bad = [k for (k, _, _), ok in zip(trans, oks) if not ok]
            if bad:
                out.append(_ledger_candidate(ex, rows, bad, forward, len(trans)))
    if len(ex.txns) >= 3 and ex.total_credits is not None:
        credits = _sum(t.credit for t in ex.txns if t.credit is not None)
        tol = _tol(len(ex.txns), credits, ex.total_credits)
        if abs(credits - ex.total_credits) > tol:
            out.append(Candidate(
                "CONTENT_TXN_TOTAL_MISMATCH", "Transaction credits do not add up to the credit total",
                f"The credits listed add up to {_money(credits)}, but the statement's credit total is {_money(ex.total_credits)}.",
                Category.TAMPERING, "numeric", Severity.HIGH, soft=True,
                involved={"total_credits": ex.total_credits, **{f"txns[{i}].credit": t.credit for i, t in enumerate(ex.txns) if t.credit is not None}},
                describe={"total_credits": "total credits"}, evidence={"credits_sum": str(credits)},
                diff=ex.total_credits - credits, tolerance=tol))
    return out, notes


def _ledger_candidate(ex, rows, bad, forward, n_trans) -> Candidate:
    """One finding for all broken running-balance steps, naming the row most likely edited.

    Step k checks the balance of row k against its neighbour. If only step k breaks, a movement
    (debit/credit) was edited. If steps k and k+1 both break, the balance of row k was edited,
    because both neighbouring steps use it.
    """
    bad_set, handled = set(bad), set()
    inv: dict[str, Decimal] = {}
    desc: dict[str, str] = {}
    lines: list[str] = []

    def add(pos: int, *names: str) -> None:
        idx, txn = rows[pos]
        for name in names:
            value = getattr(txn, name)
            if value is not None:
                inv[f"txns[{idx}].{name}"], desc[f"txns[{idx}].{name}"] = value, f"row {idx + 1} {name}"

    for k in bad:
        if k in handled:
            continue
        if k + 1 in bad_set:
            handled.add(k + 1)
            add(k - 1, "balance"), add(k, "balance"), add(k + 1, "balance")
            idx, txn = rows[k]
            lines.append(f"row {idx + 1} ({_short(txn.description)}): its balance {_money(txn.balance)} disagrees with both "
                         "neighbouring rows — the balance was likely edited")
            continue
        (ip, prev), (ic, cur) = rows[k - 1], rows[k]
        pos = k if forward else k - 1
        add(pos, "debit", "credit", "balance"), add(k - 1, "balance"), add(k, "balance")
        expected = (prev.balance + _move(cur)) if forward else (cur.balance + _move(prev))
        shown = cur.balance if forward else prev.balance
        idx, txn = rows[pos]
        lines.append(f"row {idx + 1} ({_short(txn.description)}): balance should be {_money(expected)} but is {_money(shown)} — "
                     "its debit or credit amount was likely edited")
    soft = len(bad) > max(3, n_trans // 4)
    note = " Many steps disagree, so an extraction problem is possible." if soft else ""
    return Candidate(
        "CONTENT_LEDGER_BREAK", "Running balance does not follow from the transactions",
        f"{len(bad)} of {n_trans} balance steps break (statement read {'oldest' if forward else 'newest'} first). "
        + " | ".join(lines[:4]) + note,
        Category.TAMPERING, "numeric", Severity.HIGH, soft=soft, involved=inv, describe=desc,
        evidence={"broken_steps": len(bad), "steps": n_trans, "direction": "forward" if forward else "reverse", "details": lines[:12]},
        diff=None)


# ---------------------------------------------------------------------------
# Payslips
# ---------------------------------------------------------------------------

def check_payslip(ex: Extraction) -> list[Candidate]:
    out: list[Candidate] = []

    def labeled_keys(prefix, rows):
        inv = {f"{prefix}[{i}]": r.amount for i, r in enumerate(rows)}
        return inv, {k: f"{prefix} '{_short(rows[i].label) or i + 1}'" for i, k in enumerate(inv)}

    if len(ex.earnings) >= 2 and ex.gross_pay is not None:
        s = _sum(r.amount for r in ex.earnings)
        tol = _tol(len(ex.earnings), s, ex.gross_pay)
        if abs(s - ex.gross_pay) > tol:
            inv, desc = labeled_keys("earnings", ex.earnings)
            inv["gross_pay"], desc["gross_pay"] = ex.gross_pay, "gross pay"
            out.append(Candidate(
                "CONTENT_PAYSLIP_MISMATCH", "Earnings do not add up to gross pay",
                f"The {len(ex.earnings)} earnings lines add up to {_money(s)}, but gross pay is {_money(ex.gross_pay)}.",
                Category.TAMPERING, "numeric", Severity.HIGH, involved=inv, describe=desc,
                evidence={"earnings_sum": str(s), "gross_pay": str(ex.gross_pay)}, diff=ex.gross_pay - s, tolerance=tol))
    if len(ex.deductions) >= 2 and ex.total_deductions is not None:
        s = _sum(r.amount for r in ex.deductions)
        tol = _tol(len(ex.deductions), s, ex.total_deductions)
        if abs(s - ex.total_deductions) > tol:
            inv, desc = labeled_keys("deductions", ex.deductions)
            inv["total_deductions"], desc["total_deductions"] = ex.total_deductions, "total deductions"
            out.append(Candidate(
                "CONTENT_PAYSLIP_MISMATCH", "Deductions do not add up to the deductions total",
                f"The {len(ex.deductions)} deduction lines add up to {_money(s)}, but total deductions are {_money(ex.total_deductions)}.",
                Category.TAMPERING, "numeric", Severity.HIGH, involved=inv, describe=desc,
                evidence={"deductions_sum": str(s), "total_deductions": str(ex.total_deductions)},
                diff=ex.total_deductions - s, tolerance=tol))
    net_equation_broken = False
    if ex.gross_pay is not None and ex.net_pay is not None:
        ded = ex.total_deductions
        soft = False
        if ded is None and len(ex.deductions) >= 2:
            ded, soft = _sum(r.amount for r in ex.deductions), True
        if ded is not None:
            expected = ex.gross_pay - ded
            tol = _tol(2, expected, ex.net_pay)
            if abs(expected - ex.net_pay) > tol:
                net_equation_broken = True
                inv = {"gross_pay": ex.gross_pay, "net_pay": ex.net_pay}
                if ex.total_deductions is not None:
                    inv["total_deductions"] = ex.total_deductions
                out.append(Candidate(
                    "CONTENT_PAYSLIP_MISMATCH", "Net pay is not gross pay minus deductions",
                    f"{_money(ex.gross_pay)} − {_money(ded)} = {_money(expected)}, but net pay printed is {_money(ex.net_pay)} "
                    f"(difference {_money(ex.net_pay - expected)}).",
                    Category.TAMPERING, "numeric", Severity.HIGH, soft=soft, involved=inv,
                    describe={k: k.replace("_", " ") for k in inv},
                    evidence={"expected_net": str(expected), "net_pay": str(ex.net_pay)}, diff=ex.net_pay - expected, tolerance=tol))
        # "Net above gross" is the same root cause as a broken net equation: report only one of them.
        if not net_equation_broken and ex.net_pay > ex.gross_pay + _tol(1, ex.gross_pay):
            out.append(Candidate(
                "CONTENT_PAYSLIP_MISMATCH", "Net pay is higher than gross pay",
                f"Net pay {_money(ex.net_pay)} exceeds gross pay {_money(ex.gross_pay)}. Possible with reimbursements, but unusual.",
                Category.TAMPERING, "numeric", Severity.HIGH, soft=True,
                involved={"gross_pay": ex.gross_pay, "net_pay": ex.net_pay}, describe={"gross_pay": "gross pay", "net_pay": "net pay"},
                evidence={}, diff=ex.net_pay - ex.gross_pay))
    return out


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------

_FUTURE_OK = ("due", "expir", "valid", "next", "matur", "renew", "deadline", "until", "end of", "payable by", "pay by", "effective")


def _d(iso: str) -> date:
    return date.fromisoformat(iso)


def check_dates(ex: Extraction, now: datetime) -> list[Candidate]:
    out: list[Candidate] = []
    today = now.date()
    future = []
    for item in ex.dates:
        if item.iso and not any(k in item.label.lower() for k in _FUTURE_OK) and _d(item.iso) > today + timedelta(days=2):
            future.append(item)
    for t in ex.txns:
        if t.date and _d(t.date) > today + timedelta(days=2):
            future.append(type("D", (), {"label": f"transaction '{_short(t.description, 25)}'", "printed": t.date, "iso": t.date})())
    if future:
        worst = max(_d(f.iso) for f in future)
        impossible = worst.year >= today.year + 2
        out.append(Candidate(
            "CONTENT_FUTURE_DATE", "Document carries a date that is in the future" if not impossible else "Document carries an impossible future date",
            "; ".join(f"{f.label or 'date'}: {f.printed} ({f.iso})" for f in future[:5])
            + f". Analysis date is {today.isoformat()}. A document cannot be issued after it is analysed.",
            Category.METADATA, "date", Severity.HIGH if impossible else Severity.MEDIUM,
            evidence={"dates": [{"label": f.label, "printed": f.printed, "iso": f.iso} for f in future[:10]]}))

    if ex.period_start and ex.period_end and _d(ex.period_start) > _d(ex.period_end):
        out.append(Candidate(
            "CONTENT_DATE_ORDERING", "Statement period ends before it starts",
            f"Period start {ex.period_start} is after period end {ex.period_end}.",
            Category.TAMPERING, "date", Severity.MEDIUM, evidence={"start": ex.period_start, "end": ex.period_end}))

    issue = next((i for i in ex.dates if i.iso and re.search(r"invoice date|issue|date of issue", i.label, re.I)), None)
    due = next((i for i in ex.dates if i.iso and re.search(r"\bdue\b", i.label, re.I) and not re.search(r"overdue", i.label, re.I)), None)
    if issue and due and _d(issue.iso) > _d(due.iso):
        out.append(Candidate(
            "CONTENT_DATE_ORDERING", "Invoice is due before it was issued",
            f"Issue date {issue.iso} is after due date {due.iso}.",
            Category.TAMPERING, "date", Severity.MEDIUM, evidence={"issue": issue.iso, "due": due.iso}))

    dated = [t for t in ex.txns if t.date]
    if ex.period_start and ex.period_end and dated:
        lo, hi = _d(ex.period_start) - timedelta(days=3), _d(ex.period_end) + timedelta(days=3)
        outside = [t for t in dated if not lo <= _d(t.date) <= hi]
        if outside:
            far = any(_d(t.date) < lo - timedelta(days=28) or _d(t.date) > hi + timedelta(days=28) for t in outside)
            out.append(Candidate(
                "CONTENT_DATE_ORDERING", "Transactions fall outside the statement period",
                f"{len(outside)} of {len(dated)} transactions are dated outside {ex.period_start} – {ex.period_end} "
                f"(e.g. {outside[0].date}).", Category.TAMPERING, "date", Severity.MEDIUM if far else Severity.LOW,
                evidence={"outside": [t.date for t in outside[:10]]}))
    if len(dated) >= 6:
        seq = [_d(t.date) for t in dated]
        up = sum(b < a for a, b in zip(seq, seq[1:]))
        down = sum(b > a for a, b in zip(seq, seq[1:]))
        best = min(up, down)
        if 0 < best <= max(1, len(seq) // 5):
            out.append(Candidate(
                "CONTENT_DATE_ORDERING", "A transaction is out of date order",
                f"The statement is otherwise in date order, but {best} row(s) are not. Banks list entries chronologically; "
                "an edited date breaks the order (value dates can also cause this).",
                Category.TAMPERING, "date", Severity.LOW, evidence={"out_of_order": best, "rows": len(seq)}))
    return out


# ---------------------------------------------------------------------------
# Identifiers and template text
# ---------------------------------------------------------------------------

_IBAN_LEN = {
    "AL": 28, "AD": 24, "AT": 20, "AZ": 28, "BH": 22, "BY": 28, "BE": 16, "BA": 20, "BR": 29, "BG": 22, "CR": 22, "HR": 21,
    "CY": 28, "CZ": 24, "DK": 18, "DO": 28, "EG": 29, "SV": 28, "EE": 20, "FO": 18, "FI": 18, "FR": 27, "GE": 22, "DE": 22,
    "GI": 23, "GR": 27, "GL": 18, "GT": 28, "HU": 28, "IS": 26, "IQ": 23, "IE": 22, "IL": 23, "IT": 27, "JO": 30, "KZ": 20,
    "XK": 20, "KW": 30, "LV": 21, "LB": 28, "LI": 21, "LT": 20, "LU": 20, "MT": 31, "MR": 27, "MU": 30, "MD": 24, "MC": 27,
    "ME": 22, "NL": 18, "MK": 19, "NO": 15, "PK": 24, "PS": 29, "PL": 28, "PT": 25, "QA": 29, "RO": 24, "LC": 32, "SM": 27,
    "ST": 25, "SA": 24, "RS": 22, "SC": 31, "SK": 24, "SI": 19, "ES": 24, "SE": 24, "CH": 21, "TL": 23, "TN": 24, "TR": 26,
    "UA": 29, "AE": 23, "GB": 22, "VA": 22, "VG": 24,
}
_IBAN_SHAPE = re.compile(r"^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$")


def iban_problem(value: str) -> str | None:
    """None when valid, else why it is not. Only values that are shaped like an IBAN are judged."""
    s = re.sub(r"[\s-]", "", value).upper()
    if not _IBAN_SHAPE.match(s) or s[:2] not in _IBAN_LEN:
        return None
    if len(s) != _IBAN_LEN[s[:2]]:
        return f"a {s[:2]} IBAN has {_IBAN_LEN[s[:2]]} characters, this has {len(s)}"
    rearranged = s[4:] + s[:4]
    number = "".join(str(int(c, 36)) for c in rearranged)
    return None if int(number) % 97 == 1 else "its check digits are wrong (mod-97 test fails)"


_PLACEHOLDERS = re.compile(
    r"lorem ipsum|\bjohn\s+doe\b|\bjane\s+doe\b|\bacme\s+(corp|inc|co|ltd)\b|\b(your|company|customer|employee|client)\s+(company\s+)?name\b"
    r"|\byour\s+(company|address|business|logo)\b|\b(sample|specimen|dummy|placeholder)\s+(document|invoice|statement|payslip|data|company)\b"
    r"|\[(company|name|address|date|amount|insert|your|customer|employee)[^\]]*\]|\{\{.*?\}\}|\b123456789\b|\b1234567890\b|\bexample\.(com|org)\b",
    re.IGNORECASE)


def check_identifiers(ex: Extraction) -> list[Candidate]:
    out: list[Candidate] = []
    for label, value in ex.identifiers:
        problem = iban_problem(value)
        if problem:
            out.append(Candidate(
                "CONTENT_IBAN_INVALID", "IBAN fails its built-in check",
                f"The IBAN '{value}' is not valid: {problem}. IBANs carry check digits, so a retyped or invented one almost always fails.",
                Category.TAMPERING, "identifier", Severity.MEDIUM, evidence={"label": label, "value": value, "problem": problem}))
    hits = []
    for text in ex.text_fields():
        m = _PLACEHOLDERS.search(text)
        if m:
            hits.append(m.group(0))
    if hits:
        out.append(Candidate(
            "CONTENT_PLACEHOLDER_TEXT", "Document contains template or placeholder text",
            "Found: " + ", ".join(sorted({h.lower() for h in hits})[:6]) + ". Real issuers do not print placeholder text; "
            "AI-generated and hand-made documents often do.",
            Category.AI_GENERATION, "text", Severity.MEDIUM, evidence={"matches": sorted({h.lower() for h in hits})[:10]}))
    return out


# ---------------------------------------------------------------------------
# Orchestration and de-duplication
# ---------------------------------------------------------------------------

def merge_same_discrepancy(cands: list[Candidate]) -> list[Candidate]:
    """One forged figure usually breaks several equations by the same amount; report it once."""
    merged: list[Candidate] = []
    for c in cands:
        if c.kind == "numeric" and c.diff is not None:
            twin = next((m for m in merged if m.kind == "numeric" and m.diff is not None
                         and abs(abs(m.diff) - abs(c.diff)) <= max(m.tolerance, c.tolerance)), None)
            if twin:
                twin.involved.update(c.involved)
                twin.describe.update(c.describe)
                twin.detail += f" The same difference also breaks: {c.title.lower()}."
                twin.evidence.setdefault("also_breaks", []).append(c.title)
                twin.soft = twin.soft and c.soft
                twin.severity = max(twin.severity, c.severity)  # corroborated by a second equation
                continue
        merged.append(c)
    return merged


def run_checks(ex: Extraction, now: datetime) -> tuple[list[Candidate], list[str]]:
    cands: list[Candidate] = []
    notes: list[str] = []
    cands += check_amounts(ex)
    bank, bank_notes = check_bank(ex)
    cands += bank
    notes += bank_notes
    cands += check_payslip(ex)
    cands = merge_same_discrepancy(cands)
    cands += check_dates(ex, now)
    cands += check_identifiers(ex)
    return cands, notes
