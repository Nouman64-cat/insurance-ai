"""User management from the chat (Admin): every tenant role can be given, SuperAdmin cannot, refusals from
tenant-service are passed on, ambiguous names become a choice, and a missing underwriter is something an Admin
can fix in one click."""
import asyncio

import httpx
import pytest

import permission
import toolsets
from tool_executor import _HANDLERS, ChoiceNeeded, Ctx, ExecCtx

ROLES = [{"id": f"r-{n.lower().replace(' ', '-')}", "name": n} for n in (
    "SuperAdmin", "Admin", "Underwriter", "Medical Underwriter", "Financial Underwriter", "Agent", "ClaimsManager", "Viewer")]
USERS = [
    {"id": "u-1", "full_name": "Zainab Malik", "email": "zainab@x.pk", "role_id": "r-admin", "is_active": True},
    {"id": "u-2", "full_name": "Ali Raza", "email": "ali.raza@x.pk", "role_id": "r-underwriter", "is_active": True},
    {"id": "u-3", "full_name": "Ali Khan", "email": "ali.khan@x.pk", "role_id": "r-agent", "is_active": False},
]


class FakeClient:
    """Answers the tenant-service calls the handlers make and records the writes."""

    def __init__(self, refuse: dict | None = None):
        self.calls: list[tuple[str, str, dict | None]] = []
        self.refuse = refuse or {}

    def _reply(self, method: str, url: str, body=None):
        self.calls.append((method, url, body))
        req = httpx.Request(method, url)
        if method in self.refuse:
            return httpx.Response(self.refuse[method][0], json={"detail": self.refuse[method][1]}, request=req)
        if url.endswith("/roles"):
            return httpx.Response(200, json=ROLES, request=req)
        if url.endswith("/users/") and method == "GET":
            return httpx.Response(200, json=USERS, request=req)
        if url.endswith("/auth/me"):
            return httpx.Response(200, json={"id": "u-1", "full_name": "Zainab Malik"}, request=req)
        if url.endswith("/users/directory"):
            return httpx.Response(200, json=[u for u in USERS if u["is_active"]], request=req)
        if method == "POST":
            return httpx.Response(201, json={"id": "u-new", **body, "is_active": True}, request=req)
        if method == "PATCH":
            return httpx.Response(200, json={"id": url.rsplit("/", 1)[-1], **body}, request=req)
        if method == "DELETE":
            return httpx.Response(204, request=req)
        return httpx.Response(404, json={"detail": "not found"}, request=req)

    async def get(self, url, **kw): return self._reply("GET", url)
    async def post(self, url, json=None, **kw): return self._reply("POST", url, json)
    async def patch(self, url, json=None, **kw): return self._reply("PATCH", url, json)
    async def delete(self, url, **kw): return self._reply("DELETE", url)

    def writes(self):
        return [c for c in self.calls if c[0] != "GET"]


def _ctx(client=None, role="Admin"):
    return Ctx(client=client or FakeClient(), tenant_id="t-1", exec_ctx=ExecCtx(tenant_id="t-1", jwt_token="jwt", role=role))


def _run(name, args, ctx):
    return asyncio.run(_HANDLERS[name](args, ctx))


def test_list_users_shows_role_names_and_filters_by_role_and_status():
    ctx = _ctx()
    everyone = _run("list_users", {}, ctx)
    assert "Underwriter" in everyone["message"] and "*inactive*" in everyone["message"]
    assert _run("list_users", {"role": "underwriters"}, ctx)["users"][0]["full_name"] == "Ali Raza"
    assert [u["full_name"] for u in _run("list_users", {"status": "inactive"}, ctx)["users"]] == ["Ali Khan"]


def test_add_user_with_a_role_the_old_tool_could_not_give():
    client = FakeClient()
    result = _run("add_user", {"full_name": "Dr Sana", "email": "sana@x.pk", "role_name": "medical underwriter"}, _ctx(client))
    assert result["success"] and "Medical Underwriter" in result["message"] and "emailed" in result["message"]
    assert client.writes() == [("POST", "http://tenant-service:8001/tenants/t-1/users/",
                                {"full_name": "Dr Sana", "email": "sana@x.pk", "role_id": "r-medical-underwriter"})]


def test_admin_cannot_give_superadmin_but_a_superadmin_can():
    with pytest.raises(ChoiceNeeded) as asked:
        _run("add_user", {"full_name": "X", "email": "x@x.pk", "role_name": "SuperAdmin"}, _ctx())
    assert "SuperAdmin" not in [chip["label"] for chip in asked.value.quick_actions]
    assert _run("add_user", {"full_name": "X", "email": "x@x.pk", "role_name": "SuperAdmin"}, _ctx(role="SuperAdmin"))["success"]


def test_change_role_and_deactivate_reactivate():
    client = FakeClient()
    changed = _run("update_user_role", {"user": "ali.raza@x.pk", "role_name": "Medical Underwriter"}, _ctx(client))
    assert "now **Medical Underwriter** (was Underwriter)" in changed["message"]
    _run("set_user_active", {"user": "Ali Raza", "active": False}, _ctx(client))
    _run("set_user_active", {"user": "Ali Khan", "active": True}, _ctx(client))
    assert client.writes() == [
        ("PATCH", "http://tenant-service:8001/tenants/t-1/users/u-2", {"role_id": "r-medical-underwriter"}),
        ("PATCH", "http://tenant-service:8001/tenants/t-1/users/u-2", {"is_active": False}),
        ("PATCH", "http://tenant-service:8001/tenants/t-1/users/u-3", {"is_active": True}),
    ]


