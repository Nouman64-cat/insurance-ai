# Capability coverage

Generated from declarations, handlers, skills and the existing permission function.
Registration and schema validation do not establish successful owning-service execution.

228 capabilities, 26 skills, 12 role scenarios (CustomBroker exercises the existing unknown-role fallback).

| Skill | Registered tools | SuperAdmin | Admin | Agent | Underwriter | Medical Underwriter | Financial Underwriter | ClaimsManager | ClaimsAdjuster | CustomerService | Viewer | Finance | CustomBroker |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agent-operations | 4 | 4 | 4 | 4 | 4 | 0 | 0 | 2 | 2 | 2 | 2 | 0 | 2 |
| claim-financial-underwriting | 6 | 2 | 2 | 0 | 2 | 0 | 0 | 6 | 3 | 2 | 2 | 2 | 2 |
| claims-management | 29 | 7 | 7 | 0 | 6 | 0 | 0 | 27 | 22 | 6 | 6 | 9 | 6 |
| commissions | 27 | 27 | 27 | 3 | 9 | 0 | 0 | 0 | 0 | 9 | 9 | 0 | 9 |
| corporate-insurance | 30 | 30 | 30 | 2 | 2 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 1 |
| customer-acquisition | 6 | 6 | 6 | 5 | 5 | 0 | 0 | 2 | 2 | 4 | 4 | 0 | 4 |
| customer-service | 4 | 4 | 4 | 3 | 3 | 0 | 0 | 4 | 3 | 4 | 1 | 0 | 1 |
| document-intelligence | 8 | 8 | 8 | 6 | 8 | 1 | 0 | 2 | 2 | 3 | 3 | 0 | 3 |
| failure-recovery | 4 | 4 | 4 | 4 | 4 | 0 | 0 | 4 | 4 | 4 | 3 | 0 | 3 |
| family-insurance | 5 | 5 | 5 | 5 | 5 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 3 |
| final-underwriting | 15 | 15 | 15 | 3 | 14 | 0 | 0 | 2 | 2 | 3 | 3 | 0 | 3 |
| finance-payments | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 |
| finance-reconciliation | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 |
| financial-underwriting | 7 | 7 | 7 | 0 | 3 | 5 | 7 | 0 | 0 | 0 | 0 | 0 | 0 |
| individual-insurance | 13 | 13 | 13 | 10 | 13 | 0 | 0 | 2 | 2 | 5 | 5 | 0 | 5 |
| medical-underwriting | 7 | 7 | 7 | 1 | 3 | 7 | 5 | 0 | 0 | 1 | 1 | 0 | 1 |
| platform-configuration | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| policy-issuance | 4 | 4 | 4 | 0 | 4 | 0 | 0 | 1 | 0 | 2 | 2 | 0 | 2 |
| policy-servicing | 20 | 20 | 20 | 17 | 20 | 0 | 0 | 0 | 0 | 15 | 12 | 0 | 12 |
| pre-underwriting | 9 | 9 | 9 | 4 | 9 | 0 | 1 | 0 | 0 | 2 | 2 | 0 | 2 |
| premium-management | 7 | 7 | 7 | 5 | 7 | 0 | 0 | 0 | 0 | 3 | 2 | 0 | 2 |
| reporting-and-analytics | 8 | 8 | 8 | 7 | 8 | 3 | 3 | 8 | 8 | 8 | 8 | 6 | 8 |
| request-management | 4 | 4 | 4 | 4 | 4 | 0 | 0 | 4 | 4 | 1 | 1 | 0 | 1 |
| rules-and-governance | 16 | 16 | 16 | 0 | 10 | 0 | 0 | 0 | 0 | 6 | 6 | 0 | 6 |
| tenant-administration | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| user-and-role-management | 7 | 7 | 5 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 1 | 0 | 1 |

Counts show discoverable permissions, not permission to complete every step of a workflow.
The CSV includes both allowed and denied role/skill/tool combinations. Backend record ownership, tenant isolation, delegation and lifecycle checks still apply.

## Explicit limitations

- customer-acquisition: Customer deletion is intentionally disabled; retain customer audit history.
- finance-payments: Claim approval
- finance-payments: Settlement authorisation
- finance-payments: Underwriting findings
- finance-payments: Changing bank details
- finance-reconciliation: Claim approval
- finance-reconciliation: Settlement authorisation
- finance-reconciliation: Underwriting findings
- finance-reconciliation: Changing bank details
- platform-configuration: Tenant deletion and provider API-key editing must use the platform console.
- tenant-administration: Tenant deletion and provider API-key editing must use the platform console.
- user-and-role-management: Global role deletion must use the platform console.
- Universal exactly-once mutation execution is not guaranteed. Existing owning-service idempotency and duplicate checks remain authoritative; unknown outcomes require verification.
- Natural language examples are regression inputs. Deterministic mock-provider tests do not establish real-provider completion rates.
- Backend routes without a confirmed adapter are inventoried separately; no arbitrary endpoint dispatcher is available.
