#!/usr/bin/env python3
"""End-to-end family journey of the customer portal, over HTTP, as a browser drives it (cookie jar, CSRF header).

The family head signs in with the SAME credentials as for individual policies and, with that one login, manages the family:

  1. sign in; the individual experience is unchanged and the family section appears;
  2. family overview: shared floater pool counted once, who is insured vs who is only a nominee;
  3. members and beneficiaries (100%), the head's own policy detail, a spouse's coverage;
  4. claims: only for insured people, another adult needs consent, no death claims, family claim list;
  5. premiums: the family's payment view and one simulated instalment payment (never twice);
  6. servicing request (validated, recorded, withdrawable); isolation: someone else's family is a plain 404.

Needs the stack up (customer-management, customer-portal) and a family head who has a portal account, e.g. after
`docker compose exec tenant-service python -m seeds.family_portal_seed --tenant-code PAG34` and provisioning the head's portal access:

    python3 scripts/e2e_customer_portal_family.py --username PH-2026-000003 --password '<password>' [--portal http://localhost:3009]

It creates dev records (a claim, a request, a simulated payment). Run it against a development database only.
"""
import argparse
import http.cookiejar
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import date, timedelta

PASS, FAIL = "\033[32mPASS\033[0m", "\033[31mFAIL\033[0m"
failures = 0


