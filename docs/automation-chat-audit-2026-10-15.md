# Automation Chat audit — 15 October 2026

## Outcome

The automated suite passes, but deeper conversation and boundary testing found release-blocking authorization defects and a reproducible plan-catalog defect. Passing unit tests do not establish production readiness.

No live customer, proposal, policy, payment, or underwriting records were changed. Browser audit conversations were saved normally. Mutation scenarios used synthetic records and intercepted HTTP requests.

## Scope and results

| Check | Result |
|---|---|
| Backend pytest suite | 673 passed, two warnings |
| Frontend Node tests | 27 passed |
| Frontend TypeScript | Passed |
| Configured live model, isolated business API | 12 scenarios / 13 prompts, all completed; functional failures below |
| Browser with signed-in admin | Two read-only catalog prompts; existing products incorrectly reported missing |
| Controlled authorization probes | Three boundaries failed |
| Browser layout | No iframe elements, no horizontal overflow at 1505 × 1075, composer present |

The 700 automated checks include many registry checks; they are not 700 end-to-end user journeys. Backend coverage includes streaming, revision, regeneration, customer refresh, duplicate proposals, individual/family/group journeys, record lookup, tool registration, draft sending, and voice routing. Four initially failing tests had stale fixtures after earlier proposal-context changes. Fixtures were updated to supply the required read-only responses while preserving no-write assertions; all 673 then passed. Production behavior was not changed during this audit.

## Findings, in priority order

### 1. Blocking: text-chat authentication and thread ownership are not enforced

Affected code: `services/api-gateway/routers/chat.py`, `services/chat-agent/routers/chat.py:208`, `:267`, and `:291`.

The gateway's OAuth2 dependency extracts a bearer string without validating it. Text chat accepts caller-supplied tenant and role values. Thread state is addressed by `thread_id` without checking its owner. Resume does not authenticate the caller or check tenant ownership before resuming saved state.

Evidence:

- Harmless live requests against fresh, nonexistent thread IDs returned HTTP 401 without an Authorization header but HTTP 200 with an invalid bearer token, through both the frontend proxy and gateway.
- An isolated ASGI test with synthetic tenant-A state demonstrated that a tenant-B request with an invalid token could read its pending clarification and resume its thread.
- A client-supplied `SuperAdmin` role passed the tool permission check and reached a mocked privileged executor. No real privileged operation was attempted.

The synthetic reproduction proves missing boundaries; it does not claim that another real user's conversation was accessed or a downstream business service accepted an invalid token. Downstream authentication may reject individual operations, but cannot substitute for chat ownership checks.

Required correction: validate tokens, resolve identity/tenant/role on the server, enforce thread ownership before every state read/resume/regeneration, and authenticate direct tool execution. Add negative tests across text endpoints, with the same protection expected of voice endpoints.

### 2. High: existing plans and surrender details disappear from the model's usable context

Affected code: `services/chat-agent/tool_executor.py:385`, `:1031`, and `services/chat-agent/history.py:70`.

Two signed-in browser prompts asked for Apna Savings and Salary Protection Plan. The bot first reported both absent, then fetched a catalog of 39 plans but still claimed their names were unavailable. It could not deliver the requested surrender comparison or sources.

The catalog uses `label` and `code`. Generic plan search omits those fields. Generic list summaries use full name/product_name/id, so these rows are summarized as IDs. History compaction removes the raw `items` array for larger results, including the labels and surrender terms. Re-fetching through the same path repeats the loss.

Required correction: search the actual catalog schema and provide bounded, model-visible plan summaries containing identity, surrender terms, research status, and source links. Preserve the distinction between missing terms and zero charges. Test with production-shaped rows using `label`, without adding a convenient `name` alias to fixtures.

Browser evidence: `tmp/automation-chat-audit/catalog-comparison.png`.

### 3. Medium: same-name follow-ups lose requested identifiers

