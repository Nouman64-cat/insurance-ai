"""Operations: how the runner performs what a case's `input.payload.operation` names, and turns the answer into an observation
the assertion engine can check (see assertions.py for the shape).

Two modes, chosen per operation by what the case is actually about:
  function  the service's own pure function is called in-process (no database, no network, no cost). Used where the case
            checks a calculation, so the dataset pins today's numbers and any later change to the code or the rates shows.
  http      the running service is called. Used where the case checks an endpoint: its rules, its permissions, its status codes.
An operation never judges. It returns {"result": {...}} (and, later, "state" and "trace") and the assertion engine decides.

A problem that is not the service's answer (an unknown plan, no test tenant to call) raises OperationError: the harness could
not perform the case, which is reported as an error, never as a pass or a fail of the system under test.
Each operation is registered with @operation(name, mode). Registered so far: quotes.calculate, rules.early_check and the
underwriting group (determine_requirements, assess_medical_requirement, decide, verify_profile).

The services read an ENV_VAR switch (strict or demo) that changes some rules; `execute` sets it from the case's own
`metadata.env_mode` for the duration of the call (a case that says "any" runs strict, the stricter of the two).
"""
from __future__ import annotations

import asyncio
import json
import mimetypes
import os
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta
from typing import Any, Awaitable, Callable, Dict, Iterator, List, Optional

OPERATIONS: Dict[str, "Operation"] = {}


class OperationError(Exception):
    """The harness could not perform the case (not a failure of the system under test)."""


class UnknownOperation(OperationError):
    pass


class MissingCredentials(OperationError):
    """The case needs a model provider the environment has no credentials for. Reported as blocked_missing_credentials."""


@dataclass
class RunContext:
    """What an operation may use. `http` is any async client with .post(url, json=..., headers=...) returning an object with
    .status_code and .json(); the runner supplies it, so this module needs no HTTP library."""
    fixtures: Dict[str, Any] = field(default_factory=dict)       # parsed fixture files by key
    http: Any = None
    base_url: Optional[str] = None                               # the service under test, e.g. http://localhost:8000
    tenant_id: Optional[str] = None                              # the isolated test tenant
    headers: Dict[str, str] = field(default_factory=dict)        # the acting user's credentials
    actor: Dict[str, Any] = field(default_factory=dict)          # who is acting (role, user_ref, tenant_ref): set by execute from the case
    tenant_ids: Dict[str, str] = field(default_factory=dict)     # test tenant ids by their fixture ref (tenant-a, tenant-b)
    ids: Dict[str, Dict[str, str]] = field(default_factory=dict) # ids of what the sandbox seeded: {"policies": {ref: id}, "quotes": {policy ref: id}}
    gateway_url: Optional[str] = None                            # the API gateway, for the few routes that live there (quotes); defaults to base_url
    ocr_url: Optional[str] = None                                # the OCR engine (its own service)
    files: Dict[str, bytes] = field(default_factory=dict)        # binary fixtures by file name (images, documents) the runner loaded
    usage_meter: Any = None                                      # shared.evaluation.usage.UsageMeter on the token ledger; None = not measured
    execution_id: str = "unattributed"                           # the evaluation execution this case belongs to (for attributing usage)

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


@contextmanager
def _env_mode(mode: Optional[str]) -> Iterator[None]:
    """ENV_VAR as the case declares it, restored afterwards. Cases run one after another, so a process-wide switch is safe."""
    before = os.environ.get("ENV_VAR")
    os.environ["ENV_VAR"] = "demo" if mode == "demo" else "strict"
    try:
        yield
    finally:
        if before is None:
            os.environ.pop("ENV_VAR", None)
        else:
            os.environ["ENV_VAR"] = before


async def execute(case: Dict[str, Any], ctx: RunContext) -> Dict[str, Any]:
    """Perform the case's operation and return the observation."""
    payload = case["input"].get("payload") or {}
    name = payload.get("operation")
    if name not in OPERATIONS:
        raise UnknownOperation(f"no operation {name!r} is registered")
    ctx = replace(ctx, actor=(case["input"].get("actor") or {}))
    try:
        with _env_mode((case.get("metadata") or {}).get("env_mode")):
            return await OPERATIONS[name].run(ctx, payload)
    except ImportError as exc:
        # The operation calls the service's own code, which needs the service's packages: run inside its container.
        raise OperationError(f"{name} needs the service's dependencies ({exc}); run it inside the tenant-service container") from exc


