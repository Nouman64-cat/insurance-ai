# Underwriting Case Management Flow

This document outlines the standard operating procedure (SOP) for managing underwriting cases in the insurance portal.

## Scenario: Newly Created Case
**Trigger:** The user successfully creates an underwriting case for a prospect using `create_case`.
**Context:** The case exists in the database with status `New`, but lacks required documents for AI Risk Assessment.

### Suggested Next Actions
1. **"Upload Required Documents"**
   - **Reason:** The AI Risk Assessment cannot run until mandatory documents (like CNIC, Salary Slip, Medical Records depending on product rules) are uploaded and processed.
   - **Tool:** `upload_document`
2. **"Run AI Risk Assessment"**
   - **Reason:** If documents were somehow already provided or not needed (rare), the underwriter can evaluate the risk.
   - **Tool:** `run_risk_assessment`
3. **"View Case Dashboard"**
   - **Reason:** The user may want to review the newly created shell.
   - **Tool:** `navigate_to_page` (Target: `/cases`)

## Scenario: Missing Documents for Underwriting
**Trigger:** The user attempts to run a risk assessment (`run_risk_assessment`), but the system blocks it due to missing documents in the checklist.
**Context:** The system identifies that `CNIC` or `Medical Report` is missing.

### Suggested Next Actions
1. **"Upload Missing Document"**
   - **Reason:** Immediate resolution to the blocker.
   - **Tool:** `upload_document`

## Scenario: Risk Assessment Completed
**Trigger:** The `run_risk_assessment` tool executes successfully, generating a composite risk score (Medical, Financial, Fraud).
**Context:** The case has a populated `latest_assessment` and an AI decision recommendation (`Approved`, `Rejected`, or `Human Review`).

### Suggested Next Actions
1. **"View Explainability Report"**
   - **Reason:** Underwriters need to understand *why* the AI recommended a specific decision. The AI generates PDF reports and factor breakdowns.
   - **Tool:** `navigate_to_page` (Target: `/cases`) (Note: Deep link to the case to view the UI).
2. **"Generate Underwriter Summary Note"**
   - **Reason:** The user might want to generate an internal audit note based on the AI's findings.
   - **Tool:** Manual interaction on the UI, but the agent can suggest doing it.
3. **"Change Case Status (Approve/Reject)"**
   - **Reason:** Finalizing the decision.
   - **Action:** Inform the user they can manually override or accept the decision via the dashboard.

## Scenario: Explainability Report Viewed
**Trigger:** The user navigates to the `assessments` page or explicitly views the explainability report.
**Context:** The risk assessment has already been run. The user is now reviewing the detailed reasoning (factors, scores) behind the AI's decision. DO NOT suggest running the risk assessment again or uploading pre-requisite documents.

### Suggested Next Actions
1. **"Generate Underwriter Summary Note"**
   - **Reason:** The underwriter often needs to document their own findings or synthesize the AI's report before formalizing a decision.
2. **"Approve Case (Accept AI Decision)"**
   - **Reason:** The underwriter agrees with a positive AI recommendation and is ready to bind coverage.
3. **"Reject Case (Decline Risk)"**
   - **Reason:** The underwriter agrees with a negative AI recommendation or overrides a positive one due to high risk factors seen in the report.
