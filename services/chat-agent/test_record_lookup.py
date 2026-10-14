"""show_record / search_records — lead IDs and cross-type lookups.

Lead IDs (IND-2610-003 …) exist only on the Leads board, which numbers leads
per lane in creation order. The agent has to rebuild exactly the same IDs or a
user reading one off the screen gets "not found".

Run with:  python -m pytest services/chat-agent/test_record_lookup.py -q
"""

from __future__ import annotations

import asyncio
from urllib.parse import urlparse

import httpx

import tool_executor
from tool_executor import Ctx, ExecCtx, _HANDLERS, _load_leads, _match_lead

TENANT = "t1"


def _customer(cid, name, created, status="LEAD", cnic=None):
    return {"id": cid, "name": name, "cnic": cnic or f"35202-000000{cid[-1]}-1",
            "profile_status": status, "created_at": created}


# category → rows, mirroring tenant-service's disjoint lead buckets.
DATA = {
    ("/customers", "quick_lead"): [
        _customer("c-2", "Bilal Ahmed", "2026-10-03T09:00:00"),
        _customer("c-4", "Danish Iqbal", "2026-10-09T09:00:00"),
    ],
    ("/customers", "full_details"): [
        _customer("c-1", "Ayesha Khan", "2026-09-28T09:00:00", status="PROSPECT"),
        # Converted — the board hides it, so it must not take a sequence number.
        _customer("c-9", "Old Policyholder", "2026-09-01T09:00:00", status="POLICYHOLDER"),
    ],
    ("/customers", "not_interested"): [
        _customer("c-3", "Sana Malik", "2026-10-05T09:00:00", status="NOT_INTERESTED"),
    ],
    ("/families", "new"): [
        {"id": "f-1", "name": "Rehman Family", "profile_status": "LEAD", "created_at": "2026-10-02T09:00:00"},
    ],
    ("/families", "in_progress"): [],
    ("/organizations", "new"): [
        {"id": "o-1", "name": "Acme Textiles", "registration_number": "REG-77",
         "profile_status": "LEAD", "created_at": "2026-08-15T09:00:00"},
    ],
    ("/organizations", "in_progress"): [],
    ("/cases", None): [
        {"id": "k-1", "caseNumber": "CASE-2026-A3F9C1", "applicant_name": "Bilal Ahmed"},
    ],
}


# The unfiltered customer list — every individual lead is also in here.
DATA[("/customers", None)] = [r for (path, cat), rows in list(DATA.items())
                              if path == "/customers" for r in rows]


class FakeClient:
    def __init__(self, data=DATA):
        self.data = data
        self.calls: list[tuple[str, str | None]] = []

    async def get(self, url, params=None, **kw):
        path = urlparse(url).path.removeprefix(f"/tenants/{TENANT}")
        key = (path, (params or {}).get("category"))
        self.calls.append(key)
        rows = self.data.get(key, [])
        return httpx.Response(200, json=rows, request=httpx.Request("GET", url))


def _ctx(client=None):
    return Ctx(client=client or FakeClient(), tenant_id=TENANT,
               exec_ctx=ExecCtx(tenant_id=TENANT, jwt_token="", role="Admin"))


def _run(coro):
    return asyncio.run(coro)


def test_lead_ids_match_the_board():
    leads = {l["name"]: l["display_id"] for l in _run(_load_leads(_ctx()))}
    assert leads == {
        "Ayesha Khan": "IND-2609-001",
        "Bilal Ahmed": "IND-2610-002",
        "Sana Malik": "IND-2610-003",
        "Danish Iqbal": "IND-2610-004",
        "Rehman Family": "FAM-2610-001",
        "Acme Textiles": "CORP-2608-001",
    }


def test_lead_id_lookup_tolerates_formatting_and_month_drift():
    leads = _run(_load_leads(_ctx()))
    assert _match_lead(leads, "ind-2610-003")["name"] == "Sana Malik"
    assert _match_lead(leads, "IND 2610 003")["name"] == "Sana Malik"
    # Browser timezone put it in the neighbouring month — lane + sequence still decide.
    assert _match_lead(leads, "IND-2611-003")["name"] == "Sana Malik"
    assert _match_lead(leads, "FAM-2610-002") is None


def test_show_record_finds_a_lead_by_board_id():
    res = _run(_HANDLERS["show_record"]({"record_type": "lead", "identifier": "IND-2610-002"}, _ctx()))
    assert res["success"], res
    assert "Bilal Ahmed" in res["message"]
    # Individual lead → its CNIC, which admin/leads uses to open the detail panel.
    assert res["navigate"]["route"].startswith("admin/leads?cnic=")


def test_show_record_family_lead_highlights_by_board_id():
    res = _run(_HANDLERS["show_record"]({"record_type": "lead", "identifier": "FAM-2610-001"}, _ctx()))
    assert res["success"], res
    assert res["navigate"]["entity_id"] == "FAM-2610-001"


def test_wrong_record_type_points_at_the_right_one():
    res = _run(_HANDLERS["show_record"]({"record_type": "lead", "identifier": "CASE-2026-A3F9C1"}, _ctx()))
    assert not res["success"]
    assert res["results"][0]["type"] == "case"
    assert "CASE-2026-A3F9C1" in res["message"]


def test_search_prefers_lead_over_its_customer_twin():
    res = _run(_HANDLERS["search_records"]({"query": "Bilal"}, _ctx()))
    types = [h["type"] for h in res["results"]]
    assert "lead" in types and "case" in types
    assert "customer" not in types, "the same person must not be listed twice"


def test_every_record_type_has_a_source_and_a_page():
    from typing import get_args

    from pages import page_for_record
    from tools import RecordType

    for record_type in get_args(RecordType):
        assert record_type in tool_executor._RECORD_SOURCES, record_type
        assert page_for_record(record_type), record_type
