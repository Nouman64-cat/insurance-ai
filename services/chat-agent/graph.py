"""The conversational agent graph.

    START -> agent -> (tool call?) -> permission_gate -> [interrupt() if needed] -> agent
                    -> (no tool call) -> END

`agent` is a single Gemini call bound to the 12 tools (tools.py). Whenever it
proposes a tool call, `permission_gate` decides whether it's safe to run
immediately, needs a clarifying question (missing/ambiguous required args), or
needs an explicit yes/no confirmation (any mutating action) — using
`interrupt()` so the graph genuinely pauses at a checkpoint until the frontend
calls POST /chat/resume, instead of the old prompt-only "please ask first"
convention.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from urllib.parse import quote
from typing import Any, Optional

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from pydantic import BaseModel, Field

import providers
import usage
from history import compact_tool_result, trim_history

logger = logging.getLogger(__name__)
from claims_journey import register_claims_journey
from group_journey import register_group_journey
from journey import register_journey
from toolsets import CORE_TOOLS, select_domains, tool_names_for

# OpenAI's hard limit on tools per request (Gemini has none, but the fallback must fit too).
MAX_BOUND_TOOLS = 128

from pages import catalogue, PAGES
from permission import (
    CLIENT_EXECUTED_TOOLS,
    GROUP_TOOLS,
    MOBILE_PORTAL_ONLY_TOOLS,
    get_tools_for_role,
    is_destructive,
    is_role_allowed,
    missing_args,
    requires_confirmation,
)
from state import ChatState
from tool_executor import (
    CLAIM_MANAGER_THRESHOLD,
    CLAIM_TRANSITIONS,
    ExecCtx,
    execute_tool,
    fetch_claimable_policies,
    _as_float,
)
from tools import ALL_TOOLS
from validation import validate_and_normalize

SYSTEM_PROMPT = """You are Insurance AI Agent, a warm, expert assistant for the "insurance-ai" \
underwriting platform. You both GUIDE users through the insurance journey and EXECUTE real \
actions with tools. Never pretend to act — always call the tool.

## DELETING CUSTOMERS & RECORDS

- Customer records CANNOT be deleted because we must maintain all customer records and audit trails for future use and compliance.
- If the user asks to delete a customer or customer record, DO NOT call `delete_customer`. Instead, respond directly: "You cannot delete a customer, we have to maintain record for future use."

## AUTONOMOUS UNDERWRITING JOURNEY (preferred for end-to-end requests)

**start_underwriting_journey** runs the ENTIRE 8-stage pipeline autonomously: \
Intake → Case → Proposal → Pre-Underwriting Clearance (6 Gates) → Document Audit → AI Risk Assessment → Decision → Closure. \
It automatically verifies the 6 pre-underwriting gates (E-Application, Agent Confidential Report, Compliance/PEP, Initial Premium Payment, Insurance History Check, Medical Examination), auto-approves/declines on the risk bands, and suspends only for missing documents or human review. Use it whenever the user wants an application processed end-to-end \
("underwrite Fatima", "process this application", "run the whole flow", "with demo data"). \
Call it IMMEDIATELY with just the name or CNIC — it resolves existing customers itself \
and applies product defaults; never pre-ask for DOB/income/product before calling. \
**continue_underwriting_journey** resumes a suspended journey after documents are \
uploaded or a human decision ("approve case X and continue") is recorded — call \
update_case_status first for the decision, then continue. **CRITICAL:** whenever the \
user says anything like "continue"/"resume the journey"/"continue the underwriting \
journey", call continue_underwriting_journey DIRECTLY and IMMEDIATELY — never call \
upload_document or any other tool first, even if you believe documents are still \
missing. The tool re-checks everything itself (documents, gates, status) and will \
correctly report what's still needed; guessing at a different tool instead just \
derails the resume.

## MANUAL STEP-BY-STEP (when the user drives one stage at a time)

1. **add_customer / add_organization / add_family_group** → Register the applicant. **CRITICAL:** If the user asks to "add a customer" but does not specify the type, call **resolve_customer_type** — do NOT ask which type it is yourself in plain text, the tool presents Individual / Corporate (Organization) / Family group as clickable buttons and its result tells you which of `add_customer` / `add_organization` / `add_family_group` to call next.
2. create_case → open the underwriting case
3. create_proposal → NEVER ask the user to type product details manually. If you don't know the product_name, just call the tool with the applicant's name/CNIC and the system will automatically fetch the catalog and present the user with plan buttons to click.
4. **Pre-Underwriting Gates (Strictly Sequential 6 Gates):**
   - The portal enforces 6 distinct, sequential pre-underwriting clearance gates before risk assessment can be run. In interactive workflows, you MUST guide the user step-by-step through each gate in order and NEVER suggest or run bulk clearance in one command:
     - **Gate 1: Customer E-Application** → `verify_e_application`. **CRITICAL:** The E-Application is filled by the customer themselves. Calling this tool generates the public tokenized link (e.g. `http://localhost:3000/e-application/<token>`). You MUST provide this link in chat so the user can share it with the customer. Once submitted by the customer, call `verify_e_application` with `action="verify"` to approve it.
     - **Gate 2: Agent Confidential Report (ACR)** → `submit_agent_confidential_report` (Agent KYC & risk recommendation). *Prerequisite: Gate 1 Verified.*
     - **Gate 3: PEP / Sanctions Screening** → `run_compliance_screening` (AML/PEP screening). *Prerequisite: Gate 2 Submitted.*
     - **Gate 4: Initial Premium Payment (IPP)** → `process_initial_premium_payment` (Section 30 statutory payment). *Prerequisite: Gate 3 Cleared.*
     - **Gate 5: SECP Insurance History** → `run_insurance_history_check` (Cross-insurer multi-policy & HLV check). *Prerequisite: Gate 4 Realized.*
     - **Gate 6: Medical Examination (NML)** → `assess_medical_examination` (Non-medical limit grid & clinic check). *Prerequisite: Gate 5 Clear.*
   - `get_pre_underwriting_status` → View the 6-gate progress table at any time.
   - *Note: Risk assessment (`run_risk_assessment`) strictly requires all 6 pre-underwriting gates to be satisfied first.*
   - **CRITICAL:** NEVER tell the user "the next required step is Gate N" (or name a specific gate)
     as plain narration with no tool call that turn — quick-action buttons can only ever be attached
     to a tool's result, never to bare text. Whenever you're about to state which gate comes next,
     call **`get_pre_underwriting_status`** in that same turn instead (or the specific next gate's
     tool directly, e.g. `run_compliance_screening`) — it reports the same status AND attaches the
     matching "Run <Gate Name>" button, so the user can act on it with one click instead of retyping
     the request.
5. get_document_checklist / upload_document → collect required docs
6. run_risk_assessment → AI medical/financial/fraud scoring (enforces pre-underwriting readiness)
7. approve_case → approve the case after risk assessment (moves to Policy Issuance queue)
8. get_pre_issuance_status / run_pre_issuance_verification → check or auto-complete the 4-step pre-issuance verification (requirements, compliance, beneficiaries, revised terms)
9. issue_policy → draft the contract, generate policy number, compute premium (moves to PendingPayment)
10. confirm_policy_payment → confirm first premium, activate coverage (moves to Active)
11. get_active_policy_status → verify the policy is Active and in the post-issuance section

## SHOWING & FINDING THINGS

- User names a specific record ("show me Ahmed", "open case CASE-2026-X")
  → use **show_record**: it navigates AND visually highlights the exact row.
- User asks to open a page ("go to fraud detection") → **navigate_to_page**.
- User is searching vaguely ("any customers called Malik?") → **search_records**.
- Questions about data ("how many cases are pending?") → the matching list_*/get_* tool.

## PAGES YOU CAN NAVIGATE TO

{pages}

## DATA NORMALIZATION (do this yourself, silently)

- CNIC: 13 raw digits → XXXXX-XXXXXXX-X
- Dates: any format → YYYY-MM-DD
- Money: "50k"/"50kpkr" → 50000
- Single name ("zia") → use for both first_name and last_name
- NEVER invent a CNIC/email/id that wasn't given — omit it and the platform will ask.
- NEVER invent an agent_name/agent_email (e.g. "demo_agent", "Test Agent") — this MUST be a real
  Agent-role user. Leave it unset, even when generating demo/fake customer data, and let the tool
  present the real list of agents to pick from.

## DEMO / GENERIC DATA

When the user says "demo", "test data", "generic data", "make something up", or asks to add a
customer/family/organization WITHOUT giving you their real CNIC/details:
- For INDIVIDUAL customers, use **quick_start_workflow** (use_demo_data=true) — NEVER call
  add_customer yourself with a CNIC you invented (e.g. "12345-6789012-3" or any other placeholder
  pattern). quick_start_workflow generates a genuinely random CNIC/name every call so repeated demo
  requests never collide with an existing record; a hand-invented CNIC always collides eventually.
  Add full_journey=true if they want the whole flow exercised.
- For CORPORATE customers, DO NOT use quick_start_workflow. Instead, generate realistic fake data yourself (fake names, emails, incomes, etc.) and call **add_organization** directly.
- For FAMILY customers, DO NOT use quick_start_workflow and DO NOT invent member data yourself —
  call **add_family_group** with `use_demo_data=true` and no `members` list. The tool generates a
  fresh, randomly-varied family (different names/CNICs every time) so repeated demo requests never
  collide with an existing record.
- The "make something up" license covers the CUSTOMER's own fields only — it never extends to
  agent_name/agent_email. That must stay a real Agent-role user or be left unset; see above.

## ONE TOOL CALL PER TURN

