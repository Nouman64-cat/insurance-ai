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


def _skip(tool, pre, head=None, message="✅ done for case **CASE-2026-ABC123**.\n\n👉 Next Gate: **Gate 2: Agent Confidential Report (ACR)**."):
    class Client:
        async def get(self, url, **kw):
            if url.endswith("/cases"):
                return _Resp([{"caseld": "c1", "caseNumber": "CASE-2026-ABC123", "customer_cnic": "1"}])
            return _Resp({"pre_underwriting_status": pre, "family_head_case": head})

    exec_ctx = tool_executor.ExecCtx(tenant_id="t", jwt_token="", role="Admin")
    ctx = tool_executor.Ctx(client=Client(), tenant_id="t", exec_ctx=exec_ctx)
    result = {"success": True, "message": message, "quick_actions": [{"label": "2. Submit ACR (Gate 2)", "actionType": "submit", "payload": "x"}]}
    return asyncio.run(tool_executor._skip_completed_gates(tool, result, ctx, {}))


_SPOUSE = {"e_application": "Verified", "acr": "Submitted", "compliance": "Passed", "ipp": "Realized", "insurance_history": "NotStarted", "medical_exam": "NotAssessed"}
_HEAD = {"case_number": "CASE-2026-HEAD11"}


def test_requirements_already_covered_by_the_head_are_skipped_after_a_gate():
    out = _skip("verify_e_application", _SPOUSE, _HEAD)
    assert "3 (Agent's Confidential Report), 4 (PEP & Sanctions Screening), 5 (Initial Premium Payment)" in out["message"]
    assert "recorded once for the whole family, on the head's case CASE-2026-HEAD11" in out["message"]
    assert "requirement 6 of 7" in out["message"] and "Gate 2: Agent Confidential Report" not in out["message"]
    assert [a["label"] for a in out["quick_actions"]] == ["Run History Check", "Check Gate Status"]


def test_everything_done_points_at_ai_underwriting():
    done = {**_SPOUSE, "insurance_history": "Clear", "medical_exam": "Completed"}
    out = _skip("verify_e_application", done, _HEAD)
    assert "All pre-underwriting requirements are complete" in out["message"]
    assert out["quick_actions"][0]["label"] == "Run AI Underwriting"


def test_nothing_changes_when_nothing_was_skipped_or_the_gate_is_not_done():
    plain = {"e_application": "Verified", "acr": "NotStarted", "compliance": "NotRun", "ipp": "NotStarted", "insurance_history": "NotStarted", "medical_exam": "NotAssessed"}
    out = _skip("verify_e_application", plain)
    assert "Gate 2: Agent Confidential Report" in out["message"] and out["quick_actions"][0]["label"] == "2. Submit ACR (Gate 2)"
    link_only = {**_SPOUSE, "e_application": "Submitted"}                  # the link was sent but the form isn't verified yet
    assert "Gate 2: Agent Confidential Report" in _skip("verify_e_application", link_only, _HEAD)["message"]


def test_a_requirement_the_head_already_covers_is_reported_not_run_again():
    """Re-filing the head's locked Agent report from the spouse's case used to fail with 'ACR … is locked'."""
    calls = []

    class Client:
        async def get(self, url, **kw):
            if url.endswith("/cases"):
                return _Resp([{"caseld": "c1", "caseNumber": "CASE-2026-ABC123", "customer_cnic": "1"}])
            return _Resp({"pre_underwriting_status": {**_SPOUSE, "insurance_history": "NotStarted"}, "family_head_case": _HEAD})

        async def put(self, url, **kw):
            calls.append(("PUT", url))
            return _Resp({"detail": "locked"}, 409)

        async def post(self, url, **kw):
            calls.append(("POST", url))
            return _Resp({"detail": "locked"}, 409)

    exec_ctx = tool_executor.ExecCtx(tenant_id="t", jwt_token="", role="Admin")

    async def go():
        shared = tool_executor.Ctx(client=Client(), tenant_id="t", exec_ctx=exec_ctx)
        out = {}
        for name, handler in (("acr", tool_executor._submit_agent_confidential_report),
                              ("ipp", tool_executor._process_initial_premium_payment),
                              ("pep", tool_executor._run_compliance_screening)):
            out[name] = await handler({"case_number": "CASE-2026-ABC123"}, shared)
        return out

    out = asyncio.run(go())
    assert not calls, f"nothing should be written for an already-complete requirement: {calls}"
    for name, result in out.items():
        assert result["success"] and "already complete" in result["message"] and "on the head's case CASE-2026-HEAD11" in result["message"], (name, result)


