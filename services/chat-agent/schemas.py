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
    # Edit-and-regenerate: re-ask `message` from the point where the user first asked it. The thread is rewound to
    # just before the `occurrence`-th (0-based) time this exact text was asked and the turn runs again from there;
    # everything the agent said after it is dropped from the conversation it sees.
    regenerate: bool = False
    occurrence: int = 0


class ChatResumeRequest(BaseModel):
    thread_id: str
    resume_value: Any


class ExecuteToolRequest(BaseModel):
    name: str
    args: dict[str, Any] = {}
    role: str = "Agent"
    platform: str = "web"


class ChatTitleRequest(BaseModel):
    first_user_message: str
    first_assistant_reply: str
    # Later in a conversation: a condensed transcript to title from, and the
    # titles other chats already have, so this one can be told apart from them.
    transcript: str = ""
    avoid: list[str] = []
