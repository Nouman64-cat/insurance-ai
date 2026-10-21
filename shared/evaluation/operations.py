"""Operations: how the runner performs what a case's `input.payload.operation` names, and turns the answer into an observation
the assertion engine can check (see assertions.py for the shape).

Two modes, chosen per operation by what the case is actually about:
  function  the service's own pure function is called in-process (no database, no network, no cost). Used where the case
            checks a calculation, so the dataset pins today's numbers and any later change to the code or the rates shows.
  http      the running service is called. Used where the case checks an endpoint: its rules, its permissions, its status codes.
An operation never judges. It returns {"result": {...}} (and, later, "state" and "trace") and the assertion engine decides.

A problem that is not the service's answer (an unknown plan, no test tenant to call) raises OperationError: the harness could
not perform the case, which is reported as an error, never as a pass or a fail of the system under test.
Each operation is registered with @operation(name, mode). Step A holds quotes.calculate and rules.early_check; the rest follow.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Optional

OPERATIONS: Dict[str, "Operation"] = {}


class OperationError(Exception):
    """The harness could not perform the case (not a failure of the system under test)."""


class UnknownOperation(OperationError):
    pass


@dataclass
class RunContext:
    """What an operation may use. `http` is any async client with .post(url, json=..., headers=...) returning an object with
    .status_code and .json(); the runner supplies it, so this module needs no HTTP library."""
    fixtures: Dict[str, Any] = field(default_factory=dict)       # parsed fixture files by key
    http: Any = None
    base_url: Optional[str] = None                               # the service under test, e.g. http://localhost:8000
    tenant_id: Optional[str] = None                              # the isolated test tenant
    headers: Dict[str, str] = field(default_factory=dict)        # the acting user's credentials

    def fixture(self, key: str) -> Any:
        if key not in self.fixtures:
            raise OperationError(f"fixture {key!r} is not loaded for this run")
        return self.fixtures[key]


@dataclass
class Operation:
    name: str
    mode: str                                                    # function | http
    run: Callable[[RunContext, Dict[str, Any]], Awaitable[Dict[str, Any]]]


def operation(name: str, mode: str):
    def register(fn):
        OPERATIONS[name] = Operation(name=name, mode=mode, run=fn)
        return fn
    return register


async def execute(case: Dict[str, Any], ctx: RunContext) -> Dict[str, Any]:
    """Perform the case's operation and return the observation."""
    payload = case["input"].get("payload") or {}
    name = payload.get("operation")
    if name not in OPERATIONS:
        raise UnknownOperation(f"no operation {name!r} is registered")
    return await OPERATIONS[name].run(ctx, payload)


def _flat(response: Any) -> Dict[str, Any]:
    """A service answer as `result`: its JSON fields at the top, plus the status code. A body that is not an object is
    kept under `body`."""
    try:
        body = response.json()
    except Exception:
        body = None
    result: Dict[str, Any] = {"status_code": response.status_code}
    if isinstance(body, dict):
        result.update(body)
    elif body is not None:
        result["body"] = body
    return result


def _plan(ctx: RunContext, plan_code: str) -> Dict[str, Any]:
    plans = ctx.fixture("plans-individual-v1.json").get("plans", [])
    for plan in plans:
        if plan.get("code") == plan_code:
            return plan
    raise OperationError(f"plan {plan_code!r} is not in the plans fixture")


@operation("quotes.calculate", mode="function")
async def quotes_calculate(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """The premium for an applicant and plan, from the shared calculator the quote and the issued policy both use. The plan's
    rate and smoker factor come from the plans fixture, the same values the test tenant is loaded with."""
    from shared.pricing.calculator import calculate_premium
    plan, applicant = _plan(ctx, payload.get("plan_code")), payload.get("applicant") or {}
    try:
        breakdown = calculate_premium(payload["coverage_amount"], plan["base_premium_rate"], plan["smoker_factor"],
                                      applicant["age_years"], applicant["is_smoker"], applicant["height_cm"], applicant["weight_kg"])
    except KeyError as exc:
        raise OperationError(f"quotes.calculate is missing {exc}") from exc
    return {"result": breakdown.model_dump()}


@operation("rules.early_check", mode="http")
async def rules_early_check(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Would this applicant be declined before any underwriting step? Calls the tenant's rule engine."""
    if not (ctx.http and ctx.base_url and ctx.tenant_id):
        raise OperationError("rules.early_check needs the service URL and a test tenant")
    response = await ctx.http.post(f"{ctx.base_url}/tenants/{ctx.tenant_id}/rules/early-check", json=payload.get("body") or {},
                                   headers=ctx.headers)
    return {"result": _flat(response)}
