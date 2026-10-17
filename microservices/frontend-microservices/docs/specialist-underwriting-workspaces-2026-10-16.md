# Specialist underwriting workspaces — 16 October 2026

Medical Underwriter and Financial Underwriter use the existing role-aware workbench at port 3005. Each has an assigned/unassigned review queue and application workspace; the general underwriting console remains available to Admin and Underwriter.

## Working tools by track

Medical: assess the non-medical-limit grid; send the existing customer examination-booking link; schedule against eligible panel clinics and available slots; send the booked lab's upload link; inspect reports per test; use the existing AI-assisted medical-result dialog and rating; confirm reports; record a justified medical waiver. The general case page and specialist workspace now share the same extracted MedicalReviewDialogs components.

Financial: run the existing insurance-history/exposure engine; inspect proposed and aggregate cover, HLV limit/ratio, internal/external policies and findings; record a reasoned clearance or adverse history decision. The financial evidence includes the quoted premium and acquisition-source income/occupation verification when available.

Both: upload documents in their track using the existing artifact storage/OCR pipeline; read OCR and extracted evidence; inspect authenticity flags, the current application assessment and its track-specific structured results; record review status and rationale. Medical uploads can be attached to a required examination test using the existing report-upload service, so AI reading/rating can find them.

## Identity and restrictions

Operations require the caller to own that track in the same tenant. Unassigned reviews have an explicit Start my review action. Cross-track operations, other assignees, held/closed applications, full application approval, policy issuance and payments remain blocked. Financial history overrides require a rationale. Medical waivers still use the existing justified-exception endpoint. Document type is enforced server-side, not just by the dropdown.

Medical/exposure calculations use the linked proposal, or the unique existing customer proposal for legacy applications without policy_id. Multiple candidates remain blocked rather than guessing. Read-only resolution does not change the application. Evidence upload is possible before linkage. No proposal was invented or linked during testing. Scope-specific mutations do not imply final application approval.

## Evidence fixes

The assessment lookup now uses the application ID, matching the general case workspace. It no longer misses application assessments merely because the policy linkage differs. Documents include application files and customer uploads from before case creation; plan-request uploads are limited to the linked proposal. Shared customer documents are labeled explicitly. Another application's files and the other track's document types are excluded.

## Verification

Sixteen disposable-PostgreSQL integration tests passed, including actual medical NML assessment and financial exposure/clearance calls under the new roles, cross-track denial, held/closed applications, missing-proposal blockers, assessment lookup, pre-case documents and upload-type restrictions. Eight workbench Node tests passed and the workbench TypeScript check passed.

All fifteen medical-report unit tests passed. Two stale tests were updated to exercise the existing lab-token auto-upload endpoint rather than the removed customer upload endpoint. No production medical/financial decision, payment, email or file upload was executed.

Live Firefox verification found the Medical Underwriter's Hamza Malik application and confirmed the expanded clinical controls and the missing-proposal blocker. Live financial-role verification on the same Hamza application confirmed the shared case header, four tabs, policy context, and enabled exposure action. No calculation or review decision was executed in the live session.

## Same case page, split by role

The `/case/[id]` route now selects the medical/financial variant using the verified workbench identity; the outer role wrapper no longer replaces this route. All roles share CaseWorkspaceHeader: applicant identity, policy context, Folder/Download actions, and Overview / Requirements / Documents / Applicant & Policy tabs. Specialists see their own operations and review in the original two-column application layout. General reviewers retain their existing full-case actions. The specialist PDF export contains only their own track's evidence and saved review.

Proof: `/tmp/insurance-financial-case-split.png`. Eight frontend tests and the workbench type check pass.


### Separate customer questionnaires

Medical underwriters (including affiliated doctors) and financial underwriters can email an assigned application's customer their own questionnaire from Overview. Medical questions cover conditions, medication, family history, lifestyle and previous tests; financial questions cover occupation, income, commitments, assets, existing insurance and premium funding. Doctors continue uploading test reports through Documents and the medical report tools.

Each track stores an independent questionnaire, hashed token, 14-day expiry, signature and submission timestamp. Resending replaces an unsubmitted link; submitted answers cannot be overwritten using the public link. No public endpoint returns submitted answers. Staff reads require the currently assigned reviewer in the same tenant. Held/closed applications cannot accept submissions. Missing customer email and delivery failures are shown explicitly.

After commit, `UnderwritingQuestionnaireSubmitted` uses the existing Kafka → gateway SSE flow. The matching reviewer sees an update in the queue or case; reconnect/visibility resync reloads persisted status. Submission events contain track/reviewer metadata, never questionnaire answers. Questionnaire submissions do not automatically clear a review or complete the full application questionnaire. The new table is created by the existing startup migration's `create_all`; no manual seed is required. Public links use the existing `PORTAL_PUBLIC_URL` and email configuration.

Validation: 18 disposable-PostgreSQL underwriting tests, including independent forms, role/tenant access, expiry, resend invalidation, consent, duplicate submission, private answer reads and submission event publication. Underwriting TypeScript and 8 existing Node tests pass. Portal-wide TypeScript still reports pre-existing map, SSO and e-application errors; no diagnostics reference the new questionnaire page. No live customer email was sent in testing.
