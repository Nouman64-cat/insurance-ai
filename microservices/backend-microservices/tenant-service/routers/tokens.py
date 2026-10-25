import hmac
import os
from datetime import datetime, date
from typing import List, Dict, Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, HTTPException
from sqlmodel import select, func
from sqlmodel.ext.asyncio.session import AsyncSession
from pydantic import BaseModel

from database import get_session
from routers.auth import _get_current_user, oauth2_scheme
from shared.models.core import Role, TokenUsage

router = APIRouter(prefix="/tokens", tags=["Token Management"])


def require_internal_service(x_internal_secret: str = Header(default="")) -> None:
    """Only the platform's own services may write to the usage ledger: they send the shared INTERNAL_API_SECRET.

    This fails closed. An unset secret means no write is
    accepted, so a missing configuration can never leave the ledger (and the spend figures built on it) writable by anyone
    who can reach the service. The comparison is constant-time."""
    expected = os.environ.get("INTERNAL_API_SECRET", "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="Token usage cannot be recorded: INTERNAL_API_SECRET is not configured.")
    if not hmac.compare_digest(x_internal_secret.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="A valid internal service secret is required to record token usage.")

# The three areas the Token Economy page reports spend in. Every service_name falls in exactly one; anything not
# listed is the base model (the chat agent and its specialists, risk engine, summarizer, rule assist...).
OCR_SERVICES = {"OCR Engine", "Document Reader"}
LIVE_VOICE_SERVICES = {"Live Voice", "Live Voice — Captions", "Voice Messages"}


def category_of(service_name: str) -> str:
    """'ocr' | 'live_voice' | 'base' for one service_name."""
    if service_name in OCR_SERVICES:
        return "ocr"
    if service_name in LIVE_VOICE_SERVICES:
        return "live_voice"
    return "base"


class TokenUsageCreate(BaseModel):
    service_name: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    # Optional so the older callers (OCR, summarizer) keep working unchanged.
    cached_tokens: int = 0
    # Live voice: the audio share of the counts above, and per-minute billed audio.
    audio_input_tokens: int = 0
    audio_output_tokens: int = 0
    audio_cached_tokens: int = 0
    audio_seconds: float = 0.0
    tenant_id: Optional[UUID] = None
    model_name: Optional[str] = None
    thread_id: Optional[str] = None

@router.post("/usage", dependencies=[Depends(require_internal_service)])
async def record_token_usage(
    data: TokenUsageCreate,
    session: AsyncSession = Depends(get_session)
):
    """Record LLM token usage for a specific service. Internal only: callers send X-Internal-Secret."""
    usage = TokenUsage(
        service_name=data.service_name,
        input_tokens=data.input_tokens,
        output_tokens=data.output_tokens,
        total_tokens=data.total_tokens,
        cached_tokens=data.cached_tokens,
        audio_input_tokens=data.audio_input_tokens,
        audio_output_tokens=data.audio_output_tokens,
        audio_cached_tokens=data.audio_cached_tokens,
        audio_seconds=data.audio_seconds,
        tenant_id=data.tenant_id,
        model_name=data.model_name,
        thread_id=data.thread_id,
    )
    session.add(usage)
    await session.commit()
    await session.refresh(usage)
    return {"status": "success", "id": usage.id}


async def require_usage_reader(
    tenant_id: Optional[UUID] = Query(default=None),
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Who may read the spend figures. Platform-wide totals (no tenant_id) are for SuperAdmin; one tenant's spend is for that
    tenant's Admin (or a SuperAdmin). Anyone else, and anyone not signed in, is refused. Before this the read needed no login."""
    user = await _get_current_user(token, session)             # 401: no token, a bad token, or a removed account
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Your account is inactive.")
    role = await session.get(Role, user.role_id)
    name = role.name if role else None
    if name == "SuperAdmin":
        return
    if tenant_id is None:
        raise HTTPException(status_code=403, detail="Platform-wide token usage is for SuperAdmin; pass your own tenant_id for your organisation's spend.")
    if name != "Admin" or user.tenant_id != tenant_id:
        raise HTTPException(status_code=403, detail="Token usage for a tenant is for that tenant's Admin or a SuperAdmin.")


@router.get("/usage", dependencies=[Depends(require_usage_reader)])
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
    # Format: { "YYYY-MM-DD": { "<service>": { category, input, output, cached, audio_*, requests, by_model } } }
    aggregated: Dict[str, Dict[str, Any]] = {}
    counters = ("input", "output", "cached", "audio_input", "audio_output", "audio_cached", "audio_seconds")
    
    for row in results:
        day_str = row.created_at.strftime("%Y-%m-%d")
        svc = row.service_name
        
        if day_str not in aggregated:
            aggregated[day_str] = {}
            
        if svc not in aggregated[day_str]:
            aggregated[day_str][svc] = {
                "category": category_of(svc),
                **{name: 0 for name in counters},
                "requests": 0,
                "models": [],
                # Per-model breakdown — costs differ by an order of magnitude
                # across providers, so the dashboard prices each model at its
                # own rate rather than assuming one.
                "by_model": {},
            }

        values = {
            "input": row.input_tokens, "output": row.output_tokens, "cached": row.cached_tokens or 0,
            "audio_input": row.audio_input_tokens or 0, "audio_output": row.audio_output_tokens or 0,
            "audio_cached": row.audio_cached_tokens or 0, "audio_seconds": row.audio_seconds or 0,
        }
        bucket = aggregated[day_str][svc]
        model_key = row.model_name or "unknown"
        if model_key not in bucket["models"]:
            bucket["models"].append(model_key)
        mb = bucket["by_model"].setdefault(model_key, {**{name: 0 for name in counters}, "requests": 0})
        for target in (bucket, mb):
            for name, value in values.items():
                target[name] += value
            target["requests"] += 1

    return {"data": aggregated}
