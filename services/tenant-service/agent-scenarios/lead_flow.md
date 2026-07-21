# Lead Generation and Management Flow

This document outlines the standard operating procedure (SOP) for managing leads and prospects in the insurance portal.

## Scenario: New Lead Interaction
**Trigger:** The user wants to add a new customer, prospect, or lead to the system but hasn't provided all information yet.
**Context:** The agent is collecting initial information (Name, CNIC, Occupation, Income, DOB, etc.).

### Suggested Next Actions
When a lead is successfully added to the system via the `add_customer` tool, the agent should suggest the following immediate follow-up actions:

1. **"Create an Underwriting Case"**
   - **Reason:** Once a lead is in the system, the most common next step is to initiate a formal case (application) for underwriting.
   - **Tool:** `create_case` (requires CNIC of the lead).
2. **"Generate an Indicative Quote"**
   - **Reason:** Often, agents want to give the prospect a quick premium quote before starting a full case.
   - **Tool:** (Currently handled via Plans dashboard, but you can suggest navigating to `dashboard`).
3. **"View Lead Profile"**
   - **Reason:** The user might want to review the newly added lead in the CRM interface.
   - **Tool:** `navigate_to_page` (Target: `/admin/leads`).

## Scenario: Lead Already Exists (CNIC Conflict)
**Trigger:** The user tries to add a customer, but the CNIC is already registered in the tenant's system.
**Context:** The system prevents duplicate profiles based on CNIC.

### Suggested Next Actions
If a CNIC conflict occurs, the agent should seamlessly transition to actions for an *existing* customer:

1. **"Create an Underwriting Case for Existing Lead"**
   - **Reason:** The lead already exists, so proceed directly to case creation.
   - **Tool:** `create_case` (requires the existing CNIC).
2. **"Fetch Customer Details"**
   - **Reason:** The agent may want to review the existing profile.
   - **Tool:** `get_case_details` (requires CNIC).
