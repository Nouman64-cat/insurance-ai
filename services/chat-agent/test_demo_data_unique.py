"""Demo data must never collide with, or reuse, a CNIC that is already registered.

The slip this guards against: after "Add demo data" the model called add_customer with the made-up CNIC
12345-6789012-3 — which already belonged to someone — and the user was told it was "already registered".

Run with:  python -m pytest services/chat-agent/test_demo_data_unique.py -q
"""

import asyncio
import os

import graph
import tool_executor
from langchain_core.messages import HumanMessage


def test_the_add_demo_data_chip_is_answered_without_the_model_for_each_customer_type():
    expected = {"add_customer": ("quick_start_workflow", {}),
                "add_family_group": ("add_family_group", {"use_demo_data": True}),
                "add_organization": ("add_organization", {"use_demo_data": True})}
    for lead_tool, (tool, args) in expected.items():
        out = graph._direct_intake_demo({"messages": [HumanMessage(content="Add demo data")], "lead_intake": True, "lead_tool": lead_tool})
        call = out["messages"][0].tool_calls[0]
        assert (call["name"], call["args"]) == (tool, args), lead_tool
        assert call["args"].get("cnic") is None, "no identity is ever passed in — the tool generates it"
    # Outside the intake, or for anything else, the model decides as before.
    assert graph._direct_intake_demo({"messages": [HumanMessage(content="Add demo data")], "lead_tool": "add_customer"}) is None
    assert graph._direct_intake_demo({"messages": [HumanMessage(content="Add a customer")], "lead_intake": True, "lead_tool": "add_customer"}) is None
    # The "Generate a new demo customer" button of the duplicate message.
    again = graph._direct_intake_demo({"messages": [HumanMessage(content="Run quick_start_workflow with fresh random demo data")]})
    assert again["messages"][0].tool_calls[0]["name"] == "quick_start_workflow"


def test_placeholder_cnics_are_recognised_and_real_looking_ones_are_not():
    for placeholder in ("12345-6789012-3", "1234567890123", "11111-1111111-1", "98765-4321098-7", "00000-0000000-0"):
        assert tool_executor.is_placeholder_cnic(placeholder), placeholder
    for real in ("35202-1840573-1", "61101-1234567-1", "42101-5503918-3", "", None, "123"):
        assert not tool_executor.is_placeholder_cnic(real), real


class _Resp:
    def __init__(self, status, body=None):
        self.status_code, self._body = status, body or {}

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx
            raise httpx.HTTPStatusError("error", request=None, response=self)  # type: ignore[arg-type]


class _Client:
    """A tenant-service where the first two CNICs it is offered are already registered."""
    def __init__(self):
        self.posted = []

    async def post(self, url, **kw):
        if url.endswith("/customers"):
            self.posted.append(kw["json"]["cnic"])
            return _Resp(409) if len(self.posted) <= 2 else _Resp(201, {"id": "c1"})
        return _Resp(404)

    async def get(self, url, **kw):
        return _Resp(200, [])


def _run(tool, args, mode="demo"):
    client = _Client()

    async def _shared():
        return client

    saved, tool_executor._shared_client = tool_executor._shared_client, _shared
    saved_env = os.environ.get("ENV_VAR")
    os.environ["ENV_VAR"] = mode

    async def _agent(args, ctx):                       # an Agent owns their own leads — nobody to ask
        return {"id": "a1", "full_name": "An Agent"}, None
    saved_agent, tool_executor._resolve_lead_agent = tool_executor._resolve_lead_agent, _agent
    try:
        ctx = tool_executor.ExecCtx(tenant_id="t", jwt_token="", role="Agent")
        return client, asyncio.run(tool_executor.execute_tool(tool, args, ctx))
    finally:
        tool_executor._shared_client, tool_executor._resolve_lead_agent = saved, saved_agent
        if saved_env is None:
            os.environ.pop("ENV_VAR", None)
        else:
            os.environ["ENV_VAR"] = saved_env


def test_individual_demo_data_draws_again_when_its_cnic_is_taken():
    client, result = _run("quick_start_workflow", {})
    assert result["success"], result
    assert len(client.posted) == 3 and len(set(client.posted)) == 3, "two taken CNICs, then a fresh third one"
    assert not any(tool_executor.is_placeholder_cnic(c) for c in client.posted)


def test_a_placeholder_cnic_is_never_registered():
    client, result = _run("add_customer", {"first_name": "A", "last_name": "B", "cnic": "12345-6789012-3", "date_of_birth": "1990-01-01",
                                           "gender": "Male", "occupation": "Engineer", "declared_income": 1_000_000})
    assert not result["success"] and "placeholder" in result["error"].lower()
    assert client.posted == [], "nothing is sent to the tenant service"
    labels = [a["label"] for a in result["quick_actions"]]
    assert "Generate a new demo customer" in labels


def test_a_family_with_placeholder_cnics_is_refused_and_real_demo_families_are_not():
    members = [{"name": "A", "cnic": "12345-6789012-3", "relationship": "Self"}]
    client, result = _run("add_family_group", {"name": "X", "members": members})
    assert not result["success"] and "placeholder" in result["error"].lower() and client.posted == []
