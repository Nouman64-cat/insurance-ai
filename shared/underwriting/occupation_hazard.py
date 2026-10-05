"""Deterministic occupation -> hazard-level classification.

Only a small set of unambiguous, commonly-declared occupations are mapped
here. Everything else returns None so the existing LLM prompt in
risk-engine's medical_scoring node keeps doing the interpretation it already
does for occupations rule data doesn't cover — this is brief §15's "AI for
the rest" half, not a claim that this list is exhaustive or actuarially
reviewed.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional


class OccupationHazardLevel(str, Enum):
    LOW = "Low"
    MEDIUM = "Medium"
    HIGH = "High"


# Keyword -> hazard level. Matched case-insensitively as a substring of the
# declared occupation string. First match wins, so more specific/hazardous
# keywords are listed before broader ones.
_HAZARD_KEYWORDS: list[tuple[str, OccupationHazardLevel]] = [
    ("miner", OccupationHazardLevel.HIGH),
    ("offshore", OccupationHazardLevel.HIGH),
    ("rig worker", OccupationHazardLevel.HIGH),
    ("demolition", OccupationHazardLevel.HIGH),
    ("explosive", OccupationHazardLevel.HIGH),
    ("firefighter", OccupationHazardLevel.HIGH),
    ("fire fighter", OccupationHazardLevel.HIGH),
    ("pilot", OccupationHazardLevel.HIGH),
    ("test pilot", OccupationHazardLevel.HIGH),
    ("deep sea diver", OccupationHazardLevel.HIGH),
    ("diver", OccupationHazardLevel.HIGH),
    ("construction worker", OccupationHazardLevel.MEDIUM),
    ("construction", OccupationHazardLevel.MEDIUM),
    ("electrician", OccupationHazardLevel.MEDIUM),
    ("welder", OccupationHazardLevel.MEDIUM),
    ("police", OccupationHazardLevel.MEDIUM),
    ("security guard", OccupationHazardLevel.MEDIUM),
    ("driver", OccupationHazardLevel.MEDIUM),
    ("truck driver", OccupationHazardLevel.MEDIUM),
    ("factory worker", OccupationHazardLevel.MEDIUM),
    ("fisherman", OccupationHazardLevel.MEDIUM),
    ("military", OccupationHazardLevel.MEDIUM),
    ("armed forces", OccupationHazardLevel.MEDIUM),
    ("software engineer", OccupationHazardLevel.LOW),
    ("software developer", OccupationHazardLevel.LOW),
    ("accountant", OccupationHazardLevel.LOW),
    ("teacher", OccupationHazardLevel.LOW),
    ("doctor", OccupationHazardLevel.LOW),
    ("physician", OccupationHazardLevel.LOW),
    ("banker", OccupationHazardLevel.LOW),
    ("office", OccupationHazardLevel.LOW),
    ("clerk", OccupationHazardLevel.LOW),
    ("manager", OccupationHazardLevel.LOW),
    ("analyst", OccupationHazardLevel.LOW),
    ("consultant", OccupationHazardLevel.LOW),
    ("engineer", OccupationHazardLevel.LOW),
    ("lawyer", OccupationHazardLevel.LOW),
    ("student", OccupationHazardLevel.LOW),
]


def classify_occupation_hazard(occupation: Optional[str]) -> Optional[OccupationHazardLevel]:
    """Return a deterministic hazard level for a known occupation keyword,
    or None when nothing matches (caller should fall back to AI interpretation)."""
    if not occupation:
        return None
    lowered = occupation.strip().lower()
    for keyword, level in _HAZARD_KEYWORDS:
        if keyword in lowered:
            return level
    return None
