"""Workflows a dataset can cover, with the stages and categories their cases are filed under.

Only the Individual Insurance workflow is implemented today. Family, Corporate and the rest are added here when their
agents are ready to be evaluated; nothing else in the lake is specific to one workflow.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple


@dataclass(frozen=True)
class WorkflowProfile:
    slug: str
    name: str
    stages: Tuple[str, ...]
    categories: Dict[str, str]          # category slug -> what it covers


INDIVIDUAL_INSURANCE = WorkflowProfile(
    slug="individual-insurance",
    name="Individual Insurance",
    stages=("lead", "onboarding", "plan_selection", "kyc", "underwriting", "risk", "premium_payment", "issuance",
            "servicing", "claims", "agent", "security"),
    categories={
        "lead-onboarding": "Lead creation and customer onboarding",
        "customer-validation": "Customer information and CNIC validation",
        "plan-eligibility": "Insurance plan selection and eligibility",
        "kyc-documents": "KYC, documents, and information extraction",
        "underwriting": "Medical and financial underwriting",
        "risk-aml-knockout": "Risk assessment, AML checks, and early knockout",
        "premium-payment": "Premium calculation and payment validation",
        "policy-issuance": "Policy approval, issuance, and status transitions",
        "claims-servicing": "Claims and customer servicing",
        "agent-routing": "Agent routing, skills, tools, and multi-turn conversations",
        "security-rbac": "Security, RBAC, and tenant isolation",
    },
)

WORKFLOWS: Dict[str, WorkflowProfile] = {INDIVIDUAL_INSURANCE.slug: INDIVIDUAL_INSURANCE}


def get_workflow(slug: str) -> WorkflowProfile:
    try:
        return WORKFLOWS[slug]
    except KeyError:
        raise ValueError(f"Unknown workflow {slug!r}. Available: {', '.join(sorted(WORKFLOWS))}") from None
