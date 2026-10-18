# Rule-driven agent commission continuation — 19 October 2026

The requested feature earns commission on the first premium after policy issuance, takes the percentage and recurring terms from the rule engine, and schedules disbursement for the following month using the acquisition source's start-date day. Confirmed example: source start date 15 March, premium collected in October → payable 15 November. A missing day in the following month is clamped to its last day.

## Implementation

Continued the existing uncommitted implementation rather than building a second commission ledger. `services/commission_engine.py` posts persisted receipt-backed gross earnings and uses `services/agent_commission.py` to evaluate live rule set `RS-COM-002`. Posting and the policy preview share `resolve_allocation`. Quotes, pending payment and other pre-issuance states cannot earn commission through reconciliation. An exception remains retryable after issuance; duplicate delivery of a posted receipt leaves one earning.

The first premium is the policy's earliest installment, including its actual top-up receipts. Later installments earn only under a recurring rule. Recurring percentage defaults to the first rate when omitted; an optional final policy year bounds recurrence. Receipt amounts exclude surcharge. Explicit producer splits take priority over automatic allocation to the customer's assigned agent. Existing earning snapshots and payout dates do not change when rules or source dates change.

`AcquisitionSource.start_date` supplies the payout day. For legacy sources with no start date, the existing implementation uses their creation-date day; set the actual start date when configuring the source. Payable-date scheduling does not perform a bank transfer. Disbursement eligibility separately checks policy state, free-look, producer activity and batch reservations.

New read-only commission API contracts:

- `POST /tenants/{tenant_id}/commissions/rate-preview` — hypothetical individual premium using the live rule engine.
- `GET /tenants/{tenant_id}/commissions/policies/{policy_id}/preview` — actual policy installment and producer allocation, sharing the posting calculation without writing earnings.

## Copilot integration

Fixed the tool-schema definition order that prevented chat-agent startup. Completed backend handlers for rate previews, policy calculations, commission rule CRUD/deployment, source start dates, payable earnings and payout-run listing/creation/approval. Rule edits stay in a draft until explicitly deployed; previewing never posts earnings. A later-year hypothetical preview defaults to a later premium, so a first-only rule is not mistakenly applied as a recurring rate.

Updated the commission skill and metadata, main-assistant prompts and commission specialist routing. The specialist has at most 30 explicitly scoped tools, further restricted by role/platform; the general fallback remains within the provider's 128-tool cap. New administration tools stay in the keyword-selected administration pack. Admin/SuperAdmin perform setup and payouts; Agents retain only backend-scoped authorized reads. Existing action-request authorization and backend maker–checker policies are preserved.

Payout creation excludes held earnings, reports the 100-earning batch limit, and preserves the created reference if submission fails or times out. Another administrator must approve; approval does not mean paid. Manual external-payment recording remains in the commission portal. Legacy agreement messages now distinguish historical configuration from live rule-engine rates. Invalid rule criteria and empty updates do not create a draft; a zero producer split cannot silently become 100%.

## Verification and deployment

Regression suites cover real PostgreSQL receipt posting, recurrence, amount rounding, month/year boundaries, pre-issuance exceptions, retry idempotency, producer isolation, batch reservation and independent approval. Database tests use a disposable schema that is removed afterward. Chat tests use controlled service responses and no LLM calls or customer mutations.

Validation results: 4,118 commission/registry/skill chat checks passed, plus 576 adjacent role/finance/claims/underwriting checks. All 36 PostgreSQL scenarios were verified: the final full run had 35 passes and one connection timeout; the timed-out snapshot test and the pre-issuance retry test both passed on an isolated retry. `git diff --check` passed.

Deploy the updated tenant-service and chat-agent. No new migration is introduced by this continuation. No production rates were created or deployed, and no customer payouts were recorded. Set actual business percentages and recurrence in the rule-engine draft, then explicitly publish the reviewed version. Do not treat example/test percentages as approved business terms.
