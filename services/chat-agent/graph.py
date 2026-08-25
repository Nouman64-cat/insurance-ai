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
import os

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from langchain_google_genai import ChatGoogleGenerativeAI
from pydantic import BaseModel, Field

import usage
from history import compact_tool_result, trim_history
from journey import register_journey
from toolsets import select_domains, tool_names_for

from pages import catalogue
from permission import (
    CLIENT_EXECUTED_TOOLS,
    MOBILE_PORTAL_ONLY_TOOLS,
    get_tools_for_role,
    is_destructive,
    is_role_allowed,
    missing_args,
    requires_confirmation,
)
from state import ChatState
from tool_executor import ExecCtx, execute_tool
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
update_case_status first for the decision, then continue.

## MANUAL STEP-BY-STEP (when the user drives one stage at a time)

1. **add_customer / add_organization / add_family_group** → Register the applicant. **CRITICAL:** If the user asks to "add a customer" but does not specify the type, you MUST ask them first whether the customer is an **Individual**, a **Corporate (Organization)**, or a **Family** group. Then, use the appropriate tool: `add_customer` for individuals, `add_organization` for corporate, and `add_family_group` for families.
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

## DEMO / GENERIC DATA

When the user says "demo", "test data", "generic data", or "make something up":
- For INDIVIDUAL customers, use **quick_start_workflow** (use_demo_data=true). Add full_journey=true if they want the whole flow exercised.
- For CORPORATE or FAMILY customers, DO NOT use quick_start_workflow. Instead, generate realistic fake data yourself (fake names, emails, incomes, etc.) and call the **add_organization** or **add_family_group** tool directly.

## STYLE

Brief (2–3 sentences), warm, professional. After every completed action, state what \
happened and what the sensible next step is — the UI turns your tool results into \
clickable recommendation buttons automatically."""

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

After any rule operation, offer to navigate to `admin/rule-engine` so the user can
visually confirm the change in the Rule Engine UI."""

DOMAIN_PROMPTS["commission"] = """

## COMMISSION ENGINE

**get_commission_rate_card** reads the SECP statutory rates out of the rule engine. \
**calculate_commission** previews the full waterfall for a policy — producer \
commission, hierarchy overrides, partner and referral fees, tax withholding. \
**get_commission_ledger** and **get_agent_statement** report what is owed and to \
whom; **get_commission_summary** is the portfolio-level view.

Payouts are maker–checker: **create_payout_run** assembles due tranches, \
**approve_payout_run** releases them, and the approver must not be the maker. \
Always name the period and the total before creating or approving a run."""

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
# (role, platform, domains) combinations in play is tiny.
_LLM_CACHE: dict[tuple, ChatGoogleGenerativeAI] = {}


def _llm(role: str = "Admin", platform: str = "web", domains: frozenset[str] | None = None):
    """The tool-bound model for this turn's scope."""
    key = (role, platform, domains)
    cached = _LLM_CACHE.get(key)
    if cached is not None:
        return cached

    allowed = get_tools_for_role(role, platform)
    if domains is not None:
        in_scope = tool_names_for(domains)
        allowed = [t for t in allowed if t.name in in_scope]

    llm = _bare_llm().bind_tools(allowed)
    _LLM_CACHE[key] = llm
    return llm


def _bare_llm() -> ChatGoogleGenerativeAI:
    """An unbound model — no tool schemas attached.

    Use this for side tasks like the plan advisor. Those used to go through
    _llm(), which bound all ~50 tool schemas (~7k tokens) to a call that
    needed none of them.
    """
    return ChatGoogleGenerativeAI(
        model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
        temperature=0.1,
        google_api_key=os.getenv("GEMINI_API_KEY"),
        max_output_tokens=2048,
        # Retries are handled by the explicit loop in agent_node. Leaving the
        # SDK's own layer at 3 on top of that meant a sustained 503 burned up
        # to nine billed calls for one turn.
        max_retries=0,
    )


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