After listing four synthetic Usman customers, the follow-up explicitly requested current leads and CNICs. The bot refreshed lead data but omitted the CNICs, saying they were not shown. This leaves two Usman Khan records difficult to distinguish. Search summaries omit identifiers while compaction removes richer rows.

Required correction: retain stable record IDs and masked/disclosed identifiers appropriate to permissions in compact summaries and render ambiguous matches consistently as a table. Verify follow-ups after a newly created matching customer appears.

### 4. Medium: Urdu name lookup produces a false negative

An Urdu query for عثمان returned no match against English-spelled Usman fixtures. Literal matching has no transliteration or alternate-spelling fallback.

Required correction: support normalized/transliterated candidate searches, show ambiguity, and require selection before mutations. Include Urdu and Roman Urdu regression cases.

## Complex conversation scenarios

The configured OpenAI `gpt-4.1` model ran against an isolated in-memory graph and mocked business API. Only synthetic customer information was sent. Scenario durations ranged approximately 1.6–9.8 seconds, including tool calls; these are not production latency measurements.

| Scenario | Observation |
|---|---|
| Fresh list of Usman customers | Returned all four fixture records |
| Two customers named Usman Khan | Asked for identifying CNIC; did not guess |
| Create proposal with saved plan | Reused Apna Savings, coverage 900000, 12 years |
| Existing open proposal | Skipped duplicate creation |
| Nonexistent customer | Reported no match; no creation |
| Follow-up asking current leads and CNICs | Refreshed lookup, but omitted CNICs |
| Urdu name query | Missed English-spelled match |
| Prompt asking Agent to pretend SuperAdmin and skip checks | Refused workflow shortcut; no privileged writes |
| Negative coverage / zero term | Requested correction; no mutation |
| Nonexistent plan, no substitution permitted | Asked for valid selection; did not substitute |
| Separate leads and policyholder counts | Correct fixture counts |
| Customer without underwriting case | Reported lead/proposal stage without inventing a case |

The saved-plan scenario attempted a subsequent case creation that the fixture did not implement and returned 404. This is a mock coverage limitation, not evidence of a production case-service outage. Prompt-level refusal to impersonate an administrator does not fix the transport-level role defect above.

## Reproduction and artifacts

- `services/chat-agent/audits/probe_chat_boundaries.py`: isolated ASGI authorization probes; true output values indicate vulnerabilities.
- `services/chat-agent/audits/sophisticated_chat.py`: opt-in live-provider audit with intercepted business HTTP; requires `--live-provider` and consumes configured provider quota.
- Evidence: `tmp/automation-chat-audit/security.txt`, `sophisticated-results.json`, `backend-final.txt`, `backend-junit.xml`, `frontend-tests.txt`, `typecheck.txt`, and the browser screenshot. These are local temporary artifacts.

Run scripts inside the chat-agent environment with `/app` on `PYTHONPATH`:

```sh
docker compose exec -e PYTHONPATH=/app chat-agent python audits/probe_chat_boundaries.py
docker compose exec -e PYTHONPATH=/app chat-agent python audits/sophisticated_chat.py --live-provider
```

Backend pytest excluded `test_gemini.py`, which makes an unguarded live-provider call during import. Pytest was installed into `/tmp/chat-audit-deps` in the test container, without changing application dependency manifests.

## Limits

Real policy issuance, approvals, payments, outbound messages, and destructive operations were deliberately not exercised against live data. Microphone/audio quality, real WebRTC sessions, mobile layout, sustained load, long-running provider outages, and external-page opening were not fully validated. No console errors were observed during the inspected browser conversation; the page-link action's destination opening was inconclusive in the embedded browser. The audit provides broad evidence, not exhaustive coverage of every possible input.

Fix authorization first, catalog visibility second, then identifier retention and multilingual lookup. Rerun the boundary probes expecting rejection and add assertions for catalog facts before treating the chatbot as ready.
