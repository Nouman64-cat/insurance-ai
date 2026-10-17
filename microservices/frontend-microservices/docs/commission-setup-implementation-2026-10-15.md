# Commission setup implementation

## Plan and delivered changes

1. Reuse the existing receipt-backed commission engine and preserve explicit contractual rates, independent approval and idempotent posting.
2. Add an authenticated tenant-scoped setup API showing a customer's agent/source, individual policies, suggested producer, assigned agreements, configuration blockers and frozen assignments.
3. Replace copying policy UUIDs with a searchable policy picker. Suggest the customer's producer without silently saving it. Validate splits and prevent the draft creator approving their own contract in the UI; backend approval enforcement remains authoritative.
4. Connect receipt exceptions directly to the matching policy's setup and reconciliation input.
5. Add a read-only customer commission setup chatbot tool with UUID/name lookup, ambiguity handling and no CNIC requirement. Customer navigation without a CNIC uses `customer_id` instead of putting a UUID into `cnic`.
6. Verify real browser behavior and database-backed first-premium/renewal scenarios.

No schema migration or seed is required. Deploy the updated frontend, tenant-service and chat-agent code. Existing agreements, assignments and receipts remain in their current tables. No real contractual rates were added or approved: an administrator must enter the actual agreed rates, a different administrator approves, and the producer split must be saved on the policy.

## Validation

- 19 commission integration tests passed in a separate disposable PostgreSQL database, including the full individual assigned-agent / first-premium / renewal / duplicate-reconciliation scenario and new setup access/search/UUID checks.
- 768 chat-agent tests passed, including the new tool's registration, admin-only scope, no-CNIC lookup and ambiguous-name handling.
- Live browser: a receipt exception selected its policy and suggested Sana Abbasi without saving an allocation. Save was disabled while no approved agreement existed.
- Live chatbot: “Check commission setup for QA Commission Individual 20261015” correctly returned Sana Abbasi as agent/source, zero effective approved agreements, and no policy yet. It no longer requested a CNIC for that lookup.
- Frontend `tsc --noEmit` still fails on errors in unrelated acquisition-source, e-application, proposal, sidebar, dashboard/map and satellite files. No diagnostics point to files changed for commission setup. Full frontend type-check success is not claimed.
- Local test output: `tmp/commission-implementation/`.

Actual commission payments, tax and settlement remain outside this implementation. The earlier text-chat authentication audit is a separate unresolved security concern; this change does not claim to remediate it. Existing conversations paused on an old invalid-CNIC tool call may need a fresh chat; the successful live regression used a new chat.