async def agent_node(state: ChatState, config: RunnableConfig | None = None) -> dict:
    user_role = state.get("user_role") or "Admin"
    platform = state.get("platform") or "web"

    # Bind only the tools this conversation is plausibly about — see toolsets.py.
    sticky = state.get("active_domains") or []
    domains = frozenset(select_domains(_recent_text(state["messages"]), sticky))

    # Trim before sending. Without this the whole thread is re-sent every turn
    # and a long conversation's input cost climbs without any ceiling.
    history = trim_history(state["messages"])
    messages = [SystemMessage(content=_build_prompt(user_role, platform, domains)), *history]

    llm = _llm(user_role, platform, domains)
    thread_id = ((config or {}).get("configurable") or {}).get("thread_id")

    # Gemini intermittently 429s/503s under load — one failed call must not
    # kill a live conversation turn, so retry with short exponential backoff
    # before giving up. This is now the ONLY retry layer (see _bare_llm).
    last_exc: Exception | None = None
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
            return {"messages": [response], "active_domains": sorted(domains)}
        except Exception as exc:  # noqa: BLE001 — SDK raises provider-specific types
            last_exc = exc
            text = str(exc)
            # Quota/billing exhaustion and rate limits aren't transient in a way
            # a 1.5s backoff fixes — retrying just burns more calls against the
            # same exhausted key. Fail fast with the real cause.
            if "RESOURCE_EXHAUSTED" in text or "prepayment credits" in text:
                raise RuntimeError(
                    "The AI model is out of quota (prepayment credits depleted on the Gemini API key). "
                    "This needs billing topped up at https://ai.studio/projects — resending won't help."
                ) from exc
            if "429" in text or "rate limit" in text.lower():
                raise RuntimeError(
                    "The AI model is rate-limited right now. Give it a moment and resend that message."
                ) from exc
            if attempt < 2:
                await asyncio.sleep(1.5 * (attempt + 1))
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


class Top5PlansOutput(BaseModel):
    plan_names: list[str] = Field(description="List of top 5 exact plan names (the 'name' or 'label' field), sorted from most to least recommended.")

