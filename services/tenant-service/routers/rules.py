"""
Rule Engine Router — API endpoints for managing decision tables, rule sets,
rule versioning, live evaluation, and audit trails across the 9 taxonomy domains.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from rule_evaluator import evaluate_rule_set
from shared.models.core import (
    BusinessRule,
    RuleDomainEnum,
    RuleEvaluationLog,
    RuleSet,
    RuleVersion,
    RuleVersionStatusEnum,
)

router = APIRouter(prefix="/tenants/{tenant_id}/rules", tags=["Rule Engine"])


# ─────────────────────────────────────────────────────────────────────────────
# Baseline Seeder for System Rule Sets
# ─────────────────────────────────────────────────────────────────────────────

_DEFAULT_RULE_SETS = [
    {
        "code": "medical.nml_grid",
        "name": "Non-Medical Limit (NML) Underwriting Grid",
        "domain": RuleDomainEnum.MEDICAL_NML,
        "description": "Determines whether an applicant requires panel medical examination based on age and sum assured.",
        "rules": [
            {
                "name": "High Age + High Sum Assured -> Full Medical Exam",
                "priority": 1,
                "operator": "ALL",
                "conditions": [
                    {"field": "age", "operator": "gte", "value": 50},
                    {"field": "sum_assured", "operator": "gt", "value": 5000000},
                ],
                "action_outcome": "REQUIRE_MEDICAL_EXAM",
                "outcome_payload": {
                    "required_tests": ["MER", "ECG", "Lipid Profile", "HbA1c", "LFT"],
                    "reason": "Age >= 50 and Sum Assured > 5,000,000 PKR requires full medical panel.",
                },
            },
            {
                "name": "Medium Age + High Sum Assured -> Basic Medical Exam",
                "priority": 2,
                "operator": "ALL",
                "conditions": [
                    {"field": "age", "operator": "gte", "value": 40},
                    {"field": "sum_assured", "operator": "gt", "value": 7500000},
                ],
                "action_outcome": "REQUIRE_MEDICAL_EXAM",
                "outcome_payload": {
                    "required_tests": ["MER", "Blood Glucose", "Urine RE"],
                    "reason": "Age >= 40 and Sum Assured > 7.5M PKR requires basic medical panel.",
                },
            },
            {
                "name": "Standard Non-Medical Limit (NML) Passed",
                "priority": 10,
                "operator": "ALL",
                "conditions": [
                    {"field": "sum_assured", "operator": "lte", "value": 5000000},
                ],
                "action_outcome": "WAIVE_MEDICAL",
                "outcome_payload": {
                    "required_tests": [],
                    "reason": "Within standard non-medical limit ceiling (5.0M PKR).",
                },
            },
        ],
    },
    {
        "code": "commission.secp_rate_card",
        "name": "SECP 2017 Commission & Statutory Payout Schedule",
        "domain": RuleDomainEnum.COMMISSION_SECP,
        "description": "Statutory commission caps under SECP Insurance Rules 2017.",
        "rules": [
            {
                "name": "Individual Life - Year 1 (35%)",
                "priority": 1,
                "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Individual"},
                    {"field": "policy_year", "operator": "eq", "value": 1},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {
                    "commission_pct": 35.0,
                    "withholding_tax_pct": 10.0,
                    "reason": "SECP Rule 24: Individual first-year statutory max 35%.",
                },
            },
            {
                "name": "Individual Life - Year 2 (7.5%)",
                "priority": 2,
                "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Individual"},
                    {"field": "policy_year", "operator": "eq", "value": 2},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {
                    "commission_pct": 7.5,
                    "withholding_tax_pct": 10.0,
                    "reason": "SECP Rule 24: Individual 2nd year renewal 7.5%.",
                },
            },
            {
                "name": "Individual Life - Year 3+ (5.0%)",
                "priority": 3,
                "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Individual"},
                    {"field": "policy_year", "operator": "gte", "value": 3},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {
                    "commission_pct": 5.0,
                    "withholding_tax_pct": 10.0,
                    "reason": "SECP Rule 24: Individual renewal 3rd year+ 5.0%.",
                },
            },
            {
                "name": "Group Life - Standard (15%)",
                "priority": 4,
                "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Group"},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {
                    "commission_pct": 15.0,
                    "withholding_tax_pct": 10.0,
                    "reason": "SECP statutory max Group Life commission 15%.",
                },
            },
            {
                "name": "Family Takaful - Year 1 (30%)",
                "priority": 5,
                "operator": "ALL",
                "conditions": [
                    {"field": "category", "operator": "eq", "value": "Family"},
                ],
                "action_outcome": "APPLY_COMMISSION_RATE",
                "outcome_payload": {
                    "commission_pct": 30.0,
                    "withholding_tax_pct": 10.0,
                    "reason": "SECP Family Takaful first-year statutory rate 30%.",
                },
            },
        ],
    },
    {
        "code": "compliance.secp_aml",
        "name": "AML / PEP / Sanctions Compliance Matrix",
        "domain": RuleDomainEnum.COMPLIANCE_AML,
        "description": "High-risk customer AML screening, PEP flagging, and clearance rules.",
        "rules": [
            {
                "name": "Sanctions Match -> Auto Decline & Block",
                "priority": 1,
                "operator": "ALL",
                "conditions": [
                    {"field": "sanctions_matched", "operator": "boolean", "value": True},
                ],
                "action_outcome": "BLOCK_APPLICATION",
                "outcome_payload": {
                    "terminal": True,
                    "risk_level": "CRITICAL",
                    "reason": "Match found on UN/SECP Sanctions List. Policy issue blocked.",
                },
            },
            {
                "name": "PEP Match -> Require Compliance Officer Clearance",
                "priority": 2,
                "operator": "ALL",
                "conditions": [
                    {"field": "is_pep", "operator": "boolean", "value": True},
                ],
                "action_outcome": "REQUIRE_MANUAL_CLEARANCE",
                "outcome_payload": {
                    "risk_level": "HIGH",
                    "reason": "Politically Exposed Person (PEP) requires senior compliance sign-off.",
                },
            },
            {
                "name": "High Premium (> 1.0M PKR) -> Enhanced Due Diligence (EDD)",
                "priority": 3,
                "operator": "ALL",
                "conditions": [
                    {"field": "annual_premium", "operator": "gt", "value": 1000000},
                ],
                "action_outcome": "REQUIRE_ENHANCED_DUE_DILIGENCE",
                "outcome_payload": {
                    "risk_level": "MEDIUM_HIGH",
                    "reason": "Annual premium > 1,000,000 PKR requires Source of Funds documentation.",
                },
            },
        ],
    },
    {
        "code": "pricing.base_loading",
        "name": "Underwriting Risk Loadings & Rating Table",
        "domain": RuleDomainEnum.PRICING,
        "description": "Computes health, BMI, and smoker premium loadings.",
        "rules": [
            {
                "name": "Obesity (BMI > 32) + Smoker -> 50% Extra Mortality Loading",
                "priority": 1,
                "operator": "ALL",
                "conditions": [
                    {"field": "bmi", "operator": "gt", "value": 32},
                    {"field": "is_smoker", "operator": "boolean", "value": True},
                ],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {
                    "loading_pct": 50.0,
                    "reason": "Severe Obesity (BMI > 32) combined with active smoking.",
                },
            },
            {
                "name": "Active Smoker -> 25% Loading",
                "priority": 2,
                "operator": "ALL",
                "conditions": [
                    {"field": "is_smoker", "operator": "boolean", "value": True},
                ],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {
                    "loading_pct": 25.0,
                    "reason": "Active tobacco/smoker surcharge.",
                },
            },
            {
                "name": "Overweight (BMI 28 - 32) -> 15% Loading",
                "priority": 3,
                "operator": "ALL",
                "conditions": [
                    {"field": "bmi", "operator": "between", "value": [28, 32]},
                ],
                "action_outcome": "APPLY_LOADING",
                "outcome_payload": {
                    "loading_pct": 15.0,
                    "reason": "Overweight BMI band (28 - 32).",
                },
            },
        ],
    },
    {
        "code": "ai.composite_decision_bands",
        "name": "AI Underwriting Score Bands & Action Mapping",
        "domain": RuleDomainEnum.AI_DECISION_BANDS,
        "description": "Maps composite risk scores (0-100) to automated underwriting decisions.",
        "rules": [
            {
                "name": "Low Risk (< 40) -> Auto Approve",
                "priority": 1,
                "operator": "ALL",
                "conditions": [
                    {"field": "composite_score", "operator": "lt", "value": 40},
                ],
                "action_outcome": "AUTO_APPROVE",
                "outcome_payload": {
                    "recommendation": "Auto Approve",
                    "status_code": "APPROVED",
                    "reason": "Composite risk score below 40. Standard acceptance.",
                },
            },
            {
                "name": "Moderate Risk (40 - 69) -> Approve With Loading",
                "priority": 2,
                "operator": "ALL",
                "conditions": [
                    {"field": "composite_score", "operator": "between", "value": [40, 69]},
                ],
                "action_outcome": "APPROVE_WITH_LOADING",
                "outcome_payload": {
                    "recommendation": "Approve with Loading",
                    "status_code": "ACCEPTED_WITH_LOADINGS",
                    "reason": "Moderate risk score. Underwriting loading or counter-offer required.",
                },
            },
            {
                "name": "High Risk (>= 70) -> Underwriter Human Review",
                "priority": 3,
                "operator": "ALL",
                "conditions": [
                    {"field": "composite_score", "operator": "gte", "value": 70},
                ],
                "action_outcome": "HUMAN_REVIEW",
                "outcome_payload": {
                    "recommendation": "Human Review Required",
                    "status_code": "UNDER_REVIEW",
                    "reason": "High risk score (>= 70). Escalated to Senior Underwriter.",
                },
            },
        ],
    },
]


async def seed_rules_if_empty(session: AsyncSession):
    """Populates initial rule sets if empty."""
    res = await session.exec(select(RuleSet))
    if res.first() is not None:
        return

    for rs_data in _DEFAULT_RULE_SETS:
        rule_set = RuleSet(
            code=rs_data["code"],
            name=rs_data["name"],
            domain=rs_data["domain"],
            description=rs_data["description"],
            is_active=True,
        )
        session.add(rule_set)
        await session.commit()
        await session.refresh(rule_set)

        # Active version 1
        version = RuleVersion(
            rule_set_id=rule_set.id,
            version_no=1,
            status=RuleVersionStatusEnum.ACTIVE,
            authored_by="System Baseline",
            approved_by="Compliance Office",
            notes="Initial statutory and operational rule baseline.",
        )
        session.add(version)
        await session.commit()
        await session.refresh(version)

        # Rules
        for r_data in rs_data["rules"]:
            rule = BusinessRule(
                rule_version_id=version.id,
                name=r_data["name"],
                priority=r_data["priority"],
                condition_operator=r_data["operator"],
                conditions=r_data["conditions"],
                action_outcome=r_data["action_outcome"],
                outcome_payload=r_data["outcome_payload"],
                is_enabled=True,
            )
            session.add(rule)
        await session.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Request / Response Schemas
# ─────────────────────────────────────────────────────────────────────────────

class EvaluateRuleRequest(BaseModel):
    rule_set_code: str
    context: Dict[str, Any]
    case_id: Optional[str] = None
    actor: Optional[str] = "Portal Admin"


class RuleSetCreateRequest(BaseModel):
    code: str
    name: str
    domain: RuleDomainEnum
    description: Optional[str] = ""


class RuleCreateRequest(BaseModel):
    name: str
    priority: int = 10
    condition_operator: str = "ALL"
    conditions: List[Dict[str, Any]]
    action_outcome: str
    outcome_payload: Dict[str, Any]
    is_enabled: bool = True


class VersionStatusRequest(BaseModel):
    status: RuleVersionStatusEnum
    approved_by: Optional[str] = None


# ─────────────────────────────────────────────────────────────────────────────
# API Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/sets", summary="List rule sets")
async def list_rule_sets(
    tenant_id: UUID,
    domain: Optional[RuleDomainEnum] = None,
    session: AsyncSession = Depends(get_session),
):
    await seed_rules_if_empty(session)
    query = select(RuleSet).where(
        (RuleSet.tenant_id == tenant_id) | (RuleSet.tenant_id == None)
    )
    if domain:
        query = query.where(RuleSet.domain == domain)

    res = await session.exec(query)
    rule_sets = res.all()

    output = []
    for rs in rule_sets:
        # Get active version & rule count
        ver_res = await session.exec(
            select(RuleVersion)
            .where(RuleVersion.rule_set_id == rs.id)
            .order_by(RuleVersion.version_no.desc())
        )
        versions = ver_res.all()
        active_ver = next((v for v in versions if v.status == RuleVersionStatusEnum.ACTIVE), None)
        rule_count = 0
        if active_ver:
            rule_res = await session.exec(
                select(BusinessRule).where(BusinessRule.rule_version_id == active_ver.id)
            )
            rule_count = len(rule_res.all())

        output.append({
            "id": str(rs.id),
            "code": rs.code,
            "name": rs.name,
            "domain": rs.domain,
            "description": rs.description,
            "is_active": rs.is_active,
            "active_version_no": active_ver.version_no if active_ver else None,
            "active_version_status": active_ver.status if active_ver else "NO_VERSION",
            "version_count": len(versions),
            "rule_count": rule_count,
            "updated_at": rs.updated_at.isoformat(),
        })

    return output


@router.post("/sets", status_code=status.HTTP_201_CREATED, summary="Create a new rule set")
async def create_rule_set(
    tenant_id: UUID,
    body: RuleSetCreateRequest,
    session: AsyncSession = Depends(get_session),
):
    existing = (await session.exec(select(RuleSet).where(RuleSet.code == body.code))).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Rule set code '{body.code}' already exists.")

    rule_set = RuleSet(
        tenant_id=tenant_id,
        code=body.code,
        name=body.name,
        domain=body.domain,
        description=body.description or "",
    )
    session.add(rule_set)
    await session.commit()
    await session.refresh(rule_set)

    # Initial draft version 1
    version = RuleVersion(
        rule_set_id=rule_set.id,
        version_no=1,
        status=RuleVersionStatusEnum.DRAFT,
        authored_by="Admin",
    )
    session.add(version)
    await session.commit()

    return {"id": str(rule_set.id), "code": rule_set.code, "message": "Rule set created successfully."}


@router.get("/sets/{rule_set_id}", summary="Get detailed rule set details with rules and versions")
async def get_rule_set_detail(
    tenant_id: UUID,
    rule_set_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    rule_set = await session.get(RuleSet, rule_set_id)
    if not rule_set:
        raise HTTPException(status_code=44, detail="Rule set not found.")

    ver_res = await session.exec(
        select(RuleVersion)
        .where(RuleVersion.rule_set_id == rule_set.id)
        .order_by(RuleVersion.version_no.desc())
    )
    versions = ver_res.all()

    versions_data = []
    for v in versions:
        rules_res = await session.exec(
            select(BusinessRule)
            .where(BusinessRule.rule_version_id == v.id)
            .order_by(BusinessRule.priority.asc())
        )
        rules = rules_res.all()

        versions_data.append({
            "id": str(v.id),
            "version_no": v.version_no,
            "status": v.status,
            "effective_from": v.effective_from.isoformat(),
            "effective_to": v.effective_to.isoformat() if v.effective_to else None,
            "authored_by": v.authored_by,
            "approved_by": v.approved_by,
            "notes": v.notes,
            "rules": [
                {
                    "id": str(r.id),
                    "name": r.name,
                    "priority": r.priority,
                    "condition_operator": r.condition_operator,
                    "conditions": r.conditions,
                    "action_outcome": r.action_outcome,
                    "outcome_payload": r.outcome_payload,
                    "is_enabled": r.is_enabled,
                }
                for r in rules
            ],
        })

    return {
        "id": str(rule_set.id),
        "code": rule_set.code,
        "name": rule_set.name,
        "domain": rule_set.domain,
        "description": rule_set.description,
        "is_active": rule_set.is_active,
        "versions": versions_data,
    }


@router.post("/sets/{rule_set_id}/versions", status_code=status.HTTP_201_CREATED, summary="Create a new draft version")
async def create_rule_version(
    tenant_id: UUID,
    rule_set_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    rule_set = await session.get(RuleSet, rule_set_id)
    if not rule_set:
        raise HTTPException(status_code=404, detail="Rule set not found.")

    latest = (
        await session.exec(
            select(RuleVersion)
            .where(RuleVersion.rule_set_id == rule_set.id)
            .order_by(RuleVersion.version_no.desc())
        )
    ).first()

    next_no = (latest.version_no + 1) if latest else 1
    new_version = RuleVersion(
        rule_set_id=rule_set.id,
        version_no=next_no,
        status=RuleVersionStatusEnum.DRAFT,
        authored_by="Admin",
    )
    session.add(new_version)
    await session.commit()
    await session.refresh(new_version)

    # Copy rules from latest if exists
    if latest:
        prev_rules = (
            await session.exec(
                select(BusinessRule).where(BusinessRule.rule_version_id == latest.id)
            )
        ).all()
        for r in prev_rules:
            session.add(
                BusinessRule(
                    rule_version_id=new_version.id,
                    name=r.name,
                    priority=r.priority,
                    condition_operator=r.condition_operator,
                    conditions=r.conditions,
                    action_outcome=r.action_outcome,
                    outcome_payload=r.outcome_payload,
                    is_enabled=r.is_enabled,
                )
            )
        await session.commit()

    return {"id": str(new_version.id), "version_no": new_version.version_no, "status": new_version.status}


@router.patch("/versions/{version_id}/status", summary="Update version status (Deploy/Retire)")
async def update_version_status(
    tenant_id: UUID,
    version_id: UUID,
    body: VersionStatusRequest,
    session: AsyncSession = Depends(get_session),
):
    version = await session.get(RuleVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail="Rule version not found.")

    if body.status == RuleVersionStatusEnum.ACTIVE:
        # Retire current active version for this rule set
        active_versions = (
            await session.exec(
                select(RuleVersion)
                .where(RuleVersion.rule_set_id == version.rule_set_id)
                .where(RuleVersion.status == RuleVersionStatusEnum.ACTIVE)
            )
        ).all()
        for av in active_versions:
            av.status = RuleVersionStatusEnum.RETIRED
            av.effective_to = datetime.utcnow()
            session.add(av)

        version.status = RuleVersionStatusEnum.ACTIVE
        version.approved_by = body.approved_by or "Compliance Officer"
        version.effective_from = datetime.utcnow()
    else:
        version.status = body.status

    session.add(version)
    await session.commit()
    return {"id": str(version.id), "status": version.status}


@router.post("/versions/{version_id}/rules", status_code=status.HTTP_201_CREATED, summary="Add rule to a version")
async def add_rule_to_version(
    tenant_id: UUID,
    version_id: UUID,
    body: RuleCreateRequest,
    session: AsyncSession = Depends(get_session),
):
    version = await session.get(RuleVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail="Rule version not found.")

    rule = BusinessRule(
        rule_version_id=version.id,
        name=body.name,
        priority=body.priority,
        condition_operator=body.condition_operator,
        conditions=body.conditions,
        action_outcome=body.action_outcome,
        outcome_payload=body.outcome_payload,
        is_enabled=body.is_enabled,
    )
    session.add(rule)
    await session.commit()
    await session.refresh(rule)

    return {"id": str(rule.id), "name": rule.name, "priority": rule.priority}


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a rule")
async def delete_rule(
    tenant_id: UUID,
    rule_id: UUID,
    session: AsyncSession = Depends(get_session),
):
    rule = await session.get(BusinessRule, rule_id)
    if rule:
        await session.delete(rule)
        await session.commit()
    return None


@router.post("/evaluate", summary="Evaluate a rule set against input context")
async def evaluate_rule_endpoint(
    tenant_id: UUID,
    body: EvaluateRuleRequest,
    session: AsyncSession = Depends(get_session),
):
    result = await evaluate_rule_set(
        session=session,
        rule_set_code=body.rule_set_code,
        context=body.context,
        tenant_id=tenant_id,
        case_id=body.case_id,
        actor=body.actor or "Portal Admin",
    )
    return result


@router.get("/logs", summary="Get rule evaluation audit logs")
async def list_rule_evaluation_logs(
    tenant_id: UUID,
    limit: int = Query(default=50, le=200),
    session: AsyncSession = Depends(get_session),
):
    query = (
        select(RuleEvaluationLog)
        .where(
            (RuleEvaluationLog.tenant_id == tenant_id) | (RuleEvaluationLog.tenant_id == None)
        )
        .order_by(RuleEvaluationLog.evaluated_at.desc())
        .limit(limit)
    )
    logs = (await session.exec(query)).all()

    return [
        {
            "id": str(log.id),
            "rule_set_code": log.rule_set_code,
            "rule_version_no": log.rule_version_no,
            "case_id": log.case_id,
            "actor": log.actor,
            "input_context": log.input_context,
            "outcome": log.outcome,
            "reasons": log.reasons,
            "evaluated_at": log.evaluated_at.isoformat(),
        }
        for log in logs
    ]
