"""Admin-only document intelligence: tenant ownership and persisted analysis reports."""
import os
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from sqlmodel.ext.asyncio.session import AsyncSession
from database import get_session
from routers.auth import require_roles
from routers.document_forgery import internal_config
from shared.models.core import Tenant
from services.audit_capture import record_standalone as audit_standalone

router = APIRouter(prefix="/document-intelligence", tags=["Document Intelligence"])
_roles = require_roles("Admin")


async def admin(user=Depends(_roles), session: AsyncSession = Depends(get_session)):
    if not user.is_active or user.tenant_id is None:
        raise HTTPException(403, "An active tenant Admin account is required")
    tenant = await session.get(Tenant, user.tenant_id)
    if tenant is None or not tenant.is_active:
        raise HTTPException(403, "An active organisation is required")
    return user


@router.get("/health")
async def health(user=Depends(admin), session: AsyncSession = Depends(get_session)):
    config = await internal_config(session)
    return {"status": "healthy", "analysis_policy": {k: config["settings"][k] for k in (
        "enabled", "content_enabled", "pixel_enabled", "visual_enabled", "provider", "max_pages")}}



async def engine_request(method, path, user, **kwargs):
    secret = os.getenv("INTERNAL_API_SECRET", "").strip()
    if not secret: raise HTTPException(503,"Document Intelligence internal authentication is not configured")
    base = os.getenv("DOCS_FORGERY_URL", "http://docs-forgery:8022").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(600,connect=5)) as client:
            response = await client.request(method,base+path,headers={"X-Internal-Secret":secret,
                "X-Tenant-Id":str(user.tenant_id),"X-Actor-Id":str(user.id)},**kwargs)
    except httpx.HTTPError as exc:
        raise HTTPException(503,"Document Intelligence is unavailable; check history before retrying") from exc
    if response.status_code != 200:
        detail = "Document Intelligence could not complete the request"
        try:
            value = response.json().get("detail")
            if isinstance(value,str): detail=value[:1000]
        except ValueError: pass
        raise HTTPException(response.status_code if response.status_code in (400,403,404,413,415,422,503) else 502,detail)
    return response.json()


@router.get("/results")
async def list_results(offset: int = Query(0,ge=0), limit: int = Query(20,ge=1,le=100),user=Depends(admin)):
    return await engine_request("GET","/results",user,params={"offset":offset,"limit":limit})


@router.get("/results/{result_id}")
async def get_result(result_id: UUID,user=Depends(admin)):
    return await engine_request("GET",f"/results/{result_id}",user)


@router.post("/analyze")
async def analyze(file: UploadFile = File(...), doc_type: str | None = Form(None),
                  layer2: bool = Form(False), layer3: bool = Form(False), provider: str = Form("gemini"),
                  visual: bool = Form(False), max_pages: int = Form(4,ge=1,le=40),user=Depends(admin)):
    try:
        data = await file.read(100*1024*1024+1)
        filename = (file.filename or "upload").replace("\\", "/").split("/")[-1][:255] or "upload"
    finally:
        await file.close()
    if not data: raise HTTPException(400,"The uploaded file is empty")
    if len(data)>100*1024*1024: raise HTTPException(413,"Maximum document size is 100 MiB")
    options={"layer2":str(layer2).lower(),"layer3":str(layer3).lower(),"provider":provider,
             "visual":str(visual).lower(),"max_pages":str(max_pages)}
    if doc_type: options["doc_type"]=doc_type
    result = await engine_request("POST","/results/analyze",user,files={"file":(filename,data,"application/octet-stream")},data=options)
    await audit_standalone(module="documents",action="document_intelligence.completed",entity_type="document_intelligence",
                           entity_id=result.get("id"),tenant_id=user.tenant_id,actor_id=str(user.id),actor_type="USER",actor_role="Admin",
                           metadata={"status":result.get("status"),"storage_service":"docs-forgery"})
    return result
