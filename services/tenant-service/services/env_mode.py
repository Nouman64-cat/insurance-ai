"""Single switch for demo-only shortcuts.

Strict by default: only ``ENV_VAR=demo`` (trimmed, case-insensitive) turns the
demo shortcuts on — waved-through issuance gates, self-settling payments and so
on. Any other value, or none, means every step has to be genuinely completed.
Read at call time so a restart is the only thing a change of mode needs.
"""

import os


def is_demo() -> bool:
    return os.environ.get("ENV_VAR", "").strip().lower() == "demo"
