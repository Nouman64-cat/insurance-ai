"""Oracles: how the Golden cases get their deterministic ground truth.

Every deterministic expectation in the Individual Insurance dataset is re-derived from the code that actually runs:

  * pure modules are imported as they are (pricing calculator, underwriting rules, decision engine);
  * modules that also touch the database or an agent framework are imported with small stand-ins for those
    dependencies (the enums are rebuilt from shared/models/core.py itself, so statuses and transitions are the real ones);
  * the few rules that live inline in a handler (phone check, knockout keywords, payment split) are read from the
    source text and executed from there, so a change in the code shows up as a verification failure.

`premium_independent` is deliberately a second implementation, written from the documented formula, so the premium
numbers are checked against something other than the code that produced them.

Nothing here connects to a database or a model provider. Run from the repository root:  python evals/tools/verify_dataset.py
"""
from __future__ import annotations

import ast
import enum
import re
import sys
import types
from bisect import bisect_right
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional

REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "microservices" / "backend-microservices"
TENANT = BACKEND / "tenant-service"
CHAT = BACKEND / "chat-agent"
SHARED = REPO / "shared"

if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))


# ── Stand-ins for what the host does not have installed ─────────────────────────────────────────────────────────

def _dummy_module(name: str) -> types.ModuleType:
    mod = types.ModuleType(name)
    mod.__getattr__ = lambda attr: type(attr, (), {})          # any name resolves to an empty class
    return mod


def _enums_of(path: Path) -> Dict[str, type]:
    """Every `class X(str, Enum)` in a file, rebuilt as a real Enum, without importing the file."""
    out: Dict[str, type] = {}
    for node in ast.parse(path.read_text(encoding="utf-8")).body:
        if isinstance(node, ast.ClassDef) and any(getattr(b, "id", None) == "Enum" for b in node.bases):
            members = {}
            for stmt in node.body:
                if isinstance(stmt, ast.Assign) and isinstance(stmt.targets[0], ast.Name):
                    try:
                        members[stmt.targets[0].id] = ast.literal_eval(stmt.value)
                    except (ValueError, SyntaxError):
                        pass
            if members:
                out[node.name] = enum.Enum(node.name, members, type=str)
    return out


_prepared = False


def prepare() -> None:
    """Install the stand-ins once. Safe to call repeatedly."""
    global _prepared
    if _prepared:
        return
    core = _dummy_module("shared.models.core")
    for name, cls in _enums_of(SHARED / "models" / "core.py").items():
        setattr(core, name, cls)
    sys.modules["shared.models.core"] = core
    for name in ("sqlmodel", "sqlmodel.ext", "sqlmodel.ext.asyncio", "sqlmodel.ext.asyncio.session"):
        sys.modules.setdefault(name, _dummy_module(name))
    lc, lt = types.ModuleType("langchain_core"), types.ModuleType("langchain_core.tools")

    def tool(*a, **kw):
        def deco(fn):
            fn.name = fn.__name__
            return fn
        return deco(a[0]) if a and callable(a[0]) else deco
    lt.tool, lc.tools = tool, lt
    sys.modules.update({"langchain_core": lc, "langchain_core.tools": lt})
    fastapi = types.ModuleType("fastapi")

    class HTTPException(Exception):
        def __init__(self, status_code: int, detail: Any = None):
            super().__init__(detail)
            self.status_code, self.detail = status_code, detail
    fastapi.HTTPException = HTTPException
    sys.modules.setdefault("fastapi", fastapi)
    # The policy state machine now records an outbox event on every transition. The checks here only ask whether a transition is legal, and the
    # outbox is a database table that cannot be built from the empty `sqlmodel` stand-in above, so it is replaced by one that does nothing.
    outbox = _dummy_module("shared.events.outbox")
    outbox.enqueue_policy_event = lambda *a, **kw: None
    sys.modules["shared.events.outbox"] = outbox
    skills = types.ModuleType("skills")
    skills.enabled = lambda: True
    sys.modules["skills"] = skills
    services = types.ModuleType("services")             # tenant-service's own package, found by path
    services.__path__ = [str(TENANT / "services")]
    sys.modules["services"] = services
    _prepared = True


