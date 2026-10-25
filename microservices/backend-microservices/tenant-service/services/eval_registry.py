"""Reads what the golden cases depend on, records a new registry version when it changed, and turns a change into a review item.

Read-only towards the product: it looks at the plans, rules, workflows and code, and writes only to the registry tables (eval_registry_*,
eval_drift_*). Run `snapshot()` to take a reading; the first reading of an item records version 1 and is not a change.

Watched today (the Individual Insurance journey; more are added as readers):
  plan:<code>            a plan's eligibility bands, rates and factors (all rows with that code are fingerprinted together)
  rule:<rule_code>       an underwriting or commission rule set: its active version and every rule in it
  workflow:policy-status the legal policy status transitions
  calc:premium           the premium arithmetic and the pricing engine, by what the code does
  gate:initial-premium   the rule that holds an underwriting case until the initial premium is cleared
  access:claims          how the claims router checks who may call it
Templates (`template:*`) join once the Super Admin Templates section stores them.
"""
from __future__ import annotations

import enum
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.evaluation import change_registry as cr
from shared.models.core import ActualRule, InsurancePlan, RuleCriteria, RuleSet, RuleVersion, RuleVersionStatusEnum
from shared.models.evaluation import EvalRegistryItem, EvalRegistryVersion

TENANT_SERVICE = Path(__file__).resolve().parents[1]
SHARED = Path(__import__("shared").__file__).resolve().parent

# (item key, title, repo-relative path, names to fingerprint or None for the whole file)
CODE_ITEMS = [
    ("calc:premium", "Premium calculation", ["shared/pricing/calculator.py", "microservices/backend-microservices/tenant-service/services/pricing_engine.py"], None),
    ("gate:initial-premium", "Initial premium gate before underwriting", ["microservices/backend-microservices/tenant-service/routers/cases.py"], ["_initial_premium_required"]),
    ("access:claims", "Claims access control", ["microservices/backend-microservices/tenant-service/routers/claims.py"], ["_verify_claims_tenant", "router"]),
]
VOLATILE = {"id", "tenant_id", "created_at", "updated_at", "version_id", "rule_id", "subcategory_id", "eligibility_id"}


def _file(repo_path: str) -> Path:
    """Where a repository path is inside this service's container."""
    if repo_path.startswith("shared/"):
        return SHARED / repo_path[len("shared/"):]
    prefix = "microservices/backend-microservices/tenant-service/"
    if repo_path.startswith(prefix):
        return TENANT_SERVICE / repo_path[len(prefix):]
    raise ValueError(f"{repo_path} is not readable from this service")


def _plain(value: Any) -> Any:
    if isinstance(value, enum.Enum):
        return value.value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    return value


def _row(obj: Any) -> Dict[str, Any]:
    return {k: _plain(v) for k, v in obj.model_dump().items() if k not in VOLATILE}


def _code_observation(key: str, title: str, paths: List[str], names: Optional[List[str]]) -> Dict[str, Any]:
    parts: Dict[str, Any] = {}
    for rp in paths:
        src = _file(rp).read_text(encoding="utf-8")
        parts[rp.rsplit("/", 1)[-1]] = cr.function_summary(src, names)["items"] if names else cr.module_summary(src)
    return {"key": key, "type": key.split(":")[0], "title": title, "source": ", ".join(paths), "summary": parts}


def _workflow_observation() -> Dict[str, Any]:
    from shared.services import policy_state_machine as sm
    table = {(k.value if hasattr(k, "value") else str(k)): sorted(v.value if hasattr(v, "value") else str(v) for v in vs) for k, vs in sm._TRANSITIONS.items()}
    return {"key": "workflow:policy-status", "type": "workflow", "title": "Policy status workflow", "source": "shared/services/policy_state_machine.py", "summary": {"transitions": table}}


async def read_all(session: AsyncSession) -> List[Dict[str, Any]]:
    """A fresh reading of every watched item."""
    out: List[Dict[str, Any]] = []
    for key, title, paths, names in CODE_ITEMS:
        out.append(_code_observation(key, title, paths, names))
    out.append(_workflow_observation())
    out.extend(await read_templates(session))

    by_code: Dict[str, List[Dict[str, Any]]] = {}
    for plan in (await session.exec(select(InsurancePlan))).all():
        by_code.setdefault(plan.code, []).append(_row(plan))
    for code, rows in sorted(by_code.items()):
        rows.sort(key=lambda r: canonical_row(r))
        out.append({"key": f"plan:{code}", "type": "plan", "title": f"Plan {code}", "source": "insurance_plans", "summary": {"rows": rows}})

    for rs in (await session.exec(select(RuleSet))).all():
        version = (await session.exec(select(RuleVersion).where(RuleVersion.rule_set_id == rs.id, RuleVersion.status == RuleVersionStatusEnum.ACTIVE)
                                      .order_by(RuleVersion.effective_from.desc()))).first()
        rules: Dict[str, Any] = {}
        if version is not None:
            for rule in (await session.exec(select(ActualRule).where(ActualRule.version_id == version.id).order_by(ActualRule.rule_code))).all():
                crit = (await session.exec(select(RuleCriteria).where(RuleCriteria.rule_id == rule.id))).all()
                rules[rule.rule_code] = {**_row(rule), "criteria": sorted((_row(c) for c in crit), key=canonical_row)}
        out.append({"key": f"rule:{rs.rule_code}", "type": "rule", "title": f"Rule set {rs.name}", "source": "rule_sets",
                    "summary": {"active_version": version.version_number if version else None, "effective_from": _plain(version.effective_from) if version else None, "rules": rules}})
    return out


