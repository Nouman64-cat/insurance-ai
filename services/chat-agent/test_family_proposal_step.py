"""A family added with members (demo data included) goes through the Proposal stage before
pre-underwriting, exactly like an individual customer: the tool hands the browser a
`proposal_journey` instead of offering the underwriting button straight away.

Run with:  python -m pytest services/chat-agent/test_family_proposal_step.py -q
"""

import asyncio

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
        self.calls = []

    async def post(self, url, **kw):
        self.calls.append(url)
        if url.endswith("/families"):
            return _Resp({"id": "fam-1"})
        if url.endswith("/floater-policies"):
            return _Resp({"id": "fp-1"})
        if url.endswith("/members/confirm"):
            # Like the real endpoint: a case only for the head and an insured spouse, shares for everyone else.
            sent = kw["json"]["members"]
            insured = [m for m in sent if m["relationship"] == "Self" or m.get("is_insured") is not False]
            return _Resp({
                "members": [{"case_number": f"CASE-{i}", "case_id": f"id-{i}"} for i in range(1, len(insured) + 1)],
                "nominees": [{"name": m["name"], "share_pct": m["share_pct"], "amount": m["share_pct"] * 50_000}
                             for m in sent if m["relationship"] != "Self"],
            })
        return _Resp({})


def _run(args):
    client = _Client()

    async def _shared():
        return client

    saved, tool_executor._shared_client = tool_executor._shared_client, _shared
    try:
        ctx = tool_executor.ExecCtx(tenant_id="t", jwt_token="", role="Agent")
        # An Agent owns their own leads, so no "which agent?" question is raised.
        async def _me(_ctx):
            return {"id": "agent-1", "full_name": "An Agent"}
        saved_me, tool_executor._current_user = tool_executor._current_user, _me
        try:
            return asyncio.run(tool_executor.execute_tool("add_family_group", args, ctx))
        finally:
            tool_executor._current_user = saved_me
    finally:
        tool_executor._shared_client = saved


def test_family_with_demo_data_starts_at_the_proposal_not_underwriting():
    result = _run({"use_demo_data": True})
    assert result["success"]
    journey = result["proposal_journey"]
    n = len(journey["case_numbers"])
    assert journey["family_group_id"] == "fam-1" and n >= 1 and journey["case_numbers"] == [f"CASE-{i}" for i in range(1, n + 1)]
    # The browser needs each member's case id to offer the guided / workspace options per member.
    assert [c["case_id"] for c in journey["cases"]] == [f"id-{i}" for i in range(1, n + 1)]
    assert all(c["name"] and c["case_number"] for c in journey["cases"])
    assert journey["cases"][0]["relationship"] == "Self"            # the head is underwritten first
    assert "of the death benefit" in result["message"]               # the nominee shares are shown
    labels = [a["label"] for a in result["quick_actions"]]
    assert "Start underwriting for family" not in labels, "underwriting must wait for the proposal steps"
    assert "proposal" in result["message"].lower()


def test_a_family_without_members_has_no_proposal_yet():
    result = _run({"name": "Empty Family"})
    assert result["success"] and "proposal_journey" not in result


def test_demo_family_only_insures_the_head_and_maybe_the_spouse_and_shares_total_100():
    for _ in range(60):                      # the generator is random — cover both spouse outcomes and child / no child
        _, members = tool_executor._demo_family_group()
        head = [m for m in members if m["relationship"] == "Self"]
        assert len(head) == 1 and head[0]["is_insured"] is True
        nominees = [m for m in members if m["relationship"] != "Self"]
        assert abs(sum(m["share_pct"] for m in nominees) - 100.0) < 0.01
        for m in nominees:
            if m["relationship"] != "Spouse":
                assert m["is_insured"] is False and "occupation" not in m and "cnic" not in m
            elif m["is_insured"]:
                assert m["cnic"] and m["occupation"] and "declared_income" in m
            else:
                assert "cnic" not in m and "occupation" not in m


def test_issuance_runs_on_the_heads_case_not_the_spouses():
    cases = [{"caseld": "head-id", "caseNumber": "CASE-HEAD", "customer_cnic": "1"}, {"caseld": "spouse-id", "caseNumber": "CASE-SPOUSE", "customer_cnic": "2"}]

    class Client:
        async def get(self, url, **kw):
            if url.endswith("/cases"):
                return _Resp(cases)
            if "/cases/spouse-id/detail" in url:
                return _Resp({"family_head_case": {"case_id": "head-id", "case_number": "CASE-HEAD", "name": "Head"}})
            return _Resp({"family_head_case": None})

    async def _go(case_number):
        exec_ctx = tool_executor.ExecCtx(tenant_id="t", jwt_token="", role="Admin")
        ctx = tool_executor.Ctx(client=Client(), tenant_id="t", exec_ctx=exec_ctx)
        return await tool_executor._issuance_case({"case_number": case_number}, ctx)

    assert asyncio.run(_go("CASE-SPOUSE"))["caseNumber"] == "CASE-HEAD"       # the spouse's case is redirected to the head's
    assert asyncio.run(_go("CASE-HEAD"))["caseNumber"] == "CASE-HEAD"         # the head's own case is left alone
