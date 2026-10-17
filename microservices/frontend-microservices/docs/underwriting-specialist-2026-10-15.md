# Underwriting specialist — 15 October 2026

The chatbot now has four planners: main, commissions, claims, and individual underwriting. The deterministic coordinator adds no model call. The underwriting planner uses the existing conversation checkpoint, tool executor, caller identity, permissions, and journey nodes.

## Scope

The explicit 46-tool allowlist covers applicant lookup, applications, proposals, catalog selection, the five pre-underwriting gates, document evidence and medical review, risk assessment, decisions, pre-issuance checks, issuance, and first-premium confirmation. Actual tools are intersected with role and platform permissions. Instructions naming individual actions are included only when that tool is available.

Customer creation, group/family/bulk underwriting, rules administration, servicing, and mixed domain requests remain with the main planner. Claim referrals to underwriting remain claims actions. Short answers and plan selections retain the active underwriting context. Explicit topic changes hand off to the appropriate planner. Existing autonomous journeys and their interrupts remain unchanged.

The prompt preserves sequential manual gates and distinguishes recommendations, approvals, issuance, active cover, and payment evidence. Existing backend approval and financial prerequisites remain authoritative. Scope checks block hallucinated tools. Explicit read-only requests block writes, including journey continuation (which can perform writes despite being exempt from repeat-consent prompts).

## Rollout and verification

Enabled by default. Set `UNDERWRITING_SPECIALIST_ENABLED=false` and recreate chat-agent to route through the main planner. Claims and commission switches remain independent. Usage attribution and handoff SSE events include underwriting.

Validation: 886 tests passed, one existing multipart deprecation warning. Excludes `test_gemini.py`, which calls a live provider at collection. New coverage includes domain boundaries, role-filtered bindings, read-only enforcement, original executor identity, interrupt/resume, four planners sharing a checkpoint, metering, and streamed handoffs.

Live authenticated checks fetched current application stages through the underwriting planner (46 tools) and switched to the claims dashboard (35 tools), confirmed by planner logs. A customer name containing 'Commission' conservatively used the main planner and returned the correct lead stage. Live checks were read-only; no approval, policy issuance, premium payment, financial disbursement, or email was exercised. These checks do not establish a performance benchmark or fix unrelated authentication/thread ownership issues.