async def read_templates(session: AsyncSession) -> List[Dict[str, Any]]:
    """The published content of every template, one watched item per template. A draft is not watched: nothing depends on it until it is published."""
    from shared.models.templates import DocumentTemplate, DocumentTemplateVersion
    out = []
    for t in (await session.exec(select(DocumentTemplate).where(DocumentTemplate.status == "active").order_by(DocumentTemplate.template_key))).all():
        v = (await session.exec(select(DocumentTemplateVersion).where(DocumentTemplateVersion.template_id == t.id, DocumentTemplateVersion.state == "published"))).first()
        if v is not None:
            out.append({"key": f"template:{t.template_key}", "type": "template", "title": f"Template: {t.title}", "source": "document_templates", "summary": {"content": v.content}})
    return out


def canonical_row(row: Dict[str, Any]) -> str:
    return cr.canonical(row)


async def last_version(session: AsyncSession, item_key: str) -> Optional[Dict[str, Any]]:
    item = (await session.exec(select(EvalRegistryItem).where(EvalRegistryItem.item_key == item_key))).first()
    if item is None:
        return None
    v = (await session.exec(select(EvalRegistryVersion).where(EvalRegistryVersion.item_id == item.id).order_by(EvalRegistryVersion.version.desc()))).first()
    return {"item_id": item.id, "version": v.version, "fingerprint": v.fingerprint, "summary": v.summary} if v else {"item_id": item.id, "version": 0, "fingerprint": "", "summary": {}}


async def snapshot(session: AsyncSession, *, captured_from: str = "scan", observations: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """Take a reading and record what changed. Returns one entry per item: {"observation", "reading"}; commit is the caller's. `observations`
    lets a caller (a test) supply the readings instead of reading the product."""
    results = []
    for obs in observations if observations is not None else await read_all(session):
        last = await last_version(session, obs["key"])
        reading = cr.classify_reading(obs, last if last and last["version"] else None)
        item_id = last["item_id"] if last else None
        if item_id is None:
            item = EvalRegistryItem(item_key=obs["key"], item_type=obs["type"], title=obs["title"], source=obs.get("source"))
            session.add(item)
            await session.flush()
            item_id = item.id
        if reading["status"] in ("new", "changed"):
            session.add(EvalRegistryVersion(item_id=item_id, version=reading["version"], fingerprint=reading["fingerprint"], summary=obs["summary"],
                                            previous_fingerprint=(last or {}).get("fingerprint") or None, captured_from=captured_from))
            await session.flush()
        results.append({"observation": obs, "reading": reading})
    return results


# ── which cases depend on what ─────────────────────────────────────────────────────────────────────────────────────────

class DependencyError(ValueError):
    pass


def check_dependencies(mapping: Dict[str, List[str]], known_keys: List[str]) -> List[str]:
    """Problems with a dependency declaration: a key that names nothing watched (so a typo cannot silently protect nothing)."""
    problems = []
    for case_id, keys in mapping.items():
        for k in keys:
            ok = k in known_keys or (k.endswith("*") and any(x.startswith(k[:-1]) for x in known_keys))
            if not ok:
                problems.append(f"{case_id}: '{k}' is not a watched item")
    return problems


async def load_dependencies(session: AsyncSession, dataset_slug: str, dataset_version: str, mapping: Dict[str, List[str]], known_keys: List[str]) -> int:
    """Store the declared dependencies of one published dataset version, replacing what was stored for that version before (so loading twice is
    the same as loading once). Refuses the whole declaration if any key names nothing watched. Commit is the caller's."""
    from sqlalchemy import delete
    from shared.models.evaluation import EvalCaseDependency
    problems = check_dependencies(mapping, known_keys)
    if problems:
        raise DependencyError("; ".join(problems[:10]))
    await session.exec(delete(EvalCaseDependency).where(EvalCaseDependency.dataset_slug == dataset_slug, EvalCaseDependency.dataset_version == dataset_version))
    n = 0
    for case_id, keys in sorted(mapping.items()):
        for k in sorted(set(keys)):
            session.add(EvalCaseDependency(dataset_slug=dataset_slug, dataset_version=dataset_version, case_key=case_id, item_key=k))
            n += 1
    await session.flush()
    return n


async def dependent_cases(session: AsyncSession, dataset_slug: str, dataset_version: str, item_key: str, severities: Dict[str, str]) -> List[Dict[str, Any]]:
    from shared.models.evaluation import EvalCaseDependency
    rows = (await session.exec(select(EvalCaseDependency.case_key, EvalCaseDependency.item_key).where(
        EvalCaseDependency.dataset_slug == dataset_slug, EvalCaseDependency.dataset_version == dataset_version))).all()
    return cr.dependents(item_key, [(c, k) for c, k in rows], severities)