@contextmanager
def _path(p: Path):
    sys.path.insert(0, str(p))
    try:
        yield
    finally:
        sys.path.remove(str(p))


def tenant_module(name: str):
    prepare()
    import importlib
    return importlib.import_module(f"services.{name}")


def function_from_source(path: Path, name: str, namespace: Optional[dict] = None) -> Callable:
    """A top-level function lifted out of a file by source text, for helpers inside modules too heavy to import."""
    src = path.read_text(encoding="utf-8")
    for node in ast.parse(src).body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            ns: dict = {"Optional": Optional, "re": re, **(namespace or {})}
            exec(compile(ast.get_source_segment(src, node), str(path), "exec"), ns)
            return ns[name]
    raise LookupError(f"{name} not found in {path}")


def assignment_from_source(path: Path, name: str, namespace: Optional[dict] = None) -> Any:
    src = path.read_text(encoding="utf-8")
    for node in ast.parse(src).body:
        target = node.targets[0] if isinstance(node, ast.Assign) else getattr(node, "target", None)
        if isinstance(target, ast.Name) and target.id == name and getattr(node, "value", None) is not None:
            return eval(compile(ast.Expression(node.value), str(path), "eval"), {"re": re, **(namespace or {})})
    raise LookupError(f"{name} not found in {path}")


# ── Premium ─────────────────────────────────────────────────────────────────────────────────────────────────────

def premium_real(*, coverage: float, rate: float, smoker_factor: float, age: int, smoker: bool, height_cm: float,
                 weight_kg: float, loading_pct: float = 0.0, age_index: float = 1.0) -> dict:
    from shared.pricing.calculator import calculate_premium
    r = calculate_premium(coverage, rate, smoker_factor, age, smoker, height_cm, weight_kg, loading_pct, age_index)
    return {"age_factor": r.age_factor, "bmi_factor": r.bmi_factor, "smoker_multiplier": r.smoker_multiplier,
            "base_premium": r.base_premium, "loading_applied": r.loading_applied, "risk_premium": r.risk_premium,
            "policy_fee": r.policy_fee, "stamp_duty_amount": r.stamp_duty_amount, "tax_amount": r.tax_amount,
            "total_premium": r.total_premium}


_AGE_LOWER = [18, 26, 36, 46, 56, 66]
_AGE_FACTOR = [Decimal("0.8"), Decimal("1.0"), Decimal("1.3"), Decimal("1.8"), Decimal("2.5"), Decimal("3.5")]


