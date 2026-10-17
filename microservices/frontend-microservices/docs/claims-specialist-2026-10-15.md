# Claims specialist — 15 October 2026

The chatbot now has three planners: the main assistant, commission specialist, and claims specialist. A deterministic coordinator selects the planner without an extra model call. Each uses the same conversation checkpoint and existing permission gate.

## Scope and routing

The claims specialist binds at most 35 tools, intersected with the user's role permissions. It covers claim lookup, FNOL, eligibility, documents, investigation, assessment, decisions, payees, authorization, settlement, reconciliation, closure, and referrals. Group/family claims retain the existing main workflow. Explicitly mixed claims/commission requests use the main planner. Ambiguous payment follow-ups retain the previous specialist's context.

Claim approval, payment authorization, disbursement, and reconciliation remain separate backend operations. The specialist cannot grant itself permissions or bypass backend prerequisites. Tool calls outside its role-filtered scope are blocked before execution. Explicit read-only requests also block mutating tool calls for both specialists, including for Admin.

Set `CLAIMS_SPECIALIST_ENABLED=false` in the Compose environment and recreate chat-agent to route claims through the main planner. Commission routing has its own independent flag. Usage records distinguish all three planners; planner logs record the tool count and elapsed time.

## Validation

- Chat-agent regression suite: 849 passed; one existing multipart deprecation warning. `test_gemini.py` excluded because collection makes a live provider request.
- Coverage includes routing, independent flags, role-filtered tool scopes, forbidden calls, read-only enforcement, shared execution, interrupt/resume, three-planner context switching, usage attribution, and streamed handoffs.
- Live authenticated chat: claims dashboard and blockers returned through the claims specialist with 35 tools. A follow-up commission summary switched to the commission specialist with 20 tools, confirmed in planner logs.
- Live checks were read-only. Financial writes, payout providers, and email delivery were not exercised. Existing backend approval gates remain authoritative; this change does not address previously identified authentication/thread-ownership issues.