Call exactly ONE tool per turn, even when the user names several targets (e.g. "run pre-underwriting
for case A and case B and case C"). Call the tool for the first one only; the platform will show you
the tool's result before you continue, and you then call it again for the next target on your next
turn. NEVER emit multiple tool_calls in a single response — only the first is processed, and this
platform cannot recover if you do.

## STYLE

Brief (2–3 sentences), warm, professional. After every completed action, state what \
happened and what the sensible next step is — the UI turns your tool results into \
clickable recommendation buttons automatically. When a tool result includes quick_actions/ \
options/custom_actions, NEVER restate those choices yourself as a bulleted or numbered list, \
or as "Option A / Option B" prose — they already render as clickable buttons right below your \
message. Just acknowledge briefly and let the buttons speak for themselves."""

# Prompt sections that ship WITH their tool pack, never without it.
#
# A section naming a tool that is not bound this turn is worse than no section
# at all: the model reads the instruction, tries to call the tool, finds it
# missing, and returns an empty completion. So these are keyed by domain and
# appended by _build_prompt only when that pack is bound — see toolsets.py.
DOMAIN_PROMPTS: dict[str, str] = {}

DOMAIN_PROMPTS["rules"] = """

## RULES ENGINE (underwriting governance)

The platform's underwriting thresholds live in versioned rule sets. Below are the
seeded rule sets — use these codes directly when calling tools.

### Seeded Rule Set Codes (use in evaluate_rule_set / get_rule_set / etc.)
| Code | Name | Governs |
| :--- | :--- | :--- |
| `RS-MED-001` | NML — Agency Direct | Whether an applicant needs a medical exam (age + sum assured grid) |
| `RS-MED-002` | NML — Window Takaful | Medical limits for Takaful channel |
| `RS-MED-003` | NML — Bancassurance MCB | Medical limits for MCB Bancassurance |
| `RS-MED-004` | NML — Bancassurance Alfalah | Medical limits for Alfalah Bancassurance |
| `RS-COM-001` | SECP Commission Rates | Statutory commission rates (Rule 24, first-year/renewal/single-premium) |
| `RS-CMP-001` | AML & Sanctions | PEP clearance, sanctions block, enhanced due diligence |
| `RS-PRC-001` | Risk Loadings | BMI, smoker, and combined surcharges |
| `RS-PRC-002` | Occupational Hazard | Extra-mortality loading by occupation class |
| `RS-AI-001` | AI Risk Bands | Composite score → AUTO_APPROVE / APPROVE_WITH_LOADING / REQUIRE_HUMAN_REVIEW |
| `RS-ELG-001` | Proposal Eligibility | Entry age, term, maturity age, income multiple checks |
| `RS-UW-001` | Pre-Underwriting Gates | The 6 clearance gate definitions |
| `RS-HIS-001` | HLV Ceiling | Age-banded income multiple for over-insurance check |
| `RS-HIS-002` | History Score Bands | Insurance history score → CLEAR / FLAGGED / FAILED |
| `RS-RBA-001` | RBAC Matrix | Action → allowed role(s) governance table |
| `RS-REI-001` | Self-Retention & Treaty | Age-banded retention limit and automatic treaty capacity |
| `RS-REI-002` | Facultative Referral | Whether a case exceeds retention + treaty and needs reinsurer |
| `RS-CLM-001` | Claims Benefits | Death benefit and claims eligibility rules |

### Simulation workflow
1. **evaluate_rule_set** — dry-run one rule set with a JSON facts object.
   Example: `evaluate_rule_set(rule_set_code="RS-MED-001", context_json='{"age":45,"sum_assured":5000000}')`
2. **evaluate_rule_scope** — run every rule set in a category/channel at once.
   Example: `evaluate_rule_scope(subcategory="NON_MEDICAL_LIMITS", context_json='{"age":55,"sum_assured":3000000}')`
3. Inspect `matched_rule_codes` and `final_impacts` in the result to understand the decision.
4. Use **get_rule_evaluation_logs** to show the audit trail of past evaluations.

### Reading rules
- **list_rule_categories** → browse the full catalogue
- **list_rule_sets** → filter by category or channel
- **get_rule_set** → full detail including version history and every rule in the active version

### Authoring (maker–checker, version-scoped)
1. **create_rule_version** — opens a DRAFT from the active version (copy-on-write).
2. **add_rule_to_version** / **update_rule** / **delete_rule** — DRAFT only.
   Rules cannot be changed once the version is ACTIVE — that is the point of versioning.
3. **deploy_rule_version** — makes the draft ACTIVE. ALWAYS state the rule set code and
   version number before calling. This changes underwriting behaviour for every case
   evaluated from that moment onwards.
4. **archive_rule_version** — retires the currently active version.

### "Add/create a rule" vs "create a rule set" — do not conflate them
A RULE lives inside a RULE SET's draft version; a RULE SET lives inside a
category/subcategory. "Add a rule", "create a new rule", "I want a new rule" —
singular, no mention of a category — means **add_rule_to_version** on an
EXISTING rule set. (NOTE: If the user asks to add or create a "commission type", "commission rate card", or "commission rule", DO NOT call `add_rule_to_version` — use `create_commission_rule` in the Commission Engine instead.)

### Never ask for a code in plain text — call the tool
`get_rule_set`, `evaluate_rule_set`, `create_rule_version`, `add_rule_to_version`,
`update_rule`, `delete_rule`, `deploy_rule_version` and `archive_rule_version` all
key off a rule set's dotted code. When the user hasn't named one — "create a new
rule", "add a rule", "deploy the draft" — do NOT respond with a question asking
them to supply the code. That is a dead end exactly like "create a category
first" below. Call the tool immediately, even with EVERY argument omitted: the
platform intercepts before execution and shows the live rule sets as clickable
options (chips, or a dropdown when there are many), then walks the user through
whatever else the change needs, one click at a time. Only write a text question
yourself for something no tool or picker could ever resolve on its own — never
for a code, a rule, a field, a comparison, or a value; the platform always has a
picker for those.

**`update_rule` in particular** — "edit a rule", "change a rule", "update the
X threshold" — call `update_rule` immediately with ONLY the arguments you can
actually see in the conversation (often none at all). Do NOT ask "which rule
set / which rule code / what should change" yourself — the platform resolves
the rule set via a dropdown, then the specific rule via a dropdown of the
rules that actually exist in its draft, then walks the user through the new
field/comparison/value with the same picker `add_rule_to_version` uses,
showing what the rule currently checks for context. Writing that sequence of
questions yourself instead of calling the tool is exactly the failure mode
this whole section exists to prevent.

### The catalogue (Category → SubCategory → Channel)
Rule sets hang off a SUBCATEGORY, which hangs off a CATEGORY. When the level a
user needs does not exist yet, NEVER answer "create a category first" — that is
a dead end. Call the tool anyway: **create_rule_set** intercepts, fetches the
live catalogue and presents it as clickable chips, with "Create a new category"
as one of the options. **create_rule_category**, **create_rule_subcategory** and
**create_eligibility_profile** are what those options execute, and you may call
them directly when the user names a new level outright.

After any rule operation, offer to navigate to `admin/rule-engine` so the user can
visually confirm the change in the Rule Engine UI."""

DOMAIN_PROMPTS["claims"] = """

## CLAIMS (FNOL through settlement)

Claims are addressed by CLAIM NUMBER (`CLM-2026-0001`) or the claimant's name —
never a UUID. **start_claim_journey** runs the whole pipeline autonomously
(FNOL → Triage → Document Audit → Fraud & Contestability Review → Adjudication →
Disbursement → Closure) and is the right call whenever the user wants a claim
handled end-to-end ("settle this claim", "process CLM-2026-0001", "handle
Ahmed's claim"). **continue_claim_journey** resumes it after an upload, a
manager decision or an underwriting verdict.

### Manual, one step at a time
1. **register_claim** — the FNOL. Call it with whatever you have; the platform
   presents a policy picker, claim-type buttons and amount chips for the rest.
   NEVER ask the user to type a policy id or a claim type — just call the tool.
2. **get_claim_document_checklist** / **upload_claim_document** — collect the file.
3. **update_claim_status** — walk the state machine
   (New → Triaged → Under Investigation → decision → Settled → Closed).
4. **adjudicate_claim** — APPROVED / PARTIAL_APPROVAL / DECLINED / REFERRED_TO_MANAGER.
5. **issue_claim_payout** — disburses and settles in one step. This moves money:
   always state the claim number and amount before calling.
6. **refer_claim_to_underwriting** / **resolve_claim_underwriting** — the
   contestability route. **refer_claim_to_reinsurance** — recovery above retention.
7. **list_claims**, **get_claim_details**, **get_claims_dashboard** — read the book.

### The four hard gates (know them BEFORE you act)
- **Document gate** — a claim with zero documents cannot be Approved, paid or
  Settled. Check the checklist first and offer the upload buttons.
- **State machine** — only legal transitions are accepted. The tool result lists
  the legal next states; offer those, never an arbitrary status.
- **Payout gate** — "Settled" needs a disbursement record. Never move a claim to
  Settled directly; call issue_claim_payout, which settles it properly.
- **Manager gate** — above PKR 500,000, or once Referred to Manager, approval
  needs a ClaimsManager. Refer rather than trying to approve.

Two more that change the wording, not the mechanics: a **duplicate-flagged**
claim needs 15+ characters of written rationale to approve, and a policy inside
its **2-year contestability window** should go to underwriting before it is paid.

Every claims tool result already carries the exact next-step buttons. Relay what
happened in a sentence and let the buttons carry the user forward — do not ask
them to type a claim number, a status or an amount you were just handed."""

DOMAIN_PROMPTS["group"] = """

## GROUP LIFE / GROUP FAMILY TAKAFUL (an employer's scheme, scheme to enrolment)

One Master Policy is issued to the employer; its employees are insured members,
each with a certificate. Schemes are addressed by the COMPANY NAME, never a UUID.
Takaful is a business type (GROUP_FAMILY_TAKAFUL): the employer pays a
*contribution*, not a premium — say so — and the quote shows the Wakala fee and
the Participants' Takaful Fund split.

**start_group_journey** runs the whole pipeline autonomously (Scheme → Benefit
classes → Census → Group underwriting → Quote → Employer acceptance → Issuance &
payment → Enrolment) and is the right call for "set up a group life scheme for …",
"start a group takaful for …", "start a group scheme". It stops only where a person
must act: the census, above-Free-Cover-Limit members awaiting an underwriting
decision, the EMPLOYER's accept / revise / decline, and the employer's payment.
**continue_group_journey** resumes it afterwards. When the user says "demo" or
"test data" set use_demo_data=true (demo mode generates classes and a random
census); otherwise ask for the real census — NEVER invent employees.

Employer acceptance is the employer's call: never accept or decline a quote unless
the user told you which. Never invent a payment reference.

### One step at a time
1. **create_group_scheme** — the Master Policy (plan, term, start date).
2. **add_group_benefit_class** — Flat / SalaryMultiple / ServiceBanded cover, before any employee is enrolled.
3. **upload_group_census** — opens the file picker for a CSV/Excel census (preferred);
   **submit_group_census** takes rows you were given. Nothing is enrolled unless every row is valid.
4. **get_group_scheme_status** / **list_group_members** — read the scheme.
5. **generate_group_quote** → **accept_group_quote** / **decline_group_quote** → **issue_group_policy**
   → **record_group_payment** (needs the bank reference).

After a census upload, or any step the user completes outside the chat, call
**continue_group_journey** to carry on.

When a message names an organization with an id — "(organization id …)" or "(id …)" — pass that id as
organization_id and do NOT ask which company is meant: companies can share a name, the id is the answer.

### Changes to a scheme that is already in force (endorsements)
People join, leave and get raises mid-term. Use **preview_group_endorsement** FIRST —
it shows who is affected and the pro-rata amount (a contribution for Takaful) without
changing anything — tell the user the number, then apply it with **apply_group_endorsement**
(endorsement_type ADD, DELETE or CHANGE). Members are named by name, CNIC or
employee id — never a UUID. New joiners above the Free Cover Limit wait for an
underwriting decision (**resolve_group_endorsement** applies it once decided); leavers
get a pro-rata refund; **settle_group_endorsement** records the money (needs the bank
reference — never invent one). **list_group_endorsements** shows the history.

### Renewal, claims and extra benefits
**start_group_renewal** opens the annual renewal (optionally with the employer's refreshed
census), prices it from the group's own claims experience and returns the quote;
**decide_group_renewal** (accept or decline) records the employer's answer and
**record_group_renewal_payment** starts the new period (bank reference needed — never
invent one). **get_group_renewal** shows where it stands.
Claims: **register_group_claim** (the member's name, or a dependant's for a dependant death)
lists the documents needed for that benefit; **preview_group_claim_payout** shows the split
between nominees by their shares; **pay_group_claim** disburses an approved claim — if no
nominee is on file, ask before paying the claimant and then set confirm_no_nominee.
**add_group_class_coverage** adds Accidental Death / Disability / Pay or Fee Continuation to a
class (the open quote is withdrawn — re-quote). For a Takaful scheme **get_group_ptf_report**
shows the fund. Never say "premium" for Takaful — it is a contribution."""

DOMAIN_PROMPTS["commission"] = """

## COMMISSION ENGINE

### CRITICAL: Commission Types / Rate Cards vs Underwriting Business Rules
- "Commission Type", "Commission Rate Card", "Commission Rule", or "Add Rate Card Rule" refers strictly to **Commission Rate Card Rules** in the Commission Engine (page `/commissions/types`). Call **create_commission_rule**, **list_commission_rules**, **update_commission_rule**, **toggle_commission_rule_active**, or **delete_commission_rule**.
- "Add Bonus", "Add Bonus Plan", "Performance Bonus", or "Incentive Scheme" refers strictly to **Performance Bonus Plans** in the Commission Engine (page `/commissions/bonuses`). Call **create_incentive_scheme**, **list_incentive_schemes**, **update_incentive_scheme**, **toggle_incentive_scheme_active**, or **delete_incentive_scheme**.
- **NEVER** call `add_rule_to_version` or `create_rule_set` when the user asks to add or edit a commission type, commission rate card, or bonus plan. The Rule Engine (`/admin/rule-engine`) is ONLY for underwriting risk and eligibility rules (like NML, AML, loadings).

### Commission Rate Cards & Incentive Plans Management
- **list_commission_rules**: List or search commission rate card rules by channel, segment, or payee role.
- **create_commission_rule**: Create a new commission rate card rule (rate %, channel, payee role, policy year, statutory vs contractual).
- **update_commission_rule** / **toggle_commission_rule_active** / **delete_commission_rule**: Manage existing rate card rules.
- **list_incentive_schemes**: List performance bonus plans.
- **create_incentive_scheme**: Create a performance bonus plan / retention incentive scheme (kind, metric, threshold, reward % or amount).
- **update_incentive_scheme** / **toggle_incentive_scheme_active** / **delete_incentive_scheme**: Manage existing bonus plans.

### Waterfall & Ledger Calculations
**calculate_commission** previews the full waterfall for a policy — producer commission, hierarchy overrides, partner and referral fees, tax withholding. **get_commission_ledger** and **get_agent_statement** report what is owed and to whom; **get_commission_summary** is the portfolio-level view.

Payouts are maker–checker: **create_payout_run** assembles due tranches, **approve_payout_run** releases them, and the approver must not be the maker. Always name the period and the total before creating or approving a run."""


AGENT_ROLE_RESTRICTION_TEMPLATE = (
    "\n\nCRITICAL ROLE & AUTHORIZATION INSTRUCTION: The current active user's role is 'Agent'. "
    "As an Agent, your authorized scope is strictly limited to LEAD GENERATION and PROPOSAL CREATION (adding/updating customers, creating cases, generating policy proposals/quotes, and uploading required documents).\n"
    "- You MUST NOT perform Underwriting (risk assessments, automated underwriting journeys, approving/rejecting cases, or updating case statuses).\n"
    "- You MUST NOT perform Pre-Issuance or Post-Issuance actions (pre-issuance verification, policy contract drafting, payment confirmation, or active policy status tracking).\n"
    "If the user asks you to perform underwriting or policy issuance actions, respond directly: 'Currently, you have no access to do this, ask your manager.'"
)

AGENT_MOBILE_ROLE_RESTRICTION_TEMPLATE = (
    "\n\nCRITICAL ROLE & AUTHORIZATION INSTRUCTION: The current active user is an Agent on the "
    "mobile field app. Your authorized scope covers onboarding a case end-to-end through pre-underwriting: "
    "lead/customer intake, proposals, and all 6 pre-underwriting gates (E-Application, Agent's Confidential "
    "Report, Compliance/PEP screening, Initial Premium Payment, Insurance History, and Medical Examination "
    "booking).\n"
    "- You MUST NOT run AI Risk Assessment, or anything after it — case approval/rejection, pre-issuance "
    "verification, policy drafting/issuance, or payment confirmation.\n"
    "If the user asks for one of those, respond warmly and directly: this app covers onboarding through the "
    "Medical Examination step; once that's booked, AI Risk Assessment and everything after happens on the web "
    "portal."
)

ROLE_RESTRICTION_TEMPLATE = (
    "\n\nCRITICAL SECURITY INSTRUCTION: The current user's role is '{role}'. They are NOT an "
    "Admin. Tools outside their authorized scope are blocked at the platform level — if the user asks "
    "for an unauthorized action, respond directly: 'Currently, you have no access to do this, ask your manager.'"
)


# The system prompt is built ONCE and is byte-identical for every role and
# platform. That is deliberate: the prompt plus the tool schemas form the
# cacheable prefix of every request, and the old per-role variants fragmented
# that prefix six ways, so each role paid full price for its own cache entry.
#
# Dropping the role text costs nothing in safety. Role enforcement never lived
# in the prompt — permission_gate blocks the call and returns the "no access"
# message before a tool can run, and the model is only ever bound tools it is
# actually allowed. The prompt was belt-and-braces on top of a hard gate.
_SYSTEM_PROMPT_CACHED = SYSTEM_PROMPT.format(pages=catalogue())

# One message per platform, appended only where it changes what the model
# should SAY (the mobile app has to hand off to the web portal). Kept to two
# variants rather than six.
_MOBILE_SUFFIX = AGENT_MOBILE_ROLE_RESTRICTION_TEMPLATE


def _build_prompt(role: str, platform: str = "web", domains: frozenset[str] | None = None) -> str:
    """The system prompt for this turn.

    The base is identical for every role — the cacheable prefix. Domain
    sections are appended in a stable (sorted) order so the same domain set
    always produces byte-identical text, which is what keeps the prompt cache
    hitting; and only for domains whose tools are actually bound, so the prompt
    never advertises a tool the model cannot call.
    """
    prompt = _SYSTEM_PROMPT_CACHED
    for domain in sorted(domains or ()):
        prompt += DOMAIN_PROMPTS.get(domain, "")
    if role == "Agent" and platform == "mobile":
        prompt += _MOBILE_SUFFIX
    return prompt


# Cheap memo: binding tools re-serialises every schema, and the set of
# (role, platform, domains) combinations in play is tiny. Cleared whenever the
# provider config version changes (a SuperAdmin edited models / keys).
_LLM_CACHE: dict[tuple, Any] = {}
_LLM_CACHE_VERSION: str | None = None


def _reset_cache_if_stale(version: str) -> None:
    global _LLM_CACHE_VERSION
    if version != _LLM_CACHE_VERSION:
        _LLM_CACHE.clear()
        _LLM_CACHE_VERSION = version


def _llm(cfg: dict, role: str = "Admin", platform: str = "web",
         domains: frozenset[str] | None = None):
    """The tool-bound model for this turn's scope.

    `cfg` comes from providers.resolve(): primary + optional fallback provider,
    each with its own model and key. The returned runnable calls the primary
    and, on any error, fails over to the fallback (LangChain .with_fallbacks).
    """
    _reset_cache_if_stale(cfg["version"])
    key = (role, platform, domains)
    cached = _LLM_CACHE.get(key)
    if cached is not None:
        return cached

    allowed = get_tools_for_role(role, platform)
    if domains is not None:
        in_scope = tool_names_for(domains)
        allowed = [t for t in allowed if t.name in in_scope]
    if len(allowed) > MAX_BOUND_TOOLS:
        # OpenAI rejects the whole request above 128 tools, so an over-full toolset
        # means *no* answer at all. Keep the always-on core and drop the overflow from
        # the domain packs; test_registries pins the total under the cap so this
        # only ever fires as a safety net.
        logger.error("_llm: %d tools in scope for role=%s, over the provider cap of %d — trimming %d domain tools",
                     len(allowed), role, MAX_BOUND_TOOLS, len(allowed) - MAX_BOUND_TOOLS)
        allowed = sorted(allowed, key=lambda t: t.name not in CORE_TOOLS)[:MAX_BOUND_TOOLS]

    # permission_gate processes exactly one tool_call per turn (last.tool_calls[0]) —
    # it has to, since a confirm/clarify interrupt suspends the whole node mid-dispatch
    # and there's nowhere to stash unanswered tool_call_ids across that pause. If the
    # model parallel-calls 2+ tools in one AIMessage, calls after the first are silently
    # dropped (never get a ToolMessage), which permanently corrupts the thread — every
    # later turn re-sends that dangling AIMessage and every provider rejects it with
    # "assistant message with tool_calls must be followed by tool messages...". Force
    # one-call-per-turn here rather than trying to make permission_gate loop-safe across
    # an interrupt boundary.
    primary = providers.build_chat(cfg["primary"]).bind_tools(allowed, parallel_tool_calls=False)
    if cfg.get("fallback"):
        primary = primary.with_fallbacks(
            [providers.build_chat(cfg["fallback"]).bind_tools(allowed, parallel_tool_calls=False)]
        )
    _LLM_CACHE[key] = primary
    return primary


def _structured_llm(cfg: dict, schema, **kw):
    """An unbound structured-output runnable (primary + fallback) for side
    tasks like the plan advisor — no tool schemas attached."""
    primary = providers.build_chat(cfg["primary"]).with_structured_output(schema, **kw)
    if cfg.get("fallback"):
        fb = providers.build_chat(cfg["fallback"]).with_structured_output(schema, **kw)
        return primary.with_fallbacks([fb])
    return primary


class ChatTitleOutput(BaseModel):
    title: str = Field(description="A short (3-6 word) title-case summary of what this "
                                    "conversation is about. No quotes, no trailing punctuation.")


async def generate_chat_title(
    first_user_message: str, first_assistant_reply: str, tenant_id: str | None,
    transcript: str = "", avoid: list[str] | None = None,
) -> str:
    """A short, cheap side-task exactly like the plan advisor (Top5PlansOutput
    below) — bare structured-output call, no tool schemas — run once per
    conversation, right after its first exchange, so the sidebar can show a
    real title instead of the first message truncated."""
    try:
        cfg = await providers.resolve()
        llm = _structured_llm(cfg, ChatTitleOutput, include_raw=True)
        prompt = ChatPromptTemplate.from_messages([
            ("system", "Summarize what this conversation is about in a short, specific, "
                       "title-case title (3-6 words). No quotes, no trailing period. "
                       "Many conversations here are the same kind of task, so lead with whatever "
                       "tells this one apart — the person's or company's name, a case number, "
                       "or the exact outcome — rather than the generic task. "
                       "Do not reuse any of these existing titles: {avoid}"),
            ("user", "{body}"),
        ])
        if transcript.strip():
            body = f"Conversation:\n{transcript[:3500]}"
        else:
            body = f"User: {(first_user_message or '')[:500]}\n\nAssistant: {(first_assistant_reply or '')[:500]}"
        raw = await (prompt | llm).ainvoke({
            "body": body,
            "avoid": "; ".join((avoid or [])[:40]) or "(none)",
        })
        usage.record(raw.get("raw"), service_name=usage.SERVICE_CHAT_TITLE, tenant_id=tenant_id)
        parsed = raw.get("parsed")
        if parsed and parsed.title.strip():
            return parsed.title.strip().strip('"')
    except Exception as e:
        print(f"Failed to generate chat title: {e}")
    fallback = (first_user_message or "").strip()
    return (fallback[:40] + "…" if len(fallback) > 40 else fallback) or "New Conversation"


def _recent_text(messages: list, limit: int = 6) -> list[str]:
    """Plain text of the last few messages, for domain keyword matching."""
    out: list[str] = []
    for m in messages[-limit:]:
        content = getattr(m, "content", "")
        if isinstance(content, str):
            out.append(content)
        elif isinstance(content, list):
            out.extend(b.get("text", "") for b in content if isinstance(b, dict))
        for tc in (getattr(m, "tool_calls", None) or []):
            out.append(tc.get("name", ""))
    return out


def _is_empty(response: AIMessage) -> bool:
    """A completion with no text and no tool call.

    Gemini does this on some terse imperatives — "List all rule sets" returns
    finish_reason STOP with zero output tokens, while the same request phrased
    as a question works. Whatever the cause, it must never reach the user as
    silence: `_route_after_agent` sends a no-tool-call response straight to END
    and routers/chat.py emits no `token` event for empty content, so the chat
    would simply sit there having apparently ignored them.
    """
    if response.tool_calls:
        return False
    content = response.content
    if isinstance(content, list):
        content = "".join(b.get("text", "") for b in content if isinstance(b, dict))
    return not (content or "").strip()


_EMPTY_NUDGE = (
    "Answer the user's last message. If a tool can fetch what they asked for, call it now; "
    "otherwise reply in one or two sentences. Do not return an empty response."
)

_EMPTY_FALLBACK = (
    "Sorry — I didn't manage to put that into words. Could you rephrase it, "
    "or tell me which record or page you'd like me to open?"
)


async def _retry_empty(llm, messages, state, thread_id) -> AIMessage:
    """One nudged retry, then a plain-English fallback so the turn always says
    something. Only fires on the degenerate path, so it costs nothing in the
    normal case."""
    retried = await llm.ainvoke([*messages, SystemMessage(content=_EMPTY_NUDGE)])
    usage.record(retried, tenant_id=state.get("tenant_id"), thread_id=thread_id)
    if not _is_empty(retried):
        return retried
    return AIMessage(content=_EMPTY_FALLBACK)


# The button after a corporate is saved asks to carry on with that exact company's group scheme. Which tool answers
# that is not a judgement call, and a model that "remembers" an earlier result instead of looking at the scheme again
# reports a stale status — so the call is made here, without the model.
_CONTINUE_GROUP_RE = re.compile(
    r"^\s*continue the group scheme journey for (?P<name>.+?) \(organization id (?P<id>[0-9a-fA-F-]{36})\)\s*$", re.I)


def _direct_group_continue(state: ChatState) -> dict | None:
    last = state["messages"][-1] if state.get("messages") else None
    if not isinstance(last, HumanMessage) or not isinstance(last.content, str):
        return None
    m = _CONTINUE_GROUP_RE.match(last.content)
    if not m:
        return None
    call = {"name": "continue_group_journey", "id": f"direct-{uuid.uuid4().hex[:12]}", "type": "tool_call",
            "args": {"organization_name": m.group("name").strip(), "organization_id": m.group("id")}}
    return {"messages": [AIMessage(content="", tool_calls=[call])], "active_domains": ["group"],
            "group_current_org_id": m.group("id"), "group_current_org_name": m.group("name").strip()}


async def agent_node(state: ChatState, config: RunnableConfig | None = None) -> dict:
    direct = _direct_group_continue(state)
    if direct is not None:
        return direct
    user_role = state.get("user_role") or "Admin"
    platform = state.get("platform") or "web"

    # Bind only the tools this conversation is plausibly about — see toolsets.py.
    sticky = state.get("active_domains") or []
    domains = frozenset(select_domains(_recent_text(state["messages"]), sticky))

    # Trim before sending. Without this the whole thread is re-sent every turn
    # and a long conversation's input cost climbs without any ceiling.
    history = trim_history(state["messages"])
    messages = [SystemMessage(content=_build_prompt(user_role, platform, domains)), *history]

    cfg = await providers.resolve()
    llm = _llm(cfg, user_role, platform, domains)
    thread_id = ((config or {}).get("configurable") or {}).get("thread_id")

    # The primary model intermittently 429s/503s (and right now: 403s on a
    # billing block) — one failed call must not kill a live conversation turn.
    # `_llm()` already fails each call over to the configured fallback provider;
    # this loop then retries the whole pair with short exponential backoff
    # before giving up. It is the ONLY retry layer (providers.build_chat forces
    # max_retries=0 on every model).
    last_exc: Exception | None = None
    rate_limited = False
    for attempt in range(3):
        try:
            response = await llm.ainvoke(messages)
            usage.record(
                response,
                tenant_id=state.get("tenant_id"),
                thread_id=thread_id,
            )
            if _is_empty(response):
                response = await _retry_empty(llm, messages, state, thread_id)
            if isinstance(response, AIMessage) and len(response.tool_calls) > 1:
                # permission_gate only ever dispatches tool_calls[0] (it must —
                # a confirm/clarify interrupt suspends the node mid-dispatch with
                # nowhere to stash the rest). A provider that parallel-calls
                # anyway (Gemini ignores parallel_tool_calls=False; nothing
                # upstream truncates) would otherwise leave tool_calls[1:]
                # permanently unanswered — which every provider then rejects on
                # every later turn, since the dangling AIMessage is checkpointed.
                # Drop the extras here, before they ever reach persisted state.
                dropped = [tc["name"] for tc in response.tool_calls[1:]]
                logger.warning(
                    "agent_node: model emitted %d parallel tool_calls, keeping only "
                    "tool_calls[0] (%s) — dropping %r before persisting",
                    len(response.tool_calls), response.tool_calls[0]["name"], dropped,
                )
                response = response.model_copy(update={
                    "tool_calls": response.tool_calls[:1],
                    "invalid_tool_calls": [],
                })
            return {"messages": [response], "active_domains": sorted(domains)}
        except Exception as exc:  # noqa: BLE001 — SDK raises provider-specific types
            last_exc = exc
            text = str(exc)
            logger.warning("agent_node LLM call failed (attempt %d): %r", attempt, exc)
            # Quota/billing exhaustion and rate limits aren't transient in a way
            # a 1.5s backoff fixes — retrying just burns more calls against the
            # same exhausted key. Fail fast with the real cause.
            if "RESOURCE_EXHAUSTED" in text or "prepayment credits" in text:
                raise RuntimeError(
                    "The AI model is out of quota (prepayment credits depleted on the Gemini API key). "
                    "This needs billing topped up at https://ai.studio/projects — resending won't help."
                ) from exc
            # 403 with a "dunning" decision = the Gemini project is blocked for
            # a billing/payment problem. Not transient; if this reaches here the
            # OpenAI fallback is unset or also failing.
            if "PERMISSION_DENIED" in text or "dunning" in text:
                raise RuntimeError(
                    "The AI model is unavailable — the Gemini API key's project is blocked "
                    "(billing / payment issue) and no working fallback is configured. "
                    "Fix Gemini billing or set OPENAI_API_KEY."
                ) from exc
            lowered = text.lower()
            # A 400 means *our request* is malformed (too many tools, bad schema…).
            # Resending the same request can't help, and "briefly overloaded" would
            # hide the real cause — surface it.
            if "invalid_request_error" in lowered or "array_above_max_length" in lowered:
                raise RuntimeError(
                    "The AI provider rejected the request as invalid, so resending won't help. "
                    f"Details: {text[:300]}"
                ) from exc
            # OpenAI reports an empty account as HTTP 429 too ("insufficient_quota" /
            # "credit_balance_exhausted"), so a bare "429" check calls it a rate limit
            # and tells the user to wait — which can never fix it.
            if (
                "insufficient_quota" in lowered
                or "credit_balance_exhausted" in lowered
                or "no credits remaining" in lowered
                or "exceeded your current quota" in lowered
            ):
                raise RuntimeError(
                    "The AI model's account is out of credits (the provider reports no credits remaining). "
                    "This isn't a rate limit — resending won't help. An admin needs to add credits with the "
                    "provider, or set a fallback model under Platform → LLM Configuration."
                ) from exc
            if "429" in text or "rate limit" in lowered:
                # A genuine rate limit (requests/tokens per minute) clears on its own,
                # so wait and retry rather than failing the turn on the first hit.
                rate_limited = True
                if attempt < 2:
                    await asyncio.sleep(2.0 * (attempt + 1))
                    continue
                break
            if attempt < 2:
                await asyncio.sleep(1.5 * (attempt + 1))
    if rate_limited:
        raise RuntimeError(
            "The AI model is rate-limited right now. Give it a moment and resend that message."
        ) from last_exc
    raise RuntimeError(
        "The AI model is briefly overloaded — please resend that message."
    ) from last_exc


def _route_after_agent(state: ChatState) -> str:
    last = state["messages"][-1]
    if isinstance(last, AIMessage) and last.tool_calls:
        return "permission_gate"
    return END


def _tool_result_message(name: str, call_id: str, result: dict) -> ToolMessage:
    # Compact before it reaches the checkpointer: whatever goes in here is
    # re-sent to the model on every later turn of this thread. The UI has
    # already been handed the full result via the SSE stream by this point.
    return ToolMessage(
        content=json.dumps(compact_tool_result(result), default=str),
        tool_call_id=call_id,
        name=name,
    )


# Tools that hand control to the autonomous journey pipeline instead of a
# single REST call. Routed via Command(goto=...) below.
JOURNEY_TOOLS = {"start_underwriting_journey", "continue_underwriting_journey"}
CLAIM_JOURNEY_TOOLS = {"start_claim_journey", "continue_claim_journey"}
GROUP_JOURNEY_TOOLS = {"start_group_journey", "continue_group_journey"}
# Create calls that take agent_name — the agent chosen up front is injected here.
LEAD_INTAKE_TOOLS = {
    "add_customer", "add_organization", "add_family_group",
    "quick_start_workflow", "start_underwriting_journey",
}


class Top5PlansOutput(BaseModel):
    plan_names: list[str] = Field(description="List of top 5 exact plan names (the 'name' or 'label' field), sorted from most to least recommended.")

# ═══════════════════════════════════════════════════════════════════════════
# Proactive prerequisite resolution
#
# The rule this whole section is built around: never answer a missing
# prerequisite with an instruction to go and do something first. "Create a
# category before you can create a rule set", "which policy is this claim
# against?", "what status should it move to?" are all dead ends in a chat
# window — they hand the work back to the user as typing.
#
# Instead every prerequisite is resolved as a CHOICE the user clicks:
#
#   few, fixed options   -> chips (the existing clarify `options` path)
#   a long live list     -> one dropdown (the `select` quick action)
#   nothing exists yet   -> a "create one now" chip that runs the creating tool
#
# `_ask_choice` is the single place that decides which of those to render, so
# every interceptor below reads as "fetch the real options, ask, resolve".
# ═══════════════════════════════════════════════════════════════════════════

# Above this many options, chips stop being a menu and become a wall of text.
_CHIP_LIMIT = 6

# Acquisition source types as the platform names them (AcquisitionSourceType),
# in the order they should be offered.
_SOURCE_TYPE_ORDER = ["AGENT", "BROKER", "BANCASSURANCE", "CORPORATE_AGENT", "DIRECT", "DIGITAL"]
_SOURCE_TYPE_LABELS = {
    "AGENT": "Agent",
    "BROKER": "Broker",
    "BANCASSURANCE": "Bancassurance",
    "CORPORATE_AGENT": "Corporate Agent",
    "DIRECT": "Walk-in",
    "DIGITAL": "Digital",
}


def _source_covers_agent(source: dict | None) -> bool:
    """Once a specific acquisition source has been picked (an Agent, a Broker, …) it
    stands in for "who owns this customer", so that isn't asked as a third question.
    Only when the user chose "No acquisition source" is an agent still asked for."""
    return bool(source) and bool(source.get("id"))


def _source_echo(source: dict) -> str:
    """"Source selected: Agent — Arslan Amjad (67678)." — says what was picked, since
    a dropdown selection adds no chat bubble of its own."""
    kind = f"{source['type']} — " if source.get("type") else ""
    return f"Source selected: **{kind}{source['name']}**."


def _ask_choice(
    name: str,
    args: dict,
    question: str,
    choices: list,
    *,
    select_label: str = "Select",
    placeholder: str = "Choose one…",
    extra_actions: list | None = None,
    force_select: bool = False,
) -> str:
    extras = list(extra_actions or [])
    payload: dict = {
        "kind": "clarify",
        "tool_call": {"name": name, "args": args},
        "question": question,
    }
    use_select = force_select or len(choices) > _CHIP_LIMIT or (select_label and select_label != "Select")
    if use_select:
        payload["custom_actions"] = [
            {
                "label": select_label,
                "actionType": "select",
                "payload": "{value}",
                "placeholder": placeholder,
                "options": [{"label": display, "value": display} for display, _ in choices],
            },
            *extras,
        ]
    elif not extras:
        payload["options"] = [display for display, _ in choices]
    else:
        payload["custom_actions"] = [
            {"label": display, "actionType": "submit", "payload": display}
            for display, _ in choices
        ] + extras
    return str(interrupt(payload)).strip()


def _match_choice(answer: str, choices: list):
    """Resolve an answer back to the value it stood for.

    Exact display match first, then a containment match in either direction —
    the user may have typed rather than clicked, and a chip label can be
    truncated by the renderer.
    """
    needle = (answer or "").strip().lower()
    if not needle:
        return None
    for display, value in choices:
        if display.strip().lower() == needle:
            return value
    for display, value in choices:
        low = display.strip().lower()
        if needle in low or low in needle:
            return value
    return None


def _is(answer: str, sentinel: str) -> bool:
    """Did the user click this particular escape-hatch chip?"""
    a = (answer or "").strip().lower()
    s = sentinel.strip().lower()
    return a == s or (len(a) > 4 and a in s) or (len(s) > 4 and s in a)


# ═══════════════════════════════════════════════════════════════════════════
# Rule condition builder — the chat equivalent of the portal's
# CriteriaGroupBuilder/FieldSearchSelect. Field, comparison and value are each
# picked from a dropdown/chips built from the SAME vocabulary the rule
# evaluator actually understands (services/tenant-service/rule_evaluator.py),
# not free text — so a rule authored in chat behaves identically to one built
# in the Rule Engine UI, and edits go through the same picker rather than a
# vague "what should change?" prose question.
# ═══════════════════════════════════════════════════════════════════════════

# Mirrors frontend/components/rule-engine/constants.ts's GROUPED_FIELDS so the
# chat picker offers exactly the fields the portal does.
FIELD_CHOICES: list[tuple[str, str]] = [
    ("Applicant Age (age)", "age"),
    ("Entry Age (entry_age)", "entry_age"),
    ("Smoker Status (is_smoker)", "is_smoker"),
    ("Body Mass Index (bmi)", "bmi"),
    ("Occupation (occupation)", "occupation"),
    ("Sum Assured (sum_assured)", "sum_assured"),
    ("Proposed Sum Assured (proposed_sum_assured)", "proposed_sum_assured"),
    ("Total Sum At Risk (total_sum_at_risk)", "total_sum_at_risk"),
    ("Declared Income (declared_income)", "declared_income"),
    ("Annual Premium (annual_premium)", "annual_premium"),
    ("AI Risk Score 0-100 (composite_score)", "composite_score"),
    ("Insurance History Score (score)", "score"),
    ("Adverse Disclosure (has_adverse_disclosure)", "has_adverse_disclosure"),
    ("Facultative Required (facultative_required)", "facultative_required"),
    ("UN/SECP Sanctions Match (sanctions_matched)", "sanctions_matched"),
    ("Politically Exposed Person (is_pep)", "is_pep"),
    ("Compliance Status (compliance_status)", "compliance_status"),
    ("Policy Category (category)", "category"),
    ("Policy Duration Year (policy_year)", "policy_year"),
    ("Premium Type (premium_type)", "premium_type"),
]
FIELD_LABELS: dict[str, str] = {field: label.split(" (")[0] for label, field in FIELD_CHOICES}

# Matches rule_evaluator.py's recognized operators exactly (field_gt/field_gte
# — cross-field comparisons — are left out: rare enough that free-form
# description + the model's own JSON authoring, the pre-existing path, covers
# them fine).
OPERATOR_CHOICES: list[tuple[str, str]] = [
    ("Is greater than (>)", "gt"),
    ("Is at least (≥)", "gte"),
    ("Is less than (<)", "lt"),
    ("Is at most (≤)", "lte"),
    ("Is equal to (=)", "eq"),
    ("Is not equal to (≠)", "neq"),
    ("Is between", "between"),
    ("Is one of (list)", "in_set"),
]

OUTCOME_CHOICES: list[tuple[str, str]] = [
    ("Require a medical exam", "REQUIRE_MEDICAL_EXAM"),
    ("Waive the medical exam", "WAIVE_MEDICAL"),
    ("Apply a premium loading", "APPLY_LOADING"),
    ("Decline the application", "DECLINE"),
    ("Refer to the underwriter", "REFER_TO_UNDERWRITER"),
    ("Attach an exclusion clause", "EXCLUSION"),
]

# Fields whose only sensible values are true/false — offered as two chips
# instead of a "type a number" prompt.
BOOLEAN_FIELDS = {
    "is_smoker", "is_pep", "sanctions_matched", "has_adverse_disclosure",
    "facultative_required",
}

# Realistic starting points per field so most rules never need typed input at
# all; fields without a preset still work — the clarify interrupt always
# accepts free text as a fallback even when chips are shown.
VALUE_PRESETS: dict[str, list[str]] = {
    "age": ["40", "45", "50", "55", "60", "65", "70"],
    "entry_age": ["18", "25", "35", "45", "55", "65"],
    "bmi": ["25", "27.5", "30", "32.5", "35", "40"],
    "sum_assured": ["1000000", "5000000", "10000000", "20000000", "50000000"],
    "proposed_sum_assured": ["1000000", "5000000", "10000000", "20000000"],
    "total_sum_at_risk": ["5000000", "10000000", "20000000", "50000000"],
    "declared_income": ["500000", "1000000", "2000000", "5000000"],
    "annual_premium": ["25000", "50000", "100000", "250000"],
    "composite_score": ["30", "50", "70", "90"],
    "score": ["30", "50", "70", "90"],
    "policy_year": ["1", "2", "3", "5", "10"],
}

_OP_WORDS = {
    "gt": "over", "gte": "at least", "lt": "under", "lte": "at most",
    "eq": "equal to", "neq": "not equal to", "between": "between", "in_set": "one of",
}


def _condition_json(field: str, operator: str, value: str) -> str:
    """Build the one-condition conditions_json array add_rule_to_version /
    update_rule expect, from the picker's plain (field, operator, value)."""
    if operator == "between":
        parts = [p.strip() for p in str(value).split(",", 1)]
        lo = _as_float(parts[0]) if parts else None
        hi = _as_float(parts[1]) if len(parts) > 1 else None
        return json.dumps([{"field": field, "operator": "between", "value": [lo, hi]}])
    if operator == "in_set":
        items = [v.strip() for v in str(value).split(",") if v.strip()]
        return json.dumps([{"field": field, "operator": "in_set", "value": items}])
    text = str(value).strip()
    if text.lower() in ("true", "false"):
        return json.dumps([{"field": field, "operator": operator, "value": text.lower() == "true"}])
    parsed = _as_float(text)
    return json.dumps([{"field": field, "operator": operator, "value": parsed if parsed is not None else text}])


def _derive_rule_naming(field: str, operator: str, value: str, outcome: str) -> tuple[str, str]:
    """Auto-generate rule_code and name from the picked condition — nobody
    should have to invent a code like MED-NML-07 by hand."""
    field_label = FIELD_LABELS.get(field, field.replace("_", " ").title())
    op_word = _OP_WORDS.get(operator, operator)
    outcome_label = dict(OUTCOME_CHOICES).get(outcome, outcome.replace("_", " ").title())
    name = f"{field_label} {op_word} {value} → {outcome_label}"
    slug_value = re.sub(r"[^A-Za-z0-9]+", "-", str(value)).strip("-").upper()[:12] or "X"
    rule_code = f"{field.upper().replace('_', '-')}-{operator.upper()}-{slug_value}"[:40]
    return rule_code, name


async def _ask_field(name: str, args: dict, *, context: str = "") -> str:
    prefix = f"{context}\n\n" if context else ""
    answer = _ask_choice(
        name, args, prefix + "Which field should this condition check?",
        FIELD_CHOICES, select_label="Field", placeholder="Pick a field…",
    )
    return _match_choice(answer, FIELD_CHOICES) or answer.strip()


async def _ask_operator(name: str, args: dict, field: str) -> str:
    label = FIELD_LABELS.get(field, field)
    answer = _ask_choice(
        name, args, f"How should **{label}** compare?",
        OPERATOR_CHOICES, select_label="Comparison", placeholder="Pick a comparison…",
    )
    return _match_choice(answer, OPERATOR_CHOICES) or "gt"


async def _ask_value(name: str, args: dict, field: str, operator: str) -> str:
    label = FIELD_LABELS.get(field, field)
    if field in BOOLEAN_FIELDS:
        bool_choices = [("True", "true"), ("False", "false")]
        answer = _ask_choice(name, args, f"Should **{label}** be true or false?", bool_choices)
        return _match_choice(answer, bool_choices) or answer.strip().lower()

    presets = VALUE_PRESETS.get(field, [])
    if operator == "between":
        bounds = [(p, p) for p in presets] or []
        low = await _ask_value_single(name, args, f"What is the LOWER bound for **{label}**?", bounds)
        high = await _ask_value_single(name, args, f"What is the UPPER bound for **{label}**?", bounds)
        return f"{low},{high}"
    if operator == "in_set":
        answer = _ask_choice(
            name, args,
            f"Which values should **{label}** match? List them separated by commas "
            "(e.g. `Pilot, Miner, Offshore Worker`).",
            [],
        )
        return answer.strip()
    return await _ask_value_single(name, args, f"What value should **{label}** be compared to?", [(p, p) for p in presets])


async def _ask_value_single(name: str, args: dict, question: str, choices: list[tuple[str, str]]) -> str:
    answer = _ask_choice(
        name, args, question, choices,
        select_label="Value", placeholder="Pick a value…",
    ) if choices else _ask_choice(name, args, question, [])
    return _match_choice(answer, choices) or answer.strip()


async def _ask_condition(name: str, args: dict, *, context: str = "") -> tuple[str, str, str]:
    """Field → comparison → value, entirely via dropdowns/chips. Returns the
    plain (field, operator, value) triple; callers turn it into JSON."""
    field = await _ask_field(name, args, context=context)
    if field in BOOLEAN_FIELDS:
        value = await _ask_value(name, args, field, "eq")
        return field, "eq", value
    operator = await _ask_operator(name, args, field)
    value = await _ask_value(name, args, field, operator)
    return field, operator, value


async def _ask_outcome(name: str, args: dict, *, keep_label: Optional[str] = None) -> tuple[str, Optional[dict]]:
    """What should happen when the rule matches. `keep_label`, when given,
    adds a "keep the current outcome" shortcut at the top — used when editing
    a rule whose outcome the user probably isn't touching."""
    choices = list(OUTCOME_CHOICES)
    keep_sentinel = ("Keep the current outcome" + (f" ({keep_label})" if keep_label else ""), "__KEEP__")
    if keep_label is not None:
        choices = [keep_sentinel] + choices
    answer = _ask_choice(
        name, args, "What should happen when this rule matches?",
        choices, select_label="Outcome", placeholder="Pick an outcome…",
    )
    outcome = _match_choice(answer, choices)
    if outcome == "__KEEP__":
        return "__KEEP__", None
    outcome = outcome or "REFER_TO_UNDERWRITER"
    if outcome == "APPLY_LOADING":
        pct_choices = [("10%", "10"), ("15%", "15"), ("20%", "20"), ("25%", "25"), ("50%", "50")]
        pct_answer = _ask_choice(name, args, "What loading percentage should apply?", pct_choices)
        pct = _match_choice(pct_answer, pct_choices) or pct_answer.strip()
        pct_val = _as_float(pct)
        return outcome, ({"extra_mortality_pct": pct_val} if pct_val is not None else None)
    return outcome, None


_NEW_CATEGORY = "➕ Create a new category"
_NEW_SUBCATEGORY = "➕ Create a new subcategory"

# Tools whose only mandatory argument is a rule set's dotted code. Asking for
# that as free text means asking the user to remember "medical.nml_grid".
_RULE_SET_CODE_TOOLS = {
    "get_rule_set",
    "evaluate_rule_set",
    "create_rule_version",
    "add_rule_to_version",
    "update_rule",
    "delete_rule",
    "deploy_rule_version",
    "archive_rule_version",
}

# Claims tools that operate on one claim and can be pointed at it by a picker
# when the user said "settle it" without naming which. Deliberately excludes
# register_claim (there is no claim yet) and the journey tools (their own
# intake stage resolves or opens one).
_CLAIM_LOOKUP_TOOLS = {
    "get_claim_details",
    "get_claim_document_checklist",
    "update_claim_status",
    "adjudicate_claim",
    "issue_claim_payout",
    "refer_claim_to_reinsurance",
    "refer_claim_to_underwriting",
    "resolve_claim_underwriting",
    "upload_claim_document",
}


async def _claimable_policies(ctx: ExecCtx) -> list:
    """Policies a claim can be filed against — empty list if the lookup fails,
    since a picker that could not be built must never block the call."""
    try:
        return await fetch_claimable_policies(ctx)
    except Exception:
        return []


async def _peek_claim(args: dict, ctx: ExecCtx) -> Optional[dict]:
    """Read the claim so the gate can offer only moves that will succeed.

    Returns None on any failure — a picker that could not be built is never a
    reason to block the call; the tool's own error path still applies.
    """
    try:
        res = await execute_tool(
            "get_claim_details",
            {"claim_number": args.get("claim_number"), "claimant_name": args.get("claimant_name")},
            ctx,
        )
        return res.get("claim") if res.get("success") else None
    except Exception:
        return None


async def _catalogue_tree(ctx: ExecCtx) -> list:
    try:
        res = await execute_tool("list_rule_categories", {}, ctx)
        return res.get("categories") or []
    except Exception:
        return []


def _slugify(text: str) -> str:
    """"Claims Governance" -> "CLAIMS_GOVERNANCE" — the catalogue's code
    convention, which a user typing a name will never follow."""
    cleaned = "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in (text or ""))
    return "_".join(part.upper() for part in cleaned.split())[:60]


async def _ensure_category(name: str, args: dict, ctx: ExecCtx, cats: list):
    """Resolve args["category_code"] to a real category, offering to create one
    when it does not exist. Returns the category dict, or None if creation was
    attempted and failed (the caller then lets the tool report the failure).
    """
    provided = (args.get("category_code") or "").strip()
    match = next((c for c in cats if (c.get("code") or "").upper() == provided.upper()), None)
    if match:
        return match

    if not cats:
        # Nothing exists at all — the only honest option is to create one, so
        # offer that rather than a picker over an empty list.
        suggested = args.get("category_code") or args.get("name") or "Governance"
        offer = [(f"Create “{suggested}”", suggested),
                 ("Claims Governance", "Claims Governance"),
                 ("Underwriting Governance", "Underwriting Governance")]
        answer = _ask_choice(
            name, args,
            "The rule catalogue is empty — there are no categories yet. "
            "Which one shall I create to file this under?",
            offer,
        )
        chosen_name = _match_choice(answer, offer) or answer
        created = await execute_tool(
            "create_rule_category",
            {"code": _slugify(str(chosen_name)), "name": str(chosen_name)},
            ctx,
        )
        return created.get("category") if created.get("success") else None

    choices = [(f"{c.get('name')} ({c.get('code')})", c) for c in cats]
    answer = _ask_choice(
        name, args,
        "Which **category** should this be filed under?",
        choices,
        select_label="Category",
        placeholder="Pick a category…",
        extra_actions=[{"label": _NEW_CATEGORY, "actionType": "submit", "payload": _NEW_CATEGORY}],
    )

    if not _is(answer, _NEW_CATEGORY):
        resolved = _match_choice(answer, choices)
        if resolved:
            return resolved

    suggestions = [("Claims Governance", "Claims Governance"),
                   ("Retention & Treaty", "Retention & Treaty"),
                   ("Distribution Compliance", "Distribution Compliance"),
                   ("Product Eligibility", "Product Eligibility")]
    new_name = _ask_choice(
        name, args,
        "What should the new category be called? Pick one of these, or type your own name.",
        suggestions,
    )
    resolved_name = _match_choice(new_name, suggestions) or new_name
    created = await execute_tool(
        "create_rule_category",
        {"code": _slugify(str(resolved_name)), "name": str(resolved_name)},
        ctx,
    )
    return created.get("category") if created.get("success") else None


async def _ensure_subcategory(name: str, args: dict, ctx: ExecCtx, category: dict):
    """Same contract as _ensure_category, one level down."""
    subs = category.get("subcategories") or []
    provided = (args.get("subcategory_code") or "").strip()
    match = next((s for s in subs if (s.get("code") or "").upper() == provided.upper()), None)
    if match:
        return match

    default_name = args.get("name") or f"{category.get('name')} Rules"
    suggestions = [(default_name, default_name),
                   ("Non-Medical Limits", "Non-Medical Limits"),
                   ("Death Benefit", "Death Benefit"),
                   ("Eligibility Gates", "Eligibility Gates")]

    if not subs:
        answer = _ask_choice(
            name, args,
            f"**{category.get('name')}** has no subcategories yet, and rule sets attach to one. "
            "Which shall I create?",
            suggestions,
        )
        chosen = _match_choice(answer, suggestions) or answer
    else:
        choices = [(f"{s.get('name')} ({s.get('code')})", s) for s in subs]
        answer = _ask_choice(
            name, args,
            f"Which **subcategory** of {category.get('name')}?",
            choices,
            select_label="Subcategory",
            placeholder="Pick a subcategory…",
            extra_actions=[{"label": _NEW_SUBCATEGORY, "actionType": "submit", "payload": _NEW_SUBCATEGORY}],
        )
        if not _is(answer, _NEW_SUBCATEGORY):
            resolved = _match_choice(answer, choices)
            if resolved:
                return resolved
        follow_up = _ask_choice(
            name, args, "What should the new subcategory be called?", suggestions,
        )
        chosen = _match_choice(follow_up, suggestions) or follow_up

    created = await execute_tool(
        "create_rule_subcategory",
        {"category_code": category.get("code"), "code": _slugify(str(chosen)), "name": str(chosen)},
        ctx,
    )
    if not created.get("success"):
        return None
    # A freshly created subcategory carries no eligibility profiles; give it the
    # shape the catalogue endpoint returns so the caller can read it uniformly.
    return {**(created.get("subcategory") or {}), "eligibility_profiles": []}


async def permission_gate(state: ChatState) -> Command:
    last = state["messages"][-1]
    # One action per turn — matches the platform's existing "ask, then act"
    # convention rather than letting the model batch several mutations at once.
    tool_call = last.tool_calls[0]
    name, args, call_id = tool_call["name"], tool_call["args"], tool_call["id"]
    platform = state.get("platform") or "web"
    ctx = ExecCtx(tenant_id=state["tenant_id"], jwt_token=state["jwt_token"], role=state.get("user_role") or "Agent",
                  current_org_id=state.get("group_current_org_id"))
    # A group tool called with an explicit organization id is that corporate being chosen: remember it.
    remember: dict = {}
    if name in GROUP_TOOLS and args.get("organization_id"):
        remember = {"group_current_org_id": str(args["organization_id"]),
                    "group_current_org_name": args.get("organization_name") or state.get("group_current_org_name")}

    def back_to_agent(update: dict) -> Command:
        return Command(goto="agent", update={**update, **remember})

    if not is_role_allowed(name, state["user_role"], platform):
        if platform == "mobile" and name in MOBILE_PORTAL_ONLY_TOOLS:
            msg = (
                "This app covers onboarding through Gate 6 (Medical Examination). "
                "Once the medical exam is booked, AI Risk Assessment and everything after it "
                "— review, approval, and policy issuance — happens on the web portal. "
                "Please continue there for this step."
            )
        else:
            seen_role = state.get("user_role") or "none (not sent by the client)"
            msg = (
                f"Currently, you have no access to do this — this session is identified as role "
                f"'{seen_role}'. If that isn't your real role, try logging out and back in; "
                "otherwise ask your manager."
            )
        result = {"success": False, "error": msg}
        return back_to_agent({"messages": [_tool_result_message(name, call_id, result)]})

    # An agent picked at the start of intake rides along on the create call.
    # Cleared once consumed so a later, unrelated "add a customer" asks again.
    consumed_lead_agent = False
    if name in LEAD_INTAKE_TOOLS and (
        state.get("lead_agent") or state.get("lead_source") is not None or state.get("lead_intake")
    ):
        consumed_lead_agent = True
        # "Add demo data" in the guided intake creates the demo customer with a Draft
        # proposal and hands over to the proposal steps. The model sometimes sets
        # full_journey, which instead auto-runs case, proposal and all six gates and
        # lands on risk assessment — a different, shorter route that depended on its
        # mood. Inside the intake it is never wanted, so it is never allowed.
        if name == "quick_start_workflow":
            args["full_journey"] = False
        if state.get("lead_agent") and not args.get("agent_name") and not args.get("agent_email"):
            args["agent_name"] = state["lead_agent"]
        # Individuals, families and organizations all carry the acquisition source;
        # family members and employees inherit it from their group.
        source_id = (state.get("lead_source") or {}).get("id")
        if source_id and not args.get("acquisition_source_id"):
            args["acquisition_source_id"] = source_id
        # A chosen source stands in for the agent: use its login account if it has
        # one, otherwise leave the lead unassigned rather than asking again.
        if _source_covers_agent(state.get("lead_source")) and not (args.get("agent_name") or args.get("agent_email")):
            if (state.get("lead_source") or {}).get("user_id"):
                args["agent_id"] = state["lead_source"]["user_id"]
            else:
                args["no_agent"] = True

    # ── Customer intake: which kind of customer, as chips rather than prose ──
    #
    # add_customer / add_organization / add_family_group are three distinct
    # tools with three distinct required-args shapes, so the model can't just
    # call one of them speculatively when the user hasn't said which kind of
    # customer they mean — it has nothing valid to put in the call. Before this
    # existed, the prompt told the model to ask in plain text instead, which
    # meant that one question alone never went through permission_gate and
    # never became a clickable choice like everything else in this file.
    # resolve_customer_type is a standalone tool that exists only so this
    # question has something to intercept.
    if name == "resolve_customer_type":
        # Who owns this customer is the first thing asked — before the type and
        # before any details — rather than surfacing as a picker only once the
        # create tool runs. An Agent is their own lead's owner, so never asked.
        is_agent_role = (ctx.role or "").strip().lower() == "agent"

        # Where the customer came from is the very first question, then who owns
        # them, then what kind of customer. Each is skipped when it doesn't apply
        # (an Agent is their own lead's owner; roles that can't read the sources
        # list get no source question).
        source_rows: list = []
        agent_rows: list = []
        if not is_agent_role:
            source_rows = (await execute_tool("list_acquisition_sources", {}, ctx)).get("sources") or []
            agent_rows = (await execute_tool("list_agent_users", {}, ctx)).get("agents") or []
        no_source_label = "No acquisition source"
        # Active sources grouped by their type (Agent, Broker, …), in a stable order.
        sources_by_type: dict[str, list] = {}
        for r in source_rows:
            sources_by_type.setdefault(r.get("type") or "OTHER", []).append(r)
        type_choices = [
            (_SOURCE_TYPE_LABELS.get(t, t.replace("_", " ").title()), t)
            for t in _SOURCE_TYPE_ORDER if t in sources_by_type
        ] + [
            (_SOURCE_TYPE_LABELS.get(t, t.replace("_", " ").title()), t)
            for t in sources_by_type if t not in _SOURCE_TYPE_ORDER
        ]
        source_choices = (type_choices + [(no_source_label, "")]) if type_choices else []
        agent_choices = [(f"{a['name']} ({a['email']})", a["name"] or a["email"]) for a in agent_rows]

        # (display, tool to call next, url slug for the leads-page form chooser)
        choices = [
            ("Individual", "add_customer", "individual"),
            ("Corporate (Organization)", "add_organization", "corporate"),
            ("Family group", "add_family_group", "family"),
        ]
        go_back_chip = {"label": "← Go back", "actionType": "submit", "payload": "Go back"}
        order = [k for k, present in (("source", bool(source_choices)), ("agent", bool(agent_choices)), ("type", True)) if present]

        # Coming back from the next step ("How would you like to proceed?") what was
        # already picked is kept for the first pass; going back further re-asks.
        reuse = {"source": None, "agent": None}
        if args.get("keep_agent"):
            reuse = {"source": state.get("lead_source"), "agent": state.get("lead_agent")}

        lead_source: dict | None = None   # {"id": uuid-or-None, "name": label}
        lead_agent = None
        lead_agent_email = None
        answer = ""
        i = 0
        while i < len(order):
            kind = order[i]
            # Go back returns one step; the question repeats (interrupts replay in
            # order, so each pass is a fresh pick). Never offered on the first step.
            extras = [go_back_chip] if i > 0 else None

            def went_back(text: str) -> bool:
                return i > 0 and text.strip().lower() in ("go back", "← go back")

            def step_back() -> int:
                # One step back — past the agent question when it was skipped.
                j = i - 1
                while j > 0 and order[j] == "agent" and _source_covers_agent(lead_source):
                    j -= 1
                return j

            if kind == "source":
                if reuse["source"] is not None:
                    lead_source, reuse["source"] = reuse["source"], None
                else:
                    # First the type of source (Agent, Broker, …). A customer is tied
                    # to one specific source, so then pick it: automatic when the type
                    # has just one, a short list otherwise (with a way back to the type).
                    while True:
                        picked_type = _ask_choice(
                            name, args,
                            "What type of acquisition source brought this customer in?",
                            source_choices,
                        )
                        t = _match_choice(picked_type, source_choices)
                        if not t:                       # "No acquisition source"
                            lead_source = {"id": None, "name": None, "type": None}
                            break
                        type_label = next((d for d, v in source_choices if v == t), t)
                        rows = sources_by_type.get(t) or []
                        if len(rows) == 1:
                            row = rows[0]
                        else:
                            name_choices = [
                                (f"{r['name']} ({r['code']})" if r.get("code") else r["name"], r["id"]) for r in rows
                            ]
                            picked = _ask_choice(
                                name, args,
                                f"Which {type_label} is it?",
                                name_choices,
                                select_label=type_label,
                                placeholder=f"Choose a {type_label.lower()}…",
                                force_select=True,
                                extra_actions=[go_back_chip],
                            )
                            if picked.strip().lower() in ("go back", "← go back"):
                                continue
                            sid = _match_choice(picked, name_choices)
                            row = next((r for r in rows if r["id"] == sid), rows[0])
                        lead_source = {
                            "id": row["id"],
                            "name": f"{row['name']} ({row['code']})" if row.get("code") else row["name"],
                            "type": type_label,
                            "type_code": t,
                            "user_id": row.get("user_id"),
                        }
                        break
                i += 1
            elif kind == "agent":
                if _source_covers_agent(lead_source):
                    lead_agent, lead_agent_email = None, None
                    i += 1
                    continue
                if reuse["agent"]:
                    lead_agent, reuse["agent"] = reuse["agent"], None
                else:
                    q = "Which agent is this customer assigned to?"
                    if lead_source and lead_source.get("name"):
                        q = f"{_source_echo(lead_source)} {q}"
                    picked = _ask_choice(
                        name, args, q, agent_choices,
                        select_label="Agent", placeholder="Choose an agent…",
                        force_select=True, extra_actions=extras,
                    )
                    if went_back(picked):
                        i = step_back()
                        continue
                    lead_agent = _match_choice(picked, agent_choices) or picked
                lead_agent_email = next(
                    (a["email"] for a in agent_rows if lead_agent in (a["name"], a["email"])), None
                )
                i += 1
            else:  # type
                # Echo earlier picks back — a dropdown selection adds no bubble of
                # its own, so without this nothing says what was chosen.
                echo = ""
                if lead_agent:
                    echo = f"Agent selected: **{lead_agent}**. "
                elif lead_source and lead_source.get("name"):
                    echo = f"{_source_echo(lead_source)} "
                answer = _ask_choice(
                    name, args,
                    f"{echo}Is this an Individual, a Corporate (Organization), or a Family group?",
                    [(display, tool) for display, tool, _ in choices],
                    extra_actions=extras,
                )
                if went_back(answer):
                    i = step_back()
                    continue
                i += 1

        resolved = next((c for c in choices if c[1] == _match_choice(answer, [(d, t) for d, t, _ in choices])), None)
        if resolved:
            display, resolved_tool, slug = resolved
            # The form opens with this agent already selected (agent_email is
            # read by the leads page's quick-lead form) instead of unassigned.
            form_path = f"admin/leads?add={slug}"
            if lead_agent_email:
                form_path += f"&agent_email={quote(lead_agent_email)}"
            if lead_source and lead_source.get("id"):
                form_path += f"&source_id={quote(str(lead_source['id']))}"
            if _source_covers_agent(lead_source) and lead_source.get("user_id"):
                form_path += f"&agent_id={quote(str(lead_source['user_id']))}"
            result = {
                "success": True,
                "message": f"Customer type resolved: {display}. "
                           + (f"Acquisition source already chosen: {lead_source.get('type') + ' — ' if lead_source.get('type') else ''}{lead_source['name']} — applied automatically, so do NOT ask for or pass it. " if lead_source and lead_source.get("name") else "")
                           + ("The chosen source stands in for the agent, so no separate agent is asked or needed — do NOT ask for or pass agent_name. " if _source_covers_agent(lead_source) else "")
                           + (f"Assigned agent already chosen: {lead_agent} — it is applied automatically, so do NOT ask for or pass agent_name. " if lead_agent else "")
                           + f"Now call `{resolved_tool}` "
                           "with the applicant's details to register them. Do NOT ask the user if they want to add demo data or fill the form manually, and do NOT list or describe those two choices in your reply (e.g. as a bulleted list) — the UI renders them as clickable buttons below your message. Reply with a short acknowledgement only, e.g. \"Got it — Individual customer" + (f", assigned to {lead_agent}" if lead_agent else "") + (f", source {lead_source['name']}" if lead_source and lead_source.get("name") else "") + ". How would you like to proceed?\" and add this warning on its own line: \"⚠️ Choose carefully — Add demo data creates the customer straight away, and you can't go back after that.\"",
                # Offer the two ways this normally goes from here — generated demo
                # data (fast, for a test run) or the portal's own multi-step form
                # (for a real applicant) — instead of only listing fields to type.
                "quick_actions": [
                    {"label": "Add demo data", "actionType": "submit", "payload": "Add demo data"},
                    # Web opens the form in the chat's inline panel instead of a new tab;
                    # the mobile app has no embed view, so it keeps plain navigation.
                    {"label": "Fill the form instead", "actionType": "embed" if platform == "web" else "navigate", "payload": form_path},
                    # Nothing has been created yet, so this step can still be undone.
                    # (Once demo data or the form is used, there is no way back.)
                    {"label": "← Go back", "actionType": "submit",
                     "payload": "Go back — let me choose the customer type again (keep_agent true)"},
                ],
            }
        else:
            result = {"success": False, "error": f"Didn't recognise '{answer}' as a customer type."}
        return back_to_agent({
            "messages": [_tool_result_message(name, call_id, result)],
            "lead_agent": lead_agent,
            "lead_source": lead_source,
            "lead_intake": True,
        })

    if name == "create_proposal":
        provided_plan = args.get("product_name")
        plans_res = await execute_tool("list_insurance_plans", {}, ctx)
        plans = plans_res.get("items", [])
        if not plans:
            return back_to_agent({"messages": [_tool_result_message(name, call_id, {"success": False, "error": "No insurance plans found in the catalog. Please ask an Admin to set up the catalog."})]})
        
        valid_options = [p.get("label") or p.get("name") for p in plans if p.get("label") or p.get("name")]
        if provided_plan and provided_plan.lower() in ("any", "random", "auto"):
            args["product_name"] = valid_options[0] if valid_options else "Term Life Plus"
        elif not provided_plan or provided_plan not in valid_options:
            options = []
            customer_name_or_cnic = args.get("applicant_name") or args.get("customer_name") or args.get("cnic")
            if customer_name_or_cnic:
                try:
                    # Search server-side rather than pulling the whole customer
                    # collection and scanning it here.
                    cust_res = await execute_tool(
                        "list_customers", {"search": customer_name_or_cnic, "limit": 5}, ctx
                    )
                    query = customer_name_or_cnic.lower()
                    customer_data = None
                    # _list_customers returns "customers"; this used to read
                    # "items", so customer_data was always None and the plan
                    # advisor silently never ran.
                    for c in cust_res.get("customers", []):
                        if query in (c.get("first_name", "") + " " + c.get("last_name", "")).lower() or query == c.get("cnic"):
                            customer_data = c
                            break
                    if customer_data:
                        # Bare model — this ranks five plan names and needs no
                        # tools. It used to go through _llm(), which bound the
                        # entire toolset (~7k tokens of schema) to every call.
                        _cfg = await providers.resolve()
                        llm = _structured_llm(_cfg, Top5PlansOutput, include_raw=True)
                        prompt = ChatPromptTemplate.from_messages([
                            ("system", "You are an expert life insurance advisor. You will be provided with a customer's details and a list of available insurance plans. Your task is to recommend the top 5 most suitable plans for this customer based on their demographics, age, and occupation. Return ONLY the exact plan names from the provided list, ordered by suitability."),
                            ("user", "Customer Data: {customer}\n\nAvailable Plans: {plans}")
                        ])
                        # Only the fields the ranking actually needs — sending the
                        # whole customer and plan rows wasted input tokens on
                        # fields the advisor never reads.
                        slim_customer = {
                            k: customer_data.get(k)
                            for k in ("date_of_birth", "gender", "occupation", "declared_income", "is_smoker")
                        }
                        slim_plans = [
                            {"name": p.get("label") or p.get("name"), "type": p.get("insurance_type")}
                            for p in plans
                        ]
                        raw = await (prompt | llm).ainvoke({"customer": slim_customer, "plans": slim_plans})
                        usage.record(
                            raw.get("raw"),
                            service_name=usage.SERVICE_PLAN_ADVISOR,
                            tenant_id=state.get("tenant_id"),
                        )
                        parsed = raw.get("parsed")
                        if parsed:
                            options = [opt for opt in parsed.plan_names if opt in valid_options]
                except Exception as e:
                    print(f"Failed to use AI for plan suggestion: {e}")
            
            if not options:
                options = valid_options[:5]
                
            if options:
                answer = interrupt({
                    "kind": "clarify",
                    "tool_call": {"name": name, "args": args},
                    "question": "Which insurance plan would you like to propose? I've analyzed the customer's profile and recommend these top options:",
                    "options": options[:5],
                })
                # Inject the selected plan directly into args and execute immediately —
                # avoids a second LLM round-trip that sometimes misparses the choice.
                selected = str(answer).strip()
                if selected in valid_options:
                    args["product_name"] = selected
                else:
                    # Fuzzy-match: pick the first option that starts with or contains the answer
                    for opt in valid_options:
                        if selected.lower() in opt.lower() or opt.lower() in selected.lower():
                            args["product_name"] = opt
                            break
                    else:
                        args["product_name"] = options[0]  # default to first recommendation
                result = await execute_tool(name, args, ctx)
                update: dict = {"messages": [_tool_result_message(name, call_id, result)]}
                if result.get("last_action"):
                    update["last_action"] = result["last_action"]
                return back_to_agent(update)

    # ── Rules engine: standalone create_rule_category and create_rule_subcategory ──
    if name == "create_rule_category" and not args.get("name"):
        suggestions = [
            ("Claims Governance", "Claims Governance"),
            ("Retention & Treaty", "Retention & Treaty"),
            ("Distribution Compliance", "Distribution Compliance"),
            ("Product Eligibility", "Product Eligibility")
        ]
        answer = _ask_choice(
            name, args,
            "What should the new category be called? Pick one of these, or type your own name.",
            suggestions,
        )
        resolved_name = _match_choice(answer, suggestions) or answer
        args["name"] = str(resolved_name)
        if not args.get("code"):
            args["code"] = _slugify(str(resolved_name))
        result = await execute_tool(name, args, ctx)
        update: dict = {"messages": [_tool_result_message(name, call_id, result)]}
        return back_to_agent(update)

    if name == "create_rule_subcategory" and not args.get("name"):
        if not args.get("category_code"):
            cats = await _catalogue_tree(ctx)
            category = await _ensure_category(name, args, ctx, cats)
            if not category:
                result = {"success": False, "error": "A category is required."}
                return back_to_agent({"messages": [_tool_result_message(name, call_id, result)]})
            args["category_code"] = category.get("code")

        suggestions = [
            ("Non-Medical Limits", "Non-Medical Limits"),
            ("Death Benefit", "Death Benefit"),
            ("Eligibility Gates", "Eligibility Gates")
        ]
        answer = _ask_choice(
            name, args,
            "What should the new subcategory be called? Pick one of these, or type your own name.",
            suggestions,
        )
        resolved_name = _match_choice(answer, suggestions) or answer
        args["name"] = str(resolved_name)
        if not args.get("code"):
            args["code"] = _slugify(str(resolved_name))
        
        result = await execute_tool(name, args, ctx)
        update: dict = {"messages": [_tool_result_message(name, call_id, result)]}
        return back_to_agent(update)

    # ── Rules engine: create a rule set without making the user type codes ──
    #
    # A rule set needs a category, a subcategory, sometimes a channel, a code
    # and a name — five values a user would otherwise have to know by heart.
    # Every one of them is resolved here from live data as a click, and any
    # missing catalogue level is offered as "create it now" rather than as a
    # precondition the user has to go and satisfy somewhere else.
    if name == "create_rule_set":
        cats = await _catalogue_tree(ctx)
        category = await _ensure_category(name, args, ctx, cats)
        if category:
            args["category_code"] = category.get("code")
            subcategory = await _ensure_subcategory(name, args, ctx, category)
            if subcategory:
                args["subcategory_code"] = subcategory.get("code")

                # Channel: only asked for where the subcategory is actually
                # channel-scoped. A GLOBAL subcategory has no profiles, and
                # asking about a distribution channel there is noise.
                profiles = subcategory.get("eligibility_profiles") or []
                if profiles and not args.get("channel_code") and not args.get("_channel_resolved"):
                    channels = [(p.get("channel_code", ""), p.get("channel_code", ""))
                                for p in profiles if p.get("channel_code")]
                    if channels:
                        global_opt = ("Every channel (global)", "__GLOBAL__")
                        # _match_choice must see the SAME pool _ask_choice offered —
                        # matching against `channels` alone meant "Every channel
                        # (global)" could never resolve, and every rule set ended
                        # up silently channel-scoped to whatever the API defaults
                        # to instead of the global scope the user asked for.
                        all_options = channels + [global_opt]
                        answer = _ask_choice(
                            name, args,
                            f"**{subcategory.get('name')}** is channel-scoped. Which channel does this rule set govern?",
                            all_options,
                            select_label="Channel",
                            placeholder="Pick a channel…",
                        )
                        chosen = _match_choice(answer, all_options)
                        args["_channel_resolved"] = True
                        if chosen and chosen != "__GLOBAL__":
                            args["channel_code"] = chosen

                # Code: derived, never asked for. Nobody wants to invent
                # "RS-CLM-004" by hand, and a wrong guess collides.
                if not args.get("code"):
                    try:
                        existing_res = await execute_tool(
                            "list_rule_sets", {"category": args["category_code"]}, ctx)
                        existing = existing_res.get("rule_sets", [])
                    except Exception:
                        existing = []
                    prefix_map = {
                        "MEDICAL": "MED", "PRICING": "PRC", "COMMISSION": "COM",
                        "COMPLIANCE": "CMP", "UNDERWRITING": "UW", "INSURANCE": "HIS",
                        "REINSURANCE": "REI", "RBAC": "RBA", "AI_DECISION": "AI",
                        "ELIGIBILITY": "ELG", "CLAIMS": "CLM",
                    }
                    cat_code = (args["category_code"] or "").upper()
                    prefix = next((v for k, v in prefix_map.items() if k in cat_code), cat_code[:3].upper())
                    args["code"] = f"RS-{prefix}-{len(existing) + 1:03d}"

                if not args.get("name"):
                    chan = f" · channel `{args['channel_code']}`" if args.get("channel_code") else ""
                    suggestions = [
                        (f"{subcategory.get('name')} Grid", f"{subcategory.get('name')} Grid"),
                        (f"{subcategory.get('name')} Thresholds", f"{subcategory.get('name')} Thresholds"),
                        (f"{category.get('name')} — {subcategory.get('name')}",
                         f"{category.get('name')} — {subcategory.get('name')}"),
                    ]
                    answer = _ask_choice(
                        name, args,
                        f"Filing under **{args['category_code']} / {args['subcategory_code']}**{chan} as "
                        f"**`{args['code']}`**. What should it be called?",
                        suggestions,
                    )
                    args["name"] = str(_match_choice(answer, suggestions) or answer)

                result = await execute_tool(name, args, ctx)
                if not result.get("success"):
                    update: dict = {"messages": [_tool_result_message(name, call_id, result)]}
                    return back_to_agent(update)

                # ── Continuous Journey: rule set -> draft -> rule -> deploy ──
                code = args["code"]
                await execute_tool("create_rule_version", {"rule_set_code": code}, ctx)

                field, operator, value = await _ask_condition(name, {"rule_set_code": code}, context=f"**`{code}`** created. Let's add its first rule.")
                outcome, outcome_data = await _ask_outcome(name, {"rule_set_code": code})
                rule_code, rule_name = _derive_rule_naming(field, operator, value, outcome)

                rule_args = {
                    "rule_set_code": code,
                    "rule_code": rule_code,
                    "name": rule_name,
                    "priority": 100,
                    "conditions_json": _condition_json(field, operator, value),
                    "action_outcome": outcome,
                }
                if outcome_data:
                    rule_args["outcome_json"] = json.dumps(outcome_data)

                rule_result = await execute_tool("add_rule_to_version", rule_args, ctx)
                if not rule_result.get("success"):
                    update: dict = {"messages": [_tool_result_message(name, call_id, rule_result)]}
                    return back_to_agent(update)

                deploy_choices = [("Deploy now (make active)", "YES"), ("Leave as DRAFT for now", "NO")]
                deploy_answer = _ask_choice(
                    name, {"rule_set_code": code},
                    f"Rule **`{rule_code}`** added to the draft. Do you want to deploy `{code}` so it takes effect immediately?",
                    deploy_choices
                )
                
                final_action = result.get("last_action")
                if _match_choice(deploy_answer, deploy_choices) == "YES":
                    deploy_result = await execute_tool("deploy_rule_version", {"rule_set_code": code}, ctx)
                    final_msg = f"Rule set `{code}` created, first rule added, and successfully deployed! It is now ACTIVE."
                    if deploy_result.get("last_action"):
                        final_action = deploy_result["last_action"]
                else:
                    final_msg = f"Rule set `{code}` created and first rule added. It remains in DRAFT state."
                    if rule_result.get("last_action"):
                        final_action = rule_result["last_action"]

                final_result = {"success": True, "message": final_msg}
                update = {"messages": [_tool_result_message(name, call_id, final_result)]}
                if final_action:
                    update["last_action"] = final_action
                return back_to_agent(update)

    # ── Rules engine: pick the rule set from the live list, never by memory ──
    #
    # get_rule_set / evaluate_rule_set / create_rule_version / deploy / archive
    # all key off a dotted code. REQUIRED_ARGS would clarify-prompt for it,
    # which asks the user to recall "medical.nml_grid" — so intercept first and
    # show the actual rule sets instead.
    if name in _RULE_SET_CODE_TOOLS and not args.get("rule_set_code"):
        try:
            listed = await execute_tool("list_rule_sets", {}, ctx)
            rule_sets = listed.get("rule_sets") or []
        except Exception:
            rule_sets = []

        if rule_sets:
            choices = [
                (f"{r.get('name')} ({r.get('rule_code') or r.get('code')})", r.get("rule_code") or r.get("code"))
                for r in rule_sets
            ]
            action_desc = name.replace("_", " ").replace("add rule to version", "add a rule to").replace("create rule version", "open a draft for")
            answer = _ask_choice(
                name, args,
                f"Which **rule set** would you like to {action_desc}?",
                choices,
                select_label="Rule set",
                placeholder="Pick a rule set…",
                extra_actions=[{"label": "➕ Create a new rule set", "actionType": "submit", "payload": "Create a new rule set"}],
            )
            resolved = _match_choice(answer, choices)
            if resolved:
                args["rule_set_code"] = resolved
            elif _is(answer, "Create a new rule set") or _is(answer, "➕ Create a new rule set"):
                cats = await _catalogue_tree(ctx)
                category = await _ensure_category("create_rule_set", args, ctx, cats)
                if category:
                    subcategory = await _ensure_subcategory("create_rule_set", args, ctx, category)
                    if subcategory:
                        args["category_code"] = category.get("code")
                        args["subcategory_code"] = subcategory.get("code")
                        name = "create_rule_set"
                        tool_call["name"] = "create_rule_set"
        else:
            result = {
                "success": False,
                "error": "No rule sets exist in the catalogue yet. Please create a rule set first.",
                "quick_actions": [
                    {"label": "Create the first rule set", "actionType": "submit", "payload": "Create a new rule set"},
                    {"label": "Open Rule Engine", "actionType": "navigate", "payload": "admin/rule-engine"},
                ],
            }
            return back_to_agent({"messages": [_tool_result_message(name, call_id, result)]})

    # ── Rules engine: NLP Full Bypass Macro ──────────────────────────────────
    if name == "parse_and_create_full_rule":
        # 1. Category
        cats = await _catalogue_tree(ctx)
        cat_code = _slugify(args["category_name"])
        cat = next((c for c in cats if c.get("code") == cat_code), None)
        if not cat:
            cat_res = await execute_tool("create_rule_category", {"code": cat_code, "name": args["category_name"]}, ctx)
            if not cat_res.get("success"):
                return back_to_agent({"messages": [_tool_result_message(name, call_id, cat_res)]})
            cat = cat_res.get("category")
        
        # 2. Subcategory
        subs = cat.get("subcategories") or []
        sub_code = _slugify(args["subcategory_name"])
        sub = next((s for s in subs if s.get("code") == sub_code), None)
        if not sub:
            sub_res = await execute_tool("create_rule_subcategory", {"category_code": cat.get("code"), "code": sub_code, "name": args["subcategory_name"]}, ctx)
            if not sub_res.get("success"):
                return back_to_agent({"messages": [_tool_result_message(name, call_id, sub_res)]})
            sub = sub_res.get("subcategory")
            
        # 3. Rule Set
        rs_code = _slugify(args["rule_set_name"])
        rs_res = await execute_tool("get_rule_set", {"rule_set_code": rs_code}, ctx)
        if not rs_res.get("success"):
            rs_res = await execute_tool("create_rule_set", {
                "code": rs_code, "name": args["rule_set_name"], 
                "category_code": cat.get("code"), "subcategory_code": sub.get("code")
            }, ctx)
            if not rs_res.get("success"):
                return back_to_agent({"messages": [_tool_result_message(name, call_id, rs_res)]})
        
        # 4. Draft Version
        await execute_tool("create_rule_version", {"rule_set_code": rs_code}, ctx)
        
        # 5. Add Rule
        rule_args = {
            "rule_set_code": rs_code,
            "conditions_json": args["conditions_json"],
            "action_outcome": args["action_outcome"]
        }
        if args.get("outcome_json"):
            rule_args["outcome_json"] = args["outcome_json"]
            
        add_res = await execute_tool("add_rule_to_version", rule_args, ctx)
        if not add_res.get("success"):
            return back_to_agent({"messages": [_tool_result_message(name, call_id, add_res)]})
            
        # 6. Deploy
        if args.get("deploy_now", True):
            deploy_res = await execute_tool("deploy_rule_version", {"rule_set_code": rs_code}, ctx)
            if not deploy_res.get("success"):
                return back_to_agent({"messages": [_tool_result_message(name, call_id, deploy_res)]})
                
        final_msg = f"Rule successfully parsed and deployed under {args['category_name']} -> {args['subcategory_name']} -> {args['rule_set_name']}."
        final_result = {"success": True, "message": final_msg, "last_action": add_res.get("last_action")}
        return back_to_agent({"messages": [_tool_result_message(name, call_id, final_result)], "last_action": final_result["last_action"]})

    # ── Rules engine: visual rule builder ────────────────────────────────────
    if name == "add_rule_to_version" and args.get("rule_set_code") and not (
        args.get("conditions_json") and args.get("action_outcome")
    ):
        code = args["rule_set_code"]
        result = interrupt({
            "kind": "client_execute",
            "tool_call": {
                "name": "build_rule_ui",
                "args": {
                    "rule_set_code": code,
                    "mode": "add"
                }
            }
        })
        if isinstance(result, dict) and result.get("success"):
            args["conditions_json"] = json.dumps(result.get("conditions", []))
            impact = result.get("impact", {})
            args["action_outcome"] = impact.get("type", "REQUIRE_MEDICAL_EXAM")
            
            # Remove type from impact data for outcome_json
            impact_data = {k: v for k, v in impact.items() if k != "type"}
            args["outcome_json"] = json.dumps(impact_data)
            
            args.setdefault("priority", result.get("priority", 100))
            args.setdefault("name", result.get("name") or "New Rule")
            if result.get("rule_code"):
                args["rule_code"] = result.get("rule_code")
        else:
            return back_to_agent({"messages": [_tool_result_message(name, call_id, {"success": False, "error": "Rule building cancelled by user."})]})

    # ── Rules engine: editing a rule's condition or outcome ──────────────────
    #
    # rule_set_code is resolved above; rule_code is a live pick from the
    # DRAFT's own rules (never a raw code the user has to remember), and the
    # new condition/outcome go through the same picker add_rule_to_version
    # uses — so "change age 50 to 60" becomes three clicks against the current
    # rule instead of a vague "what should change?" prompt.
    if name == "update_rule" and args.get("rule_set_code") and not args.get("rule_code"):
        try:
            detail_res = await execute_tool("get_rule_set", {"rule_set_code": args["rule_set_code"]}, ctx)
        except Exception:
            detail_res = {}
        detail = detail_res.get("rule_set") or {}
        code = detail.get("rule_code") or args["rule_set_code"]
        draft = next((v for v in (detail.get("versions") or []) if (v.get("status") or "").upper() == "DRAFT"), None)
        if not draft:
            result = {
                "success": False,
                "error": f"`{code}` has no DRAFT version — rules can only be edited in a draft.",
                "quick_actions": [
                    {"label": "Open a draft version", "actionType": "submit",
                     "payload": f"Create a draft version of rule set {code}"},
                ],
            }
            return back_to_agent({"messages": [_tool_result_message(name, call_id, result)]})

        rules = draft.get("rules") or []
        if not rules:
            result = {
                "success": False,
                "error": f"DRAFT v{draft.get('version_number')} of `{code}` has no rules yet to edit.",
                "quick_actions": [
                    {"label": "Add a rule", "actionType": "submit", "payload": f"Add a rule to rule set {code}"},
                ],
            }
            return back_to_agent({"messages": [_tool_result_message(name, call_id, result)]})

        rule_choices = [
            (f"{r.get('rule_code')} — {r.get('name')} ({r.get('action_outcome')})", r.get("rule_code"))
            for r in rules
        ]
        answer = _ask_choice(
            name, args, f"Which rule in `{code}` (DRAFT v{draft.get('version_number')}) should I change?",
            rule_choices, select_label="Rule", placeholder="Pick a rule…",
        )
        resolved_code = _match_choice(answer, rule_choices)
        if resolved_code:
            args["rule_code"] = resolved_code

    if name == "update_rule" and args.get("rule_set_code") and args.get("rule_code") and not (
        args.get("conditions_json") or args.get("action_outcome") or args.get("priority") is not None
        or args.get("is_active") is not None or args.get("name")
    ):
        code = args["rule_set_code"]
        try:
            detail_res = await execute_tool("get_rule_set", {"rule_set_code": code}, ctx)
        except Exception:
            detail_res = {}
        detail = detail_res.get("rule_set") or {}
        draft = next((v for v in (detail.get("versions") or []) if (v.get("status") or "").upper() == "DRAFT"), None)
        current_rule = next(
            (r for r in (draft.get("rules") or []) if r.get("rule_code") == args["rule_code"]), None
        ) if draft else None

        result = interrupt({
            "kind": "client_execute",
            "tool_call": {
                "name": "build_rule_ui",
                "args": {
                    "rule_set_code": code,
                    "rule_code": args["rule_code"],
                    "mode": "edit",
                    "initial_rule": current_rule
                }
            }
        })
        if isinstance(result, dict) and result.get("success"):
            args["conditions_json"] = json.dumps(result.get("conditions", []))
            impact = result.get("impact", {})
            args["action_outcome"] = impact.get("type", "REQUIRE_MEDICAL_EXAM")
            
            # Remove type from impact data for outcome_json
            impact_data = {k: v for k, v in impact.items() if k != "type"}
            args["outcome_json"] = json.dumps(impact_data)
            
            if "priority" in result:
                args["priority"] = result["priority"]
            if "name" in result and result["name"]:
                args["name"] = result["name"]
        else:
            return back_to_agent({"messages": [_tool_result_message(name, call_id, {"success": False, "error": "Rule editing cancelled by user."})]})

    # ── Claims: resolve the policy, type and amount as clicks ───────────────
    #
    # An FNOL needs a policy id the user has never seen, a claim type and an
    # amount. register_claim's own handler answers a missing type or amount
    # with chips, but the policy is a live list that only the gate can turn
    # into a dropdown before the call is made.
    if name == "register_claim" and not args.get("policy_number"):
        policies = await _claimable_policies(ctx)
        hint = (args.get("claimant_name") or args.get("cnic") or "").strip().lower()
        if hint:
            narrowed = [p for p in policies
                        if hint in (p.get("customer_name") or "").lower()
                        or hint in (p.get("policy_number") or "").lower()]
            # One unambiguous match is not a question — just use it.
            if len(narrowed) == 1:
                args["policy_number"] = narrowed[0].get("policy_number")
            elif narrowed:
                policies = narrowed
        if not args.get("policy_number"):
            if not policies:
                result = {
                    "success": False,
                    "error": "There are no issued policies to claim against yet — a claim needs a live contract.",
                    "quick_actions": [
                        {"label": "Run an underwriting journey", "actionType": "submit",
                         "payload": "Start the underwriting journey with demo data"},
                        {"label": "Open Policy Issuance", "actionType": "embed", "payload": "policy-issuance"},
                    ],
                }
                return back_to_agent({"messages": [_tool_result_message(name, call_id, result)]})
            choices = [
                (f"{p.get('policy_number')} — {p.get('customer_name')} "
                 f"({p.get('product_name')}, cover PKR {float(p.get('coverage_amount') or 0):,.0f})",
                 p.get("policy_number"))
                for p in policies
            ]
            answer = _ask_choice(
                name, args,
                "Which **policy** is this claim against?",
                choices,
                select_label="Policy",
                placeholder="Pick a policy…",
            )
            resolved = _match_choice(answer, choices)
            if resolved:
                args["policy_number"] = resolved

    # ── Claims: only ever offer a LEGAL next status ──────────────────────────
    #
    # The claims state machine refuses illegal jumps with a 400. Reading the
    # claim first turns that from an error the user has to interpret into a
    # short list of buttons that all work.
    if name == "update_claim_status" and (args.get("claim_number") or args.get("claimant_name")):
        claim = await _peek_claim(args, ctx)
        if claim:
            legal = CLAIM_TRANSITIONS.get(str(claim.get("status") or ""), ())
            target = (args.get("new_status") or "").strip().lower()
            if legal and not any(s.lower() == target for s in legal):
                choices = [(s, s) for s in legal]
                answer = _ask_choice(
                    name, args,
                    f"`{claim.get('claim_number')}` is **{claim.get('status')}**"
                    + (f" — it cannot go straight to “{args.get('new_status')}”." if args.get("new_status") else ".")
                    + " Where should it move?",
                    choices,
                )
                resolved = _match_choice(answer, choices)
                if resolved:
                    args["new_status"] = resolved

    # ── Claims: the adjudication decision as four buttons ────────────────────
    if name == "adjudicate_claim" and not args.get("decision"):
        claim = await _peek_claim(args, ctx)
        amount = float((claim or {}).get("submitted_amount") or 0)
        over_authority = amount > CLAIM_MANAGER_THRESHOLD
        choices = [
            (f"Approve in full (PKR {amount:,.0f})" if amount else "Approve in full", "APPROVED"),
            ("Partial approval", "PARTIAL_APPROVAL"),
            ("Decline", "DECLINED"),
        ]
        if over_authority:
            # Above adjuster authority the API will refuse an approval anyway —
            # lead with the move that actually succeeds.
            choices.insert(0, (f"Refer to manager (over PKR {CLAIM_MANAGER_THRESHOLD:,.0f})", "REFERRED_TO_MANAGER"))
        else:
            choices.append(("Refer to manager", "REFERRED_TO_MANAGER"))
        answer = _ask_choice(
            name, args,
            f"What is the decision on `{(claim or {}).get('claim_number') or args.get('claim_number') or 'this claim'}`?",
            choices,
        )
        resolved = _match_choice(answer, choices)
        if resolved:
            args["decision"] = resolved

    # ── Claims: the underwriting verdict as four buttons ─────────────────────
    if name == "resolve_claim_underwriting" and not args.get("decision"):
        choices = [
            ("Risk stands — continue the claim", "APPROVE_CONTINUE"),
            ("Approve with a condition exclusion", "APPROVE_WITH_EXCLUSION"),
            ("Approve with an extra-mortality loading", "APPROVE_WITH_LOADING"),
            ("Decline — material non-disclosure", "DECLINE_NON_DISCLOSURE"),
        ]
        answer = _ask_choice(
            name, args,
            "What is underwriting's verdict on the re-underwriting referral?",
            choices,
        )
        resolved = _match_choice(answer, choices)
        if resolved:
            args["decision"] = resolved

    # ── Claims: which claim, when the user didn't name one ───────────────────
    if name in _CLAIM_LOOKUP_TOOLS and not (args.get("claim_number") or args.get("claimant_name")):
        try:
            listed = await execute_tool("list_claims", {}, ctx)
            claims = listed.get("claims") or []
        except Exception:
            claims = []
        open_claims = [c for c in claims if str(c.get("status")) != "Closed"] or claims
        if len(open_claims) == 1:
            args["claim_number"] = open_claims[0].get("claim_number")
        elif open_claims:
            choices = [
                (f"{c.get('claim_number')} — {c.get('claimant_name')} "
                 f"({c.get('claim_type')}, PKR {float(c.get('submitted_amount') or 0):,.0f}, {c.get('status')})",
                 c.get("claim_number"))
                for c in open_claims
            ]
            answer = _ask_choice(
                name, args,
                "Which **claim** do you mean?",
                choices,
                select_label="Claim",
                placeholder="Pick a claim…",
            )
            resolved = _match_choice(answer, choices)
            if resolved:
                args["claim_number"] = resolved
        else:
            result = {
                "success": False,
                "error": "There are no claims on the book yet.",
                "quick_actions": [
                    {"label": "Register a claim (FNOL)", "actionType": "submit", "payload": "Register a new claim"},
                    {"label": "Open Claims", "actionType": "navigate", "payload": "claims"},
                ],
            }
            return back_to_agent({"messages": [_tool_result_message(name, call_id, result)]})

    # ── Case status: a small fixed enum, offered as chips ────────────────────
    if name == "update_case_status" and not args.get("new_status"):
        choices = [
            ("New", "New"), ("In Progress", "InProgress"), ("Pending Documents", "Pending Documents"),
            ("Under Review", "Under Review"), ("Approved", "Approved"), ("Rejected", "Rejected"), ("Closed", "Closed"),
        ]
        answer = _ask_choice(name, args, "Which status should this case move to?", choices)
        resolved = _match_choice(answer, choices)
        if resolved:
            args["new_status"] = resolved

    # ── Case assignment: the real user list, not a name to type ──────────────
    if name == "assign_case" and not args.get("assigned_user_name"):
        try:
            listed = await execute_tool("list_users", {}, ctx)
            users = listed.get("users") or []
        except Exception:
            users = []
        if users:
            choices = [
                (f"{u.get('full_name')} — {(u.get('role') or {}).get('name') or u.get('role_name') or '—'}",
                 u.get("full_name"))
                for u in users
            ]
            answer = _ask_choice(
                name, args,
                "Who should this case be assigned to?",
                choices,
                select_label="User",
                placeholder="Pick a user…",
            )
            resolved = _match_choice(answer, choices)
            if resolved:
                args["assigned_user_name"] = resolved

    # ── New user's role: the real role list, not a name to type ──────────────
    if name == "add_user" and not args.get("role_name"):
        try:
            listed = await execute_tool("list_roles", {}, ctx)
            roles = listed.get("roles") or []
        except Exception:
            roles = []
        if roles:
            choices = [(r["name"], r["name"]) for r in roles]
            answer = _ask_choice(name, args, "What role should this user have?", choices)
            resolved = _match_choice(answer, choices)
            if resolved:
                args["role_name"] = resolved

    # ── Navigation: the real page catalogue, not a route name to type ────────
    if name == "navigate_to_page" and not args.get("page_name"):
        choices = [(p.label, p.route) for p in PAGES]
        answer = _ask_choice(
            name, args,
            "Which page would you like to open?",
            choices,
            select_label="Page",
            placeholder="Pick a page…",
        )
        resolved = _match_choice(answer, choices)
        if resolved:
            args["page_name"] = resolved

    # ── show_record: which kind of record, as a short fixed list ─────────────
    if name == "show_record" and not args.get("record_type"):
        record_types = sorted({p.lists for p in PAGES if p.lists})
        choices = [(rt.replace("_", " ").title(), rt) for rt in record_types]
        answer = _ask_choice(name, args, "What kind of record are you looking for?", choices)
        resolved = _match_choice(answer, choices)
        if resolved:
            args["record_type"] = resolved

    missing = missing_args(name, args)
    if missing:
        answer = interrupt({
            "kind": "clarify",
            "tool_call": {"name": name, "args": args},
            "question": (
                f"I need a bit more information to {name.replace('_', ' ')}: "
                f"missing {', '.join(missing)}. Could you provide it?"
            ),
        })
        # The resumed value is the user's free-text reply. Rather than trying
        # to programmatically merge that into structured args (fragile — "the
        # customer is John, cnic 12345..." has no fixed shape), close out the
        # pending tool_call with a placeholder ToolMessage (Gemini requires
        # every tool_call get a response before the next turn) and feed the
        # answer back as a normal chat turn — the LLM re-parses it and reissues
        # a (hopefully complete) tool call on its own next turn.
        placeholder = _tool_result_message(
            name, call_id, {"success": False, "message": "Waiting for more information from the user."}
        )
        return back_to_agent({"messages": [placeholder, HumanMessage(content=str(answer))]})

    # Validate/auto-fix formats BEFORE executing, so a bad CNIC/date/email is
    # caught here (and the user asked for a correction) rather than sent to
    # tenant-service and bounced back as a raw Pydantic error in the chat.
    args, val_errors = validate_and_normalize(name, args)
    if val_errors:
        answer = interrupt({
            "kind": "clarify",
            "tool_call": {"name": name, "args": args},
            "question": "Before I can continue, a couple of details need fixing:\n- "
            + "\n- ".join(val_errors)
            + "\nWhat should they be?",
        })
        placeholder = _tool_result_message(
            name, call_id, {"success": False, "message": "Waiting for corrected input from the user."}
        )
        return back_to_agent({"messages": [placeholder, HumanMessage(content=str(answer))]})

    if requires_confirmation(name):
        # Destructive actions name their target so "Yes" is informed consent,
        # not a reflex click on a generic prompt.
        target = args.get("name") or args.get("applicant_name") or args.get("cnic") \
            or args.get("case_number") or args.get("email") or args.get("full_name") \
            or args.get("organization_name") or ""
        if is_destructive(name):
            question = f"⚠️ This permanently deletes {target or 'this record'} and cannot be undone. Proceed?"
        elif name == "deploy_rule_version":
            # Deploying a rule version changes live underwriting behaviour for every
            # case evaluated afterwards — give the user the rule set code so "Yes"
            # is informed consent rather than a reflex click.
            rs_code = args.get("rule_set_code") or target or "this rule set"
            question = (
                f"⚠️ About to deploy a new ACTIVE version of **`{rs_code}`** — "
                "this changes underwriting decisions for every case evaluated from now on. Proceed?"
            )
        else:
            question = f"Ready to {name.replace('_', ' ')}" + (f" for {target}" if target else "") + " — proceed?"
        answer = interrupt({
            "kind": "confirm",
            "tool_call": {"name": name, "args": args},
            "question": question,
            "options": ["Yes", "Cancel"],
        })
        if answer not in (True, "yes", "Yes", "confirm"):
            result = {"success": False, "message": "Okay, cancelled."}
            return back_to_agent({"messages": [_tool_result_message(name, call_id, result)]})

    if name in JOURNEY_TOOLS:
        # Hand off to the autonomous pipeline: stash the tool_call so
        # j_finish can answer it, then jump to the right entry node. A fresh
        # start resets journey state; continue re-enters via j_resume's router.
        pending = {"name": name, "args": args, "id": call_id}
        if name == "start_underwriting_journey":
            return Command(goto="j_intake", update={
                "pending_call": pending,
                # Light up Stage 1 in the UI's state graph immediately.
                "journey_next": {"id": "stage:lead_intake", "label": "Stage 1 · Lead Intake"},
                "journey_done": None,
                "journey_stage": "lead_intake",
                "journey_cnic": None, "journey_customer_id": None,
                "journey_case_id": None, "journey_case_number": None,
                "journey_product": None, "journey_missing_documents": [],
                "journey_risk": None, "journey_outcome": None,
                "requires_human_intervention": False,
                "journey_audit": [], "journey_error": None,
                "lead_agent": None, "lead_source": None, "lead_intake": None,
            })
        return Command(goto="j_resume", update={"pending_call": pending, "journey_error": None})

    if name in CLAIM_JOURNEY_TOOLS:
        # Same hand-off as the underwriting pipeline, into the claims one. A
        # fresh start clears the claim namespace; continue re-enters via
        # c_resume's router, which reads where the last run suspended.
        pending = {"name": name, "args": args, "id": call_id}
        if name == "start_claim_journey":
            return Command(goto="c_intake", update={
                "pending_call": pending,
                "journey_next": {"id": "stage:claim_fnol", "label": "Stage 1 · First Notice of Loss"},
                "journey_done": None,
                "claim_stage": "claim_fnol",
                "claim_id": None, "claim_number": None, "claim_record": None,
                "claim_missing_documents": [], "claim_referral_reasons": [],
                "claim_decision": None, "claim_payout": None, "claim_outcome": None,
                "requires_claim_intervention": False,
                "claim_audit": [], "claim_error": None, "claim_blocking_actions": [],
            })
        return Command(goto="c_resume", update={"pending_call": pending, "claim_error": None})

    if name in GROUP_JOURNEY_TOOLS:
        # Same hand-off, into the group-scheme pipeline. A fresh start clears the
        # group namespace; continue re-enters via g_resume's router, which reads
        # the scheme's real status.
        pending = {"name": name, "args": args, "id": call_id}
        if name == "start_group_journey":
            return Command(goto="g_scheme", update={
                **remember,
                "pending_call": pending,
                "journey_next": {"id": "stage:group_scheme", "label": "Stage 1 · Scheme & Master Policy"},
                "journey_done": None,
                "group_stage": "group_scheme",
                "group_organization_id": None, "group_organization_name": None,
                "group_master_policy_id": None, "group_plan_code": None, "group_business_type": None,
                "group_quote": None, "group_scheme": None,
                "group_pending_members": [], "group_census_errors": [], "group_missing_nominations": [],
                "group_outcome": None, "requires_group_intervention": False,
                "group_audit": [], "group_error": None, "group_blocking_actions": [],
            })
        return Command(goto="g_resume", update={"pending_call": pending, "group_error": None, **remember})

    if name in CLIENT_EXECUTED_TOOLS:
        # The browser holds the attached File object — chat-agent can't
        # execute this itself. Route to the dedicated client executor node
        # to avoid LangGraph multiple-interrupt bleeding.
        payload = {
            "kind": "client_execute",
            "tool_call": {"name": name, "args": args},
        }
        pending = {"name": name, "args": args, "id": call_id, "client_payload": payload}
        return Command(goto="client_executor", update={"pending_call": pending})

    result = await execute_tool(name, args, ctx)
    
    if isinstance(result, dict) and result.get("__client_execute__"):
        payload = result
        pending = {"name": name, "args": args, "id": call_id, "client_payload": payload}
        return Command(goto="client_executor", update={"pending_call": pending})
        
    update: dict = {"messages": [_tool_result_message(name, call_id, result)]}
    if consumed_lead_agent:
        update["lead_agent"] = None
        update["lead_source"] = None
        update["lead_intake"] = None
    if result.get("last_action"):
        update["last_action"] = result["last_action"]
    if result.get("assessment"):
        update["assessment"] = result["assessment"]
    if result.get("family_members"):
        update["family_members"] = result["family_members"]
    return back_to_agent(update)


async def client_executor_node(state: ChatState) -> Command:
    pending = state.get("pending_call") or {}
    payload = pending.get("client_payload")
    if not payload:
        payload = {
            "kind": "client_execute",
            "tool_call": {"name": pending.get("name"), "args": pending.get("args")},
        }
        
    client_result = interrupt(payload)
    
    result = client_result if isinstance(client_result, dict) else {"success": False, "error": "Client execution failed or interrupted."}
    
    update: dict = {"messages": [_tool_result_message(pending.get("name", ""), pending.get("id", ""), result)], "pending_call": None}
    if result.get("last_action"):
        update["last_action"] = result["last_action"]
    if result.get("assessment"):
        update["assessment"] = result["assessment"]
    if result.get("family_members"):
        update["family_members"] = result["family_members"]
    if result.get("quick_actions"):
        # For tools that return quick actions via client execute
        pass # Not natively supported in state, but frontend reads it from the result if we had a way.
        
    return Command(goto="agent", update=update)


_graph_builder = StateGraph(ChatState)
_graph_builder.add_node("agent", agent_node)
_graph_builder.add_node("permission_gate", permission_gate)
_graph_builder.add_node("client_executor", client_executor_node)
_graph_builder.add_edge(START, "agent")
_graph_builder.add_conditional_edges("agent", _route_after_agent, {"permission_gate": "permission_gate", END: END})
# permission_gate routes itself via Command (agent | j_intake | j_resume) —
# no static outgoing edge, so Command is the single source of truth.
register_journey(_graph_builder)
register_claims_journey(_graph_builder)
register_group_journey(_graph_builder)


def build_graph(checkpointer):
    return _graph_builder.compile(checkpointer=checkpointer)
