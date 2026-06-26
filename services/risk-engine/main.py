import asyncio
import json
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Any, Dict, Optional

from graph_writer import write_applicant_to_graph
from workflow import run_evaluation, stream_evaluation

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


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _persist_to_graph(
    result: Dict[str, Any],
    request: "EvaluationRequest",
    tenant_id: str,
) -> None:
    """Fire-and-forget write of an evaluated applicant into Memgraph.

    Only writes valid evaluations. Any failure is swallowed inside
    write_applicant_to_graph so the evaluation response is never affected.
    """
    if not result.get("is_valid", False):
        return
    write_applicant_to_graph(
        cnic              = request.applicant.cnic,
        tenant_id         = tenant_id,
        occupation        = request.applicant.occupation,
        declared_income   = float(request.applicant.declared_income),
        coverage_amount   = float(request.policy.coverage_amount),
        medical_score     = int(result.get("medical_score", 0)),
        financial_score   = int(result.get("financial_score", 0)),
        fraud_probability = float(result.get("fraud_probability", 0.0)),
    )


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health_check():
    return {"service": "risk-engine", "status": "healthy"}


@app.post("/evaluate", response_model=EvaluationResponse)
async def evaluate(
    request: EvaluationRequest,
    x_tenant_id: str = Header(default=""),
):
    """Run the LangGraph risk workflow for a single applicant + policy pair."""
    result: Dict[str, Any] = run_evaluation(
        applicant_data=request.applicant.model_dump(),
        policy_data=request.policy.model_dump(),
        tenant_id=x_tenant_id,
    )

    if not result["is_valid"]:
        raise HTTPException(status_code=422, detail=result["validation_errors"])

    # Fire-and-forget: persist the evaluated applicant into Memgraph so the
    # fraud-ring graph builds up over time. Never blocks the response.
    _persist_to_graph(result, request, x_tenant_id)

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


@app.post("/evaluate/stream")
async def evaluate_stream(
    request: EvaluationRequest,
    x_tenant_id: str = Header(default=""),
):
    """Streams each LangGraph node completion as SSE, then emits the full result."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def run_graph():
        try:
            for node_name, node_data in stream_evaluation(
                applicant_data=request.applicant.model_dump(),
                policy_data=request.policy.model_dump(),
                tenant_id=x_tenant_id,
            ):
                if node_name == "__done__":
                    # Persist the fully-scored applicant into Memgraph before
                    # emitting the final event. Fire-and-forget — never blocks.
                    _persist_to_graph(node_data, request, x_tenant_id)
                    evt = {"type": "done", "data": node_data}
                else:
                    evt = {"type": "progress", "node": node_name, "data": node_data}
                loop.call_soon_threadsafe(queue.put_nowait, evt)
        except Exception as exc:
            loop.call_soon_threadsafe(queue.put_nowait, {"type": "error", "message": str(exc)})
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    async def generate():
        fut = loop.run_in_executor(None, run_graph)
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield f"data: {json.dumps(item, default=str)}\n\n"
        finally:
            await fut

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
