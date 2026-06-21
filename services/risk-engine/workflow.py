from __future__ import annotations

import os
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict

from pydantic import BaseModel, Field
from langchain_core.prompts import ChatPromptTemplate
from langchain_google_genai import ChatGoogleGenerativeAI

# ─────────────────────────────────────────────────────────────────────────────
# State schema
# ─────────────────────────────────────────────────────────────────────────────


class RiskState(TypedDict):
    applicant: Dict[str, Any]
    policy: Dict[str, Any]
    is_valid: bool
    validation_errors: List[str]
    medical_score: int
    medical_reasons: List[str]
    financial_score: int
    financial_reasons: List[str]
    fraud_probability: float
    fraud_reasons: List[str]
    composite_risk_score: int
    ai_decision: str
    suggested_loading: Optional[float]
    reasons: List[str]


# ─────────────────────────────────────────────────────────────────────────────
# LLM helper
# ─────────────────────────────────────────────────────────────────────────────


def _llm() -> ChatGoogleGenerativeAI:
    return ChatGoogleGenerativeAI(
        model="gemini-2.5-flash",
        temperature=0.1,
        google_api_key=os.getenv("GEMINI_API_KEY"),
    )


# ─────────────────────────────────────────────────────────────────────────────
# LLM output schemas
# ─────────────────────────────────────────────────────────────────────────────


class MedicalScoreOutput(BaseModel):
    medical_score: int = Field(
        description="Actuarial medical risk score from 0 to 100.", ge=0, le=100)
    medical_reasons: List[str] = Field(
        description="List of strings explaining the exact reasons for the score.")


class FinancialScoreOutput(BaseModel):
    financial_score: int = Field(
        description="Financial risk score from 0 to 100.", ge=0, le=100)
    financial_reasons: List[str] = Field(
        description="List of strings explaining the financial risk assessment.")


class FraudOutput(BaseModel):
    fraud_probability: float = Field(
        description="Probability of fraud from 0.0 to 1.0.", ge=0.0, le=1.0)
    fraud_reasons: List[str] = Field(
        description="List of indicators that contributed to the fraud score.")


class DecisionOutput(BaseModel):
    composite_risk_score: int = Field(
        description="Overall composite risk score from 0 to 100.", ge=0, le=100)
    ai_decision: str = Field(
        description='One of exactly: "Auto Approve", "Approve with Loading", "Human Review", "Decline"')
    suggested_loading: Optional[float] = Field(
        default=None,
        description="Premium loading percentage if applicable, e.g. 25.0 for 25% extra premium.")
    reasons: List[str] = Field(
        description="Final list of reasons summarising the underwriting decision.")


# ─────────────────────────────────────────────────────────────────────────────
# Graph nodes
# ─────────────────────────────────────────────────────────────────────────────


def validate_input(state: RiskState) -> Dict[str, Any]:
    errors: List[str] = []
    applicant = state["applicant"]
    policy = state["policy"]

    try:
        dob = datetime.strptime(applicant["dob"], "%Y-%m-%d").date()
        age = (date.today() - dob).days // 365
        if age < 18:
            errors.append(f"Applicant is under 18 (age: {age}).")
        if age > 70:
            errors.append(
                f"Applicant exceeds maximum entry age of 70 (age: {age}).")
    except (KeyError, ValueError):
        errors.append("Invalid or missing date of birth.")

    income = applicant.get("declared_income", 0)
    if income <= 0:
        errors.append("Declared income must be greater than zero.")

    coverage = policy.get("coverage_amount", 0)
    if coverage <= 0:
        errors.append("Coverage amount must be greater than zero.")

    if income > 0 and coverage > income * 20:
        errors.append(
            f"Coverage amount ({coverage:,.0f}) exceeds 20× annual income ({income * 20:,.0f})."
        )

    term = policy.get("term_years", 0)
    if term < 1 or term > 40:
        errors.append(
            f"Policy term must be between 1 and 40 years (got {term}).")

    return {"is_valid": len(errors) == 0, "validation_errors": errors}


