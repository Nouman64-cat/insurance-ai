"""Conversation history trimming.

Two separate cost problems live here.

**Depth.** The whole thread was re-sent to the model on every turn, so a long
conversation's input cost climbed without any ceiling. `trim_history` keeps a
recent window instead.

**Width.** Tool results are checkpointed verbatim, and some of them are large:
a case detail carries the full customer and policy objects, `show_record`
echoes the whole matched row, `get_active_policy_status` returns every field of
a policy plus its documents, and the journey's `audit_trail` is a growing list
of strings. The model reads the `message` line and ignores the payload — but
the payload is re-billed on every subsequent turn for the life of the thread.
`compact_tool_result` strips those keys before the result is stored.

Both are conservative on purpose: correctness first, savings second. Trimming
never drops the system message, never splits a tool_call from its answering
ToolMessage (Gemini rejects that), and never touches the current turn.
"""

from __future__ import annotations

import json
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

# How many messages of history to carry. A turn is typically 3-4 messages
# (human, AI+tool_call, tool result, AI answer), so this is roughly the last
# 8-10 exchanges — comfortably more than any flow needs to stay coherent.
MAX_HISTORY_MESSAGES = 40

# Result keys the model never reads but which dominate the payload size.
# The human-readable `message` field is always kept; that is what the model
# actually uses to narrate the result.
_HEAVY_KEYS = {
    "record",
    "records",
    "customer",
    "customers",
    "policy",
    "policy_detail",
    "policies",
    "case",
    "cases",
    "items",
    "results",
    "rows",
    "audit_trail",
    "readiness",
    "checklist",
    "pre_underwriting_status",
    "demo_customer",
    "entries",
    "ledger",
}

# NEVER strip these. routers/chat.py builds its SSE events by re-reading the
# ToolMessage content — `quick_actions` becomes the click-through chips,
# `navigate` drives the page jump, `last_action` the toast, `assessment` the
# score panel. Dropping them here silently removes the one-click affordances
# from the UI, which is the whole point of the product.
_UI_CRITICAL_KEYS = {"quick_actions", "navigate", "last_action", "assessment"}

# Below this there is nothing worth stripping.
_COMPACT_THRESHOLD_CHARS = 600


def compact_tool_result(result: dict[str, Any]) -> dict[str, Any]:
    """Shrink a tool result to what the model actually needs to read.

    Returns the input unchanged when it is already small, so the common case
    (a one-line confirmation) is untouched.
    """
    if not isinstance(result, dict):
        return result

    try:
        if len(json.dumps(result, default=str)) < _COMPACT_THRESHOLD_CHARS:
            return result
    except (TypeError, ValueError):
        return result

    trimmed: dict[str, Any] = {}
    dropped: list[str] = []
    for key, value in result.items():
        if key in _UI_CRITICAL_KEYS:
            trimmed[key] = value
            continue
        if key in _HEAVY_KEYS:
            # Keep the shape visible so the model knows the data existed and
            # how much of it there was — it can re-fetch if it genuinely needs
            # a field, and it stops it claiming the list was empty.
            if isinstance(value, list):
                dropped.append(f"{key}[{len(value)}]")
            elif value not in (None, {}, ""):
                dropped.append(key)
            continue
        trimmed[key] = value

    if dropped:
        trimmed["_omitted"] = (
            "Large fields omitted from history to save tokens: "
            + ", ".join(dropped)
            + ". Call the relevant tool again if you need their contents."
        )
    return trimmed


def _is_orphaned_tool_message(msg: BaseMessage, kept_call_ids: set[str]) -> bool:
    return isinstance(msg, ToolMessage) and msg.tool_call_id not in kept_call_ids


def trim_history(messages: list[BaseMessage], limit: int = MAX_HISTORY_MESSAGES) -> list[BaseMessage]:
    """Keep the most recent `limit` messages, without breaking tool pairing.

    Gemini rejects a request where a ToolMessage has no preceding AIMessage
    carrying the matching tool_call — so a naive tail slice can produce a
    request that 400s. This walks back from the cut point and drops any
    ToolMessage whose call was left behind.
    """
    if len(messages) <= limit:
        return list(messages)

    window = list(messages[-limit:])

    # Every tool_call id introduced inside the window.
    kept_call_ids: set[str] = set()
    for m in window:
        if isinstance(m, AIMessage):
            for tc in (m.tool_calls or []):
                if tc.get("id"):
                    kept_call_ids.add(tc["id"])

    window = [m for m in window if not _is_orphaned_tool_message(m, kept_call_ids)]

    # A window that opens on an AIMessage whose tool_calls were answered in
    # the dropped region leaves dangling calls — trim from the front until the
    # first message is a safe entry point.
    while window and isinstance(window[0], AIMessage) and window[0].tool_calls:
        answered = {
            m.tool_call_id for m in window if isinstance(m, ToolMessage)
        }
        if all(tc.get("id") in answered for tc in window[0].tool_calls):
            break
        window.pop(0)

    return window
