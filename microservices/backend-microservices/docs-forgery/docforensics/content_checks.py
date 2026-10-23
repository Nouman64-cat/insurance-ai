"""Compatibility entry point for layer 2. The implementation lives in ``docforensics.layer2``.

    check_content(data, name, file_type, doc_type) -> (findings, errors)

Failures are returned in ``errors`` (never swallowed). Callers that need to know
whether the document was actually read should use ``run_layer2`` and its ``status``.
"""

from __future__ import annotations

from datetime import datetime

from .gemini_client import GeminiClient
from .layer2 import Options, run_layer2
from .report import Finding


def check_content(data: bytes, name: str, file_type: str, doc_type: str | None = None,
                  client: GeminiClient | None = None, now: datetime | None = None,
                  options: Options | None = None) -> tuple[list[Finding], list[str]]:
    result = run_layer2(data, name, file_type, doc_type, client=client, now=now, options=options)
    return result.findings, result.errors
