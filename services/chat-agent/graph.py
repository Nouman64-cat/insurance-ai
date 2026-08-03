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
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from langchain_google_genai import ChatGoogleGenerativeAI
from pydantic import BaseModel, Field

from journey import register_journey

from pages import catalogue
from permission import (
    CLIENT_EXECUTED_TOOLS,
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

## AUTONOMOUS UNDERWRITING JOURNEY (preferred for end-to-end requests)

**start_underwriting_journey** runs the ENTIRE 7-stage pipeline autonomously: \
Intake → Case → Proposal → Document Audit → AI Risk Assessment → Decision → Closure. \
It auto-approves/declines on the risk bands and suspends only for missing documents \
or human review. Use it whenever the user wants an application processed end-to-end \
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
4. get_document_checklist / upload_document → collect required docs
5. run_risk_assessment → AI medical/financial/fraud scoring
6. approve_case → approve the case after risk assessment (moves to Policy Issuance queue)
7. get_pre_issuance_status / run_pre_issuance_verification → check or auto-complete the 4-step pre-issuance verification (requirements, compliance, beneficiaries, revised terms)
8. issue_policy → draft the contract, generate policy number, compute premium (moves to PendingPayment)
9. confirm_policy_payment → confirm first premium, activate coverage (moves to Active)
10. get_active_policy_status → verify the policy is Active and in the post-issuance section

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

ROLE_RESTRICTION_TEMPLATE = (
    "\n\nCRITICAL SECURITY INSTRUCTION: The current user's role is '{role}'. They are NOT an "
    "Admin. Mutating tools are blocked for this role at the platform level — if the user asks "
    "for one, politely explain they don't have sufficient permission. You can still look things "
    "up or navigate for them."
)


def _build_prompt(role: str) -> str:
    prompt = SYSTEM_PROMPT.format(pages=catalogue())
    if role not in ("SuperAdmin", "Admin"):
        prompt += ROLE_RESTRICTION_TEMPLATE.format(role=role)
    return prompt


def _llm() -> ChatGoogleGenerativeAI:
    return ChatGoogleGenerativeAI(
        model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
        temperature=0.1,
        google_api_key=os.getenv("GEMINI_API_KEY"),
        max_output_tokens=2048,
        # Belt: the SDK's own retry layer for rate-limit/transient errors.
        max_retries=3,
    ).bind_tools(ALL_TOOLS)


async def agent_node(state: ChatState) -> dict:
    messages = [SystemMessage(content=_build_prompt(state["user_role"])), *state["messages"]]
    # Braces: Gemini intermittently 429s/503s under load — one failed call must
    # not kill a live conversation turn, so retry with short exponential
    # backoff on top of the SDK's internal retries before giving up.
    llm = _llm()
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            response = await llm.ainvoke(messages)
            return {"messages": [response]}
        except Exception as exc:  # noqa: BLE001 — SDK raises provider-specific types
            last_exc = exc
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
    return ToolMessage(content=json.dumps(result), tool_call_id=call_id, name=name)


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
    ctx = ExecCtx(tenant_id=state["tenant_id"], jwt_token=state["jwt_token"])

    def back_to_agent(update: dict) -> Command:
        return Command(goto="agent", update=update)

    if not is_role_allowed(name, state["user_role"]):
        result = {"success": False, "error": "You do not have permission to perform this action."}
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
                    cust_res = await execute_tool("list_customers", {}, ctx)
                    query = customer_name_or_cnic.lower()
                    customer_data = None
                    for c in cust_res.get("items", []):
                        if query in (c.get("first_name", "") + " " + c.get("last_name", "")).lower() or query == c.get("cnic"):
                            customer_data = c
                            break
                    if customer_data:
                        llm = _llm().with_structured_output(Top5PlansOutput)
                        prompt = ChatPromptTemplate.from_messages([
                            ("system", "You are an expert life insurance advisor. You will be provided with a customer's details and a list of available insurance plans. Your task is to recommend the top 5 most suitable plans for this customer based on their demographics, age, and occupation. Return ONLY the exact plan names from the provided list, ordered by suitability."),
                            ("user", "Customer Data: {customer}\n\nAvailable Plans: {plans}")
                        ])
                        result = await (prompt | llm).ainvoke({"customer": customer_data, "plans": plans})
                        options = [opt for opt in result.plan_names if opt in valid_options]
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
