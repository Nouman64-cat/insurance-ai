"""list_acquisition_sources must answer with a bounded table, not a page jump."""
import httpx
import pytest

from test_record_lookup import FakeClient, _ctx, _run
from tool_executor import _HANDLERS
from tools import ListAcquisitionSourcesArgs


def _sources(n_active=1000, n_inactive=3):
    types = ["AGENT", "BROKER", "BANCASSURANCE", "DIRECT"]
    rows = [{"id": f"s-{i}", "name": f"Source {i}", "code": f"SRC-{i:04d}", "source_type": types[i % 4],
             "partner_name": None, "city": "Lahore", "customer_count": i % 7, "is_active": True}
            for i in range(n_active)]
    rows += [{"id": f"x-{i}", "name": f"Retired {i}", "code": f"OLD-{i}", "source_type": "BROKER",
              "city": "Karachi", "customer_count": 0, "is_active": False} for i in range(n_inactive)]
    return {("/acquisition-sources", None): rows}


def test_large_tenant_returns_one_bounded_page():
    result = _run(_HANDLERS["list_acquisition_sources"]({}, _ctx(FakeClient(_sources()))))
    assert result["total"] == 1000
    assert len(result["sources"]) == 20
    assert result["has_more"]
    assert result["message"].count("\n| SRC-") == 20
    assert "980 more" in result["message"]


def test_limit_is_capped_even_if_schema_is_bypassed():
    result = _run(_HANDLERS["list_acquisition_sources"]({"limit": 5000}, _ctx(FakeClient(_sources()))))
    assert len(result["sources"]) == 50


def test_schema_rejects_oversized_limit():
    with pytest.raises(ValueError):
        ListAcquisitionSourcesArgs(limit=51)


def test_pagination_and_filters():
    client = FakeClient(_sources(n_active=40))
    page = _run(_HANDLERS["list_acquisition_sources"]({"limit": 10, "offset": 30}, _ctx(client)))
    assert page["total"] == 40 and len(page["sources"]) == 10 and not page["has_more"]

    brokers = _run(_HANDLERS["list_acquisition_sources"]({"source_type": "BROKER"}, _ctx(client)))
    assert brokers["total"] == 10
    assert all(s["type_label"] == "Broker" for s in brokers["sources"])

    inactive = _run(_HANDLERS["list_acquisition_sources"]({"status": "inactive"}, _ctx(client)))
    assert inactive["total"] == 3 and inactive["sources"][0]["status_label"] == "Inactive"

    found = _run(_HANDLERS["list_acquisition_sources"]({"search": "SRC-0007", "status": "all"}, _ctx(client)))
    assert [s["name"] for s in found["sources"]] == ["Source 7"]


def test_walk_in_label_and_escaped_cells():
    data = {("/acquisition-sources", None): [{"id": "s", "name": "Desk | A\nB", "code": "W1",
                                              "source_type": "DIRECT", "customer_count": 2, "is_active": True}]}
    result = _run(_HANDLERS["list_acquisition_sources"]({}, _ctx(FakeClient(data))))
    assert "| W1 | Desk \\| A B | Walk-in | — | — | 2 | Active |" in result["message"]


def test_non_admin_gets_a_clear_answer_not_zero():
    class Forbidden:
        async def get(self, url, **kwargs):
            return httpx.Response(403, request=httpx.Request("GET", url))
    result = _run(_HANDLERS["list_acquisition_sources"]({}, _ctx(Forbidden())))
    assert not result["success"]
    assert "total" not in result
    assert _run(_HANDLERS["list_active_acquisition_sources"]({}, _ctx(Forbidden())))["sources"] == []


def test_intake_helper_still_returns_every_active_source():
    result = _run(_HANDLERS["list_active_acquisition_sources"]({}, _ctx(FakeClient(_sources()))))
    assert len(result["sources"]) == 1000
    assert {"id", "name", "code", "type", "user_id"} <= set(result["sources"][0])
