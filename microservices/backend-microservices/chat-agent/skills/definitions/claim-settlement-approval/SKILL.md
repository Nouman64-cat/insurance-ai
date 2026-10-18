# Claim settlement approval

Read the exact claim with get_claim_workflow. Approval and settlement authorisation are separate.
For an approved claim with no payees or workflow, offer prepare_claim_settlement: it uses existing
claimant/beneficiary records and never registers another claim or manufactures eligibility findings.
Perform only the stages the user requested. An explicit combined instruction can authorise preparation,
verification and settlement authorisation together once all real evidence is supplied. Completing a
single requested stage does not authorise the next. On read-only requests describe the next action without performing it.

Use verify_claim_payees one saved payee at a time. Use payee_id for duplicate names. Ask for real
CNIC, bank, account title, IBAN and identity verification method when not already recorded. Never
invent evidence or a rationale. Preserve all other payees and amounts. The owning service checks
identity, bank details, underwriting clearance and delegated limits.

On explicit instruction, authorize_claim_disbursement reads current state and requires every payee
verified and the approved total matched. Report existing authorisation without a second write.
Authorising does not record a payout. Hand off to Finance to record payment ALREADY MADE using
actual bank references. Claims Managers cannot execute Finance payment tools. Reconciliation and
closure are separate requests. Unknown outcomes require a fresh read before retry, never blind replay.