def medical_scoring(state: RiskState) -> Dict[str, Any]:
    applicant = state["applicant"]
    structured_llm = _llm().with_structured_output(MedicalScoreOutput)
    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are an expert life insurance medical underwriter.
         Evaluate the following applicant's baseline medical risk based on:
         1. Age (Calculate from DOB. Older = higher risk).
         2. Gender (Standard actuarial mortality differentials).
         3. Occupation Hazard (High hazard like mining/military = high points, office work = 0 points).

         Output a strict composite risk score from 0 (standard risk) to 100 (uninsurable) and the specific reasons."""),
        ("user", "Applicant Data: {applicant}")
    ])
    result = (prompt | structured_llm).invoke({"applicant": applicant})
    return {"medical_score": result.medical_score, "medical_reasons": result.medical_reasons}


def financial_scoring(state: RiskState) -> Dict[str, Any]:
    applicant = state["applicant"]
    policy = state["policy"]
    structured_llm = _llm().with_structured_output(FinancialScoreOutput)
    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are an expert insurance financial underwriter.
         Assess the financial risk of this applicant based on:
         1. Income-to-coverage ratio (high coverage vs low income = higher risk).
         2. Policy term (longer term = higher exposure).
         3. Occupation stability and income reliability.

         Output a financial risk score from 0 (low risk) to 100 (very high risk) and specific reasons."""),
        ("user", "Applicant: {applicant}\nPolicy: {policy}")
    ])
    result = (prompt | structured_llm).invoke(
        {"applicant": applicant, "policy": policy})
    return {"financial_score": result.financial_score, "financial_reasons": result.financial_reasons}


