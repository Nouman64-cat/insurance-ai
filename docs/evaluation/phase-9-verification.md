# Phase 9: final security, integration and production-readiness verification (running report)

Only results from commands that were actually run are recorded. A stage is not complete because test files exist. Last updated 2026-10-25 (core security remediation, router 1 of 17).

**Release status: NO-GO.** 135 core routes still answer an anonymous caller. The Evaluation Center is clean.

| Stage | State |
|---|---|
| 1 Security and tenant isolation | **in progress**: Evaluation Center verified; core-application remediation under way (Rules router done; 135 routes still open) |
| 2 Dataset and storage integrity | not started |
| 3 Harness and DeepEval | not started |
| 4 Multi-LLM benchmarking | not started |
| 5 Cost and budget | not started |
| 6 Studio UI | not started |
| 7 Performance and reliability | not started |
| 8 Production readiness | not started |
| 9 Final report and verdict | not started |

## Stage 1: security and tenant isolation

### How it was tested
A sweep called every route of the tenant service (574 route-methods) on the isolated evaluation stack with dummy ids, first with no login, then as a logged-in user who is not a Super Admin. `test_eval_security.py` (new, permanent) keeps the Evaluation Center part as a regression test. The working gateway (port 8010) was probed read-only, and with random non-existent ids for the two DELETE checks, so nothing real could change.

### Verified (passes)
- All 91 `/eval`, `/platform` and `/tokens` routes refuse a caller with no login (401) and a non-Super-Admin (403).
- The 8 internal endpoints refuse no secret, a wrong secret, an ordinary token and a Super Admin token.
- Cross-tenant retest: an Admin of tenant A is refused tenant B's policies, claims, customers and users (403); no login gets 401; a Super Admin gets 200; A's own lists work. The earlier policies/claims leak is fixed.
- No Evaluation Center listing contains a provider key or the internal secret (8 listings checked with key-shaped patterns).

### Findings
| # | Severity | Finding | State |
|---|---|---|---|
| S1 | **High** | `GET /internal/llm-config` (returns **decrypted provider API keys**) and `/internal/agent-config` checked the shared secret only when one was configured, so a deployment without it was open. | **Fixed**: `services/internal_auth.py` fails closed (503 when unset, 401 on a wrong secret, constant-time compare). Tested; the working services still get 200 with their secret. |
| S2 | **Critical** | **154 routes in 17 core-application routers have no authentication** and answer an anonymous caller, through the real gateway too. Confirmed on the working gateway: anonymous `GET /tenants/{id}/rules/sets` returns the live underwriting rule sets; anonymous `DELETE` on `rules/rules`, `rules/sets`, `rules/categories`, `rules/subcategories` returns 204 (probed with random ids only); `GET /roles` lists the roles; policy sub-resources (premiums, free-look, endorsements, renewals, reinstatement, exit, onboarding), case management, medical exam, e-application, ACR and others answer without a login. By router: post_issuance 36, rules 19, pre_issuance 19, cases 15, reinstatement 13, renewals 12, medical_exam 8, agent_confidential_report 5, claim_workflow 5, policy_exit 5, tenants 3, e_application 3, insurance_history 3, branches 2, artifacts 2, and one each in agent, underwriting_tracks, demo, main. | **Open: needs a decision** (see below). Not part of the Evaluation Center, which is clean. |
| S3 | Medium | `/docs`, `/redoc` and `/openapi.json` answer anonymous callers on the tenant service (the full route list). | Open |
| S4 | Medium | `POST /tenants/{id}/demo/reset-funnel` answers an anonymous caller with a 500 (and a 500 to a non-privileged user); `GET /tenants/{id}/panel-clinics` and `/reinsurers` return 500 for a plain user. | Open |
| S5 | Info | The tenant service (8011) and the gateway (8010) are published on all host interfaces. | Open |

### S2: why it is not fixed yet
Most of these routes are called by the front end with the user's token, but some are likely called by other services (chat agent, customer portal) or by public pages without one; adding a login requirement to 154 routes blindly could break those flows, and there is no full-application regression suite to prove it did not. The fix needs a decision on the approach (see the options put to the owner), then the same sweep re-run as the proof.


## Core application remediation (staged, risk-based)

### Step 1: containment and exposure (measured, isolated stack)
Of the 154 routes that answered an anonymous caller, **131 are reachable anonymously through the API gateway** (its catch-all proxies add no login check) and the other 23 are open on the tenant service's own published port (8011). The gateway verifies nothing itself: the tenant service is the only place a token is checked, so the fix belongs there. Gateway-level containment was NOT added: a presence-only token check on the catch-alls could break public pages (marketing site, customer portal, walk-in leads) before their callers are mapped; each router is closed at the service as its callers are confirmed. Host binding of ports 8010/8011 is still open (S5).

### Step 2: caller analysis and the route matrix
`evals/security/route_matrix.py` (with `dump_routes.py` and `anon_probe.py`) builds `docs/evaluation/security/route-matrix.csv`: for all 607 route-methods, the current authentication, the status an anonymous caller gets directly and through the gateway, and the callers found by searching every front end (7 apps, mobile), service and test for the route's path. It is a search, so a caller list is evidence to check, not proof that nobody else calls the route. Per-route required permission and tenant scope are decided router by router (below) and enforced by tests; the CSV is regenerated after each router.

