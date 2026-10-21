"""Demo-only tamper tools (ENV_VAR=demo). The status route is always mounted so the UI can ask whether to show the
buttons; the mutating routes are mounted only in demo mode (app/main.py) and refuse again themselves."""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from app import demo_tools
from app.auth import Identity, current_identity

status_router = APIRouter(prefix="/v1/demo", tags=["Demo tools"])
router = APIRouter(prefix="/v1/demo", tags=["Demo tools"])


@status_router.get("/status", summary="Whether the demo-only delete/restore tools are enabled")
async def demo_status(identity: Identity = Depends(current_identity)):
    return {"enabled": demo_tools.enabled()}


def _scope(identity: Identity) -> dict:
    return {"chain_scope": identity.tenant_id, "unrestricted": identity.is_super_admin}


async def _run(coro):
    try:
        return await coro
    except demo_tools.DemoError as exc:
        raise HTTPException(400, str(exc))


@router.post("/events/{event_id}/delete", summary="DEMO ONLY: move an event to the recycle bin (breaks the hash chain on purpose)")
async def delete_event(event_id: UUID, identity: Identity = Depends(current_identity)):
    return await _run(demo_tools.delete_event(event_id, actor=identity.requester, **_scope(identity)))


@router.get("/recycle-bin", summary="DEMO ONLY: deleted events with their full original content")
async def recycle_bin(identity: Identity = Depends(current_identity)):
    return {"items": await _run(demo_tools.list_bin(**_scope(identity)))}


@router.post("/recycle-bin/{bin_id}/restore", summary="DEMO ONLY: put a deleted event back exactly as it was")
async def restore_event(bin_id: UUID, identity: Identity = Depends(current_identity)):
    return await _run(demo_tools.restore_event(bin_id, actor=identity.requester, **_scope(identity)))
