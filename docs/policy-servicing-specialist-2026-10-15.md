# Policy servicing specialist — 15 October 2026

The chatbot now has five planners: main, commissions, claims, underwriting, and individual policy servicing. The coordinator selects a planner without an extra model call, retaining the original checkpoint, identity, shared executor, permission gate, and backend workflows.

## Scope and boundaries

The servicing specialist has an explicit 26-tool allowlist, filtered by role and platform. It covers premium schedules and receipts, delivery, portal onboarding, endorsements, renewals, reinstatement, and free-look/surrender exits. Lookup and timeline helpers preserve exact policy identity and existing ambiguity interrupts.

Mixed requests, customer creation, and group/family contracts stay with the main planner. Claims, commissions, and underwriting can be selected on later turns. Commission renewal-rate follow-ups stay with commissions. Initial-premium activation stays with underwriting. Servicing follow-ups retain context for policy numbers, short answers and names.

The specialist prompt distinguishes previews, submitted requests, applied changes, active coverage, queued versus delivered communications, and settlement. Backend approval and financial checks remain authoritative. Scope guards reject unavailable tools, and explicit read-only requests block writes, reminder emails, delivery retries and portal provisioning. This adds a planner; it does not add payment authority or automate approvals.

Enabled by default. To roll back routing, set `SERVICING_SPECIALIST_ENABLED=false` and recreate chat-agent. The other specialist switches remain independent. Separate usage attribution and streamed handoff events identify policy servicing.

## Verification

The chat-agent regression suite passed: 942 tests, with one existing multipart deprecation warning, including new servicing tests for routing, five planners in one checkpoint, role-filtered exact bindings, forbidden tool calls, read-only enforcement, original tenant/role/token execution context, interrupt/resume, metering and streaming. The live-provider `test_gemini.py` module is excluded because it calls a provider at collection.

Live browser verification was attempted with a read-only premium-schedule lookup. Local services restarted during the attempt; a subsequent chat request returned HTTP 401 and the SSO session endpoint also returned 401. No successful live servicing response is claimed. Financial changes, policy exits, emails and account provisioning were not executed in live testing.
