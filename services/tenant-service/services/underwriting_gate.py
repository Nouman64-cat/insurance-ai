"""Underwriting Requirements / Verification gate — the case-scoped,
pre-decision counterpart to pre_issuance_gate.py (which runs post-decision).

Mirrors the onboarding_gate.py/pre_issuance_gate.py shape: one set of
``compute_*``/``build_*`` functions, called by both a read endpoint
(routers/cases.py) and api-gateway's evaluate flow (via the same endpoints,
over HTTP — risk-engine and api-gateway never import this module directly,
since it owns the DB session tenant-service is the only one holding).

This module is also the first — and only — writer of CaseWorkflow rows in
the whole repository; before this change the table existed but nothing ever
instantiated it.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import Request
from sqlmodel import delete, select
from sqlmodel.ext.asyncio.session import AsyncSession

from services.case_events import publish_case_event
from shared.models.core import (
    ActionTypeEnum,
    AgentConfidentialReport,
    Artifact,
    Case,
    CaseHistory,
    CaseRequirement,
    CaseRequirementStatusEnum,
    CaseStatusEnum,
    CaseWorkflow,
    Customer,
    CustomerEApplication,
    MedicalExamOrder,
    Policy,
    User,
    VerificationFinding,
    VerificationSeverityEnum,
    WorkflowStateEnum,
)
from shared.underwriting.profile import UnderwritingProfile, build_profile
from shared.underwriting.requirements_rules import apply_medical_exam_order, determine_requirements
from shared.underwriting.results import VerificationFindingSpec
from shared.underwriting.verification import verify_profile

logger = logging.getLogger(__name__)

WORKFLOW_VERSION = "v1"


# ─────────────────────────────────────────────────────────────────────────────
# Row -> plain dict helpers (shared.underwriting.profile is DB-free, so the
# SQLModel rows are flattened here before crossing that boundary)
# ─────────────────────────────────────────────────────────────────────────────

def _customer_dict(customer: Optional[Customer]) -> dict:
    if customer is None:
        return {}
    return {
        "cnic": customer.cnic,
        "name": customer.name,
        "dob": customer.dob.isoformat() if customer.dob else None,
        "gender": customer.gender.value if hasattr(customer.gender, "value") else customer.gender,
        "marital_status": customer.marital_status.value if hasattr(customer.marital_status, "value") else customer.marital_status,
        "occupation": customer.occupation,
        "declared_income": customer.declared_income,
        "is_smoker": customer.is_smoker,
        "height_cm": customer.height_cm,
        "weight_kg": customer.weight_kg,
    }


def _policy_dict(policy: Optional[Policy]) -> dict:
    if policy is None:
        return {}
    return {
        "product_name": policy.product_name,
        "insurance_type": policy.insurance_type.value if hasattr(policy.insurance_type, "value") else policy.insurance_type,
        "coverage_amount": policy.coverage_amount,
        "term_years": policy.term_years,
        "dependent_dob": policy.dependent_dob.isoformat() if getattr(policy, "dependent_dob", None) else None,
    }


def _e_application_dict(ea: Optional[CustomerEApplication]) -> dict:
    if ea is None:
        return {}
    return {
        "medical_questionnaire": ea.medical_questionnaire or {},
        "family_history": ea.family_history or {},
        "lifestyle_habits": ea.lifestyle_habits or {},
        "existing_insurance": ea.existing_insurance or {},
    }


def _acr_dict(acr: Optional[AgentConfidentialReport]) -> dict:
    if acr is None:
        return {}
    return {
        "estimated_income_opinion": acr.estimated_income_opinion,
        "income_consistency_note": acr.income_consistency_note,
        "habits_observed": acr.habits_observed or {},
        "recommendation": acr.recommendation.value if acr.recommendation else None,
        "adverse_info_known": acr.adverse_info_known,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Evidence assembly
# ─────────────────────────────────────────────────────────────────────────────

async def collect_document_evidence(session: AsyncSession, tenant_id: UUID, case_id: UUID) -> list[dict]:
    """Accepted artifacts for this case, shaped for shared.underwriting.profile.
    Only "Accepted" (OCR succeeded with reasonable confidence) counts as
    evidence — a "Re-submission Requested" artifact must not silently
    participate in underwriting."""
    artifacts = (await session.exec(
        select(Artifact).where(
            Artifact.tenant_id == tenant_id,
            Artifact.case_id == case_id,
            Artifact.status == "Accepted",
        )
    )).all()
    return [
        {
            "artifact_id": a.id,
            "document_type": a.document_type,
            "ocr_confidence_score": a.ocr_confidence_score,
            "extracted_metadata": a.extracted_metadata or {},
        }
        for a in artifacts
    ]


async def _prior_findings(session: AsyncSession, case_id: UUID) -> list[VerificationFindingSpec]:
    rows = (await session.exec(select(VerificationFinding).where(VerificationFinding.case_id == case_id))).all()
    return [
        VerificationFindingSpec(
            field=row.field,
            severity=row.severity.value,
            declared_value=row.declared_value,
            observed_value=row.observed_value,
            source_artifact_id=row.source_artifact_id,
            explanation=row.explanation,
        )
        for row in rows
    ]


async def build_case_profile(session: AsyncSession, tenant_id: UUID, case: Case) -> UnderwritingProfile:
    customer = await session.get(Customer, case.customer_id)
    policy = await session.get(Policy, case.policy_id) if case.policy_id else None
    ea = (await session.exec(
        select(CustomerEApplication).where(CustomerEApplication.case_id == case.caseld)
    )).first()
    from family_approval import owner_case_id
    acr = (await session.exec(
        select(AgentConfidentialReport).where(AgentConfidentialReport.case_id == await owner_case_id(session, case, "acr"))
    )).first()
    document_evidence = await collect_document_evidence(session, tenant_id, case.caseld)
    prior = await _prior_findings(session, case.caseld)

    return build_profile(
        _customer_dict(customer),
        _policy_dict(policy),
        e_application=_e_application_dict(ea),
        acr=_acr_dict(acr),
        document_evidence=document_evidence,
        verified_facts=[spec.model_dump(mode="json") for spec in prior],
    )


# ─────────────────────────────────────────────────────────────────────────────
# CaseWorkflow — the authoritative step tracker (brief §5)
# ─────────────────────────────────────────────────────────────────────────────

async def advance_workflow(
    session: AsyncSession,
    case: Case,
    step: str,
    *,
    state: WorkflowStateEnum = WorkflowStateEnum.RUNNING,
    triggered_by: Optional[UUID] = None,
) -> CaseWorkflow:
    existing = (await session.exec(
        select(CaseWorkflow).where(CaseWorkflow.caseld == case.caseld)
    )).first()
    if existing is None:
        workflow = CaseWorkflow(
            caseld=case.caseld, currentStep=step, previousStep=None,
            workflowState=state, triggeredBy=triggered_by, workflowVersion=WORKFLOW_VERSION,
        )
        session.add(workflow)
        return workflow

    existing.previousStep = existing.currentStep
    existing.currentStep = step
    existing.workflowState = state
    existing.triggeredBy = triggered_by
    existing.lastUpdatedAt = datetime.utcnow()
    session.add(existing)
    return existing


# ─────────────────────────────────────────────────────────────────────────────
# Requirements Engine (brief §4)
# ─────────────────────────────────────────────────────────────────────────────

def _requirement_rows_satisfied(rows: list[CaseRequirement]) -> bool:
    return all(
        row.status in (CaseRequirementStatusEnum.SATISFIED, CaseRequirementStatusEnum.WAIVED)
        for row in rows
        if row.required
    )


async def compute_requirements(
    session: AsyncSession,
    tenant_id: UUID,
    case: Case,
    *,
    request: Optional[Request] = None,
) -> tuple[list[CaseRequirement], bool]:
    """Determine + upsert CaseRequirement rows. Idempotent: matches on
    `code` so repeated calls never duplicate a requirement. A requirement a
    human has already Waived is never silently reverted by a later
    recomputation — only required/reason are refreshed for it."""
    profile = await build_case_profile(session, tenant_id, case)
    prior = await _prior_findings(session, case.caseld)
    specs = determine_requirements(profile, prior)
    exam = (await session.exec(
        select(MedicalExamOrder).where(MedicalExamOrder.case_id == case.caseld)
    )).first()
    if exam is not None:
        specs = apply_medical_exam_order(
            specs,
            exam.status.value if hasattr(exam.status, "value") else exam.status,
            [t.get("code") for t in (exam.required_tests or []) if isinstance(t, dict) and t.get("code")],
            exam.result_artifact_id,
        )

    existing_rows = {
        row.code: row
        for row in (await session.exec(
            select(CaseRequirement).where(CaseRequirement.case_id == case.caseld)
        )).all()
    }

    result_rows: list[CaseRequirement] = []
    for spec in specs:
        row = existing_rows.get(spec.code)
        if row is None:
            row = CaseRequirement(
                tenant_id=tenant_id, case_id=case.caseld, code=spec.code,
                category=spec.category.value, required=spec.required,
                status=CaseRequirementStatusEnum(spec.status.value), reason=spec.reason,
                satisfied_by_artifact_id=spec.satisfied_by_artifact_id,
            )
        else:
            row.required = spec.required
            row.reason = spec.reason
            if row.status != CaseRequirementStatusEnum.WAIVED:
                row.status = CaseRequirementStatusEnum(spec.status.value)
                row.satisfied_by_artifact_id = spec.satisfied_by_artifact_id
            row.updated_at = datetime.utcnow()
        session.add(row)
        result_rows.append(row)

    await session.flush()
    satisfied = _requirement_rows_satisfied(result_rows)

    if not satisfied:
        await apply_pending_documents(session, tenant_id, case)
    await advance_workflow(session, case, "requirements_determination" if satisfied else "document_collection")

    if request is not None:
        await publish_case_event(
            request, session, event_type="RequirementsDetermined", tenant_id=tenant_id,
            case_id=case.caseld, customer_id=case.customer_id,
            detail={"satisfied": satisfied, "count": len(result_rows)},
        )

    return result_rows, satisfied


async def waive_requirement(
    session: AsyncSession, requirement: CaseRequirement, *, note: Optional[str] = None,
) -> CaseRequirement:
    requirement.status = CaseRequirementStatusEnum.WAIVED
    requirement.updated_at = datetime.utcnow()
    if note:
        requirement.reason = f"{requirement.reason} — waived: {note}" if requirement.reason else f"Waived: {note}"
    session.add(requirement)
    return requirement


async def apply_pending_documents(session: AsyncSession, tenant_id: UUID, case: Case) -> None:
    """System-generated transition to Pending Documents when mandatory
    requirements are unmet — mirrors the system-generated CaseHistory pattern
    already used by api-gateway/risk_persistence.py::apply_ai_case_status."""
    if case.caseStatus == CaseStatusEnum.PENDING_DOCUMENTS:
        return
    system_user = (await session.exec(select(User).where(User.tenant_id == tenant_id))).first()
    old_status = case.caseStatus
    case.caseStatus = CaseStatusEnum.PENDING_DOCUMENTS
    case.updatedAt = datetime.utcnow()
    if system_user is not None:
        session.add(CaseHistory(
            caseld=case.caseld, actionType=ActionTypeEnum.STATUS_CHANGE,
            fromStatus=old_status.value if hasattr(old_status, "value") else str(old_status),
            toStatus=case.caseStatus.value, changedBy=system_user.id, systemGeneratedFlag=True,
        ))
    session.add(case)


# ─────────────────────────────────────────────────────────────────────────────
# Verification (brief §3)
# ─────────────────────────────────────────────────────────────────────────────

async def run_verification(
    session: AsyncSession,
    tenant_id: UUID,
    case: Case,
    *,
    request: Optional[Request] = None,
) -> list[VerificationFinding]:
    """Recomputes findings from the current evidence and replaces the prior
    set — re-running verification after new evidence arrives must not pile
    up stale findings that no longer apply."""
    profile = await build_case_profile(session, tenant_id, case)
    specs = verify_profile(profile)

    await session.exec(delete(VerificationFinding).where(VerificationFinding.case_id == case.caseld))

    rows: list[VerificationFinding] = []
    for spec in specs:
        row = VerificationFinding(
            tenant_id=tenant_id, case_id=case.caseld, field=spec.field,
            severity=VerificationSeverityEnum(spec.severity.value),
            declared_value=spec.declared_value, observed_value=spec.observed_value,
            source_artifact_id=spec.source_artifact_id, explanation=spec.explanation,
        )
        session.add(row)
        rows.append(row)

    await session.flush()
    await advance_workflow(session, case, "document_verification")

    if request is not None and rows:
        await publish_case_event(
            request, session, event_type="VerificationCompleted", tenant_id=tenant_id,
            case_id=case.caseld, customer_id=case.customer_id,
            detail={"finding_count": len(rows)},
        )
    return rows


# ─────────────────────────────────────────────────────────────────────────────
# Evidence bundle — what api-gateway forwards to risk-engine
# ─────────────────────────────────────────────────────────────────────────────

async def build_evidence_bundle(
    session: AsyncSession,
    tenant_id: UUID,
    case: Case,
    *,
    request: Optional[Request] = None,
) -> dict:
    profile = await build_case_profile(session, tenant_id, case)
    findings = await run_verification(session, tenant_id, case, request=request)
    requirement_rows = (await session.exec(
        select(CaseRequirement).where(CaseRequirement.case_id == case.caseld)
    )).all()
    satisfied = _requirement_rows_satisfied(requirement_rows)

    return {
        "requirements_satisfied": satisfied,
        "document_evidence": profile.document_evidence,
        "e_application": profile.raw.get("e_application"),
        "acr": profile.raw.get("acr"),
        "verified_facts": [
            {
                "field": f.field,
                "severity": f.severity.value,
                "declared_value": f.declared_value,
                "observed_value": f.observed_value,
                "source_artifact_id": str(f.source_artifact_id) if f.source_artifact_id else None,
                "explanation": f.explanation,
            }
            for f in findings
        ],
    }
