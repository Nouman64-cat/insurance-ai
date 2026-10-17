#!/usr/bin/env python3
"""End-to-end journey of the individual customer portal, over HTTP, exactly as a browser drives it (cookie jar, CSRF header).

  1. (existing staff workflow) assign a policyholder ID and provision portal access for an issued policy;
  2. open the portal, sign in with those generated credentials, change the temporary password;
  3. dashboard shows the policy; policy detail, premium schedule, a document download;
  4. view claims, submit an eligible self-claim, and see it in the EXISTING claims management;
  5. sign out and prove the session is dead; plus the isolation / separation checks.

Needs the stack running (docker compose up -d customer-management customer-portal) and a dev tenant with an issued,
in-force, individual policy whose customer has NO portal account yet (or pass --reuse to sign in with --password).

    python3 scripts/e2e_customer_portal.py --tenant-code PAG34 --policy-id <uuid> [--portal http://localhost:3009] [--tenant-api http://localhost:8011]

It creates real (dev) records: a policyholder ID, a portal account, one claim. Run it against a development database only.
"""
import argparse
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request
from datetime import date

PASS, FAIL = "\033[32mPASS\033[0m", "\033[31mFAIL\033[0m"
failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    failures += 0 if ok else 1
    print(f"  {PASS if ok else FAIL}  {name}{('  — ' + detail) if detail and not ok else ''}")


