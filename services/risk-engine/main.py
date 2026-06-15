from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any, Dict, Optional

from workflow import run_evaluation

app = FastAPI(title="Risk Engine", version="0.1.0")


# ─── Request / response shapes (Pydantic, not SQLModel — no DB writes here) ──

class ApplicantInput(BaseModel):
    cnic: str
    name: str
    dob: str                  # ISO date string: YYYY-MM-DD
    gender: str
    occupation: str
    declared_income: float


class PolicyInput(BaseModel):
    product_name: str
    coverage_amount: float
    term_years: int


class EvaluationRequest(BaseModel):
    applicant: ApplicantInput
    policy: PolicyInput


class EvaluationResponse(BaseModel):
    is_valid: bool
    validation_errors: list[str]
    medical_score: int
    financial_score: int
    fraud_probability: float
    composite_risk_score: int
    ai_decision: str
    suggested_loading: Optional[float]
    reasons: list[str]


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health_check():
    return {"service": "risk-engine", "status": "healthy"}


@app.post("/evaluate", response_model=EvaluationResponse)
async def evaluate(request: EvaluationRequest):
    """Run the LangGraph risk workflow for a single applicant + policy pair."""
    result: Dict[str, Any] = run_evaluation(
        applicant_data=request.applicant.model_dump(),
        policy_data=request.policy.model_dump(),
    )

    if not result["is_valid"]:
        raise HTTPException(status_code=422, detail=result["validation_errors"])

    return EvaluationResponse(
        is_valid=result["is_valid"],
        validation_errors=result["validation_errors"],
        medical_score=result["medical_score"],
        financial_score=result["financial_score"],
        fraud_probability=result["fraud_probability"],
        composite_risk_score=result["composite_risk_score"],
        ai_decision=result["ai_decision"],
        suggested_loading=result["suggested_loading"],
        reasons=result["reasons"],
    )
