# Automatic commission and disbursement — implementation

## Delivered workflow

1. An administrator creates a rate agreement with explicit first-year/renewal percentages and effective dates. Another administrator approves it.
2. Link that approved agreement to an individual catalog plan once in **Automatic commission by plan**.
3. Assign the customer's agent through the normal customer workflow. The agent needs an active AGENT acquisition source linked to their login.
4. A premium receipt automatically resolves the exact plan and applicable rate, allocates 100% to that agent, and persists the allocation and gross earning atomically. An explicit policy split overrides this automatic path.
5. Finance creates a draft disbursement batch from eligible earnings. Its creator submits it; a different administrator approves it.
6. Once an external payment is complete, record its reference and confirm completion. This marks the batch PAID; the application does not initiate a bank transfer.

## Financial invariants

- No receipt means no accrued commission. Missing/ambiguous agents, catalog matches or rates create durable exceptions without guessed amounts or partial assignments.
- Latest approved plan rate starting on/before the receipt date wins. Equal start dates are rejected; expired latest rates never fall back to older versions.
- First successful posting freezes producer/agreement allocation on the policy. Later customer-agent or master-plan-rate changes do not rewrite it. Renewal uses that agreement's renewal rate and the installment due date's policy year.
- Receipt duplicate delivery posts once, including concurrent attempts.
- One earning can be reserved/paid in only one active batch. Concurrent batch creation serializes on earnings and is protected by a uniqueness constraint.
- Batch totals come from immutable persisted earnings. Clients cannot choose payout totals.
- Submission, approval and payment recording recheck in-force status, active producer, positive earnings and expiry of a known free-look period. Cancellation/exit before payment creates a hold.
- Policy/source locks serialize final eligibility checks with relevant state changes.
- Rejection/cancellation releases reservations but retains original batch items and actor/time/reason audit events.
- Paid batches cannot be rejected/reopened. A tenant payment reference cannot be reused in a different batch. Repeating the same completed-payment confirmation is idempotent and creates no duplicate audit event.
- Tenant access, active accounts and maker–checker approval are enforced by authenticated backend dependencies. Agent earnings/paid totals retain their source scope.

## Implementation

- Additive models: `CommissionPlanRule`, `CommissionDisbursement`, `CommissionDisbursementItem`, `CommissionDisbursementEvent` in `shared/models/commission.py`, registered by `shared/models/core.py`.
- Receipt integration: `services/tenant-service/services/commission_engine.py`.
- Plan mapping, setup preview, scoped ledger states and paid totals: `services/tenant-service/routers/commissions.py`.
- Batch state machine and reservation/audit handling: `services/tenant-service/routers/commission_disbursements.py`.
- Portal: `frontend/components/commissions/PlanCommissionRules.tsx`, `CommissionDisbursements.tsx`, commission service types and earnings page.
- Chat: current customer setup/summary/ledger explanations describe automatic allocation and manual-payment states; paid-state filtering is supported. Batch creation/approval/payment recording directs users to the portal instead of pretending a legacy chat prototype performed an action.

The setup preview loads shared configuration in batches rather than re-querying plans, sources and agreements per policy.

## Validation

- **31 PostgreSQL integration tests passed** in a disposable database, including first-premium payment-handler integration, renewal, concurrent receipts/batches, rejected batches, missing configuration, expired rates, plan binding permissions, cancellation holds and duplicate external references with rollback.
- **775 chat-agent pytest tests passed** in the final run.
- Signed-in browser: plan catalog and approved agreement selector render, automatic-allocation activation remains disabled without approved configuration, and disbursement eligibility/batch controls render with no observed console errors.
- Frontend TypeScript reported the same unrelated acquisition-source, e-application, proposal, sidebar, map/dashboard and satellite diagnostics; no commission-file diagnostics. Full-project type-check success is not claimed.
- Evidence is under `/tmp/insurance-commission-auto-audit/`, including integration outputs, chat tests, type-check diagnostics, and plan/disbursement screenshots.

## Deployment and boundaries

Run `docker compose up -d --build` with the normal project environment. Tenant-service startup creates the four missing additive tables; no existing-column migration or seed is required. Existing financial rows are preserved. Existing receipt exceptions can be reconciled explicitly after plan rates are configured; policy status alone is not backfilled into earnings.

No live agreements were created/approved, no live financial batch was paid, and no live money was transferred during implementation. Real contractual rates remain a required one-time input.

This delivers gross disbursement approval and manual external-payment recording. Bank integration, tax/net computation, automated post-payment clawback and group/family commission allocation are not included. Paid history remains immutable if a policy exits later; that situation needs contractual clawback review. The earlier general text-chat authentication audit remains separate from these authenticated commission endpoints.
