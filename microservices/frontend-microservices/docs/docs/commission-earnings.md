---
id: commission-earnings
title: Commission Earnings
---

# Automatic commission and disbursement approval

The portal at `/commissions` now reads persisted **accrued gross earnings** from the tenant service. The mobile commission screen and copilot ledger, summary, payee and statement tools use that same backend. A policy's status never implies a commission payment.

## One-time plan setup

1. Create the real producer in **Acquisition Sources**. Link its login account for the agent to see its own earnings.
2. In **Commission earnings**, create an agreement with an explicit code/version, first-year and renewal rates, and effective dates. No statutory or tax rate is seeded or selected automatically.
3. A **different administrator** approves the draft. Approved agreements have no edit/delete endpoint; create a new version for new assignments.
4. In **Automatic commission by plan**, link the approved agreement to the catalog plan. Each receipt then automatically allocates 100% to the customer's assigned agent through their active AGENT acquisition source. There is no per-customer approval or manual split requirement.
5. Collect a premium through the existing payment flow. The receipt, accrual and earnings are written in the **same database transaction**. Missing/expired configuration creates an exception without inventing an amount.
6. After correcting configuration, reconcile the receipt by ID. Previously posted receipts return their existing accrual without creating new earnings.

The plan is resolved by an exact catalog label or code and insurance type in the same tenant. Missing or ambiguous plan/agent/source/rates create exceptions. If several approved rate versions start on different dates, the latest starting on or before the receipt date applies. Equal start dates are rejected; an expired latest version never falls back to an older rate. Plan rules and approved rates are immutable.

An explicit policy split overrides automatic allocation. Shared production can still be configured on individual policies, with positive splits totaling 100%. The first successful posting persists and freezes the producer and agreement; subsequent agent or plan-rate changes do not rewrite that policy's allocation or historical earnings. New rate versions apply to newly allocated policies. Expired contracts on existing assignments remain exceptions for contractual review.

The setup checklist previews automatic allocation without saving it. Receipt dates determine actual eligibility, including reconciliation of older receipts. **Review setup** on an exception selects that receipt and policy. Draft creators see **Awaiting another administrator** instead of an enabled self-approval action.

In Automation Chat, ask “Check commission setup for [customer name]”. The read-only tool identifies the agent/source, previews policy readiness and links to setup. Quick leads without a CNIC are supported using customer UUIDs; names shared by several customers require selection. Setup details require Admin/SuperAdmin. Ledger reads support accrued and disbursement states; summary includes externally confirmed paid gross. Batch creation, approval and payment recording are performed in the portal.

The first-premium path creates a stable receipt when cover binds, including a credited initial premium payment. A top-up requests and accepts only the unpaid balance. Later full or partial collections each retain their own receipt. Historical Active policies are not automatically backfilled from their status; only existing receipt records can be reconciled.

## Calculation contract

- Basis `RECEIPT_BASE`: the recorded receipt base, **including any policy fees/duty already included in that base**, excluding late surcharge. This is the only supported basis in this milestone; configure agreements only when this matches their terms.
- Formula per producer: `receipt base × contractual rate / 100 × split / 100`.
- Policy year comes from installment due date relative to inception, not collection date. Rates are first year versus year two onwards.
- Effective dates are tested against the receipt date. No fallback rate is used.
- Decimal arithmetic and largest-remainder allocation conserve the rounded aggregate to the paisa. Stable producer IDs break ties.
- Entries preserve the rate, split, basis amount, gross amount, producer identity, agreement version, receipt identity and policy/customer labels.
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

Eligibility is rechecked at submission, approval and payment recording. Policies must be Active/GracePeriod, past a known free-look end date, and have an active producer and positive earning. Cancelled, surrendered, lapsed or otherwise exited policies are held. Policy locks serialize the final check with policy transitions. One earning can be reserved/paid in only one active batch. A tenant payment reference cannot be reused in another batch. Replaying an identical payment confirmation returns the existing batch without another event.

Every transition records its authenticated actor and time. Amounts come from immutable earnings, never from client-supplied totals. Paid totals remain historical if a policy is cancelled later; automatic clawback and tax/net calculation require a subsequent implementation.

## API

All routes are under `/tenants/{tenant_id}/commissions` and require a valid bearer session. Cross-tenant access is denied except for SuperAdmin. Inactive accounts are denied. Agent reads are scoped to acquisition sources linked to their user ID.

| Method | Route | Access |
|---|---|---|
| GET | `/payees` | Tenant staff; agents see their own sources |
| GET | `/setup` | Admin / SuperAdmin; optional customer_id or search, up to 50 individual policies |
| GET / POST | `/agreements` | Admin / SuperAdmin |
| POST | `/agreements/{id}/approve` | A different Admin / SuperAdmin |
| GET / PUT | `/policies/{id}/assignments` | Admin / SuperAdmin |
| GET | `/earnings` | Staff; agents see their own earnings |
| GET | `/summary` | Same scope as earnings |
| GET | `/exceptions` | Admin / SuperAdmin |
| POST | `/reconcile` | Admin / SuperAdmin; explicit receipt IDs |
| GET / POST | `/plan-rules` | Admin / SuperAdmin; approved agreement linked once per plan/rate version |
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
- Automatic matching is for individual agents and exact catalog plans; other distribution channels and shared splits require explicit policy configuration.
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