def _flat(response: Any) -> Dict[str, Any]:
    """A service answer as `result`: its JSON fields at the top, the status code, and the whole answer under `body`."""
    try:
        body = response.json()
    except Exception:
        body = None
    result: Dict[str, Any] = {"status_code": response.status_code}
    if isinstance(body, dict):
        result.update(body)
    if body is not None:
        result["body"] = body          # the whole answer too: cases address `result.body.<field>` and `result.body` as text
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


# ── Underwriting ────────────────────────────────────────────────────────────────────────────────────────────────────────
# These call the real rule code. None of them writes anything, so `state` is what the fixtures already hold: a case that
# asserts "the declared income was not overwritten" reads it from there.

def _need(payload: Dict[str, Any], *keys: str) -> List[Any]:
    missing = [k for k in keys if k not in payload]
    if missing:
        raise OperationError(f"{payload.get('operation')} is missing {', '.join(missing)}")
    return [payload[k] for k in keys]


def _value(x: Any) -> Any:
    return getattr(x, "value", x)


def _unchanged_state(ctx: RunContext) -> Dict[str, Any]:
    """The customers as the fixture holds them: nothing in these operations changes a record."""
    personas = ctx.fixtures.get("personas-individual-v1.json") or {}
    return {"customers": {c["ref"]: {"declared_income": c.get("declared_income"), "cnic": c.get("cnic"), "exists": True}
                          for c in personas.get("customers", [])}}


def _dob_for(age: int) -> date:
    """A birth date that makes the applicant `age` years old today, with a margin so the age holds all year."""
    return date.today() - timedelta(days=365 * age + 100)


