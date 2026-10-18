# Implementation verification — 18 October 2026

## Automated results

| Suite | Result | What it establishes |
|---|---|---|
| Chat-agent regression suite, including new skills | 3,892 passed; 1 warning | Registry integrity, 2,664 role/capability scenarios, role boundaries, discovery/binding, checkpointed graph execution, recovery, isolation, existing journeys, voice and SSE contracts |
| Owning tenant-service proposal/initial-premium suite | 7 passed | Real PostgreSQL proposal/payment/case ordering, received-premium activation, split/loading accounting, and cross-tenant rejection using synthetic fixtures |
| Authenticated live API smoke suite | 18 passed | Discovery for 10 configured roles, actual initial-premium reads, cross-tenant rejection, denied operations, actual synthetic tenant and global-role creation; all fixtures removed |
| Owning tenant-service underwriting tracks | 23 passed; 2 failed | Most HTTP/DB track isolation and lifecycle checks pass; the two existing fixture/requirements failures below remain |
| Static inventory | 724 routes; 10 services; 11 web/mobile surfaces | Implementation source inventory; not a claim of live execution for every route |
| Diff whitespace check | Passed | `git diff --check` |

The final chat count includes adapter method/path and credential-redaction tests,
underwriting adapter reachability, missing-role discovery isolation, Finance
workspace restrictions, and actionable claims handoffs. The JUnit artifact
contains individual cases. `test_gemini.py` is deliberately excluded because it
unconditionally calls a real provider at import; this implementation has not
measured live-provider natural-language completion rates or latency.

The live smoke harness found no configured `CustomerService` role in this local
database. It skipped that role rather than creating or elevating one. CustomerService
has positive/negative automated permission and natural-language selection tests.
`CustomBroker` exercises the existing unknown-role read-only fallback; the system
does not assign Agent permissions based on the word “broker.”

## Existing owning-service failures

`tenant-service/test_underwriting_tracks.py` fails in unchanged backend code:

1. `test_each_specialist_works_only_their_own_track`: the fixture expects clearing
   a financial review to return 200; the backend returns 422 because the financial
   questionnaire, insurance history, income evidence and application documents
   are incomplete.
2. `test_final_underwriting_compiles_both_specialist_reviews`: the fixture expects
   a medical review to be CLEARED; it remains PENDING when prerequisites are not
   completed.

The suite runs in a disposable PostgreSQL database and removes it. No tenant-service
source or evidence/approval gates were weakened to make these tests pass.

## Execution evidence and limitations

The nine new adapters have typed schemas and isolated transport/authorization
coverage. Live execution is additionally established for initial-premium reads,
tenant creation and global role creation. Model-configuration writes and payment
proof acceptance have not been performed against real platform/financial state.
The owning initial-premium suite uses explicitly synthetic financial fixtures;
none is represented as real premium activity.

The role/skill/tool matrix describes registered reachability. It does not label
all 222 capabilities complete or all 724 routes AI-accessible. Unmapped route
contracts are explicitly marked in the route inventory. Tenant deletion, global
role deletion and API-key editing remain manual console operations. Existing
backend idempotency checks remain authoritative; universal exactly-once mutation
execution across service commits and graph-checkpoint crashes is not guaranteed.

No frontend/mobile contracts changed. Existing automated streaming, voice,
quick-action, upload, correction and resume tests passed. A browser/mobile UI
walkthrough and an authenticated real-provider demo across all configured roles
remain deployment validation tasks.

## SuperAdmin UI control follow-up

- Database-backed agent settings: **5 tests passed** in a disposable PostgreSQL database.
- Chat runtime/cache/inventory tests: included in the **3,892** passing chat regression tests.
- Changed AI Agents page, Sidebar and their dependency graph: **0 TypeScript errors**.
- Full-project TypeScript check: blocked by 11 existing diagnostics in the e-application, dashboard map and satellite SSO files; none are in the changed UI files.
- Browser verification: signed in with a disposable synthetic SuperAdmin, saved the setting off, reloaded to verify persistence, confirmed the gateway and live runtime both reported disabled, then restored enabled. Verified subagent lists, tool search, Finance role filtering and skill search. The temporary user was removed.
- Runtime inventory displayed **2 agents, 8 subagents, 224 tools and 23 skills**, using the database's actual configured role names.
- Settings take effect on new chat requests within the five-second refresh interval without restarting services. The old environment toggle is ignored and removed from the example/Compose configuration.


## Claim financial underwriting tools — 2026-10-18

- Added `get_claim_financial_review` and `record_claim_financial_check` for ClaimsManager, plus the `claim-financial-underwriting` skill in the claims specialist.
- Claims Managers can record explicit financial claim findings and rationale. The record and audit identify the actual manager; the assigned financial reviewer and claim decision remain separate.
- Full chat suite: **3,929 passed**, excluding `test_gemini.py` (unconditional real provider invocation during collection).
- Disposable PostgreSQL/API integration: **3 passed**, covering Claims Manager findings, specialist findings, ownership, tenant/role limits, held/closed work, concern blockers, unchanged decisions on identical retries and audit persistence.
- Live deployed inventory: **226 tools and 24 skills**; both new tools expose ClaimsManager as their authorized role. Static route inventory regenerated: **727 routes**, 10 services and 11 client applications.
- No production claim findings, approvals or payments were written during validation.


## Final claim-underwriting resolution authority — 2026-10-18

- `resolve_claim_underwriting` and the resolve-underwriting API now allow ClaimsManager only. Medical, Financial and general Underwriters, ClaimsAdjusters, Admin, SuperAdmin and Finance are denied.
- Specialist UI retains its own review actions and a read-only combined summary. The final resolution control is on the Claims Manager’s claims workbench and policy-scoped claims decision step.
- Readiness requires both submitted reviews on the latest open referral, with hold and tenant checks. Earlier referrals cannot supply a missing review. A decision rationale is mandatory and the history identifies the actual Claims Manager.
- Verification: full chat suite **3,929 passed**; subsequent final-action role-chip regression **10 targeted tests passed**. Frontend **28 tests passed**; changed portal UI dependency graph and underwriting workbench **0 TypeScript diagnostics**. Disposable PostgreSQL/API integration **3 passed**, including final-resolution role denial, current-referral readiness, hold checks, history attribution and successful manager continuation.
- Validation did not record a final decision on a production claim.
