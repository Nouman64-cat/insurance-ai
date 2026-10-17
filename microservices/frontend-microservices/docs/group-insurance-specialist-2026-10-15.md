# Group insurance specialist — 15 October 2026

Developed specialists: commissions, claims, underwriting, individual policy servicing, and group insurance. The main coordinator makes six planners total. Group insurance uses the existing checkpoint, caller identity, executor, permission gate and group journey nodes; there is no additional router-model call.

## Scope

The explicit 37-tool scope covers employer/scheme lookup, benefit classes, census validation, group quotes, issuance, premium recording, membership endorsements, renewal, group claims, member workflow status and takaful fund reporting. Actual bindings intersect the allowlist with role/platform permissions. Household family and individual insurance remain outside this specialist; group family takaful stays within it.

Group renewals, endorsements and claims remain with the group specialist instead of being split across individual specialists. Explicit individual-domain switches and commission requests hand off appropriately. Mixed group/individual or group/commission requests use the main planner. Follow-up employer names, numbers and short answers retain group context.

The prompt distinguishes previews, acceptance, issuance, payments and settlement, preserves above-FCL and census gates, prohibits fabricated financial references and unrequested demo data, and treats backend permissions as authoritative. Explicit read-only requests block mutations, including journey/member-workflow resumption. Existing backend authorization and financial prerequisites are unchanged.

Enabled by default. Set `GROUP_SPECIALIST_ENABLED=false` and recreate chat-agent to use the main planner for group requests. Other rollout flags remain independent. Streaming handoff events and usage logs identify the group specialist separately.

## Verification

- Chat-agent suite: 994 passed, one existing multipart deprecation warning. The live-provider `test_gemini.py` collection module is excluded.
- New coverage includes group versus individual routing, mixed requests, rollout flag, exact role-filtered bindings, forbidden calls, read-only financial/journey restrictions, shared executor identity, interrupt/resume, six planners in one checkpoint, usage attribution and streamed handoffs.
- Live authenticated read-only employer lookup used the group specialist with 37 tools and reported no organizations in the current tenant. A follow-up commission summary switched to the commission specialist with 20 tools; both were confirmed in planner logs.
- No employers, schemes, policies, claims, payment records or emails were created by live checks. Actual group issuance, external payouts and financial settlement were not exercised.
