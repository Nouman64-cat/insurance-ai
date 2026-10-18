---
id: commission-earnings
title: Commission Earnings
---

# Automatic commission and disbursement approval

The portal at `/commissions` now reads persisted **accrued gross earnings** from the tenant service. The mobile commission screen and copilot ledger, summary, payee and statement tools use that same backend. A policy's status never implies a commission payment.

## Setup

1. Create the real producer in **Acquisition Sources**. Set its **Start Date**: that day of the month is the producer's payout day. Link its login account for the agent to see its own earnings.
2. Review the **Agent Commission** rule set (`RS-COM-002`) in the **Rule Engine**. Each rule tests premium context (`category`, `insurance_type`, `product_name`, `policy_year`, `premium_type`, `installment_number`, `is_first_premium`, `premium_amount`, `channel_code`, `source_type`, `source_code`, `coverage_amount`, `term_years`) and sets:
   - **Commission rate (%)**: paid on the first premium after policy issuance.
   - **Recurring commission**: whether later premiums also earn.
   - **Recurring rate (%)**: the rate for later premiums (the commission rate when empty).
   - **Recurring for (policy years)**: the last policy year that earns (no limit when empty).
   - **Withholding tax (%)**: recorded in the earning snapshot only; no net amount is calculated.

   The startup seed is one rule, `COM-AGT-IND`: 35% of the first premium on individual policies, not recurring. This is the SECP first-year maximum. Change it to the insurer's real rates, and deploy a new version, before go-live. Rules are versioned and edited like every other rule set; the first matching rule (by priority) with a commission rate decides.
3. Assign the customer's agent. Each receipt then automatically allocates 100% to that agent through their active AGENT acquisition source. No per-customer approval or manual split is required.
4. Collect a premium through the existing payment flow. The receipt, accrual and earnings are written in the **same database transaction**. A missing rule set, active version or matching rule creates an exception without inventing an amount. A later premium that the matched rule does not pay (not recurring, or past its recurring years) is recorded as `NOT_APPLICABLE`, not as an exception.
5. After correcting configuration, reconcile the receipt by ID. Previously posted receipts return their existing accrual without creating new earnings. `NOT_APPLICABLE` receipts are evaluated again, so enabling recurring and reconciling posts them.

The first premium is every receipt against the policy's earliest installment, including first-premium top-ups. Rules are evaluated with the version active at posting time. The rule set, rule code and version are frozen on the earning.

An explicit policy split overrides automatic allocation. Shared production can still be configured on individual policies, with positive splits totaling 100%. Each producer is evaluated against the rules with its own channel. The first successful posting persists and freezes the producer allocation; subsequent agent changes do not rewrite that policy's allocation or historical earnings.

Commission agreements and plan rate links (`/agreements`, `/plan-rules`) no longer set rates. They remain readable for history; earnings posted before this change keep their agreement snapshot.

The setup checklist previews automatic allocation without saving it. Receipt dates determine actual eligibility, including reconciliation of older receipts. **Review setup** on an exception selects that receipt and policy. Draft creators see **Awaiting another administrator** instead of an enabled self-approval action.

In Automation Chat, ask “Check commission setup for [customer name]”. The read-only tool identifies the agent/source, previews policy readiness and links to setup. Quick leads without a CNIC are supported using customer UUIDs; names shared by several customers require selection. Setup details require Admin/SuperAdmin. Ledger reads support accrued and disbursement states; summary includes externally confirmed paid gross. Batch creation, approval and payment recording are performed in the portal.

The first-premium path creates a stable receipt when cover binds, including a credited initial premium payment. A top-up requests and accepts only the unpaid balance. Later full or partial collections each retain their own receipt. Historical Active policies are not automatically backfilled from their status; only existing receipt records can be reconciled.

## Calculation contract

- Basis `RECEIPT_BASE`: the recorded receipt base, **including any policy fees/duty already included in that base**, excluding late surcharge. This is the only supported basis in this milestone.
- Formula per producer: `receipt base × rule rate / 100 × split / 100`. The rate is the rule's commission rate on the first premium, otherwise its recurring rate.
- Policy year comes from installment due date relative to inception, not collection date.
- No fallback rate is used.
- **Disburse date**: the producer's start day-of-month in the month after the receipt date, clamped to month end (a 31st start pays on 28/29 Feb). The source's creation date is used when no start date is set.
- Decimal arithmetic and largest-remainder allocation conserve the rounded aggregate to the paisa. Stable producer IDs break ties.
- Entries preserve the rate, split, basis amount, gross amount, producer identity, rule code and version, recurring flag, disburse date, receipt identity and policy/customer labels.
- Reports use posting dates. The receipt's original date remains in the snapshot.

## Storage and transactions

The new `commission_agreements`, `commission_assignments`, `commission_accruals` and `commission_earnings` tables register through `shared/models/core.py`. Existing startup `create_all` creates missing tables; legacy commission rows and browser-generated balances are not migrated.

Automatic plan configuration and disbursement add `commission_plan_rules`, `commission_disbursements`, `commission_disbursement_items` and `commission_disbursement_events`. These are additive tables; no existing-column migration or financial seed is needed. Deploy the updated services with `docker compose up -d --build`; tenant-service startup creates the missing tables. Do not invent live contract rates when installing.

