import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from dependencies import get_settings, get_tenant_id, Settings
from uuid import UUID

router = APIRouter(tags=["Underwriting"])

@router.post(
    "/suggest-plan",
    summary="Suggest an insurance plan using AI",
    description="Proxies the applicant data and available plans to the Risk Engine to determine the best plan recommendation."
)
async def suggest_plan(
    request: Request,
    tenant_id: UUID = Depends(get_tenant_id),
    settings: Settings = Depends(get_settings),
) -> Response:
    body = await request.body()
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{settings.risk_engine_url}/suggest-plan",
                content=body,
                headers={"X-Tenant-Id": str(tenant_id), "Content-Type": "application/json"},
            )
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                headers=dict(resp.headers)
            )
    except httpx.ConnectError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Risk engine is unreachable"
        )
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Risk engine timed out"
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Risk engine suggest failed: {str(exc)}"
        )
