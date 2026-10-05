"""Single switch for demo-only shortcuts.

Strict by default: only ``ENV_VAR=demo`` (trimmed, case-insensitive) turns the
demo shortcuts on — "continue anyway" chips, auto-filled e-application / ACR,
simulated payment and medical results. Any other value, or none, means every
step has to be genuinely completed before the flow moves on. Read at call time.
"""

import os

# Tool arguments that exist only to skip a step. Dropped outside demo mode even
# if the model (or a crafted message) supplies them.
_DEMO_ONLY_ARGS = ("bypass_prerequisites", "bypass_gates", "auto_fill", "auto_complete")


def is_demo() -> bool:
    return os.environ.get("ENV_VAR", "").strip().lower() == "demo"


def strip_demo_args(args: dict) -> dict:
    if is_demo():
        return args
    cleaned = {k: v for k, v in args.items() if k not in _DEMO_ONLY_ARGS}
    if cleaned.get("action") == "auto_submit":
        cleaned["action"] = "invite"
    return cleaned
