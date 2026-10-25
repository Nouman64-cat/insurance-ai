from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

DOC_TYPES = ("bank_statement", "payslip", "other")


@dataclass
class Context:
    doc_type: str | None = None  # one of DOC_TYPES; tightens rules that depend on who issues the document
    now: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    max_pages: int = 40  # pages analysed in depth (layout, fonts, images); metadata checks always cover the whole file
    max_revisions: int = 25
