"""Narrow adapters for verified backend operations previously unavailable to chat.

Paths, methods and request fields are server-owned. No arbitrary URL/body proxy.
"""
from __future__ import annotations

from datetime import date
from typing import Literal
from uuid import UUID

from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field


class StrictArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EmptyArgs(StrictArgs):
    pass


class TokenUsageArgs(StrictArgs):
    start_date: date
    end_date: date


class CreateTenantArgs(StrictArgs):
    name: str = Field(min_length=1, max_length=150)
    code: str = Field(pattern=r"^[A-Za-z0-9_-]{2,50}$")


class PlatformRoleArgs(StrictArgs):
    action: Literal["create", "update"]
    role_id: UUID | None = None
    name: str = Field(min_length=2, max_length=50)
    description: str = Field(default="", max_length=1000)


class LLMModelArgs(StrictArgs):
    provider: Literal["openai", "anthropic", "gemini"]
    model_name: str = Field(min_length=1, max_length=150)
    role: Literal["primary", "fallback", "disabled"] | None = None


class PolicyArgs(StrictArgs):
    policy_id: UUID


class PaymentProofArgs(PolicyArgs):
    decision: Literal["accept", "reject"]
    note: str = Field(min_length=1, max_length=2000)


class ProposalTransitionArgs(StrictArgs):
    quote_id: UUID
    status: Literal["Proposed", "UnderReview", "InformationRequested"]


@tool(args_schema=EmptyArgs)
def get_platform_configuration(**kwargs) -> str:
    """SuperAdmin: inspect tenant setup, global roles and non-secret LLM provider status."""
    return "{}"


@tool(args_schema=CreateTenantArgs)
def create_platform_tenant(**kwargs) -> str:
    """SuperAdmin: create a tenant with an explicit name and code. Backend rejects duplicate names/codes."""
    return "{}"


@tool(args_schema=PlatformRoleArgs)
def manage_platform_role(**kwargs) -> str:
    """SuperAdmin: create or update a global role. Changing a name can change existing users' access; state the exact requested change first."""
    return "{}"


@tool(args_schema=LLMModelArgs)
def configure_platform_model(**kwargs) -> str:
    """SuperAdmin: update a configured provider's model and optional primary/fallback role. API keys must be managed in the platform console."""
    return "{}"


@tool(args_schema=TokenUsageArgs)
def get_platform_token_usage(**kwargs) -> str:
    """SuperAdmin: read platform token usage for an explicit date interval."""
    return "{}"


@tool(args_schema=PolicyArgs)
def get_initial_premium_status(**kwargs) -> str:
    """Read the initial premium collected on a proposal, before underwriting opens. Requires a verified proposal policy UUID."""
    return "{}"


@tool(args_schema=PolicyArgs)
def request_initial_premium(**kwargs) -> str:
    """Explicitly request the proposal's initial premium via the backend customer payment link. This may email the customer; it does not confirm payment."""
    return "{}"


@tool(args_schema=PaymentProofArgs)
def review_initial_premium_proof(**kwargs) -> str:
    """Authorized staff: accept or reject submitted initial-premium proof only after reviewing actual evidence, with an explicit decision and note."""
    return "{}"


@tool(args_schema=ProposalTransitionArgs)
def transition_proposal(**kwargs) -> str:
    """Submit or move an existing proposal into review or information requested. Uses the gateway's authoritative policy state machine; cannot approve or reject underwriting."""
    return "{}"


CAPABILITY_TOOLS = [get_platform_configuration, create_platform_tenant, manage_platform_role,
                    configure_platform_model, get_platform_token_usage, get_initial_premium_status,
                    request_initial_premium, review_initial_premium_proof, transition_proposal]
PLATFORM_TOOLS = frozenset(t.name for t in CAPABILITY_TOOLS[:5])
PROPOSAL_TOOLS = frozenset(t.name for t in CAPABILITY_TOOLS[5:])


