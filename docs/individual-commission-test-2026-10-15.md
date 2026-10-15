# Individual customer commission test — 15 October 2026

## Verdict

The receipt-backed commission engine passed the tested individual-policy workflow. The current Crescent tenant is not configured to accrue commission, and Automation Chat could not complete the lookup for a quick lead without a CNIC. This is not a successful full live chatbot-to-commission journey.

## Customer created in the running application

Created through the Leads UI while signed in as Mahnoor Hashmi:

| Field | Verified value |
|---|---|
| Customer | QA Commission Individual 20261015 |
| Lead ID displayed | IND-2610-015 |
| Customer UUID | 10cc14ca-a548-4cd0-bb81-e60c73b65ce2 |
| Tenant | Crescent Life Assurance Ltd. |
| Assigned agent | Sana Abbasi |
| Acquisition source | Sana Abbasi, AGT-9267 |
| Source login matches assigned agent | Yes |
| Stage | New lead |
| CNIC / phone | Not supplied; supported quick-lead intake |

The lead remains available for inspection. Database verification confirmed both agent ownership and acquisition-source linkage. No existing customer was changed and no external notification was sent as part of the test actions.

## Current tenant configuration

The commission page and a read-only database query agree:

- Zero commission agreements.
- Zero posted earnings.
- Six existing receipt exceptions, all with `No producer agreement assigned to this policy`.

Customer `assigned_agent_id` and acquisition-source linkage establish ownership. They do not constitute an approved contractual rate or a policy-level commission allocation. A different administrator must approve a draft agreement; the policy then needs a producer assignment whose splits total 100%. A premium receipt triggers accrual. Reconciliation can retry an exception after configuration is corrected.

No contractual rate was invented or approved in the live tenant, and no live premium collection or payout was executed.

## Full database-backed use case

Ran the existing 16 integration tests, then added `test_individual_agent_assignment_to_first_premium_and_renewal` in `services/tenant-service/test_commission_earnings.py`. The expanded suite passes **17/17** against a separate temporary PostgreSQL container. The test database/schema was removed afterward.

The added scenario creates an individual customer, assigns an agent login and acquisition source, and verifies these steps with the real commission engine, authenticated commission API, payment handler, collection handler, and persisted ledger:

| Step | Expected | Actual |
|---|---|---|
| Assigned agent, no policy producer agreement | Exception, no earnings | Passed |
| Draft agreement: first year 12.5%, renewal 5% | Stored draft | Passed |
| Creator tries to approve own draft | HTTP 403 | Passed |
| Separate test administrator approves | HTTP 200 | Passed |
| Assign producer under approved agreement | 100% split accepted | Passed |
| First premium PKR 12,000 | Active policy; PKR 1,500 gross accrual | Passed |
| Year-two premium PKR 12,000 | PKR 600 gross accrual | Passed |
| Reconcile first receipt twice | Still two earnings total | Passed |
| Assigned agent views ledger | Two entries, PKR 2,100 accrued gross | Passed |
| Different agent views ledger | Zero entries | Passed |

The 12.5% and 5% rates are synthetic test inputs, not Adamjee contractual rates. Document generation was mocked to avoid file/external-service side effects; business calculations, database persistence, commission authorization and payment transitions were exercised. The first-payment and collection functions were called directly, so this does not validate their entire browser/network path. No bank integration or actual settlement was tested. The implementation currently supports accrued gross, not tax, net payable or payouts.

Existing tests also passed concurrent duplicate receipt processing, rounding, partial collections, short first-payment rejection, credited initial-premium top-ups, expired configuration, immutable posted assignments, rollback, reconciliation, and tenant isolation.

## Chatbot failure reproduced

In a new chat titled **QA Commission Individual Record Audit**, asked the bot to find the new customer, identify its agent/source, inspect agreements and earnings, and make no changes.

It responded that `10cc14ca-a548-4cd0-bb81-e60c73b65ce2` was not a valid CNIC. The page link also put that UUID into a `cnic` query parameter. A follow-up explicitly explained that this was a quick lead without a CNIC and requested list-based lookup; the bot repeated the same error.

This blocks commission investigation through chat for an otherwise valid quick lead. Customer UUID and CNIC must remain distinct throughout lookup, navigation and conversation state. The user should be able to read commission configuration without supplying a CNIC for a customer whose intake intentionally omitted it.

## Evidence and follow-through

- `tmp/commission-audit/live-customer.json`: database confirmation and configuration counts.
- `tmp/commission-audit/integration.txt`: original 16-test result.
- `tmp/commission-audit/integration-with-use-case.txt`: expanded 17-test result.
- Reusable scenario: `services/tenant-service/test_commission_earnings.py`.

Next implementation work is the chat UUID/CNIC handling. Live commission setup requires a real contractual agreement, independent approval, and policy producer allocation; assigning the lead to Sana alone will not generate earnings.
