"""A flagged insurance-history screen (e.g. HLV over-exposure on a family member entered through
the form with a low income): demo mode accepts it so the gates carry on to the medical step;
outside demo it stays a hold and says so instead of a green tick and "next: Gate 6".

Run with:  python -m pytest services/chat-agent/test_history_flagged.py -q
"""

import asyncio
import os

import tool_executor


class _Resp:
    def __init__(self, body, status=200):
        self.status_code, self._body = status, body

    def json(self):
        return self._body

    def raise_for_status(self):
        pass


class _Client:
    def __init__(self):
        self.cleared = False

    async def get(self, url, **kw):
        if "/cases/case-1/detail" in url:
            return _Resp({"pre_underwriting_status": {"ipp": "Realized"}})
        return _Resp([{"caseld": "case-1", "caseNumber": "CASE-1", "customer_cnic": "1"}])

    async def post(self, url, **kw):
        if url.endswith("/insurance-history/run"):
            return _Resp({"status": "Flagged", "aggregate_sum_assured": 5_000_000, "hlv_ratio": 9.0,
                          "findings": [{"title": "HLV", "detail": "9.0x income"}]})
        if url.endswith("/insurance-history/clear"):
            self.cleared = True
            return _Resp({"status": "Clear"})
        return _Resp({})


def _run(mode):
    client = _Client()

    async def _shared():
        return client

    async def _case(args, ctx):
        return {"caseld": "case-1", "caseNumber": "CASE-1"}

    saved = (tool_executor._shared_client, tool_executor._resolve_case, os.environ.get("ENV_VAR"))
    tool_executor._shared_client, tool_executor._resolve_case = _shared, _case
    os.environ["ENV_VAR"] = mode
    try:
        ctx = tool_executor.ExecCtx(tenant_id="t", jwt_token="", role="Admin")
        return client, asyncio.run(tool_executor.execute_tool("run_insurance_history_check", {"case_number": "CASE-1"}, ctx))
    finally:
        tool_executor._shared_client, tool_executor._resolve_case = saved[0], saved[1]
        if saved[2] is None:
            os.environ.pop("ENV_VAR", None)
        else:
            os.environ["ENV_VAR"] = saved[2]


def test_demo_accepts_a_flagged_screen_and_moves_on_to_medical():
    client, result = _run("demo")
    assert client.cleared and result["status"] == "Clear"
    assert "accepted automatically" in result["message"] and "Gate 6" in result["message"]
    assert [a["label"] for a in result["quick_actions"]][0] == "6. Medical Exam (Gate 6)"


def test_outside_demo_a_flagged_screen_is_a_hold_not_a_green_tick():
    client, result = _run("prod")
    assert not client.cleared and result["status"] == "Flagged"
    assert result["message"].startswith("⚠️") and "on hold" in result["message"]
    assert "6. Medical Exam (Gate 6)" not in [a["label"] for a in result["quick_actions"]]
