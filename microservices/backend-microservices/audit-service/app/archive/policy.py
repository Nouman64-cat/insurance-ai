"""Retention policy resolution and the module -> category map.

Nothing in this file is a legal retention period. Periods are DATA (the retention_policies table, edited by authorised people and
versioned); the defaults ship as "hot 6 months, archive indefinitely, not approved". Hot retention decides WHEN events are archived and
may leave PostgreSQL; cold retention decides when an archive may even be CONSIDERED for deletion (never automatic here).
"""
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Iterable, Optional

CATEGORIES = ("underwriting_policy", "claims", "financial", "administration", "ai_decisions", "operational")

# Event `module` -> category. The first matching entry wins; anything unmatched is "operational". Matching is by prefix on the module
# name so new sub-modules ("claims_adjustment") land in the right category without a code change.
MODULE_CATEGORY: tuple[tuple[str, str], ...] = (
    ("underwriting", "underwriting_policy"), ("polic", "underwriting_policy"), ("quote", "underwriting_policy"), ("proposal", "underwriting_policy"),
    ("customers", "underwriting_policy"), ("leads", "underwriting_policy"), ("documents", "underwriting_policy"), ("family", "underwriting_policy"),
    ("corporate", "underwriting_policy"), ("group", "underwriting_policy"), ("renewal", "underwriting_policy"), ("reinstatement", "underwriting_policy"),
    ("claim", "claims"),
    ("payment", "financial"), ("finance", "financial"), ("billing", "financial"), ("commission", "financial"), ("premium", "financial"), ("accounting", "financial"),
    ("admin", "administration"), ("security", "administration"), ("auth", "administration"), ("tenant", "administration"), ("user", "administration"),
    ("role", "administration"), ("audit", "administration"),
    ("ai", "ai_decisions"), ("decision", "ai_decisions"), ("risk", "ai_decisions"), ("copilot", "ai_decisions"), ("chat", "ai_decisions"), ("ocr", "ai_decisions"),
)


def category_of(module: str) -> str:
    name = (module or "").lower()
    for prefix, category in MODULE_CATEGORY:
        if name.startswith(prefix):
            return category
    return "operational"


@dataclass(frozen=True)
class Policy:
    category: str
    hot_retention_months: int
    cold_retention_years: Optional[int]      # None: keep indefinitely
    allow_hot_cleanup: bool
    approved: bool
    policy_id: Optional[str] = None
    tenant_id: Optional[str] = None          # None: the platform default


def resolve(rows: Iterable[dict], fallback_hot_months: int) -> dict[str, Policy]:
    """One policy per category for a tenant: its own row if it has one, else the platform default, else the configured fallback."""
    by_category: dict[str, dict] = {}
    for row in sorted(rows, key=lambda r: r["tenant_id"] is not None):      # tenant rows last, so they win
        by_category[row["category"]] = row
    out = {}
    for category in CATEGORIES:
        row = by_category.get(category)
        if row is None:
            out[category] = Policy(category, fallback_hot_months, None, True, False)
        else:
            out[category] = Policy(category, row["hot_retention_months"], row["cold_retention_years"], row["allow_hot_cleanup"], row["approved"],
                                   str(row["policy_id"]), str(row["tenant_id"]) if row["tenant_id"] else None)
    return out


def effective_hot_months(policies: dict[str, Policy]) -> int:
    """A chain mixes categories and archives are cut by position (a prefix of the chain), so the chain-wide hot window is the LONGEST of
    its categories': no category is archived out of hot storage earlier than its own policy allows."""
    return max(p.hot_retention_months for p in policies.values())


def hot_cleanup_allowed(policies: dict[str, Policy]) -> bool:
    return all(p.allow_hot_cleanup for p in policies.values())


def hot_cutoff(now: datetime, months: int, *, test_seconds: Optional[float] = None, aligned: bool = True) -> datetime:
    """Events recorded BEFORE this instant are old enough to archive. Aligned to the start of a month by default, so archives end on
    partition boundaries and whole monthly partitions can later leave hot storage; "continuous" scheduling uses the exact rolling age
    instead; test mode uses a plain age in seconds."""
    if test_seconds is not None:
        return datetime.fromtimestamp(now.timestamp() - test_seconds, timezone.utc)
    year, month = now.year, now.month - months
    while month < 1:
        month += 12
        year -= 1
    if not aligned:
        day = min(now.day, 28)
        return now.replace(year=year, month=month, day=day)
    return datetime(year, month, 1, tzinfo=timezone.utc)


def retention_until(policies: dict[str, Policy], categories: Iterable[str], last_recorded: datetime) -> Optional[date]:
    """When an archive may first be considered for deletion review: the longest cold period among the categories it holds, counted from
    its newest event. None (keep indefinitely) if any category has no approved period."""
    longest = 0
    for category in set(categories) or {"operational"}:
        policy = policies[category]
        if policy.cold_retention_years is None or not policy.approved:
            return None
        longest = max(longest, policy.cold_retention_years)
    try:
        return last_recorded.date().replace(year=last_recorded.year + longest)
    except ValueError:                                      # Feb 29
        return last_recorded.date().replace(year=last_recorded.year + longest, day=28)