class Browser:
    def __init__(self, base: str):
        self.base, self.jar = base.rstrip("/"), http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect())

    def cookie(self, name: str):
        return next((c.value for c in self.jar if c.name == name), None)

    def req(self, method, path, body=None, headers=None, raw=False):
        h = {"x-requested-with": "customer-portal", **(headers or {})}
        data = None
        if body is not None:
            data, h["content-type"] = json.dumps(body).encode(), "application/json"
        r = urllib.request.Request(self.base + path, method=method, data=data, headers=h)
        try:
            resp = self.opener.open(r, timeout=60)
            status, payload, rh = resp.status, resp.read(), resp.headers
        except urllib.error.HTTPError as e:
            status, payload, rh = e.code, e.read(), e.headers
        if raw:
            return status, payload, rh
        try:
            return status, json.loads(payload or b"null"), rh
        except ValueError:
            return status, payload.decode("utf-8", "replace"), rh


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def staff(api: str, method: str, path: str, body=None):
    r = urllib.request.Request(api + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tenant-code", required=True)
    ap.add_argument("--policy-id", required=True)
    ap.add_argument("--portal", default="http://localhost:3009")
    ap.add_argument("--tenant-api", default="http://localhost:8011")
    ap.add_argument("--password", default="E2e#Portal2026x", help="the new password to set at first login")
    a = ap.parse_args()

    print("1. Staff workflow: policyholder ID and portal credentials (existing post-issuance endpoints)")
    # tenant id from the policy (the tenants list needs a staff login; the onboarding endpoint reports it instead)
    import subprocess
    tid = subprocess.run(["docker", "exec", "-w", "/app", "insurance-tenant-service", "python", "-c",
                          f"import asyncio;from sqlalchemy import text;from database import engine\nasync def m():\n  async with engine.connect() as c: print((await c.execute(text(\"select id from tenants where code='{a.tenant_code}'\"))).scalar())\nasyncio.run(m())"],
                         capture_output=True, text=True).stdout.strip().splitlines()[-1]
    s, ph = staff(a.tenant_api, "POST", f"/tenants/{tid}/policies/{a.policy_id}/onboarding/policyholder-id")
    check("policyholder ID assigned", s == 200 and ph.get("policyholder_id"), str(ph))
    s, creds = staff(a.tenant_api, "POST", f"/tenants/{tid}/policies/{a.policy_id}/onboarding/portal")
    check("portal credentials generated", s == 200 and bool(creds.get("temp_password")), "already provisioned? use a policy whose customer has no account" if s == 200 else str(creds))
    if not creds.get("temp_password"):
        return 1
    user, temp = creds["username"], creds["temp_password"]

    print("2. Customer signs in with the generated credentials")
    b = Browser(a.portal)
    s, body, _ = b.req("GET", "/dashboard", raw=True)
    check("protected page redirects an anonymous visitor to /login", s in (302, 307), f"HTTP {s}")
    s, body, _ = b.req("POST", "/api/portal/auth/login", {"username": user, "password": "wrong-password-1"})
    check("wrong password is refused with a generic message", s == 401 and body["error"]["code"] == "INVALID_CREDENTIALS")
    s, body, _ = b.req("POST", "/api/portal/auth/login", {"username": user, "password": temp})
    check("login succeeds with the temporary password", s == 200 and body.get("must_change_password") is True, str(body))
    check("tokens are httpOnly cookies, not in the response body", "access_token" not in json.dumps(body) and b.cookie("cp_at") is not None)
    s, body, _ = b.req("GET", "/api/portal/v1/policies")
    check("data is refused until the password is changed", s == 403 and body["error"]["code"] == "PASSWORD_CHANGE_REQUIRED", f"{s} {body}")
    s, body, _ = b.req("GET", "/dashboard", raw=True)
    check("pages route to /first-login", s in (302, 307))
    s, body, _ = b.req("POST", "/api/portal/auth/first-change", {"current_password": temp, "new_password": a.password})
    check("first-login password change succeeds", s == 200 and body["account"]["state"] == "ACTIVE", str(body))
    s, body, _ = b.req("POST", "/api/portal/auth/login", {"username": user, "password": temp})
    check("the temporary password no longer works", s == 401)
    s, body, _ = b.req("POST", "/api/portal/auth/login", {"username": user, "password": a.password})
    check("the new password works", s == 200 and body["must_change_password"] is False)

    print("3. Dashboard, policy, premiums, document")
    s, dash, _ = b.req("GET", "/api/portal/v1/dashboard")
    check("dashboard loads with the customer's own data", s == 200 and dash["customer"]["policyholder_id"] == ph["policyholder_id"], str(dash)[:200])
    ids = [p["id"] for p in dash["policies"]]
    check("the issued policy appears", a.policy_id in ids, f"{ids}")
    s, pol, _ = b.req("GET", f"/api/portal/v1/policies/{a.policy_id}")
    check("policy detail opens", s == 200 and pol["policy_number"], str(pol)[:120])
    check("premium schedule present", len(pol["premium_schedule"]) > 0)
    s, pay, _ = b.req("GET", "/api/portal/v1/payments")
    check("payments overview (simulated gateway flagged)", s == 200 and pay["simulated_payments"] is True)
    docs = [d for d in b.req("GET", "/api/portal/v1/documents")[1]["items"] if d["available"]]
    if docs:
        s, content, hdr = b.req("GET", "/api/portal/v1/documents/download?handle=" + urllib.parse.quote(docs[0]["id"]), raw=True)
        check("a document downloads as a PDF", s == 200 and content[:4] == b"%PDF", f"{s}")
    else:
        check("a document is available to download", False, "no available document")

    print("4. Claims")
    s, before, _ = b.req("GET", "/api/portal/v1/claims")
    check("claims list loads", s == 200)
    s, opts, _ = b.req("GET", f"/api/portal/v1/policies/{a.policy_id}/claims/options")
    cats = [c["key"] for c in opts.get("categories", []) if c["available"]]
    if cats:
        s, claim, _ = b.req("POST", f"/api/portal/v1/policies/{a.policy_id}/claims", {"category": cats[0], "event_date": date.today().isoformat(), "description": "E2E test claim — emergency admission", "claimed_amount": 42000, "event_details": {"hospital": "E2E Hospital"}},
                            headers={"idempotency-key": "e2e-" + user + "-claim-1"})
        check("self-claim submitted", s == 201 and claim.get("claim_number"), str(claim)[:200])
        s, again, _ = b.req("POST", f"/api/portal/v1/policies/{a.policy_id}/claims", {"category": cats[0], "event_date": date.today().isoformat(), "description": "E2E test claim — emergency admission", "claimed_amount": 42000, "event_details": {"hospital": "E2E Hospital"}},
                            headers={"idempotency-key": "e2e-" + user + "-claim-1"})
        check("replaying the same submission returns the same claim", s == 201 and again.get("id") == claim.get("id"))
        s, reg = staff(a.tenant_api, "GET", f"/tenants/{tid}/policies/{a.policy_id}/claims-management")
        check("the claim is in the existing Claims Management system", s == 200 and any(c["claim_number"] == claim["claim_number"] for c in reg["claims"]))
    else:
        check("a claim can be raised (plan has a self-claimable benefit)", False, "this plan has no hospitalization/disability benefit — pick another policy")
    s, death, _ = b.req("POST", f"/api/portal/v1/policies/{a.policy_id}/claims", {"category": "Death", "event_date": date.today().isoformat(), "description": "not allowed online", "claimed_amount": 1000}, headers={"idempotency-key": "e2e-" + user + "-death"})
    check("death claims are refused (claimant verification is out of scope)", s == 422 and death["error"]["code"] == "CLAIM_TYPE_NOT_SUPPORTED_ONLINE", f"{s} {death}")

    print("5. Separation, then sign out")
    s, body, _ = b.req("GET", "/api/portal/v1/policies/00000000-0000-0000-0000-000000000000")
    check("an unknown / foreign policy id is a plain 404", s == 404)
    s, body, _ = b.req("GET", "/api/portal/internal/v1/accounts")
    check("internal endpoints are not reachable through the portal", s in (404, 405))
    token = b.cookie("cp_at")
    s, body, _ = b.req("POST", "/api/portal/auth/logout")
    check("logout succeeds and clears the cookies", s == 200 and b.cookie("cp_at") in (None, ""))
    s, body, _ = b.req("GET", "/api/portal/v1/dashboard")
    check("the cleared session cannot reach data", s == 401)
    s, body, _ = b.req("GET", "/api/portal/v1/dashboard", headers={"cookie": f"cp_at={token}"})
    check("the old token is dead server-side", s == 401, f"{s}")
    s, body, _ = Browser(a.portal).req("GET", "/dashboard", raw=True)
    check("protected pages redirect again", s in (302, 307))

    print(f"\n{'ALL CHECKS PASSED' if not failures else str(failures) + ' CHECK(S) FAILED'}")
    return 1 if failures else 0


if __name__ == "__main__":
    import urllib.parse  # noqa: F401  (used above)
    sys.exit(main())
