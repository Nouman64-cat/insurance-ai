from typing import Any, Optional

from pydantic import BaseModel


class ChatStreamRequest(BaseModel):
    thread_id: str
    # Optional so the frontend can do a mount-time "is this thread paused at an
    # interrupt?" check (e.g. after a page reload) without sending a new turn.
    message: Optional[str] = None
    role: str = "Agent"
    attachments: Optional[list[dict[str, Any]]] = None
    # "web" (portal) or "mobile" (agent-app) — the mobile client is Agent-only
    # and scoped to onboarding through Gate 6, see permission.py.
    platform: str = "web"


class ChatResumeRequest(BaseModel):
    thread_id: str
    resume_value: Any


class ExecuteToolRequest(BaseModel):
    name: str
    args: dict[str, Any] = {}
    role: str = "Agent"
    platform: str = "web"