The service locks the policy before checking/posting an accrual. Uniqueness constraints enforce one accrual per tenant/receipt and one allocation per accrual/producer. Assignment changes take the same lock. Calculation/configuration exceptions have no partial earnings. Receipt and commission writes roll back together on database failure.

This milestone uses local transactions instead of an asynchronous Kafka consumer. An outbox is needed before moving commission posting across service boundaries. Existing best-effort policy event publication is not used as the commission source of truth.

## Disbursement

1. Select eligible unreserved earnings and create a draft batch (up to 100 entries).
2. The creator submits it. A different administrator approves it.
3. After external payment completes, record its reference and explicitly confirm completion. This marks the batch PAID; the application does not transfer money.
4. Rejection/cancellation releases earnings for a new batch while retaining the original items and audit events. Paid batches cannot be reopened or rejected.

Eligibility is rechecked at submission, approval and payment recording. An earning is held until its disburse date. Policies must be Active/GracePeriod, past a known free-look end date, and have an active producer and positive earning. Cancelled, surrendered, lapsed or otherwise exited policies are held. Policy locks serialize the final check with policy transitions. One earning can be reserved/paid in only one active batch. A tenant payment reference cannot be reused in another batch. Replaying an identical payment confirmation returns the existing batch without another event.

Every transition records its authenticated actor and time. Amounts come from immutable earnings, never from client-supplied totals. Paid totals remain historical if a policy is cancelled later; automatic clawback and tax/net calculation require a subsequent implementation.

## API

All routes are under `/tenants/{tenant_id}/commissions` and require a valid bearer session. Cross-tenant access is denied except for SuperAdmin. Inactive accounts are denied. Agent reads are scoped to acquisition sources linked to their user ID.

| Method | Route | Access |
|---|---|---|
| GET | `/payees` | Tenant staff; agents see their own sources |
| GET | `/setup` | Admin / SuperAdmin; optional customer_id or search, up to 50 individual policies |
| GET / POST | `/agreements` | Admin / SuperAdmin; legacy, does not set rates |
| POST | `/agreements/{id}/approve` | A different Admin / SuperAdmin; legacy |
| GET / PUT | `/policies/{id}/assignments` | Admin / SuperAdmin |
| GET | `/earnings` | Staff; agents see their own earnings |
| GET | `/summary` | Same scope as earnings |
| GET | `/exceptions` | Admin / SuperAdmin |
| POST | `/reconcile` | Admin / SuperAdmin; explicit receipt IDs |
| GET / POST | `/plan-rules` | Admin / SuperAdmin; legacy, does not set rates |
| GET | `/disbursements/eligible` | Admin / SuperAdmin; unreserved entries with hold reasons |
| GET / POST | `/disbursements` | Admin / SuperAdmin; list/create batches |
| GET | `/disbursements/{id}` | Admin / SuperAdmin; entries and audit events |
| POST | `/disbursements/{id}/submit` | Draft creator |
| POST | `/disbursements/{id}/approve` | A different Admin / SuperAdmin |
| POST | `/disbursements/{id}/reject` | Admin; different from creator after submission |
| POST | `/disbursements/{id}/record-payment` | Admin / SuperAdmin; approved batch, reference and explicit confirmation |

Earnings accept `offset`, `limit`, `source_id`, `date_from`, `date_to`, and `disbursement_status` (ACCRUED, DRAFT, SUBMITTED, APPROVED, PAID). Summary uses source/date filters on original earning posting dates. Reconciliation accepts up to 100 receipt IDs. Exceptions support pagination; the portal shows the first 100. Candidates and batches are paginated.

## Deliberate limits

- Only individual policies are allocated. Group and family policies produce exceptions to avoid multiplying one collected premium across certificates.
- No net balance, tax computation, bank transfer, automatic clawback or incentive settlement is implemented. Payment recording is gross and manual.
- Automatic matching is for the customer's assigned individual agent; other distribution channels and shared splits require explicit policy configuration.
- Collection still uses the application's existing manual/mock payment gateway. A persisted receipt is not independent confirmation from a live bank integration.
- The old commission dashboard is at `/commissions/preview`. Legacy commission subpages are marked illustrative. Their browser state is not imported into the ledger. Copilot prototype mutations are disabled.

## Verification

The integration suite creates and drops its own schema in a **dedicated test database**. It requires `COMMISSION_TEST_DATABASE_URL`; it never defaults to the application's database.

Example with Docker:

```bash
docker run --detach --rm --name insurance-commission-tests \
  --network insurance-ai_insurance-net \
  -e POSTGRES_PASSWORD=commission-test-only -e POSTGRES_DB=commission_test postgres:16

docker compose exec -T \
  -e COMMISSION_TEST_DATABASE_URL=postgresql+asyncpg://postgres:commission-test-only@insurance-commission-tests:5432/commission_test \
  tenant-service python test_commission_earnings.py

docker stop insurance-commission-tests
```

Coverage includes concurrent duplicate receipt/batch delivery, automatic first-premium posting, frozen producer/rate snapshots, renewal selection, rounding, version expiry, short payments/top-ups, missing configuration, rejection/retry, cancellation holds, duplicate external references, maker–checker approval, rollback, and tenant/agent isolation.