def fraud_detection(state: RiskState) -> Dict[str, Any]:
    applicant = state["applicant"]
    policy = state["policy"]
    structured_llm = _llm().with_structured_output(FraudOutput)
    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are an insurance fraud detection specialist.
         Assess the likelihood of fraudulent intent based on:
         1. Coverage-to-income ratio anomalies (very high coverage vs low income).
         2. Policy term vs applicant age (unusual combinations).
         3. Any suspicious patterns in the declared data.

         Output a fraud probability from 0.0 (no concern) to 1.0 (near-certain fraud) and specific indicators."""),
        ("user", "Applicant: {applicant}\nPolicy: {policy}")
    ])
    result = (prompt | structured_llm).invoke(
        {"applicant": applicant, "policy": policy})
    return {"fraud_probability": result.fraud_probability, "fraud_reasons": result.fraud_reasons}


def make_decision(state: RiskState) -> Dict[str, Any]:
    structured_llm = _llm().with_structured_output(DecisionOutput)
    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are a senior insurance underwriting manager making the final decision.
         Based on all risk scores, produce:
         1. A composite risk score (0-100) as a weighted blend: 40% medical + 30% financial + 30% (fraud×100).
         2. A decision using EXACTLY one of these strings:
            - "Auto Approve"        (composite score 0-40)
            - "Approve with Loading" (composite score 41-65)
            - "Human Review"        (composite score 66-80)
            - "Decline"             (composite score 81-100)
         3. If "Approve with Loading", suggest a loading percentage (e.g. 25.0 for 25% extra premium).
         4. A concise list of final reasons for the decision."""),
        ("user",
         "Medical score: {medical_score} | Reasons: {medical_reasons}\n"
         "Financial score: {financial_score} | Reasons: {financial_reasons}\n"
         "Fraud probability: {fraud_probability} | Reasons: {fraud_reasons}\n"
         "Applicant: {applicant}\nPolicy: {policy}")
    ])
    result = (prompt | structured_llm).invoke({
        "medical_score": state["medical_score"],
        "medical_reasons": state["medical_reasons"],
        "financial_score": state["financial_score"],
        "financial_reasons": state["financial_reasons"],
        "fraud_probability": state["fraud_probability"],
        "fraud_reasons": state["fraud_reasons"],
        "applicant": state["applicant"],
        "policy": state["policy"],
    })
    return {
        "composite_risk_score": result.composite_risk_score,
        "ai_decision": result.ai_decision,
        "suggested_loading": result.suggested_loading,
        "reasons": result.reasons,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Graph assembly
# ─────────────────────────────────────────────────────────────────────────────


def _should_continue(state: RiskState) -> str:
    return "medical_scoring" if state["is_valid"] else END


_graph = StateGraph(RiskState)
_graph.add_node("validate_input", validate_input)
_graph.add_node("medical_scoring", medical_scoring)
_graph.add_node("financial_scoring", financial_scoring)
_graph.add_node("fraud_detection", fraud_detection)
_graph.add_node("make_decision", make_decision)

_graph.add_edge(START, "validate_input")
_graph.add_conditional_edges("validate_input", _should_continue)
_graph.add_edge("medical_scoring", "financial_scoring")
_graph.add_edge("financial_scoring", "fraud_detection")
_graph.add_edge("fraud_detection", "make_decision")
_graph.add_edge("make_decision", END)

_workflow = _graph.compile()


# ─────────────────────────────────────────────────────────────────────────────
# Public entry points
# ─────────────────────────────────────────────────────────────────────────────

def _initial_state(applicant_data: Dict[str, Any], policy_data: Dict[str, Any]) -> RiskState:
    return {
        "applicant": applicant_data,
        "policy": policy_data,
        "is_valid": False,
        "validation_errors": [],
        "medical_score": 0,
        "medical_reasons": [],
        "financial_score": 0,
        "financial_reasons": [],
        "fraud_probability": 0.0,
        "fraud_reasons": [],
        "composite_risk_score": 0,
        "ai_decision": "",
        "suggested_loading": None,
        "reasons": [],
    }


def run_evaluation(applicant_data: Dict[str, Any], policy_data: Dict[str, Any]) -> Dict[str, Any]:
    return dict(_workflow.invoke(_initial_state(applicant_data, policy_data)))


def stream_evaluation(applicant_data: Dict[str, Any], policy_data: Dict[str, Any]):
    """Yields (node_name, node_data) for each completed node, then ('__done__', full_state)."""
    accumulated = dict(_initial_state(applicant_data, policy_data))
    for update in _workflow.stream(_initial_state(applicant_data, policy_data), stream_mode="updates"):
        node_name = list(update.keys())[0]
        node_data = update[node_name]
        accumulated.update(node_data)
        yield node_name, node_data
    yield "__done__", accumulated


# --- Add this below MedicalScoreOutput ---
class FinancialScoreOutput(BaseModel):
    financial_score: int = Field(
        description="Financial risk score from 0 to 100.", ge=0, le=100)
    financial_reasons: List[str] = Field(
        description="List of strings explaining the financial score.")

# --- Replace the existing financial_scoring function ---


def financial_scoring(state: RiskState) -> Dict[str, Any]:
    """
    LLM-powered financial underwriting node using Gemini 2.5 Flash.
    """
    applicant = state["applicant"]
    policy = state["policy"]

    llm = ChatGoogleGenerativeAI(
        model="gemini-2.5-flash",
        temperature=0.1,
        google_api_key=os.getenv("GOOGLE_API_KEY")
    )

    structured_llm = llm.with_structured_output(FinancialScoreOutput)

    prompt = ChatPromptTemplate.from_messages([
        ("system", """You are an expert life insurance financial underwriter. 
         Evaluate the applicant's financial risk based on:
         1. Coverage-to-income ratio (Higher ratio = higher lapse/moral hazard risk).
         2. Absolute income bracket (Lower income = higher affordability risk).
         3. Policy term length (Longer terms increase exposure).
         
         Output a strict financial risk score from 0 (standard risk) to 100 (uninsurable) and the specific reasons."""),
        ("user", "Applicant Data: {applicant}\nPolicy Data: {policy}")
    ])

    result = (prompt | structured_llm).invoke(
        {"applicant": applicant, "policy": policy})

    return {
        "financial_score": result.financial_score,
        "financial_reasons": result.financial_reasons
    }