@operation("underwriting.determine_requirements", mode="function")
async def underwriting_determine_requirements(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Which evidence the shared requirements engine asks for, given the applicant, the cover and the questionnaire."""
    from shared.underwriting.profile import build_profile
    from shared.underwriting.requirements_rules import determine_requirements
    applicant, policy = _need(payload, "applicant", "policy")
    try:
        profile = build_profile(
            {"dob": _dob_for(applicant["age_years"]), "declared_income": applicant["declared_income"], "is_smoker": applicant["is_smoker"],
             "height_cm": applicant["height_cm"], "weight_kg": applicant["weight_kg"], "occupation": applicant.get("occupation", "Teacher")},
            {"coverage_amount": policy["coverage_amount"], "term_years": policy["term_years"]},
            e_application={"medical_questionnaire": payload.get("medical_questionnaire") or {}})
    except KeyError as exc:
        raise OperationError(f"underwriting.determine_requirements is missing {exc}") from exc
    specs = determine_requirements(profile)
    return {"result": {"required_codes": sorted(_value(s.code) for s in specs if s.required),
                       "all_codes": sorted(_value(s.code) for s in specs)}, "state": _unchanged_state(ctx)}


@operation("underwriting.assess_medical_requirement", mode="function")
async def underwriting_assess_medical_requirement(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """The underwriting limit book: is a medical needed at this age and sum at risk, which tests, and at what cost."""
    from services import underwriting_limits
    applicant, sum_at_risk = _need(payload, "applicant", "sum_at_risk")
    r = underwriting_limits.assess_medical_requirement(age=applicant["age_years"], sum_at_risk=sum_at_risk, gender=applicant.get("gender"),
                                                       is_smoker=applicant.get("is_smoker"), adverse_disclosures=payload.get("disclosures"))
    return {"result": {"required": r["required"], "non_medical_limit": r["non_medical_limit"],
                       "tests": [t["code"] for t in r["tests"]], "estimated_cost": r["estimated_cost"]}}


def _decide(payload: Dict[str, Any], findings: List[Dict[str, str]]) -> str:
    """The decision engine, fed assessments the case spells out (any it does not mention are the neutral ones)."""
    from shared.underwriting.decision_rules import decide
    from shared.underwriting.results import (FinancialUnderwritingResult, FraudAssessment, FraudSeverity, MedicalRiskClass,
                                             MedicalUnderwritingResult, VerificationFindingSpec, VerificationSeverity)
    medical = payload.get("medical") or {}
    financial = payload.get("financial") or {}
    fraud = payload.get("fraud") or {}
    decision, _ = decide(
        requirements_satisfied=payload.get("requirements_satisfied", True),
        medical=MedicalUnderwritingResult(risk_score=medical.get("risk_score", 40), risk_class=MedicalRiskClass(medical.get("risk_class", "Standard")),
                                          loading_percentage=medical.get("loading_percentage"),
                                          requires_human_review=medical.get("requires_human_review", False)),
        financial=FinancialUnderwritingResult(financially_justified=financial.get("financially_justified", True), declared_income=1_000_000,
                                              coverage_to_income_ratio=5.0, referral_required=financial.get("referral_required", False)),
        fraud=FraudAssessment(probability=fraud.get("probability", 0.05), severity=FraudSeverity(fraud.get("severity", "Low")),
                              investigation_required=fraud.get("investigation_required", False)),
        findings=[VerificationFindingSpec(field=f["field"], severity=VerificationSeverity(f["severity"]), explanation="synthetic")
                  for f in findings])
    return _value(decision)


@operation("underwriting.decide", mode="function")
async def underwriting_decide(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """The final underwriting decision from the medical, financial, fraud and verification assessments."""
    return {"result": {"decision": _decide(payload, payload.get("findings") or [])}}


@operation("underwriting.verify_profile", mode="function")
async def underwriting_verify_profile(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Compare what the customer declared with what the evidence shows (income on a salary slip, the CNIC on a card), then
    decide the case on the findings with everything else clean."""
    from shared.underwriting.profile import UnderwritingProfile
    from shared.underwriting.verification import verify_profile
    declared = payload.get("declared") or {}
    income = payload.get("declared_income", declared.get("declared_income", 0))
    monthly = payload.get("verified_monthly_income")
    profile = UnderwritingProfile(
        identity={"cnic": declared.get("cnic"), "evidence": {"cnic": payload.get("evidence_cnic"), "dob": payload.get("evidence_dob")}},
        demographics={"dob": declared.get("dob")},
        financial={"declared_income": income, "verified_income": monthly * 12 if monthly is not None else None},
        medical_history={"declared_conditions": {}, "document_findings": []})
    findings = [{"field": f.field, "severity": _value(f.severity)} for f in verify_profile(profile)]
    return {"result": {"findings": findings, "decision": _decide({}, findings)}, "state": _unchanged_state(ctx)}


# ── Claims ────────────────────────────────────────────────────────────────────────────────────────────────────────────

def _find(ctx: RunContext, fixture: str, collection: str, ref: str) -> Dict[str, Any]:
    for item in ctx.fixture(fixture).get(collection, []):
        if item.get("ref") == ref:
            return item
    raise OperationError(f"{ref!r} is not in {fixture}")


@operation("claims.verify_eligibility", mode="function")
async def claims_verify_eligibility(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Is the claim covered, judged on the event date against the policy's own status history (the claims engine's pure rules)."""
    from services import claim_engine
    policy = _find(ctx, "policies-claims-v1.json", "policies", _need(payload, "policy")[0])
    plan = _plan(ctx, policy["plan"])
    events = [{"at": datetime.fromisoformat(e["at"]), "event_type": e["event_type"], "to_status": e["to_status"], "detail": e.get("detail")}
              for e in policy.get("status_history") or []]
    effective = date.fromisoformat(policy["effective_date"])
    periods = claim_engine.coverage_timeline(events, effective_date=effective, status_now=policy["status"])
    try:
        r = claim_engine.evaluate_eligibility_facts(
            category=payload["category"], event_date=date.fromisoformat(payload["event_date"]),
            reported_date=date.fromisoformat(payload["reported_date"]), today=date.fromisoformat(payload["today"]) if payload.get("today") else date.today(),
            periods=periods, policy_status=policy["status"], maturity_date=None, insurance_type=plan["insurance_type"],
            coverage_amount=policy["coverage_amount"], riders=policy.get("riders") or [],
            covered_relationship=payload.get("covered_person_relationship", "Self"), cause=payload.get("cause"), duplicate_count=0)
    except KeyError as exc:
        raise OperationError(f"claims.verify_eligibility is missing {exc}") from exc
    return {"result": {"status": r["status"], "message": r["message"], "blockers": sorted(c["key"] for c in r["blockers"]),
                       "reviews": sorted(c["key"] for c in r["reviews"]), "contestable": r["contestable"]}}


class _NoMatrixRow:
    def first(self) -> None:
        return None


class _NoDatabase:
    """Stands in for the session when the claim authority matrix is not configured: limits_for then answers the platform
    defaults, which is what a tenant that has not set its own limits gets."""
    async def exec(self, *_args: Any, **_kwargs: Any) -> _NoMatrixRow:
        return _NoMatrixRow()


@operation("claims.decide", mode="function")
async def claims_decide(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """May this role approve or decline a claim of this size? Runs the claim authority gate the decision endpoint runs first.
    It models the gate only: when the gate lets the decision through, nothing is recorded here, so a case that asserts the
    claim's resulting state reports that it was not observed (it is the endpoint's job once a test tenant exists)."""
    from fastapi import HTTPException
    from services import claim_authority
    claim = _find(ctx, "policies-claims-v1.json", "claims", _need(payload, "claim")[0])
    role = (ctx.actor or {}).get("role")
    if not role:
        raise OperationError("claims.decide needs the acting user's role")
    try:
        await claim_authority.assert_can_decide(_NoDatabase(), None, role, claim["submitted_amount"], referred_up=False)
    except HTTPException as exc:
        # The gate refused: the claim was not touched, so its status is what the fixture holds.
        return {"result": {"status_code": exc.status_code, "detail": exc.detail}, "state": {"claim": {"status": claim["status"]}}}
    return {"result": {"status_code": 200}}


@operation("claims.list_payments", mode="http")
async def claims_list_payments(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """The Finance payment register of a tenant, asked for by a user of another tenant (the cross-tenant guard)."""
    if not (ctx.http and ctx.base_url):
        raise OperationError("claims.list_payments needs the service URL and the test tenants")
    ref = payload.get("tenant")
    tenant = ctx.tenant_ids.get(ref) if ref else ctx.tenant_id
    if not tenant:
        raise OperationError(f"claims.list_payments: no test tenant for {ref!r}")
    return {"result": _flat(await ctx.http.get(f"{ctx.base_url}/tenants/{tenant}/claims/payments", headers=ctx.headers))}


# ── Compliance screening ────────────────────────────────────────────────────────────────────────────────────────────────
# The three mandatory checks the platform runs on every applicant. They read only the few fields they screen, so the case's
# `customer` and `policy` are given as plain objects with those fields.

def _screening(check: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": {"status": check["status"], "score": check["score"], "details": check["details"]}}


@operation("compliance.screen_aml", mode="function")
async def compliance_screen_aml(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """The anti-money-laundering score: occupation signals, cover against income, and very large sums assured."""
    from types import SimpleNamespace
    from services import compliance_engine
    customer, policy = _need(payload, "customer", "policy")
    return _screening(compliance_engine._screen_aml(
        SimpleNamespace(occupation=customer.get("occupation"), declared_income=customer.get("declared_income")),
        SimpleNamespace(coverage_amount=policy.get("coverage_amount"))))


@operation("compliance.screen_secp", mode="function")
async def compliance_screen_secp(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """The identity check: the CNIC must be present and a valid 13-digit number."""
    from types import SimpleNamespace
    from services import compliance_engine
    (customer,) = _need(payload, "customer")
    return _screening(compliance_engine._screen_secp(SimpleNamespace(cnic=customer.get("cnic"))))


@operation("compliance.screen_sanctions", mode="function")
async def compliance_screen_sanctions(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """The sanctions and PEP screen. The cases pin the fallback that applies when no live OpenSanctions key is configured, so
    the key is cleared for this one call (and put back): the real screening flow runs, with no network and no name sent out."""
    from types import SimpleNamespace
    from services import compliance_engine, pep_screening
    (customer,) = _need(payload, "customer")
    live_key = pep_screening._API_KEY
    pep_screening._API_KEY = ""
    try:
        check = await compliance_engine._screen_sanctions(SimpleNamespace(name=customer.get("name"), dob=None))
    finally:
        pep_screening._API_KEY = live_key
    return _screening(check)


# ── Policy lifecycle: initial premium payment and pre-issuance readiness ──────────────────────────────────────────────────
# These endpoints act on policies that already exist in the test tenant (a proposal, a payment already received, a policy
# waiting on a reinsurer), so they need the seeded sandbox; the runner supplies the ids of what it seeded in `ctx.ids`.

def _policy_url(ctx: RunContext, payload: Dict[str, Any], tail: str) -> str:
    if not (ctx.http and ctx.base_url and ctx.tenant_id):
        raise OperationError(f"{payload.get('operation')} needs the service URL and a test tenant")
    ref = _need(payload, "policy")[0]
    policy_id = (ctx.ids.get("policies") or {}).get(ref)
    if not policy_id:
        raise OperationError(f"{payload.get('operation')}: the sandbox has not seeded policy {ref!r}")
    return f"{ctx.base_url}/tenants/{ctx.tenant_id}/policies/{policy_id}/{tail}"


async def _ipp_state(ctx: RunContext, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The payment record as it stands after the call, which is what a case means by `state.ipp`."""
    url = _policy_url(ctx, payload, "ipp")
    response = await ctx.http.get(url, headers=ctx.headers)
    return _flat(response).get("body") if response.status_code == 200 else None


