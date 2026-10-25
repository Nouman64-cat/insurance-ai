"""Security regression test of the Rule Engine router (/tenants/{id}/rules/*). ISOLATED evaluation stack only.

Scenarios, for every route: no login, a garbage token, an expired token, a user of another tenant and a user of this tenant without the role are all refused; the permitted roles can do the work with the business validation,
audit and idempotency intact; a rule set of one tenant cannot be read, deployed, edited or deleted through another tenant's path; the evaluation log shows only the tenant's own rows; the actor and the approver in the audit
trail are the verified caller, never a name in the body; and the internal early-knockout check works for the platform's own service (shared secret) but not for anyone else.

Run: python evals/environment/envctl.py fresh; docker exec eval-tenant-service python -B -W ignore test_rules_security.py"""
import asyncio
import os
import sys
import uuid

import httpx
from sqlmodel import select

import database
import security_support as ss
from security_support import check, expect, fails, world
from shared.models.core import Customer, RuleEvaluationLog, RuleSet

BASE = "http://localhost:8001"
AUTHORS = {"underwriter_a", "admin_a", "superadmin"}
ADMINS = {"admin_a", "superadmin"}


async def main_() -> int:
    w = await world()
    A, B = str(w["a"]), str(w["b"])
    tag = uuid.uuid4().hex[:6]
    all_callers = set(w["callers"])
    members = {m for m in all_callers if m.endswith("_a") or m == "superadmin"}          # every role of tenant A, and the Super Admin
    none_of = lambda allowed: all_callers - allowed
    async with database._session_factory() as s:
        code = (await s.exec(select(RuleSet.rule_code).limit(1))).first()
        b_customer = (await s.exec(select(Customer).where(Customer.tenant_id == w["b"]))).first()
    async with httpx.AsyncClient(base_url=BASE, timeout=30) as c:
        R = "/tenants/{tenant_id}/rules"
        # ── refusals, route by route ──
        reads = [("GET", "/categories", None), ("GET", "/sets", None), ("GET", "/sets/{rule_set_id}", None), ("POST", "/evaluate", {"rule_set_code": code or "X", "context": {}}),
                 ("POST", "/evaluate-scope", {"subcategory_code": "x", "context": {}})]
        for m, p, body in reads:
            await expect(c, w, m, R + p, body, callers=none_of(members), label=f"{m} {p}: no login / garbage / expired token / another tenant's user are refused")
        await expect(c, w, "GET", R + "/logs", callers=none_of(AUTHORS), label="GET /logs: only an Underwriter, Admin or Super Admin (the log holds CNICs and full inputs); every other caller is refused")
        authoring = [("POST", "/sets", {"rule_code": "x", "name": "x", "subcategory_id": str(uuid.uuid4())}), ("POST", "/sets/{rule_set_id}/versions", None),
                     ("POST", "/versions/{version_id}/rules", {"name": "x", "impact_type": "DECLINE"}), ("PUT", "/versions/{version_id}/rules/{rule_id}", {"name": "y"})]
        for m, p, body in authoring:
            await expect(c, w, m, R + p, body, callers=none_of(AUTHORS), label=f"{m} {p}: authoring is for an Underwriter, Admin or Super Admin only")
        admin_only = [("POST", "/categories", {"code": "x", "name": "x"}), ("POST", "/categories/{category_id}/subcategories", {"code": "x", "name": "x"}),
                      ("POST", "/subcategories/{subcategory_id}/eligibility-profiles", {"channel_code": "x"}), ("DELETE", "/categories/{category_id}", None), ("DELETE", "/subcategories/{subcategory_id}", None),
                      ("DELETE", "/sets/{rule_set_id}", None), ("PATCH", "/versions/{version_id}/status", {"status": "ACTIVE"}), ("DELETE", "/rules/{rule_id}", None)]
        for m, p, body in admin_only:
            await expect(c, w, m, R + p, body, callers=none_of(ADMINS), label=f"{m} {p}: Admin or Super Admin only (an Underwriter, Agent, Viewer... are refused)")
        # ── early-check: members and the internal service, nobody else ──
        secret = os.environ.get("INTERNAL_API_SECRET", "")
        ec = f"/tenants/{A}/rules/early-check"
        body = {"occupation": "Teacher", "age": 30}
        bad = await expect(c, w, "POST", R + "/early-check", body, allow={m: ({200, 403} if "underwriter_a" in m and m != "underwriter_a" else 200) for m in members}, label="early-check: members of the tenant get an answer (the medical and financial specialists are confined by the existing responsibility guard); no login, garbage, expired and another tenant's user are refused")
        r_srv = await c.post(ec, json=body, headers={"X-Internal-Secret": secret})
        r_wrong = await c.post(ec, json=body, headers={"X-Internal-Secret": "wrong"})
        r_none = await c.post(ec, json=body)
        r_mix = await c.post(ec, json=body, headers={"Authorization": "Bearer not.a.token", "X-Internal-Secret": secret})
        check("early-check: the platform's own service (shared secret, no user) gets the answer, a wrong secret is 401, no credentials is 401, and a bad token is not rescued by a good secret",
              r_srv.status_code == 200 and "decision" in r_srv.json() and r_wrong.status_code == 401 and r_none.status_code == 401 and r_mix.status_code == 401, [r_srv.status_code, r_wrong.status_code, r_none.status_code, r_mix.status_code])

        # ── the permitted roles can do the work ──
        H = w["callers"]
        cat = await c.post(f"/tenants/{A}/rules/categories", json={"code": f"T9{tag}", "name": "Security test"}, headers={**H["admin_a"], "Idempotency-Key": f"cat-{tag}"})
        check("Admin creates a category (201) and the audited operation still answers with the id", cat.status_code == 201 and "id" in cat.json(), cat.text[:200])
        cat_id = cat.json().get("id")
        sub = await c.post(f"/tenants/{A}/rules/categories/{cat_id}/subcategories", json={"code": f"S9{tag}", "name": "Sub"}, headers={**H["admin_a"], "Idempotency-Key": f"sub-{tag}"})
        sub_id = sub.json().get("id")
        check("Admin creates a subcategory (201)", sub.status_code == 201 and bool(sub_id), sub.text[:200])
        rs = await c.post(f"/tenants/{A}/rules/sets", json={"rule_code": f"RS-T9-{tag}", "name": "Security test set", "scope_type": "GLOBAL", "subcategory_id": sub_id}, headers={**H["underwriter_a"], "Idempotency-Key": f"rs-{tag}"})
        rs_id = rs.json().get("id")
        check("an Underwriter creates a rule set (201): authoring is open to the underwriting role", rs.status_code == 201 and bool(rs_id), rs.text[:300])
        ver = await c.post(f"/tenants/{A}/rules/sets/{rs_id}/versions", headers={**H["underwriter_a"], "Idempotency-Key": f"v-{tag}"})
        ver_id = ver.json().get("id")
        check("an Underwriter creates a draft version (201)", ver.status_code == 201 and bool(ver_id), ver.text[:200])
        rule = await c.post(f"/tenants/{A}/rules/versions/{ver_id}/rules", json={"name": "Decline test", "impact_type": "DECLINE", "criteria": []}, headers={**H["underwriter_a"], "Idempotency-Key": f"r-{tag}"})
        rule_id = rule.json().get("id")
        check("an Underwriter adds a rule to the draft (201)", rule.status_code == 201 and bool(rule_id), rule.text[:200])
        upd = await c.put(f"/tenants/{A}/rules/versions/{ver_id}/rules/{rule_id}", json={"name": "Decline test 2"}, headers={**H["underwriter_a"], "Idempotency-Key": f"u-{tag}"})
        check("an Underwriter edits a rule in a DRAFT version (200)", upd.status_code == 200, upd.text[:200])
        dep_uw = await c.patch(f"/tenants/{A}/rules/versions/{ver_id}/status", json={"status": "ACTIVE", "approved_by": "Mallory"}, headers=H["underwriter_a"])
        check("an Underwriter cannot DEPLOY a version (403): deploying changes how every later case is underwritten", dep_uw.status_code == 403, dep_uw.status_code)
        sets_b = await c.get(f"/tenants/{B}/rules/sets/{rs_id}", headers=H["admin_b"])
        check("another tenant's Admin cannot read this tenant's rule set through his own path (404)", sets_b.status_code == 404, sets_b.status_code)
        # cross-tenant by id: B's path, A's ids
        deploy_b = await c.patch(f"/tenants/{B}/rules/versions/{ver_id}/status", json={"status": "ACTIVE"}, headers=H["admin_b"])
        add_b = await c.post(f"/tenants/{B}/rules/versions/{ver_id}/rules", json={"name": "Injected", "impact_type": "DECLINE"}, headers=H["admin_b"])
        upd_b = await c.put(f"/tenants/{B}/rules/versions/{ver_id}/rules/{rule_id}", json={"name": "Hijacked"}, headers=H["admin_b"])
        ver_b = await c.post(f"/tenants/{B}/rules/sets/{rs_id}/versions", headers=H["admin_b"])
        check("IDOR: Admin of tenant B, on B's own path, cannot deploy, add to, edit or version tenant A's rule set by its ids (all 404)", {deploy_b.status_code, add_b.status_code, upd_b.status_code, ver_b.status_code} == {404}, [deploy_b.status_code, add_b.status_code, upd_b.status_code, ver_b.status_code])
        await c.delete(f"/tenants/{B}/rules/rules/{rule_id}", headers=H["admin_b"])
        await c.delete(f"/tenants/{B}/rules/sets/{rs_id}", headers=H["admin_b"])
        detail = await c.get(f"/tenants/{A}/rules/sets/{rs_id}", headers=H["admin_a"])
        names = [r.get("name") for v in detail.json().get("versions", []) for r in v.get("rules", [])] if detail.status_code == 200 else None
        check("... and a delete through B's path changed nothing: A's set and rule are still there, unedited", detail.status_code == 200 and names == ["Decline test 2"], names)
        dep = await c.patch(f"/tenants/{A}/rules/versions/{ver_id}/status", json={"status": "ACTIVE", "approved_by": "Mallory"}, headers=H["admin_a"])
        check("Admin deploys the version (200) and the approver recorded is the verified Admin, not the name in the body", dep.status_code == 200, dep.text[:200])
        detail = await c.get(f"/tenants/{A}/rules/sets/{rs_id}", headers=H["admin_a"])
        approvers = {v.get("approved_by") for v in detail.json().get("versions", [])}
        admin_name = w["users"][(w["a"], "Admin")].full_name
        check("approved_by is the verified Admin's name and never 'Mallory'", "Mallory" not in approvers and admin_name in approvers, approvers)
        # evaluation: actor and IDOR
        ev = await c.post(f"/tenants/{A}/rules/evaluate", json={"rule_set_code": f"RS-T9-{tag}", "context": {}, "actor": "Mallory"}, headers=H["agent_a"])
        check("an Agent may evaluate a rule set (200)", ev.status_code == 200, ev.text[:200])
        if b_customer:
            await c.post(f"/tenants/{A}/rules/evaluate", json={"rule_set_code": f"RS-T9-{tag}", "customer_id": str(b_customer.id), "context": {}}, headers=H["admin_a"])
        async with database._session_factory() as s:
            logs = (await s.exec(select(RuleEvaluationLog).where(RuleEvaluationLog.rule_set_code == f"RS-T9-{tag}"))).all()
            actors = {l.actor for l in logs}
            leaked = [l for l in logs if b_customer and l.customer_cnic == b_customer.cnic]
        agent_name = w["users"][(w["a"], "Agent")].full_name
        check("the audit log names the verified caller as the actor, not 'Mallory' from the body", "Mallory" not in actors and agent_name in actors, actors)
        check("IDOR: evaluating with another tenant's customer_id does not pull that customer's CNIC into the evaluation or its log", b_customer is not None and not leaked, [l.customer_cnic for l in leaked])
        # logs scope
        async with database._session_factory() as s:
            s.add(RuleEvaluationLog(tenant_id=None, rule_set_code=f"NULLTENANT-{tag}", version_number="1.0.0", actor="platform", input_context_snapshot={}, matched_rule_codes=[], final_impacts={}, reasons=[], execution_duration_ms=1))
            await s.commit()
        lg_uw = (await c.get(f"/tenants/{A}/rules/logs?limit=200", headers=H["underwriter_a"])).json()
        lg_sa = (await c.get(f"/tenants/{A}/rules/logs?limit=200", headers=H["superadmin"])).json()
        check("the evaluation log: a tenant sees only its own rows; the rows that belong to no tenant are for the Super Admin only", all(l["rule_set_code"] != f"NULLTENANT-{tag}" for l in lg_uw) and any(l["rule_set_code"] == f"NULLTENANT-{tag}" for l in lg_sa) and len(lg_uw) > 0, [len(lg_uw), len(lg_sa)])
        # cleanup through the API (Admin): delete rule, set, subcategory, category
        d1 = await c.delete(f"/tenants/{A}/rules/rules/{rule_id}", headers=H["underwriter_a"])
        d2 = await c.delete(f"/tenants/{A}/rules/rules/{rule_id}", headers=H["admin_a"])
        d3 = await c.delete(f"/tenants/{A}/rules/sets/{rs_id}", headers=H["admin_a"])
        d4 = await c.delete(f"/tenants/{A}/rules/subcategories/{sub_id}", headers=H["admin_a"])
        d5 = await c.delete(f"/tenants/{A}/rules/categories/{cat_id}", headers=H["admin_a"])
        check("an Underwriter cannot delete a rule (403); the Admin can delete the rule, the set, the subcategory and the category (204)", d1.status_code == 403 and [d2.status_code, d3.status_code, d4.status_code, d5.status_code] == [204] * 4, [d1.status_code, d2.status_code, d3.status_code, d4.status_code, d5.status_code])
        gone = await c.get(f"/tenants/{A}/rules/sets/{rs_id}", headers=H["admin_a"])
        check("the deleted rule set is gone (404)", gone.status_code == 404, gone.status_code)
    print("FAILED" if fails() else "all passed")
    return 1 if fails() else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main_()))
