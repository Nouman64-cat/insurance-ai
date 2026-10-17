from datetime import datetime, date
from typing import List, Dict, Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlmodel import select, func
from sqlmodel.ext.asyncio.session import AsyncSession
from pydantic import BaseModel

from database import get_session
from shared.models.core import TokenUsage

router = APIRouter(prefix="/tokens", tags=["Token Management"])

class TokenUsageCreate(BaseModel):
    service_name: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    # Optional so the older callers (OCR, summarizer) keep working unchanged.
    cached_tokens: int = 0
    tenant_id: Optional[UUID] = None
    model_name: Optional[str] = None
    thread_id: Optional[str] = None

@router.post("/usage")
async def record_token_usage(
    data: TokenUsageCreate,
    session: AsyncSession = Depends(get_session)
):
    """Record LLM token usage for a specific service."""
    usage = TokenUsage(
        service_name=data.service_name,
        input_tokens=data.input_tokens,
        output_tokens=data.output_tokens,
        total_tokens=data.total_tokens,
        cached_tokens=data.cached_tokens,
        tenant_id=data.tenant_id,
        model_name=data.model_name,
        thread_id=data.thread_id,
    )
    session.add(usage)
    await session.commit()
    await session.refresh(usage)
    return {"status": "success", "id": usage.id}


@router.get("/usage")
async def get_token_usage(
    start_date: str = Query(..., description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(..., description="End date (YYYY-MM-DD)"),
    tenant_id: Optional[UUID] = Query(
        default=None,
        description="Restrict to one tenant's spend. Omit for the platform-wide total.",
    ),
    session: AsyncSession = Depends(get_session)
):
    """Retrieve token usage aggregated by date and service name."""
    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d").date()
        end_dt = datetime.strptime(end_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
    
    # We query all rows in the date range. Grouping in SQLModel/Asyncpg by date can be tricky,
    # so we'll fetch and aggregate in Python for simplicity given this is an MVP dashboard.
    
    # Ensure end_date includes the entire day
    query_end_dt = datetime.combine(end_dt, datetime.max.time())
    query_start_dt = datetime.combine(start_dt, datetime.min.time())
    
    statement = select(TokenUsage).where(
        TokenUsage.created_at >= query_start_dt,
        TokenUsage.created_at <= query_end_dt
    )
    if tenant_id is not None:
        statement = statement.where(TokenUsage.tenant_id == tenant_id)

    results = (await session.exec(statement)).all()
    
    # Aggregate by date
    # Format: { "YYYY-MM-DD": { "ocr-engine": { input, output, requests }, "text-summarizer": { input, output, requests } } }
    aggregated: Dict[str, Dict[str, Any]] = {}
    
    for row in results:
        day_str = row.created_at.strftime("%Y-%m-%d")
        svc = row.service_name
        
        if day_str not in aggregated:
            aggregated[day_str] = {}
            
        if svc not in aggregated[day_str]:
            aggregated[day_str][svc] = {
                "input": 0,
                "output": 0,
                "cached": 0,
                "requests": 0,
                "models": [],
                # Per-model breakdown — costs differ by an order of magnitude
                # across providers, so the dashboard prices each model at its
                # own rate rather than assuming one.
                "by_model": {},
            }

        bucket = aggregated[day_str][svc]
        bucket["input"] += row.input_tokens
        bucket["output"] += row.output_tokens
        bucket["cached"] += (row.cached_tokens or 0)
        bucket["requests"] += 1

        model_key = row.model_name or "unknown"
        if model_key not in bucket["models"]:
            bucket["models"].append(model_key)
        mb = bucket["by_model"].setdefault(
            model_key, {"input": 0, "output": 0, "cached": 0, "requests": 0}
        )
        mb["input"] += row.input_tokens
        mb["output"] += row.output_tokens
        mb["cached"] += (row.cached_tokens or 0)
        mb["requests"] += 1

    return {"data": aggregated}