@operation("ipp.initiate", mode="http")
async def ipp_initiate(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Start the initial premium payment of a proposal; the answer carries the amount due now."""
    url = _policy_url(ctx, payload, "ipp/initiate")        # built first: it reports a missing service or an unseeded policy
    response = await ctx.http.post(url, json=payload.get("body") or {}, headers=ctx.headers)
    return {"result": _flat(response), "state": {"ipp": await _ipp_state(ctx, payload)}}


@operation("ipp.confirm", mode="http")
async def ipp_confirm(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Confirm that the initial premium was received (outside demo mode it needs the transaction reference)."""
    url = _policy_url(ctx, payload, "ipp/confirm")
    response = await ctx.http.post(url, json=payload.get("body") or {}, headers=ctx.headers)
    return {"result": _flat(response), "state": {"ipp": await _ipp_state(ctx, payload)}}


@operation("policies.pre_issuance", mode="http")
async def policies_pre_issuance(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """The issuance readiness checklist: is this policy ready to issue, and if not, what blocks it."""
    url = _policy_url(ctx, payload, "pre-issuance")
    return {"result": _flat(await ctx.http.get(url, headers=ctx.headers))}


# ── Operations that change data ────────────────────────────────────────────────────────────────────────────────────────
# Each reads the relevant state before and after the call, so "nothing was created" and "the status did not change" are
# observed, not assumed. They only ever run against the isolated test tenant the runner seeds.

def _service(ctx: RunContext, payload: Dict[str, Any]) -> None:
    if not (ctx.http and ctx.base_url and ctx.tenant_id):
        raise OperationError(f"{payload.get('operation')} needs the service URL and a test tenant")


async def _customers(ctx: RunContext) -> List[Dict[str, Any]]:
    response = await ctx.http.get(f"{ctx.base_url}/tenants/{ctx.tenant_id}/customers", headers=ctx.headers)
    if response.status_code != 200 or not isinstance(response.json(), list):
        raise OperationError(f"could not list the test tenant's customers (status {response.status_code})")
    return response.json()


async def _policy_state(ctx: RunContext, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The policy as it stands after the call: its status, and whether it has been given a policy number."""
    url = _policy_url(ctx, payload, "")[:-1]                       # .../policies/<id>
    response = await ctx.http.get(url, headers=ctx.headers)
    if response.status_code != 200 or not isinstance(response.json(), dict):
        return None
    body = response.json()
    return {"status": body.get("status"), "policy_number_is_null": body.get("policy_number") is None}


@operation("customers.create", mode="http")
async def customers_create(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Register a customer. The customers are listed before and after, so the new ones are counted and every stored CNIC
    can be checked (a refused or injected value must not be among them)."""
    _service(ctx, payload)
    before = {c["id"] for c in await _customers(ctx)}
    response = await ctx.http.post(f"{ctx.base_url}/tenants/{ctx.tenant_id}/customers", json=payload.get("body") or {}, headers=ctx.headers)
    after = await _customers(ctx)
    return {"result": _flat(response),
            "state": {"new_customers": len([c for c in after if c["id"] not in before]), "customers": {"cnics": [c.get("cnic") for c in after]}}}


@operation("quotes.update_status", mode="http")
async def quotes_update_status(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Move a proposal to another status. The route is on the API gateway and takes the quote's id; the policy is read back."""
    _service(ctx, payload)
    ref = _need(payload, "policy")[0]
    quote_id = (ctx.ids.get("quotes") or {}).get(ref)
    if not quote_id:
        raise OperationError(f"quotes.update_status: the sandbox has not seeded a quote for {ref!r}")
    response = await ctx.http.patch(f"{ctx.gateway_url or ctx.base_url}/quotes/{quote_id}", json=payload.get("body") or {}, headers=ctx.headers)
    return {"result": _flat(response), "state": {"policy": await _policy_state(ctx, payload)}}


@operation("policies.issue", mode="http")
async def policies_issue(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Issue a policy (give it a number and bind the contract). Only an approved policy may be issued."""
    url = _policy_url(ctx, payload, "issue")
    response = await ctx.http.post(url, json=payload.get("body") or {}, headers=ctx.headers)
    return {"result": _flat(response), "state": {"policy": await _policy_state(ctx, payload)}}


# ── Document reading (OCR) ─────────────────────────────────────────────────────────────────────────────────────────────
# The OCR engine is its own service and calls a vision model, so these cases cost money and the answer can differ between
# runs. Two of the five are refused before the model is reached: they are free and deterministic, and they assert that
# no model call was made.

@operation("ocr.extract_customer", mode="http")
async def ocr_extract_customer(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Upload a document to the customer-form reader and return the fields it found.

    The model calls it caused are measured from the token ledger (shared/evaluation/usage.py) and written as
    `trace.llm_calls` only when they are known. A reply that read a document proves at least one call; if the ledger shows
    fewer, or cannot be read, the count is not written at all, so an assertion about it is reported as "not observed" and
    can never pass on an assumed zero. What was measured, known or not, is always in `usage` for the cost records."""
    if not (ctx.http and ctx.ocr_url):
        raise OperationError("ocr.extract_customer needs the OCR engine's URL")
    name = _need(payload, "file")[0]
    if name not in ctx.files:
        raise OperationError(f"ocr.extract_customer: the file {name!r} is not loaded for this run")
    content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    meter = ctx.usage_meter
    mark = await meter.begin(ctx.execution_id) if meter else None
    try:
        response = await ctx.http.post(f"{ctx.ocr_url}/extract-customer", files={"file": (name, ctx.files[name], content_type)}, headers=ctx.headers)
    except BaseException:
        if meter:
            meter.abandon()
        raise
    if response.status_code == 503:
        # The engine has no model to call: the environment lacks a provider, which is not the system answering the case.
        if meter:
            meter.abandon()
        raise MissingCredentials("the OCR engine has no model provider configured in this environment (set OPENAI_API_KEY in eval.env)")
    result = _flat(response)
    if isinstance(result.get("fields"), dict):
        result["fields_json"] = json.dumps(result["fields"], ensure_ascii=False)      # the fields as one text, for "must not appear" checks
    observation: Dict[str, Any] = {"result": result}
    if meter:
        usage = await meter.end(mark, expected_min_calls=1 if response.status_code == 200 else 0, reported_tokens=result.get("token_usage"))
        observation["usage"] = usage.as_dict()
        if usage.known:
            observation["trace"] = {"llm_calls": usage.calls, "token_usage": result.get("token_usage")}
    return observation


# ── Listing a tenant's records, as a signed-in member, a member of another tenant, or nobody ─────────────────────────────

async def _list(ctx: RunContext, payload: Dict[str, Any], tail: str) -> Dict[str, Any]:
    if not (ctx.http and ctx.base_url):
        raise OperationError(f"{payload.get('operation')} needs the service URL and the test tenants")
    ref = payload.get("tenant")
    tenant = ctx.tenant_ids.get(ref) if ref else ctx.tenant_id
    if not tenant:
        raise OperationError(f"{payload.get('operation')}: no test tenant for {ref!r}")
    headers = {k: v for k, v in ctx.headers.items() if not (payload.get("anonymous") and k.lower() == "authorization")}
    return {"result": _flat(await ctx.http.get(f"{ctx.base_url}/tenants/{tenant}/{tail}", headers=headers))}


@operation("policies.list", mode="http")
async def policies_list(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """The policy list of a tenant. `anonymous: true` sends no login at all."""
    return await _list(ctx, payload, "policies")


@operation("claims.list", mode="http")
async def claims_list(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """The claim list of a tenant."""
    return await _list(ctx, payload, "claims")


@operation("chat.stream", mode="chat")
async def chat_stream(ctx: RunContext, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Registered so the runner knows the operation exists. Conversations are not performed through `execute`: they need the chat
    agent, the scripted model and database snapshots, which the runner wires up (shared/evaluation/chat_executor.py)."""
    raise OperationError("chat cases are executed by the chat executor, not by execute()")