def test_no_op_changes_write_nothing():
    client = FakeClient()
    assert "already **Underwriter**" in _run("update_user_role", {"user": "Ali Raza", "role_name": "Underwriter"}, _ctx(client))["message"]
    assert "already inactive" in _run("set_user_active", {"user": "Ali Khan", "active": False}, _ctx(client))["message"]
    assert client.writes() == []


def test_an_ambiguous_name_becomes_a_choice_and_an_unknown_one_a_clear_miss():
    with pytest.raises(ChoiceNeeded) as asked:
        _run("set_user_active", {"user": "Ali", "active": False}, _ctx())
    assert {chip["label"] for chip in asked.value.quick_actions} == {"Ali Raza (ali.raza@x.pk)", "Ali Khan (ali.khan@x.pk)"}
    with pytest.raises(LookupError):
        _run("delete_user", {"full_name": "Nobody"}, _ctx())


def test_tenant_service_refusals_are_passed_on_in_its_words():
    client = FakeClient(refuse={"PATCH": (400, "You can't deactivate your own account.")})
    result = _run("set_user_active", {"user": "zainab@x.pk", "active": False}, _ctx(client))
    assert result == {"success": False, "message": "You can't deactivate your own account."}


def test_user_tools_are_admin_only_and_mutations_are_marked():
    changes = ("add_user", "update_user_role", "set_user_active", "delete_user")
    for tool in changes:
        assert permission.is_role_allowed(tool, "Admin")
        for role in ("Underwriter", "Agent", "Medical Underwriter", "Financial Underwriter", "ClaimsManager",
                     "ClaimsAdjuster", "CustomerService", "Viewer"):
            assert not permission.is_role_allowed(tool, role), (tool, role)
    # Listing was already open to a ClaimsManager (their adjusters) and Viewer (read-only); for them it reads the
    # directory of active users (see test_a_claims_manager_lists_from_the_directory_not_the_admin_list).
    assert permission.is_role_allowed("list_users", "Admin")
    assert not permission.is_role_allowed("list_users", "Underwriter")


def test_a_claims_manager_lists_from_the_directory_not_the_admin_list():
    client = FakeClient()
    listed = _run("list_users", {}, _ctx(client, role="ClaimsManager"))
    assert [u["full_name"] for u in listed["users"]] == ["Zainab Malik", "Ali Raza"]  # active users only
    assert [url for _, url, _ in client.calls if "/users" in url] == ["http://tenant-service:8001/tenants/t-1/users/directory"]
    assert {"update_user_role", "set_user_active"} <= permission.MUTATING_TOOLS
    assert permission.missing_args("set_user_active", {"user": "Ali", "active": False}) == []


def test_user_pack_loads_on_user_talk_and_stays_out_of_the_fallback():
    for text in ("deactivate Ali's account", "Add a new Medical Underwriter user", "make Sana a claims adjuster",
                 "who is on my team?"):
        assert "users" in toolsets.matched_domains([text]), text
    assert toolsets.domain_of("set_user_active") == "users"
    assert "users" not in toolsets.FALLBACK_DOMAINS


def test_missing_underwriter_offers_an_admin_the_fix_and_tells_others_who_can():
    from specialist_review_tools import _no_underwriter
    admin = _no_underwriter("medical", _ctx())
    assert [c["label"] for c in admin["quick_actions"]][:1] == ["Add a Medical Underwriter"]
    other = _no_underwriter("medical", _ctx(role="Underwriter"))
    assert "Ask an Admin" in other["message"] and "quick_actions" not in other


def test_assignment_pickers_read_the_directory_so_underwriters_can_use_them():
    client = FakeClient()
    listed = _run("list_assignable_users", {}, _ctx(client, role="Underwriter"))
    assert [u["role_name"] for u in listed["users"]] == ["Admin", "Underwriter"]
    assert all(not url.endswith("/users/") for _, url, _ in client.calls)


def test_me_is_the_signed_in_user_and_the_api_has_the_last_word():
    client = FakeClient(refuse={"PATCH": (400, "You can't deactivate your own account.")})
    result = _run("set_user_active", {"user": "my own account", "active": False}, _ctx(client))
    assert result["message"] == "You can't deactivate your own account."
    assert [c for c in client.calls if c[0] == "PATCH"][0][1].endswith("/users/u-1")  # Zainab, the signed-in Admin


def test_user_management_requests_go_to_the_main_assistant_for_admins():
    from langchain_core.messages import HumanMessage
    from specialist_router import coordinator_node

    def route(text, role="Admin", active=None):
        return coordinator_node({"messages": [HumanMessage(content=text)], "user_role": role, "active_specialist": active})

    for text in ("Add a Medical Underwriter", "Add a new Medical Underwriter user", "deactivate the claims adjuster Ali",
                 "Change Sana's role to Financial Underwriter", "make Bilal an admin"):
        assert route(text, active="final_underwriting")["active_specialist"] is None, text
    # Ordinary work is not mistaken for user management, and other roles are not rerouted.
    from specialist_router import _USER_ADMIN
    for text in ("Assign the medical review of case APP-2026-E1E8F9", "Add a customer named Ali", "Create a proposal",
                 "Show the underwriting status of APP-2026-E1E8F9", "add a comment to the case"):
        assert not _USER_ADMIN.search(text), text
    assert route("Add a Medical Underwriter", role="Medical Underwriter")["active_specialist"] == "medical_underwriting"
