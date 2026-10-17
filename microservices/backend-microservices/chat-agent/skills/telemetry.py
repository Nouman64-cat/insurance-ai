"""Allowlisted operational metadata only: never log arguments, output, prompts or credentials."""
import json
import logging

LOG = logging.getLogger("insurance.capabilities")


def emit(event: str, *, capability: str, role: str, duration_ms: float = 0,
         attempt: int = 0, outcome: str = "", recovery: str = "") -> None:
    LOG.info("capability_event %s", json.dumps({"event": event, "capability": capability,
             "role": role, "duration_ms": round(duration_ms, 1), "attempt": attempt,
             "outcome": outcome, "recovery": recovery}, sort_keys=True))
