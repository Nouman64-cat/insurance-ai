"""Finding and report types shared by every check."""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any


class Severity(enum.IntEnum):
    INFO = 0  # context for the reviewer, carries no risk weight
    LOW = 1  # weak signal that genuine documents also produce
    MEDIUM = 2  # suspicious, but has innocent explanations
    HIGH = 3  # strong sign of manipulation
    CRITICAL = 4  # the file itself proves it was altered or machine-generated


class Category(str, enum.Enum):
    TAMPERING = "tampering"
    AI_GENERATION = "ai_generation"
    EDITING_SOFTWARE = "editing_software"
    METADATA = "metadata"
    STRUCTURE = "structure"
    AUTHENTICITY = "authenticity"  # positive evidence, e.g. an intact signature
    CONTEXT = "context"


class Verdict(str, enum.Enum):
    NO_EVIDENCE = "no_evidence"  # nothing found by this layer; not proof of authenticity
    REVIEW = "review"
    HIGH_RISK = "high_risk"
    INCONCLUSIVE = "inconclusive"  # the file could not be analysed


@dataclass
class Finding:
    code: str
    severity: Severity
    category: Category
    title: str
    detail: str
    evidence: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "severity": self.severity.name.lower(),
            "category": self.category.value,
            "title": self.title,
            "detail": self.detail,
            "evidence": self.evidence,
        }


def verdict_from_findings(findings: list[Finding]) -> Verdict:
    counts = {s: 0 for s in Severity}
    for f in findings:
        if f.category is not Category.AUTHENTICITY:
            counts[f.severity] += 1
    if counts[Severity.CRITICAL] or counts[Severity.HIGH] >= 2:
        return Verdict.HIGH_RISK
    # A single MEDIUM signal is too common in genuine documents to act on alone.
    if counts[Severity.HIGH] or counts[Severity.MEDIUM] >= 2:
        return Verdict.REVIEW
    return Verdict.NO_EVIDENCE


@dataclass
class Report:
    path: str
    file_type: str
    sha256: str
    size: int
    findings: list[Finding] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    parsed: bool = True
    layer2_status: str | None = None  # None: not requested; "ok", "partial" or "failed" once run
    layer3_status: str | None = None  # None: not requested; "ok", "unavailable" or "failed" once run
    incomplete: list[str] = field(default_factory=list)  # layers that were requested but could not run

    @property
    def verdict(self) -> Verdict:
        if not self.parsed:
            return Verdict.INCONCLUSIVE
        verdict = verdict_from_findings(self.findings)
        # A layer that never ran cannot vouch for the document: "nothing found" is not "nothing there".
        if verdict is Verdict.NO_EVIDENCE and self.incomplete:
            return Verdict.INCONCLUSIVE
        return verdict

    def sorted_findings(self) -> list[Finding]:
        return sorted(self.findings, key=lambda f: (-f.severity, f.code))

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "file_type": self.file_type,
            "sha256": self.sha256,
            "size": self.size,
            "verdict": self.verdict.value,
            "layer2_status": self.layer2_status,
            "layer3_status": self.layer3_status,
            "incomplete": self.incomplete,
            "findings": [f.to_dict() for f in self.sorted_findings()],
            "errors": self.errors,
        }
