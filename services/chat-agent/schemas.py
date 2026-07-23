from typing import Any, Optional

from pydantic import BaseModel


class ChatStreamRequest(BaseModel):
    thread_id: str
    # Optional so the frontend can do a mount-time "is this thread paused at an
    # interrupt?" check (e.g. after a page reload) without sending a new turn.
    message: Optional[str] = None
    role: str = "Agent"


class ChatResumeRequest(BaseModel):
    thread_id: str
    resume_value: Any


class ExecuteToolRequest(BaseModel):
    name: str
    args: dict[str, Any] = {}
    role: str = "Agent"
