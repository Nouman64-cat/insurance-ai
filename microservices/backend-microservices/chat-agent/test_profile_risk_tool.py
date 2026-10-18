from types import SimpleNamespace
from unittest.mock import AsyncMock
import unittest

from tool_executor import ChoiceNeeded
import profile_risk_tools  # noqa: F401
from profile_risk_tools import _assess_customer_risk_profile

CUSTOMERS = [
    {"id": "c1", "cnic": "35202-8411849-8", "first_name": "Amna", "last_name": "Butt", "name": "Amna Butt",
     "details": {"pending_plan": {"product_name": "Protect Plan", "coverage_amount": 23900000}}},
    {"id": "c2", "cnic": "35202-1111111-1", "first_name": "Amna", "last_name": "Khan", "name": "Amna Khan", "details": {}},
]
PROFILE = {"customer_id": "c1", "name": "Amna Butt", "plan_considered": "Protect Plan", "safe_pct": 94.6, "risk_pct": 5.4,
           "band": "Low", "completeness_pct": 100, "cover_considered": 23900000.0, "missing": [],
           "safe_factors": [{"label": "Medical history", "detail": "No conditions declared", "contribution_pct": 18.0}],
           "risk_factors": [{"label": "Body mass index", "detail": "BMI 26.4 (overweight)", "contribution_pct": 3.0}],
           "categories": [
               {"key": "medical", "label": "Medical risk", "share_pct": 21.0, "safe_pct": 18.0 + 0.0, "risk_pct": 3.0, "band": "Low",
                "missing": [],
                "safe_factors": [{"key": "medical", "label": "Medical history", "detail": "No conditions declared", "contribution_pct": 18.0}],
                "risk_factors": [{"key": "bmi", "label": "Body mass index", "detail": "BMI 26.4 (overweight)", "contribution_pct": 3.0,
                                  "rules": [{"code": "RSK-BMI-02", "name": "Overweight", "reason": "Excess weight raises the risk of diabetes."}]}]},
               {"key": "occupational", "label": "Occupational risk", "share_pct": 0, "safe_pct": 0, "risk_pct": 0, "band": "Not recorded",
                "missing": ["Occupation hazard"], "safe_factors": [], "risk_factors": []},
           ]}


def _ctx():
    def get(url, params=None):
        body = CUSTOMERS if url.endswith("/customers") else PROFILE
        return SimpleNamespace(status_code=200, json=lambda: body, raise_for_status=lambda: None)
    return SimpleNamespace(client=SimpleNamespace(get=AsyncMock(side_effect=get)), tsvc=lambda p: "/t" + p)


class ProfileRiskToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_cnic_lookup_returns_both_sides_totalling_100(self):
        ctx = _ctx()
        out = await _assess_customer_risk_profile({"cnic": "3520284118498"}, ctx)
        assert out["success"]
        assert "Safe **94.6%** · Risk **5.4%**" in out["message"]
        assert "**Medical risk** — Low · 21.0% of the profile" in out["message"]
        assert "| Medical history | No conditions declared | 18.0% | 0.0% |" in out["message"]
        assert "| Body mass index | BMI 26.4 (overweight) | 0.0% | 3.0% |" in out["message"]
        assert "**Occupational risk** — not recorded (Occupation hazard)." in out["message"]
        assert "- **Body mass index**: Excess weight raises the risk of diabetes. _(RSK-BMI-02)_" in out["message"]
        assert ctx.client.get.call_args_list[-1].args[0] == "/t/customers/c1/risk-profile"
        assert out["quick_actions"][0]["label"] == "Create proposal"


    async def test_ambiguous_name_asks_which_customer(self):
        with self.assertRaises(ChoiceNeeded):
            await _assess_customer_risk_profile({"customer_name": "Amna"}, _ctx())


    async def test_needs_someone_to_assess(self):
        out = await _assess_customer_risk_profile({}, _ctx())
        assert not out["success"]


class SavedLeadRiskTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_saves_through_same_lead_endpoint_without_case(self):
        from profile_risk_tools import _run_customer_risk_assessment
        ctx = _ctx()
        saved = {**PROFILE, "assessed_at": "2026-10-19T01:00:00Z", "stale": False}
        ctx.client.post = AsyncMock(return_value=SimpleNamespace(json=lambda: saved, raise_for_status=lambda: None))
        out = await _run_customer_risk_assessment({"customer_name": "Amna Butt"}, ctx)
        ctx.client.post.assert_awaited_once_with("/t/customers/c1/risk-profile")
        assert [c.args[0] for c in ctx.client.get.call_args_list] == ["/t/customers"]
        assert out["success"] and "assessment saved" in out["message"]
        assert out["risk_profile"]["assessed_at"] == saved["assessed_at"]
        assert "Safe **94.6%**" in out["message"]

    async def test_run_ambiguity_or_missing_customer_never_posts(self):
        from profile_risk_tools import _run_customer_risk_assessment
        ctx = _ctx()
        ctx.client.post = AsyncMock()
        with self.assertRaises(ChoiceNeeded):
            await _run_customer_risk_assessment({"customer_name": "Amna"}, ctx)
        out = await _run_customer_risk_assessment({"customer_name": "Unknown"}, ctx)
        assert not out["success"]
        ctx.client.post.assert_not_awaited()

    async def test_backend_failure_does_not_claim_saved(self):
        import httpx
        from profile_risk_tools import _run_customer_risk_assessment
        ctx = _ctx()
        response = httpx.Response(403, request=httpx.Request("POST", "http://tenant/customers/c1/risk-profile"))
        ctx.client.post = AsyncMock(return_value=response)
        with self.assertRaises(httpx.HTTPStatusError):
            await _run_customer_risk_assessment({"customer_id": "c1"}, ctx)
        ctx.client.post.assert_awaited_once()

    async def test_saved_result_reports_staleness_without_rerunning(self):
        from profile_risk_tools import _get_customer_risk_assessment
        ctx = _ctx()
        body = {"assessment": {**PROFILE, "stale": True, "stale_reasons": ["Profile changed"]}}
        ctx.client.get.side_effect = [SimpleNamespace(json=lambda: CUSTOMERS, raise_for_status=lambda: None),
                                      SimpleNamespace(json=lambda: body, raise_for_status=lambda: None)]
        ctx.client.post = AsyncMock()
        out = await _get_customer_risk_assessment({"customer_id": "c1"}, ctx)
        assert "outdated" in out["message"] and "Profile changed" in out["message"]
        assert ctx.client.get.call_args.args[0] == "/t/customers/c1/risk-profile/latest"
        ctx.client.post.assert_not_awaited()

    async def test_no_saved_result_is_not_a_case_prerequisite(self):
        from profile_risk_tools import _get_customer_risk_assessment
        ctx = _ctx()
        ctx.client.get.side_effect = [SimpleNamespace(json=lambda: CUSTOMERS, raise_for_status=lambda: None),
                                      SimpleNamespace(json=lambda: {"assessment": None}, raise_for_status=lambda: None)]
        out = await _get_customer_risk_assessment({"customer_id": "c1"}, ctx)
        assert out["assessment"] is None
        assert "without creating a proposal" in out["message"]
