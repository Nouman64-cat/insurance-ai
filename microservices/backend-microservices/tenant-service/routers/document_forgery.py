"""Document forgery runtime policy and cost ledger (tenant Admin analysis)."""
from datetime import date, datetime, time
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator
from sqlalchemy.dialects.postgresql import insert
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession
from database import get_session
from routers.auth import require_roles
from routers.tokens import require_internal_service
from shared.models.core import DocumentForgeryConfig, DocumentForgeryUsage

router = APIRouter(tags=["Document Forgery Detection"])
superadmin = require_roles("SuperAdmin")


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    enabled: StrictBool = True
    content_enabled: StrictBool = True
    pixel_enabled: StrictBool = True
    visual_enabled: StrictBool = True
    provider: Literal["gemini", "groq"] = "gemini"
    gemini_model: str = Field(default="gemini-2.5-flash", min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9./_-]+$")
    groq_model: str = Field(default="meta-llama/llama-4-scout-17b-16e-instruct", min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9./_-]+$")
    max_pages: int = Field(default=4, ge=1, le=40)
    pixel_timeout_seconds: int = Field(default=300, ge=30, le=540)
    threshold_mode: Literal["reference", "manual"] = "reference"
    t95: float = Field(default=0.5256373882293701, ge=0, le=1)
    tmax: float = Field(default=0.7155507206916809, ge=0, le=1)
    gemini_input_per_million: float | None = Field(default=None, ge=0, le=10000)
    gemini_output_per_million: float | None = Field(default=None, ge=0, le=10000)
    groq_input_per_million: float | None = Field(default=None, ge=0, le=10000)
    groq_output_per_million: float | None = Field(default=None, ge=0, le=10000)
    pixel_per_hour: float | None = Field(default=None, ge=0, le=10000)

    @model_validator(mode="after")
    def ordered(self):
        if self.t95 > self.tmax:
            raise ValueError("INFO threshold must be less than or equal to LOW threshold")
        return self


def view(row):
    return {"settings": Settings.model_validate(row.settings).model_dump() if row else Settings().model_dump(),
            "updated_at": row.updated_at if row else None, "updated_by": row.updated_by if row else None,
            "propagation_seconds": 5}


@router.get("/platform/document-forgery/config")
async def get_config(user=Depends(superadmin), session: AsyncSession = Depends(get_session)):
    return view(await session.get(DocumentForgeryConfig, "default"))


@router.put("/platform/document-forgery/config")
async def put_config(body: Settings, user=Depends(superadmin), session: AsyncSession = Depends(get_session)):
    values = dict(id="default", settings=body.model_dump(), updated_by=user.id, updated_at=datetime.utcnow())
    stmt = insert(DocumentForgeryConfig).values(**values)
    await session.exec(stmt.on_conflict_do_update(index_elements=["id"], set_=values))
    await session.commit()
    return view(await session.get(DocumentForgeryConfig, "default", populate_existing=True))


@router.get("/internal/document-forgery/config", dependencies=[Depends(require_internal_service)], include_in_schema=False)
async def internal_config(session: AsyncSession = Depends(get_session)):
    return view(await session.get(DocumentForgeryConfig, "default"))


class ModelUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str = Field(max_length=100)
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    input_rate: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    output_rate: float | None = Field(default=None, ge=0, allow_inf_nan=False)


class Usage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    tenant_id: UUID | None = None
    models: list[ModelUsage] = Field(default_factory=list, max_length=1000)
    pixel_pages: int = Field(default=0, ge=0, le=40)
    pixel_seconds: float = Field(default=0, ge=0, allow_inf_nan=False)
    pixel_rate: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    complete: bool
    config_revision: str | None = None


def price(body: Usage):
    token_cost = 0.0
    unpriced = 0
    for model in body.models:
        for count, rate in ((model.input_tokens, model.input_rate), (model.output_tokens, model.output_rate)):
            if count is None or (count > 0 and rate is None):
                unpriced += 1
            elif count and rate is not None:
                token_cost += count * rate / 1_000_000
    pixel_cost = body.pixel_seconds * (body.pixel_rate or 0) / 3600
    if body.pixel_seconds > 0 and body.pixel_rate is None:
        unpriced += 1
    return {"token_cost_usd": token_cost, "pixel_cost_usd": pixel_cost,
            "known_cost_usd": token_cost + pixel_cost, "unpriced_components": unpriced}


@router.post("/internal/document-forgery/usage", dependencies=[Depends(require_internal_service)], include_in_schema=False)
async def record_usage(body: Usage, session: AsyncSession = Depends(get_session)):
    # A stable request ID permits retries without charging an analysis twice.
    details = body.model_dump(mode="json", exclude={"id"}) | price(body)
    await session.exec(insert(DocumentForgeryUsage).values(id=body.id, details=details).on_conflict_do_nothing(index_elements=["id"]))
    await session.commit()
    return {"status": "recorded", "id": body.id}


@router.get("/platform/document-forgery/usage")
async def get_usage(start_date: date = Query(...), end_date: date = Query(...),
                    user=Depends(superadmin), session: AsyncSession = Depends(get_session)):
    if start_date > end_date or (end_date-start_date).days > 366:
        raise HTTPException(400, "Choose an ordered date range of at most 366 days")
    rows = (await session.exec(select(DocumentForgeryUsage).where(
        DocumentForgeryUsage.created_at >= datetime.combine(start_date, time.min),
        DocumentForgeryUsage.created_at <= datetime.combine(end_date, time.max)))).all()
    summary = dict(analyses=len(rows), incomplete=0, input_tokens=0, output_tokens=0, pixel_pages=0,
                   pixel_seconds=0.0, token_cost_usd=0.0, pixel_cost_usd=0.0, known_cost_usd=0.0, unpriced_components=0)
    by_model = {}
    for row in rows:
        d = row.details
        summary["incomplete"] += not d["complete"]
        for key in ("pixel_pages", "pixel_seconds", "token_cost_usd", "pixel_cost_usd", "known_cost_usd", "unpriced_components"):
            summary[key] += d[key]
        for m in d["models"]:
            bucket = by_model.setdefault(m["model"], dict(calls=0, input_tokens=0, output_tokens=0))
            bucket["calls"] += 1
            for key in ("input_tokens", "output_tokens"):
                summary[key] += m[key] or 0
                bucket[key] += m[key] or 0
    return {"summary": summary, "by_model": by_model, "currency": "USD", "scope": "platform_admin_analysis"}


@router.get("/platform/document-forgery/performance")
async def performance(user=Depends(superadmin)):
    import os
    import httpx
    secret = os.getenv("INTERNAL_API_SECRET", "").strip()
    if not secret: raise HTTPException(503, "Internal service authentication is not configured")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            result = await client.get(os.getenv("DOCS_FORGERY_URL", "http://docs-forgery:8022").rstrip("/") + "/performance", headers={"X-Internal-Secret":secret})
            result.raise_for_status()
        return result.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(503, "Performance metrics are temporarily unavailable") from exc
