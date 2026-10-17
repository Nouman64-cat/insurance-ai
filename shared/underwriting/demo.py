"""Demo-mode tolerances for the underwriting rules.

Only ``ENV_VAR=demo`` (trimmed, case-insensitive) turns them on — the same switch as services/env_mode.py. Read at
call time. Anything else keeps every rule strict.
"""
from __future__ import annotations

import os

# Discrepancies a demo lets through: test data often pairs a made-up CNIC with a real-looking ID card, which would
# otherwise stop every walkthrough. The finding is still recorded and shown; it just no longer blocks.
DEMO_TOLERATED_FIELDS = frozenset({"cnic"})


def is_demo() -> bool:
    return os.environ.get("ENV_VAR", "").strip().lower() == "demo"


def tolerated(field: str | None) -> bool:
    """True when a discrepancy in `field` is allowed to continue (demo mode only)."""
    return is_demo() and (field or "") in DEMO_TOLERATED_FIELDS