def register_handlers():
    from tool_executor import handles, TENANT_SERVICE_URL

    models = {t.name: t.args_schema for t in CAPABILITY_TOOLS}

    async def dispatch(name, args, ctx):
        from permission import is_role_allowed
        if not is_role_allowed(name, ctx.exec_ctx.role, ctx.exec_ctx.platform):
            return {"success": False, "error_code": "forbidden", "error": "An authorized colleague must perform this action."}
        from pydantic import ValidationError
        try:
            args = models[name].model_validate(args).model_dump(mode="json")
        except ValidationError as exc:
            return {"success": False, "error_code": "validation", "needs_user_input": True,
                    "error": "Required fields are missing or invalid.",
                    "fields": [".".join(map(str, e["loc"])) for e in exc.errors(include_input=False)]}
        if name == "get_platform_configuration":
            data = {}
            for key, path in (("tenants", "/tenants/setup-status"), ("roles", "/roles/management"), ("llm", "/platform/llm-config")):
                response = await ctx.client.get(f"{TENANT_SERVICE_URL}{path}")
                response.raise_for_status()
                payload = response.json()
                # Explicitly whitelist fields: never forward credentials, even if the service response changes.
                if key == "llm":
                    payload = {"providers": [{k: row.get(k) for k in ("provider", "model_name", "role", "has_key")}
                                             for row in payload.get("providers", [])]}
                data[key] = payload
            return {"success": True, "configuration": data, "message": "Retrieved current platform configuration; credentials are excluded."}
        if name == "get_platform_token_usage":
            if args["end_date"] < args["start_date"]:
                return {"success": False, "error_code": "validation", "error": "End date must be on or after start date."}
            response = await ctx.client.get(f"{TENANT_SERVICE_URL}/tokens/usage", params=args)
        elif name == "create_platform_tenant":
            response = await ctx.client.post(f"{TENANT_SERVICE_URL}/tenants/", json=args)
        elif name == "manage_platform_role":
            action, role_id = args.pop("action"), args.pop("role_id")
            if action == "update" and not role_id:
                return {"success": False, "error_code": "validation", "needs_user_input": True, "error": "A verified role ID is required to update a role."}
            base = f"{TENANT_SERVICE_URL}/roles"
            response = await (ctx.client.post(base, json=args) if action == "create" else ctx.client.put(f"{base}/{role_id}", json=args))
        elif name == "configure_platform_model":
            provider = args.pop("provider")
            if args.get("role") is None:
                args.pop("role")
            response = await ctx.client.put(f"{TENANT_SERVICE_URL}/platform/llm-config/{provider}", json=args)
        elif name == "transition_proposal":
            quote_id = args.pop("quote_id")
            response = await ctx.client.patch(ctx.gateway(f"/quotes/{quote_id}"), json=args)
        else:
            policy_id = args.pop("policy_id")
            base = ctx.tsvc(f"/policies/{policy_id}/ipp")
            if name == "get_initial_premium_status":
                response = await ctx.client.get(base)
            elif name == "request_initial_premium":
                # Sending a second request revokes the first link. Reuse a valid existing request.
                current = await ctx.client.get(base)
                current.raise_for_status()
                existing = current.json()
                if existing.get("status") == "Realized" or (existing.get("link") and not existing.get("link_expired")):
                    return {"success": True, "skipped": True, "result": existing,
                            "message": "Initial premium already received." if existing.get("status") == "Realized" else "An active payment request already exists; reused its link without sending another email."}
                response = await ctx.client.post(base + "/request")
            else:
                response = await ctx.client.post(base + "/review", json=args)
        response.raise_for_status()
        data = response.json()
        if name == "configure_platform_model":
            data = {k: data.get(k) for k in ("provider", "model_name", "role", "has_key")}
        return {"success": True, "result": data, "message": f"{name.replace('_', ' ').capitalize()} confirmed by the owning service."}

    for tool in CAPABILITY_TOOLS:
        def build(name):
            async def handler(args, ctx):
                return await dispatch(name, args, ctx)
            return handler
        handles(tool.name)(build(tool.name))