async def permission_gate(state: ChatState) -> Command:
    last = state["messages"][-1]
    # One action per turn — matches the platform's existing "ask, then act"
    # convention rather than letting the model batch several mutations at once.
    tool_call = last.tool_calls[0]
    name, args, call_id = tool_call["name"], tool_call["args"], tool_call["id"]
    platform = state.get("platform") or "web"
    ctx = ExecCtx(tenant_id=state["tenant_id"], jwt_token=state["jwt_token"], role=state.get("user_role") or "Agent")

    def back_to_agent(update: dict) -> Command:
        return Command(goto="agent", update=update)

    if not is_role_allowed(name, state["user_role"], platform):
        if platform == "mobile" and name in MOBILE_PORTAL_ONLY_TOOLS:
            msg = (
                "This app covers onboarding through Gate 6 (Medical Examination). "
                "Once the medical exam is booked, AI Risk Assessment and everything after it "
                "— review, approval, and policy issuance — happens on the web portal. "
                "Please continue there for this step."
            )
        else:
            msg = "Currently, you have no access to do this, ask your manager."
        result = {"success": False, "error": msg}
        return back_to_agent({"messages": [_tool_result_message(name, call_id, result)]})

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
                        llm = _bare_llm().with_structured_output(Top5PlansOutput, include_raw=True)
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

    if name == "create_rule_set":
        # Fetch the live category → subcategory tree so the user can pick from
        # real options rather than typing codes from memory.
        try:

            cats_res = await execute_tool("list_rule_categories", {}, ctx)
            cats = cats_res.get("categories", [])
        except Exception:
            cats = []

        if cats:
            # Build a flat list of "CATEGORY → Subcategory" display strings
            # that the clarify interrupt renders as clickable chips.
            # Also store eligibility_profiles per sub so we can ask for a
            # channel when the subcategory is CHANNEL_PRODUCT-scoped.
            cat_options: list[str] = []
            cat_map: dict[str, dict] = {}  # display → metadata
            for cat in cats:
                for sub in (cat.get("subcategories") or []):
                    display = f"{cat.get('name', cat.get('code'))} → {sub.get('name', sub.get('code'))}"
                    cat_options.append(display)
                    cat_map[display] = {
                        "category_code": cat.get("code", ""),
                        "subcategory_code": sub.get("code", ""),
                        "cat_name": cat.get("name", ""),
                        "sub_name": sub.get("name", ""),
                        # Profiles present → CHANNEL_PRODUCT scope; absent → GLOBAL
                        "profiles": sub.get("eligibility_profiles") or [],
                    }

            # Check if the model already resolved both codes to known values.
            provided_cat = (args.get("category_code") or "").upper()
            provided_sub = (args.get("subcategory_code") or "").upper()
            already_known = any(
                m["category_code"].upper() == provided_cat and m["subcategory_code"].upper() == provided_sub
                for m in cat_map.values()
            ) if provided_cat and provided_sub else False

            if not already_known and cat_options:
                # ── Step 1: pick category / subcategory ──────────────────────
                name_hint = f" **\"{args.get('name')}\"**" if args.get("name") else ""
                answer = interrupt({
                    "kind": "clarify",
                    "tool_call": {"name": name, "args": args},
                    "question": (
                        f"Creating rule set{name_hint}. "
                        "Which **category → subcategory** should it belong to?"
                    ),
                    "options": cat_options[:20],
                })

                # Match back to a known cat/sub entry
                selected = str(answer).strip()
                matched = cat_map.get(selected)
                if not matched:
                    for display, mapping in cat_map.items():
                        if selected.lower() in display.lower() or display.lower() in selected.lower():
                            matched = mapping
                            break

                if matched:
                    args["category_code"] = matched["category_code"]
                    args["subcategory_code"] = matched["subcategory_code"]

                    # ── Step 2: pick channel (only for CHANNEL_PRODUCT subs) ──
                    # If the subcategory has eligibility profiles, the API
                    # requires a channel_code so it can resolve eligibility_id.
                    # GLOBAL-scoped subcategories have no profiles — skip this.
                    profiles = matched["profiles"]
                    if profiles and not args.get("channel_code"):
                        channel_options = [
                            p.get("channel_code", p.get("id", ""))
                            for p in profiles
                            if p.get("channel_code")
                        ]
                        channel_options.append("GLOBAL (no specific channel)")
                        channel_answer = interrupt({
                            "kind": "clarify",
                            "tool_call": {"name": name, "args": args},
                            "question": (
                                f"**{matched['sub_name']}** is channel-scoped. "
                                "Which channel should this rule set apply to?"
                            ),
                            "options": channel_options,
                        })
                        chosen_channel = str(channel_answer).strip()
                        if "global" not in chosen_channel.lower():
                            # Strip any trailing label text — keep just the code
                            args["channel_code"] = chosen_channel.split()[0].upper()

                    # ── Auto-suggest a code if none provided ─────────────────
                    if not args.get("code"):
                        try:
                            existing_res = await execute_tool("list_rule_sets", {"category": matched["category_code"]}, ctx)
                            existing = existing_res.get("rule_sets", [])
                        except Exception:
                            existing = []
                        n = len(existing) + 1
                        cat_code = matched["category_code"]
                        prefix_map = {
                            "MEDICAL": "MED", "PRICING": "PRC", "COMMISSION": "COM",
                            "COMPLIANCE": "CMP", "UNDERWRITING": "UW", "INSURANCE": "HIS",
                            "REINSURANCE": "REI", "RBAC": "RBA", "AI_DECISION": "AI",
                            "ELIGIBILITY": "ELG", "CLAIMS": "CLM",
                        }
                        prefix = next(
                            (v for k, v in prefix_map.items() if k in cat_code.upper()),
                            cat_code[:3].upper()
                        )
                        args["code"] = f"RS-{prefix}-{n:03d}"

                # ── Step 3: ask for name if not provided ──────────────────────
                if not args.get("name"):
                    cat_label = args.get("category_code", "")
                    sub_label = args.get("subcategory_code", "")
                    chan_label = f" · channel `{args['channel_code']}`" if args.get("channel_code") else ""
                    name_answer = interrupt({
                        "kind": "clarify",
                        "tool_call": {"name": name, "args": args},
                        "question": (
                            f"Got it — filing under **{cat_label} / {sub_label}**{chan_label}. "
                            f"I've suggested the code **`{args.get('code')}`**. "
                            "What should the rule set be named? (Give it a clear description.)"
                        ),
                    })
                    args["name"] = str(name_answer).strip()

                # Execute immediately with all args resolved
                result = await execute_tool(name, args, ctx)
                update = {"messages": [_tool_result_message(name, call_id, result)]}
                if result.get("last_action"):
                    update["last_action"] = result["last_action"]
                return back_to_agent(update)


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
            or args.get("case_number") or args.get("email") or args.get("full_name") or ""
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
            })
        return Command(goto="j_resume", update={"pending_call": pending, "journey_error": None})

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
    if result.get("last_action"):
        update["last_action"] = result["last_action"]
    if result.get("assessment"):
        update["assessment"] = result["assessment"]
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


def build_graph(checkpointer):
    return _graph_builder.compile(checkpointer=checkpointer)
