"""Reject malformed definitions before they can influence selection."""
from __future__ import annotations

import re
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Step(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    id: str
    capability: str
    depends_on: tuple[str, ...] = ()


class Skill(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    id: str = Field(pattern=r"^[a-z][a-z0-9-]{1,63}$")
    purpose: str = Field(min_length=10, max_length=500)
    intents: tuple[str, ...] = Field(min_length=1)
    capabilities: tuple[str, ...]
    roles: tuple[str, ...] = ("backend-authorized",)
    prerequisites: tuple[str, ...] = Field(min_length=1)
    business_rules: tuple[str, ...] = Field(min_length=1)
    lifecycle_source: str
    approvals: str
    recovery: tuple[str, ...] = Field(min_length=1)
    verification: str
    tests: tuple[str, ...] = Field(min_length=1)
    steps: tuple[Step, ...] = ()
    unsupported: tuple[str, ...] = ()

    @model_validator(mode="after")
    def validate_plan(self):
        seen = set()
        for step in self.steps:
            if not re.fullmatch(r"[a-z0-9_-]+", step.id) or step.id in seen:
                raise ValueError("Invalid or duplicate step id")
            if step.capability not in self.capabilities or not set(step.depends_on) <= seen:
                raise ValueError("Steps must reference declared capabilities and earlier dependencies")
            seen.add(step.id)
        return self
