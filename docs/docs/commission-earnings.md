---
id: commission-earnings
title: Commission Earnings
---

# Commission earnings — first milestone

The portal at `/commissions` now reads persisted **accrued gross earnings** from the tenant service. The mobile commission screen and copilot ledger, summary, payee and statement tools use that same backend. A policy's status never implies a commission payment.

## Set up a policy

1. Create the real producer in **Acquisition Sources**. Link its login account for the agent to see its own earnings.
2. In **Commission earnings**, create an agreement with an explicit code/version, first-year and renewal rates, and effective dates. No statutory or tax rate is seeded or selected automatically.
3. A **different administrator** approves the draft. Approved agreements have no edit/delete endpoint; create a new version for new assignments.
4. Search by customer, plan or policy number in **Commission earnings** and select the individual policy. The customer's active acquisition source (or a unique source linked to their assigned agent) is suggested. Select an approved agreement and explicitly save the producer split. Positive splits must total exactly 100%. Assignments freeze after the first successful posting.
5. Collect a premium through the existing payment flow. The receipt, accrual and earnings are written in the **same database transaction**. Missing/expired configuration creates an exception without inventing an amount.
6. After correcting configuration, reconcile the receipt by ID. Previously posted receipts return their existing accrual without creating new earnings.

The setup checklist shows missing producer configuration and whether the assigned agreement is approved and effective today. Receipt dates still determine actual eligibility, including reconciliation of older receipts. **Review setup** on an exception selects that receipt and policy, including policies outside the first search page. Draft creators see **Awaiting another administrator** instead of an enabled self-approval action.

In Automation Chat, ask “Check commission setup for [customer name]”. The read-only `get_customer_commission_setup` tool identifies the agent and acquisition source, lists individual policy readiness, and links to the customer's commission setup. Quick leads without a CNIC are supported using customer UUIDs; names shared by several customers require selection. These setup details require Admin/SuperAdmin access. Customer ownership never substitutes for a policy producer assignment.

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

The service locks the policy before checking/posting an accrual. Uniqueness constraints enforce one accrual per tenant/receipt and one allocation per accrual/producer. Assignment changes take the same lock. Calculation/configuration exceptions have no partial earnings. Receipt and commission writes roll back together on database failure.

This milestone uses local transactions instead of an asynchronous Kafka consumer. An outbox is needed before moving commission posting across service boundaries. Existing best-effort policy event publication is not used as the commission source of truth.

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

Earnings accept `offset`, `limit`, `source_id`, `date_from`, and `date_to`; summary accepts the same source/date filters. Reconciliation accepts up to 100 receipt IDs. Exceptions support pagination; the current portal shows the first 100.

## Deliberate limits

- Only individual policies are allocated. Group and family policies produce exceptions to avoid multiplying one collected premium across certificates.
- No payable/net balance, tax computation, release stages, actual payout, clawback, incentive or settlement is implemented yet.
- Agreements and assignments are explicit; automatic product/channel matching and prospective reassignment after posting are future work.
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

Coverage includes concurrent duplicate delivery, persisted snapshots, first-premium short-payment rejection and top-ups, partial/final collections, renewal selection, rounding, retryable exceptions, transaction rollback, maker–checker approval, frozen assignments, and tenant/agent isolation.
