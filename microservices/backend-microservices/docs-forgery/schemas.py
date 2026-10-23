"""Stable JSON report contract for service callers."""

from typing import Any, Literal

from pydantic import BaseModel, Field


class FindingResponse(BaseModel):
    code: str
    severity: Literal["info", "low", "medium", "high", "critical"]
    category: str
    title: str
    detail: str
    evidence: dict[str, Any] = Field(default_factory=dict)


class PixelPageResponse(BaseModel):
    page: int
    score: float
    map_mean: float | None = None
    map_p99: float | None = None
    map_p99_conf: float | None = None
    map_png_b64: str | None = None
    size: list[int] = Field(default_factory=list)
    seconds: float = 0


class PixelForensicsResponse(BaseModel):
    model: str = "TruFor"
    calibrated: bool
    seconds: float
    pages: list[PixelPageResponse]


class AnalysisResponse(BaseModel):
    path: str
    file_type: str
    sha256: str
    size: int
    verdict: Literal["no_evidence", "review", "high_risk", "inconclusive"]
    layer2_status: str | None
    layer3_status: str | None
    incomplete: list[str]
    findings: list[FindingResponse]
    errors: list[str]
    pixel_forensics: PixelForensicsResponse | None = None
    performance: dict[str, Any] = Field(default_factory=dict)
