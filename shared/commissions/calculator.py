from datetime import date
from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")


def money(value) -> Decimal:
    amount = Decimal(str(value))
    if not amount.is_finite() or amount < 0:
        raise ValueError("Amount must be finite and non-negative")
    return amount.quantize(CENT, rounding=ROUND_HALF_UP)


def policy_year(effective: date, due: date) -> int:
    if due < effective:
        raise ValueError("Installment predates policy inception")
    # Feb-29 anniversaries fall on Feb-28 in non-leap years.
    try:
        anniversary = effective.replace(year=due.year)
    except ValueError:
        anniversary = date(due.year, 2, 28)
    return due.year - effective.year + 1 - (due < anniversary)


def allocate(base, rows):
    """Rows: (stable source key, rate, split). Round the aggregate once, then
    distribute residual cents by largest remainder, with a stable tie-break.
    Different contractual rates are allowed for co-producers.
    """
    if not rows or sum(Decimal(str(r[2])) for r in rows) != Decimal(100):
        raise ValueError("Producer splits must total exactly 100%")
    if len({r[0] for r in rows}) != len(rows):
        raise ValueError("Duplicate producer")
    raw = []
    for key, rate, split in rows:
        rate, split = Decimal(str(rate)), Decimal(str(split))
        if not rate.is_finite() or not split.is_finite() or not 0 <= rate <= 100 or not 0 < split <= 100:
            raise ValueError("Invalid commission rate or split")
        raw.append((key, money(base) * rate * split / Decimal(10000)))
    total = sum(v for _, v in raw).quantize(CENT, rounding=ROUND_HALF_UP)
    cents = {k: v // CENT for k, v in raw}
    remaining = int(total / CENT - sum(cents.values()))
    for key, _ in sorted(raw, key=lambda x: (-(x[1] / CENT - cents[x[0]]), str(x[0])))[:remaining]:
        cents[key] += 1
    return {k: (v * CENT).quantize(CENT) for k, v in cents.items()}