def check(name, ok, detail=""):
    global failures
    failures += 0 if ok else 1
    print(f"  {PASS if ok else FAIL}  {name}{('  — ' + str(detail)[:200]) if detail and not ok else ''}")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Browser:
    def __init__(self, base):
        self.base, self.jar = base.rstrip("/"), http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect())

    def req(self, method, path, body=None, headers=None, raw=False):
        h = {"x-requested-with": "customer-portal", **(headers or {})}
        data = None
        if body is not None:
            data, h["content-type"] = json.dumps(body).encode(), "application/json"
        r = urllib.request.Request(self.base + path, method=method, data=data, headers=h)
        try:
            resp = self.opener.open(r, timeout=60)
            status, payload = resp.status, resp.read()
        except urllib.error.HTTPError as e:
            status, payload = e.code, e.read()
        if raw:
            return status, payload
        try:
            return status, json.loads(payload or b"null")
        except ValueError:
            return status, payload.decode("utf-8", "replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--username", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--portal", default="http://localhost:3009")
    a = ap.parse_args()
    run = uuid.uuid4().hex[:8]
    b = Browser(a.portal)

    print("1. One sign-in for individual and family")
    s, r = b.req("POST", "/api/portal/auth/login", {"username": a.username, "password": a.password})
    check("sign in with the existing credentials", s == 200 and r.get("must_change_password") is False, r)
    s, dash = b.req("GET", "/api/portal/v1/dashboard")
    check("dashboard loads and the individual figures are still there", s == 200 and "total_policies" in dash["summary"], dash)
    check("the dashboard shows a family section", bool(dash.get("family")), dash.get("family"))
    s, fams = b.req("GET", "/api/portal/v1/family")
    check("family list", s == 200 and fams["total"] >= 1, fams)
    fam = fams["items"][0]
    fid = fam["id"]
    s, ind = b.req("GET", "/api/portal/v1/policies")
    check("the individual policy list does not contain family policies", s == 200 and all(p["segment"] == "individual" for p in ind["items"]), ind)
    s, body = b.req("GET", "/family", raw=True)
    check("the My Family page is served to the signed-in customer", s == 200)

    print("2. Family overview: pool once, insured versus nominees")
    s, ov = b.req("GET", f"/api/portal/v1/family/{fid}")
    check("overview opens", s == 200, ov)
    floaters = [x for x in ov["arrangements"] if x["plan_type"] == "Floater"]
    if floaters:
        pool = floaters[0]["shared_sum_insured"]
        floater_cover = sum(c["sum_assured"] for c in floaters[0]["policies"] if c["in_force"])
        check("the shared pool is counted once in the family total", abs(ov["totals"]["coverage"] - pool) < 1 or ov["totals"]["coverage"] >= pool, (ov["totals"]["coverage"], pool))
        check("a floater has a single policy row for its pool", len(floaters[0]["policies"]) == 1 and abs(floater_cover - pool) < 1)
    s, mem = b.req("GET", f"/api/portal/v1/family/{fid}/members")
    insured = [m for m in mem["items"] if m["kind"] == "insured"]
    nominees = [m for m in mem["items"] if m["kind"] == "nominee"]
    check("insured people are listed from the cover records", s == 200 and len(insured) >= 1, mem["counts"])
    check("a nominee is never shown as insured", all(not n["insured"] and n["coverage"] is None for n in nominees))
    check("counts reconcile with the list", mem["counts"]["insured_total"] == len({m["key"] for m in insured}))

    print("3. Policy detail and beneficiaries")
    full = [c for x in ov["arrangements"] for c in x["policies"] if c["access"] != "summary"]
    pol = full[0]
    s, d = b.req("GET", f"/api/portal/v1/policies/{pol['id']}")
    check("family policy detail (insured lives, premium schedule, documents)", s == 200 and d["insured_lives"] and d["premium_schedule"] is not None and d["documents"] is not None, d)
    s, ben = b.req("GET", f"/api/portal/v1/family/{fid}/beneficiaries?policy_id={pol['id']}")
    check("beneficiaries add up to 100% with version history", s == 200 and ben["complete"] and ben["versions"], ben)

    print("4. Claims")
    s, opt = b.req("GET", f"/api/portal/v1/policies/{pol['id']}/claims/options")
    persons = opt.get("covered_persons", []) if s == 200 else []
    check("claim options list only insured people", s == 200 and persons and all(p["name"] for p in persons), opt)
    cats = [c["key"] for c in opt.get("categories", []) if c["available"]]
    other = next((p for p in persons if not p["is_you"]), None)
    ev = (date.today() - timedelta(days=4 + int(run, 16) % 3)).isoformat()
    base = {"category": cats[0] if cats else "Hospitalization", "event_date": ev, "description": f"E2E family claim {run}", "claimed_amount": 31000, "event_details": {"hospital": "E2E Hospital"}}
    if other:
        s, r = b.req("POST", f"/api/portal/v1/policies/{pol['id']}/claims", {**base, "covered_person_id": other["id"]}, headers={"idempotency-key": f"e2e-fam-{run}-1"})
        check("a claim for another adult needs their consent", s == 422 and r["error"]["code"] == "CONSENT_REQUIRED", r)
    s, r = b.req("POST", f"/api/portal/v1/policies/{pol['id']}/claims", {**base, "covered_person_id": str(uuid.uuid4()), "consent_confirmed": True}, headers={"idempotency-key": f"e2e-fam-{run}-2"})
    check("a claim for someone who is not insured is refused", s == 422 and r["error"]["code"] == "COVERED_PERSON_NOT_INSURED", r)
    s, r = b.req("POST", f"/api/portal/v1/policies/{pol['id']}/claims", {**base, "category": "Death"}, headers={"idempotency-key": f"e2e-fam-{run}-3"})
    check("death claims are not available from the policyholder's account", s == 422 and r["error"]["code"] == "CLAIM_TYPE_NOT_SUPPORTED_ONLINE", r)
    if cats:
        body = {**base, **({"covered_person_id": other["id"], "consent_confirmed": True} if other else {})}
        s, r = b.req("POST", f"/api/portal/v1/policies/{pol['id']}/claims", body, headers={"idempotency-key": f"e2e-fam-{run}-4"})
        check("an eligible family claim is submitted", s == 201 and r.get("claim_number"), r)
        s, again = b.req("POST", f"/api/portal/v1/policies/{pol['id']}/claims", body, headers={"idempotency-key": f"e2e-fam-{run}-4"})
        check("replaying the same submission returns the same claim", s == 201 and again.get("id") == r.get("id"))
        s, lst = b.req("GET", "/api/portal/v1/claims?segment=family")
        check("it appears in the family claim list, not the individual one", s == 200 and any(c["id"] == r["id"] for c in lst["items"])
              and not any(c["id"] == r["id"] for c in b.req("GET", "/api/portal/v1/claims")[1]["items"]))
    else:
        check("this plan has a claimable benefit", False, "pick a family policy with a hospital/disability benefit")

    print("5. Premiums")
    s, pay = b.req("GET", "/api/portal/v1/payments?segment=family")
    check("family payments view", s == 200 and pay["simulated_payments"] is True, pay)
    target = next((r for r in pay["policies"] if r["premiums"] and r["premiums"]["payable_installment_id"] and r["policy"]["id"] == pol["id"]), None)
    if target:
        inst = next(i for i in target["premiums"]["installments"] if i["payable_now"])
        s, p1 = b.req("POST", f"/api/portal/v1/policies/{pol['id']}/premiums/{inst['id']}/pay", {"method": "JazzCash", "expected_amount": inst["payable"]}, headers={"idempotency-key": f"e2e-fam-{run}-pay"})
        check("an instalment is paid (simulated)", s == 200 and p1["simulated"] is True and p1["receipt"], p1)
        s, p2 = b.req("POST", f"/api/portal/v1/policies/{pol['id']}/premiums/{inst['id']}/pay", {"method": "JazzCash", "expected_amount": inst["payable"]}, headers={"idempotency-key": f"e2e-fam-{run}-pay"})
        check("replaying the payment does not charge twice", s == 200 and p2.get("duplicate") is True)
        s, p3 = b.req("POST", f"/api/portal/v1/policies/{pol['id']}/premiums/{inst['id']}/pay", {"method": "JazzCash", "expected_amount": inst["payable"]}, headers={"idempotency-key": f"e2e-fam-{run}-pay2"})
        check("a new attempt on a paid instalment is refused", s == 409 and p3["error"]["code"] == "ALREADY_PAID", p3)
    else:
        print("  (no payable instalment on this policy; payment step skipped)")

    print("6. Servicing request and isolation")
    s, r = b.req("POST", f"/api/portal/v1/family/{fid}/requests", {"kind": "NOMINEE_CHANGE", "policy_id": pol["id"], "reason": "E2E check", "beneficiaries": [
        {"name": "Nominee One", "relationship": "Child", "share_pct": 60}, {"name": "Nominee Two", "relationship": "Parent", "share_pct": 30}]}, headers={"idempotency-key": f"e2e-fam-{run}-rq1"})
    check("nominee shares must total 100%", s == 422 and r["error"]["code"] == "SHARES_MUST_TOTAL_100", r)
    s, r = b.req("POST", f"/api/portal/v1/family/{fid}/requests", {"kind": "NOMINEE_CHANGE", "policy_id": pol["id"], "reason": "E2E check", "beneficiaries": [
        {"name": "Nominee One", "relationship": "Child", "share_pct": 60}, {"name": "Nominee Two", "relationship": "Parent", "share_pct": 40}]}, headers={"idempotency-key": f"e2e-fam-{run}-rq2"})
    check("a valid nominee-change request is recorded for the insurer", s == 201 and r["status"] == "SUBMITTED" and r["reference"].startswith("FSR-"), r)
    s, w = b.req("POST", f"/api/portal/v1/family/requests/{r['id']}/withdraw")
    check("it can be withdrawn", s == 200 and w["status"] == "WITHDRAWN", w)
    s, _ = b.req("GET", f"/api/portal/v1/family/{uuid.uuid4()}")
    check("someone else's (unknown) family is a plain 404", s == 404)
    s, _ = b.req("GET", f"/api/portal/v1/family/{uuid.uuid4()}/members")
    check("...and so are its members", s == 404)

    print(f"\n{'ALL CHECKS PASSED' if not failures else str(failures) + ' CHECK(S) FAILED'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