def _money(x: Decimal) -> float:
    return float(x.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def premium_independent(*, coverage: float, rate: float, smoker_factor: float, age: int, smoker: bool, height_cm: float,
                        weight_kg: float, loading_pct: float = 0.0, age_index: float = 1.0) -> dict:
    """Written from the formula in the calculator's docstring and the published bands, in Decimal, not from its code."""
    d = Decimal
    idx = bisect_right(_AGE_LOWER, age) - 1
    age_factor = _AGE_FACTOR[max(idx, 0)]
    bmi = d(str(weight_kg)) / ((d(str(height_cm)) / 100) ** 2)
    bmi_factor = d("1.0") if d("18.5") <= bmi <= d("24.9") else d("1.15")
    # BMI 24.95 would sit between the two published ends; the code compares with <18.5 and >24.9 on the raw value.
    if d("24.9") < bmi:
        bmi_factor = d("1.15")
    smoker_mult = d(str(smoker_factor)) if smoker else d("1")
    base = d(str(coverage)) / 1000 * d(str(rate)) * d(str(age_index)) * age_factor
    loading = base * (smoker_mult - 1) + base * (bmi_factor - 1) + base * d(str(max(loading_pct, 0.0))) / 100
    risk = base + loading
    fee = d("500")
    sub = risk + fee
    stamp, tax = sub * d("0.01"), sub * d("0.16")
    return {"age_factor": float(age_factor), "bmi_factor": float(bmi_factor), "smoker_multiplier": float(smoker_mult),
            "base_premium": _money(base), "loading_applied": _money(loading), "risk_premium": _money(risk),
            "policy_fee": _money(fee), "stamp_duty_amount": _money(stamp), "tax_amount": _money(tax),
            "total_premium": _money(sub + stamp + tax)}


def premium(**kw) -> dict:
    """The real calculator's answer; raises if the independent implementation disagrees by more than a paisa."""
    real, other = premium_real(**kw), premium_independent(**kw)
    for key, value in real.items():
        if abs(value - other[key]) > 0.011:
            raise AssertionError(f"premium {key}: code says {value}, independent calculation says {other[key]}")
    return real


def payment_split(total: float) -> dict:
    """RS-PAY-001 as seeded: the share paid before underwriting, from the rule set in services/payment_split.py."""
    rule_set = assignment_from_source(TENANT / "services" / "payment_split.py", "PAYMENT_SPLIT_RULE_SET",
                                      {"DEFAULT_MESSAGE": "", "PAYMENT_SPLIT_RULE_SET_CODE": "RS-PAY-001"})
    pct = float(rule_set["rules"][0]["outcome_payload"]["upfront_payment_pct"])
    upfront = round(round(total, 2) * pct / 100.0, 2)
    return {"upfront_pct": pct, "upfront_amount": upfront, "remaining_amount": round(round(total, 2) - upfront, 2)}


# ── Underwriting rules ──────────────────────────────────────────────────────────────────────────────────────────

def _dob_for(age: int) -> date:
    return date.today() - timedelta(days=365 * age + 100)


def requirements(*, age: int, coverage: float, declared_income: float, smoker: bool = False, height_cm: float = 170.0,
                 weight_kg: float = 65.0, questionnaire: Optional[dict] = None) -> List[str]:
    """The required requirement codes, sorted, for a case with no documents yet."""
    from shared.underwriting.profile import build_profile
    from shared.underwriting.requirements_rules import determine_requirements
    profile = build_profile(
        {"dob": _dob_for(age), "declared_income": declared_income, "is_smoker": smoker, "height_cm": height_cm,
         "weight_kg": weight_kg, "occupation": "Teacher"},
        {"coverage_amount": coverage, "term_years": 20},
        e_application={"medical_questionnaire": questionnaire or {}})
    return sorted(s.code for s in determine_requirements(profile) if s.required)


def medical_requirement(*, age: int, sum_at_risk: float, gender: Optional[str] = None, smoker: Optional[bool] = None,
                        disclosures: Optional[list] = None) -> dict:
    m = tenant_module("underwriting_limits")
    r = m.assess_medical_requirement(age=age, sum_at_risk=sum_at_risk, gender=gender, is_smoker=smoker,
                                     adverse_disclosures=disclosures)
    return {"required": r["required"], "non_medical_limit": r["non_medical_limit"], "tests": [t["code"] for t in r["tests"]],
            "estimated_cost": r["estimated_cost"]}


def cession(*, sum_assured: float, age: Optional[int]) -> dict:
    r = tenant_module("underwriting_limits").compute_cession(sum_assured, age)
    return {k: r[k] for k in ("retention_limit", "treaty_capacity", "automatic_capacity", "retained_amount",
                              "treaty_ceded_amount", "facultative_ceded_amount", "referral_required", "referral_type")}


def hlv_limit(*, income: float, age: int) -> float:
    return tenant_module("underwriting_limits").hlv_limit(income, age)


def decide(*, requirements_satisfied: bool = True, medical_class: str = "Standard", medical_loading: Optional[float] = None,
           medical_review: bool = False, justified: bool = True, financial_referral: bool = False,
           fraud_severity: str = "Low", fraud_probability: float = 0.05, fraud_investigation: bool = False,
           findings: Optional[List[dict]] = None) -> str:
    from shared.underwriting.decision_rules import decide as run
    from shared.underwriting.results import (FinancialUnderwritingResult, FraudAssessment, FraudSeverity, MedicalRiskClass,
                                             MedicalUnderwritingResult, VerificationFindingSpec, VerificationSeverity)
    decision, _ = run(
        requirements_satisfied=requirements_satisfied,
        medical=MedicalUnderwritingResult(risk_score=40, risk_class=MedicalRiskClass(medical_class),
                                          loading_percentage=medical_loading, requires_human_review=medical_review),
        financial=FinancialUnderwritingResult(financially_justified=justified, declared_income=1_000_000,
                                              coverage_to_income_ratio=5.0, referral_required=financial_referral),
        fraud=FraudAssessment(probability=fraud_probability, severity=FraudSeverity(fraud_severity),
                              investigation_required=fraud_investigation),
        findings=[VerificationFindingSpec(field=f["field"], severity=VerificationSeverity(f["severity"]),
                                          explanation="synthetic") for f in (findings or [])])
    return decision.value


def verification(*, declared_income: float = 0, verified_income: Optional[float] = None, declared_cnic: Optional[str] = None,
                 evidenced_cnic: Optional[str] = None, declared_dob: Optional[str] = None,
                 evidenced_dob: Optional[str] = None, conditions_declared: bool = False,
                 document_conditions: Optional[list] = None) -> List[dict]:
    from shared.underwriting.profile import UnderwritingProfile
    from shared.underwriting.verification import verify_profile
    declared = {"q1": {"answer": "yes"}} if conditions_declared else {}
    profile = UnderwritingProfile(
        identity={"cnic": declared_cnic, "evidence": {"cnic": evidenced_cnic, "dob": evidenced_dob}},
        demographics={"dob": declared_dob},
        financial={"declared_income": declared_income, "verified_income": verified_income},
        medical_history={"declared_conditions": declared,
                         "document_findings": [{"conditions": document_conditions}] if document_conditions else []})
    return [{"field": f.field, "severity": f.severity.value} for f in verify_profile(profile)]


# ── AML, sanctions and identity screening ───────────────────────────────────────────────────────────────────────

def aml(*, occupation: str, declared_income: float, coverage: float) -> dict:
    m = tenant_module("compliance_engine")
    r = m._screen_aml(SimpleNamespace(occupation=occupation, declared_income=declared_income),
                      SimpleNamespace(coverage_amount=coverage))
    return {"status": r["status"], "score": r["score"]}


def secp(*, cnic: Optional[str]) -> str:
    return tenant_module("compliance_engine")._screen_secp(SimpleNamespace(cnic=cnic))["status"]


def sanctions_internal(*, name: str) -> str:
    return tenant_module("compliance_engine")._screen_sanctions_internal(SimpleNamespace(name=name))["status"]


# ── Early knockout (RS-ELG-002) ─────────────────────────────────────────────────────────────────────────────────

def knockout(*, occupation: Optional[str], age: Optional[int]) -> dict:
    """The seeded rule set, evaluated the way rule_evaluator does: contains is a case-insensitive substring, a missing
    value never matches, any matching DECLINE rule declines."""
    rule_set = assignment_from_source(TENANT / "routers" / "rules.py", "_KNOCKOUT_RULE_SET", {})
    declines: List[str] = []
    for rule in rule_set["rules"]:
        hits = []
        for c in rule["conditions"]:
            value = {"occupation": occupation, "age": age}.get(c["field"])
            if value is None:
                hits.append(False)
            elif c["operator"] == "contains":
                hits.append(str(c["value"]).lower() in str(value).lower())
            elif c["operator"] == "lt":
                hits.append(float(value) < float(c["value"]))
            elif c["operator"] == "gt":
                hits.append(float(value) > float(c["value"]))
            else:
                raise ValueError(f"unhandled operator {c['operator']}")
        matched = (any(hits) if rule["operator"] == "ANY" else all(hits))
        if matched and rule["action_outcome"] == "DECLINE":
            declines.append(rule["code"])
    return {"decision": "DECLINE" if declines else "PROCEED", "rule_codes": declines}


# ── Identity and lead validation (rules that sit inside handlers) ───────────────────────────────────────────────

def cnic_normalised(raw: str) -> Optional[str]:
    """tenant-service schemas.CustomerCreate: 13 digits or XXXXX-XXXXXXX-X; anything else is refused."""
    v = raw.strip()
    if re.fullmatch(r"\d{13}", v):
        v = f"{v[:5]}-{v[5:12]}-{v[12]}"
    return v if re.fullmatch(r"\d{5}-\d{7}-\d", v) else None


def is_placeholder_cnic(cnic: Optional[str]) -> bool:
    fn = function_from_source(CHAT / "tool_executor.py", "is_placeholder_cnic")
    return fn(cnic)


def lead_phone_ok(phone: str) -> bool:
    """record_lead: digits, spaces, brackets and dashes with an optional leading +, 10 to 15 digits."""
    phone = str(phone or "").strip()
    return bool(re.fullmatch(r"\+?[\d\s()\-]+", phone)) and 10 <= len(re.sub(r"\D", "", phone)) <= 15


def plan_choices(*, age: int, plans: List[dict]) -> List[str]:
    """select_customer_plan: active individual plans whose entry band contains the age and whose shortest term still ends
    within the maturity age (chat-agent/acquisition_tools.py)."""
    return [p["code"] for p in plans if p["category"] == "Individual" and p["status"] == "Active"
            and p["entry_age_min"] <= age <= p["entry_age_max"] and age + p["term_min_years"] <= p["max_maturity_age"]]


def plan_selection(*, age: int, plan: dict, coverage: float, term: int, income: Optional[float]) -> str:
    """'ok' or the reason select_customer_plan refuses a chosen plan, cover and term."""
    if plan["code"] not in plan_choices(age=age, plans=[plan]):
        return "plan_not_eligible"
    if not plan["term_min_years"] <= term <= plan["term_max_years"] or age + term > plan["max_maturity_age"]:
        return "term_or_maturity"
    if plan.get("max_income_multiple"):
        if not income or income <= 0:
            return "income_missing"
        if coverage > income * plan["max_income_multiple"]:
            return "income_multiple"
    return "ok"


# ── Policy lifecycle ────────────────────────────────────────────────────────────────────────────────────────────

def transition_legal(frm: str, to: str) -> bool:
    prepare()
    import importlib
    return importlib.import_module("shared.services.policy_state_machine").can_transition(frm, to)


# ── Claims ──────────────────────────────────────────────────────────────────────────────────────────────────────

def claim_eligibility(*, category: str = "Death", event_date: str, reported_date: str, today: str = "2026-10-01",
                      effective_date: str, policy_events: Optional[List[dict]] = None, status_now: str = "Active",
                      insurance_type: str = "TERM_LIFE", coverage_amount: float = 5_000_000, riders: Optional[list] = None,
                      relationship: str = "Self", cause: Optional[str] = None, duplicate_count: int = 0,
                      maturity_date: Optional[str] = None) -> dict:
    ce = tenant_module("claim_engine")
    eff = date.fromisoformat(effective_date)
    events = [{"at": datetime.fromisoformat(e["at"]), "event_type": e["event_type"], "to_status": e["to_status"],
               "detail": e.get("detail")} for e in (policy_events or [{"at": effective_date + "T00:00:00", "event_type": "Activated", "to_status": "Active"}])]
    periods = ce.coverage_timeline(events, effective_date=eff, status_now=status_now)
    r = ce.evaluate_eligibility_facts(
        category=category, event_date=date.fromisoformat(event_date), reported_date=date.fromisoformat(reported_date),
        today=date.fromisoformat(today), periods=periods, policy_status=status_now,
        maturity_date=date.fromisoformat(maturity_date) if maturity_date else None, insurance_type=insurance_type,
        coverage_amount=coverage_amount, riders=riders or [], covered_relationship=relationship, cause=cause,
        duplicate_count=duplicate_count)
    return {"status": r["status"], "failed": sorted(c["key"] for c in r["checks"] if not c["passed"]),
            "blockers": sorted(c["key"] for c in r["blockers"]), "reviews": sorted(c["key"] for c in r["reviews"]),
            "contestable": r["contestable"]}


def claim_authority(*, role: str, action: str, amount: float) -> str:
    """allowed | denied_role | over_limit, from services/claim_authority.py with the platform default limits."""
    ca = tenant_module("claim_authority")
    default_limits = {"ClaimsAdjuster": (ca.cfg.CLAIM_MANAGER_LIMIT, 0.0), "ClaimsManager": (None, None)}
    roles = ca.DECIDE_ROLES if action == "decide" else ca.AUTHORIZE_ROLES if action == "authorize" else ca.DISBURSE_ROLES
    if role not in roles:
        return "denied_role"
    approve, authorize = default_limits.get(role, (0.0, 0.0))
    limit = approve if action == "decide" else authorize
    return "over_limit" if limit is not None and amount > limit else "allowed"


# ── Agent permissions and routing ───────────────────────────────────────────────────────────────────────────────

def rbac(role: str, tool: str, platform: str = "web") -> bool:
    prepare()
    with _path(CHAT):
        import importlib
        return importlib.import_module("permission").is_role_allowed(tool, role, platform)


def routing(*, role: str, message: str) -> str:
    """The specialist the coordinator hands a message to, for the rules that do not depend on keyword lists."""
    src = (CHAT / "specialist_router.py")
    pinned = assignment_from_source(src, "PINNED_SPECIALIST")
    user_admin = assignment_from_source(src, "_USER_ADMIN")
    if role == "Agent":
        return "general"
    if role in pinned:
        return pinned[role]
    if role in ("Admin", "SuperAdmin") and user_admin.search(message):
        return "general"
    return "keyword_routed"


# ── Reading the code itself ─────────────────────────────────────────────────────────────────────────────────────

def source_literal(*, path: str, name: str) -> Any:
    """A module-level literal from a source file, as JSON-friendly data (sets and tuples become sorted lists)."""
    value = assignment_from_source(REPO / path, name)
    return sorted(value, key=str) if isinstance(value, (set, frozenset)) else list(value) if isinstance(value, tuple) else value


def source_contains(*, path: str, text: str) -> bool:
    """Whether a file still contains a message or phrase. Used to pin the exact wording a case quotes."""
    return text in (REPO / path).read_text(encoding="utf-8")


def payment_methods() -> List[str]:
    return [m.value for m in tenant_module("payment_gateway").PaymentMethodEnum]


def days_between(*, start: str, end: str) -> int:
    return (date.fromisoformat(end) - date.fromisoformat(start)).days


# ── Registry used by verify_dataset.py ──────────────────────────────────────────────────────────────────────────

ORACLES: Dict[str, Callable[..., Any]] = {
    "premium": premium, "payment_split": payment_split, "requirements": requirements,
    "medical_requirement": medical_requirement, "cession": cession, "hlv_limit": hlv_limit, "decide": decide,
    "verification": verification, "aml": aml, "secp": secp, "sanctions_internal": sanctions_internal,
    "knockout": knockout, "cnic_normalised": cnic_normalised, "is_placeholder_cnic": is_placeholder_cnic,
    "lead_phone_ok": lead_phone_ok, "plan_choices": plan_choices, "plan_selection": plan_selection,
    "transition_legal": transition_legal, "claim_eligibility": claim_eligibility, "claim_authority": claim_authority,
    "rbac": rbac, "routing": routing, "source_literal": source_literal, "source_contains": source_contains,
    "payment_methods": payment_methods, "days_between": days_between,
}
