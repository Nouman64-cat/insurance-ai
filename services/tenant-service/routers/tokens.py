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
        total_tokens=data.total_tokens
    )
    session.add(usage)
    await session.commit()
    await session.refresh(usage)
    return {"status": "success", "id": usage.id}


@router.get("/usage")
async def get_token_usage(
    start_date: str = Query(..., description="Start date (YYYY-MM-DD)"),
    end_date: str = Query(..., description="End date (YYYY-MM-DD)"),
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
                "requests": 0
            }
            
        aggregated[day_str][svc]["input"] += row.input_tokens
        aggregated[day_str][svc]["output"] += row.output_tokens
        aggregated[day_str][svc]["requests"] += 1
        
    return {"data": aggregated}