def test_the_head_going_last_sees_what_the_spouse_already_recorded():
    """The spouse is underwritten first, so the head's own checklist is where the shared steps turn up already done."""
    pre = {**_SPOUSE, "insurance_history": "NotStarted"}

    class Client:
        async def get(self, url, **kw):
            if url.endswith("/cases"):
                return _Resp([{"caseld": "c1", "caseNumber": "CASE-2026-ABC123", "customer_cnic": "1"}])
            return _Resp({"pre_underwriting_status": pre, "family_head_case": None, "family_members": [{}, {}]})

    exec_ctx = tool_executor.ExecCtx(tenant_id="t", jwt_token="", role="Admin")
    ctx = tool_executor.Ctx(client=Client(), tenant_id="t", exec_ctx=exec_ctx)
    result = {"success": True, "message": "✅ done for case **CASE-2026-ABC123**.", "quick_actions": []}
    out = asyncio.run(tool_executor._skip_completed_gates("verify_e_application", result, ctx, {}))
    assert "already recorded for the family" in out["message"] and "requirement 6 of 7" in out["message"]


def _risk_chip_result(members, ready_by_case):
    class Client:
        async def get(self, url, **kw):
            if url.endswith("/cases"):
                return _Resp([{"caseld": "head-id", "caseNumber": "CASE-HEAD", "customer_cnic": "1"}])
            for cid, ready in ready_by_case.items():
                if f"/cases/{cid}/detail" in url:
                    return _Resp({"pre_underwriting_status": {"is_ready": ready}, "family_members": members})
            return _Resp({"pre_underwriting_status": {"is_ready": True}, "family_members": members})

    exec_ctx = tool_executor.ExecCtx(tenant_id="t", jwt_token="", role="Admin")
    ctx = tool_executor.Ctx(client=Client(), tenant_id="t", exec_ctx=exec_ctx)
    result = {"success": True, "message": "✅ done.", "quick_actions": [
        {"label": "Run AI Underwriting", "actionType": "submit", "payload": "Run risk assessment for case CASE-HEAD"},
        {"label": "Check Gate Status", "actionType": "submit", "payload": "Check pre-underwriting status for case CASE-HEAD"}]}
    return asyncio.run(tool_executor._family_risk_chips(result, ctx))


_FAMILY = [{"case_id": "head-id", "case_number": "CASE-HEAD", "name": "Imran", "relationship": "SELF", "is_current": True},
           {"case_id": "spouse-id", "case_number": "CASE-SPOUSE", "name": "Ayesha", "relationship": "SPOUSE", "is_current": False}]


def test_after_the_head_the_chat_points_at_the_spouse_not_at_a_risk_assessment():
    out = _risk_chip_result(_FAMILY, {"spouse-id": False})
    labels = [a["label"] for a in out["quick_actions"]]
    assert labels[0] == "Underwrite Ayesha" and "Run AI Underwriting" not in labels
    assert out["quick_actions"][0]["actionType"] == "uw_requirements" and '"caseId": "spouse-id"' in out["quick_actions"][0]["payload"]
    assert "all insured members together" in out["message"] and "Ayesha" in out["message"]


def test_once_the_spouse_is_in_the_assessment_is_one_run_for_everyone():
    out = _risk_chip_result(_FAMILY, {"spouse-id": True})
    assert out["quick_actions"][0] == {"label": "Run risk assessment — all insured members", "actionType": "family_assess", "payload": "{}"}
    assert "Run AI Underwriting" not in [a["label"] for a in out["quick_actions"]]


def test_a_single_person_keeps_their_own_assessment_chip():
    out = _risk_chip_result(_FAMILY[:1], {})
    assert out["quick_actions"][0]["label"] == "Run AI Underwriting"


def test_a_case_past_underwriting_says_where_it_stands_instead_of_being_assessed_again():
    case = {"caseNumber": "CASE-2026-ABC123", "caseStatus": "Closed"}
    active = tool_executor._past_underwriting(case, {"status": "Active"})
    assert "already done" in active["message"] and "Active" in active["message"] and active["quick_actions"][0]["label"] == "View active policy"
    paying = tool_executor._past_underwriting({**case, "caseStatus": "Approved"}, {"status": "PendingPayment"})
    assert "waiting for the first payment" in paying["message"] and paying["quick_actions"][0]["label"] == "Confirm payment"
    approved = tool_executor._past_underwriting({**case, "caseStatus": "Approved"}, {"status": "Approved"})
    assert "already **approved**" in approved["message"] and approved["quick_actions"][0]["label"] == "Yes — Issue Policy"
    # Still being underwritten: nothing to say, the assessment goes ahead.
    assert tool_executor._past_underwriting({**case, "caseStatus": "Under Review"}, {"status": "UnderReview"}) is None
    assert tool_executor._past_underwriting({**case, "caseStatus": "Approved"}, {"status": "UnderReview"}) is None
