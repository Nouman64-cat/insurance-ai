# Medical and financial underwriter workspaces

The verified SSO role now selects a dedicated workspace at the existing Underwriting Workbench URL (`/underwriting`, port 3005 by default). `Medical Underwriter` and `Financial Underwriter` never mount the general pre-underwriting, evaluation, case-decision or post-underwriting page components. Their workbench navigation contains one role-specific review queue. Portal login sends either role directly to the workbench; portal navigation offers only underwriting and profile.

Each reviewer has a searchable, paginated queue with assignment and review-status filters. The default is Assigned to me; Unassigned and My reviews and unassigned show available work. Other assignees' reviews are excluded by the server. Finished applications leave the queue, and direct links to them remain read-only.

Medical evidence includes health declarations, family medical history, measurements, exam findings/tests, medical documents and the current policy's medical risk score/reasons. Financial evidence includes declared income, occupation, sum assured, term, existing insurance, financial documents and financial risk score/reasons. Unavailable evidence is shown as missing, not zero or clearance. The workspace API returns only the selected track's evidence and assessment fields; this is not a claim of field-level access control over all legacy read APIs.

Reviewers save In review, Cleared, Referred or Declined with a rationale for decisions. Saving an unassigned review assigns it to the verified reviewer. Specialists cannot take a review assigned to another person, clear its assignee, change the other track or update a held/closed application. Notes-only changes are audited. A case-row lock serializes competing assignment saves.

The admin overview and assignment flow remain intact. Track clearance is not final application approval, policy issuance or payment. Existing final-decision workflow behavior has not been replaced with an automatic two-track approval rule.

## Backend boundaries

Authenticated specialist tenant writes are limited to PUT on their own track endpoint. The endpoint verifies tenant, track, assignee, application status and decision rationale. Existing hold middleware remains authoritative. The API gateway's synchronous and asynchronous evaluation endpoints also reject these two roles. Existing internal unauthenticated evaluation callers are preserved; this work does not remediate the wider legacy service-authentication model.

## Validation

- Eleven disposable-PostgreSQL API tests passed: own-track edits, cross-track denial, assignment restrictions, scoped queue/evidence, tenant boundaries, required rationale, unchanged other track, held/closed applications, general workflow write denial and admin assignments.
- Eight existing workbench Node tests passed.
- Workbench TypeScript check passed.
- Direct gateway dependency checks confirmed both specialist roles are rejected, Admin/Underwriter remain allowed and both evaluation routes are guarded.
- Live authenticated Admin workbench still loads after the changes. A specialist browser session was not available, so no claim of live end-to-end browser verification for those roles is made. No production reviews, assignments, policy decisions or payments were created during testing.
