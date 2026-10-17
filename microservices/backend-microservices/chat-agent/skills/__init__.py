"""Trusted, versioned instructions over the existing execution and authorization layers."""
import os


def enabled() -> bool:
    return os.getenv("SKILL_AGENT_ENABLED", "true").lower() in {"true", "1", "yes"}