### Step 3: shared security dependencies (`services/route_security.py`, `services/internal_auth.py`)
Built on the existing `verify_tenant_member`: `tenant_member` (valid token of an active user of the tenant in the path; a Super Admin anywhere), `require_roles(...)` (plus a role check), `acting_member` (returns the verified user, so audit entries name who really acted), `member_or_service` (a tenant member, or a platform service presenting the shared internal secret; a bad token is never rescued by a good secret). The internal secret check is constant-time and fails closed (503 when unset). No bypass was added.

### Router 1: Rules (19 routes): DONE
| Callers found | Decision |
|---|---|
| Admin front end (rule engine page), automation-chat, the chat agent's rule tools (they forward the user's token), the commissions page and a mobile app (`/rules/evaluate`), and **the API gateway's quote worker (`/rules/early-check`, no user)** | Router-wide: login + the user's own tenant. Reads and evaluations: any role of the tenant. Rule evaluation log (holds CNICs and full inputs): Underwriter, Admin, Super Admin, and only the tenant's own rows (rows of no tenant: Super Admin only). Authoring (create set, version, rule, edit a draft rule): Underwriter, Admin. Deploy/archive a version, delete a rule or set, create/delete the category tree: Admin only. These mirror the chat agent's own permission matrix. `early-check`: a tenant member, or the gateway with the shared internal secret. |

Additional defects found and fixed in this router:
- **IDOR (customer):** `ContextDerivationService.derive` loaded a customer by id without checking its tenant, so a logged-in user could pull another tenant's customer (CNIC, policy-derived context) into an evaluation. A customer of another tenant is now treated as not found.
- **IDOR (rule sets):** the version and rule endpoints ignored the tenant: an Admin of tenant B could deploy, edit, add to or delete a rule set owned by tenant A by its ids. A rule set of another tenant is now treated as not found (404; a delete is a no-op).
- **Spoofable audit fields:** `actor` (evaluations) and `approved_by` (deploying a version) were taken from the request body. Both are now the verified caller.
- **Pre-existing bug:** deleting a rule set that had versions failed with HTTP 500 (foreign-key order). Fixed with explicit flushes.
- **Gateway:** the quote worker now sends the internal secret on `early-check`, and logs an error (not a warning) when the check is refused, because it fails open and a refusal would silently disable the early-knockout rule. The running gateway container was recreated so it has the secret.

Evidence (all run):
| Check | Result |
|---|---|
| `test_rules_security.py` on the isolated stack (no login, garbage token, expired token, other tenant's Admin and Agent, every role of the tenant, per route; positive flows; IDORs; audit actor/approver; log scope; early-check for members and the service) | **38 passed, 0 failed** |
| `envctl.py test` (19 environment tests incl. cross-tenant policies/claims, roles, token ledger) | **19 passed, 0 failed** |
| Golden single-turn suite 1.0.6 (44 cases, deterministic) | **27 passed, 0 failed, 17 skipped** (chat cases are not run in this mode) |
| Working stack, anonymous, random ids only: GET sets/categories/logs, DELETE rule/set, POST early-check, directly (8011) and through the gateway (8010) | **all 401** (were 200/204) |
| Gateway `_early_knockout` against the working tenant service: a 17-year-old / a 40-year-old | declined with the entry-age reason / no reasons (proves the secret works end to end) |
| Anonymous sweep of all routes | **154 -> 135 open**; the Rules router has 0 |

Not covered yet (stated, not claimed): the front end, the chat agent's rule tools and the mobile app were not run against the changed router (they send the user's token, which the new check accepts; I did not exercise them in a browser or a live chat). The Underwriter and Admin roles are assumed correct for authoring/deploy because they mirror the agent's matrix; the business owner should confirm.

### Decisions the owner needs to make
1. **Platform-wide rule catalogue.** Categories, subcategories, eligibility profiles and versions have no tenant, and all four real rule sets are global (no tenant). Any tenant's Admin can therefore still deploy or delete a *global* rule set, which changes underwriting for every tenant. Today there is one tenant, so this is a latent multi-tenant risk. Option: only a Super Admin may change global rules (a tenant's Admin keeps its own tenant-owned sets). That would remove today's Admin ability to edit the seeded rules, so it needs a decision.
2. **Deleting a rule from an ACTIVE version** is allowed (Admin): there is no DRAFT-only guard as there is for adding or editing. Possibly intended; worth confirming.

### Remaining routers (135 routes), in the order planned
pre_issuance 19, post_issuance 36, cases 15, medical_exam 8, then reinstatement 13, renewals 12, claim_workflow 5, policy_exit 5, agent_confidential_report 5, tenants 3, e_application 3, insurance_history 3, branches 2, artifacts 2, underwriting_tracks 1, agent 1, demo 1, main 1. Each: callers, authorization, caller updates, positive and negative tests, sweep re-run.

### Deployment notes for what is already changed (read before pushing or deploying)
1. **`INTERNAL_API_SECRET` must be set on the API gateway AND the tenant service, with the same value.** The tenant service now refuses `/rules/early-check` without a user token or that secret, and `/internal/llm-config`, `/internal/agent-config` fail closed (503) when no secret is configured. If the gateway lacks the secret, its quote worker's early-knockout call is refused and (by its fail-open design) **the early-knockout rule is silently skipped**: a business-rule regression with only an error log as evidence. Recreate, do not just restart, the gateway container after `.env` changes.
2. Anyone calling `/tenants/{id}/rules/*` must now send a user token of that tenant. Known callers (admin front end, chat agent tools, commissions page, mobile app) do, but they were not exercised after the change.
3. Release status remains **NO-GO**: 135 core routes in 16 routers still answer an anonymous caller (see the route matrix).
