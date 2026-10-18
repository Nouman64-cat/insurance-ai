"""The medical and financial underwriters' reviews of one application, compiled.

Final underwriting is a compilation: each specialist submits their review
(Cleared / Referred / Declined, with a rationale) backed by their AI run — the
medical examination's rated results, the financial score and cover ceiling —
and the final AI run combines those with PEP screening and the agent's report.
This module is the one place that reads both reviews in that shape: for the
case page, and for the evidence bundle risk-engine decides from.
"""

from typing import Optional
from uuid import UUID

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from shared.models.core import CaseUnderwritingTrack, MedicalExamOrder, User

# A review is submitted once its underwriter has recorded a decision.
SUBMITTED = ("CLEARED", "REFERRED", "DECLINED")


def _status(value) -> Optional[str]:
    return str(getattr(value, "value", value)) if value is not None else None


async def compile_specialist_reviews(session: AsyncSession, case_id: UUID) -> dict:
    rows = {r.track: r for r in (await session.exec(
        select(CaseUnderwritingTrack).where(CaseUnderwritingTrack.case_id == case_id))).all()}
    names = {}
    ids = {r.assigned_user_id for r in rows.values() if r.assigned_user_id}
    if ids:
        names = {u.id: u.full_name for u in (await session.exec(select(User).where(User.id.in_(ids)))).all()}
    exam = (await session.exec(select(MedicalExamOrder).where(MedicalExamOrder.case_id == case_id))).first()

    def review(track: str) -> dict:
        row = rows.get(track)
        status = row.status if row else "PENDING"
        return {
            "status": status,
            "submitted": status in SUBMITTED,
            "reviewer": names.get(row.assigned_user_id) if row and row.assigned_user_id else None,
            "note": row.note if row else None,
            "updated_at": row.updated_at.isoformat() if row and row.updated_at else None,
        }

    medical = review("MEDICAL")
    medical["ai"] = {
        "exam_status": _status(exam.status),
        "outcome": _status(exam.outcome),
        "suggested_loading_pct": exam.suggested_loading_pct,
        "abnormal_findings": exam.abnormal_findings or [],
        "completed_at": exam.completed_at.isoformat() if exam.completed_at else None,
    } if exam else None
    medical_row = rows.get("MEDICAL")
    if medical_row and (medical_row.ai_result or {}).get("scope") == "claim":
        medical["ai"] = {**medical_row.ai_result, "run_at": medical_row.ai_run_at.isoformat() if medical_row.ai_run_at else None}
    financial = review("FINANCIAL")
    row = rows.get("FINANCIAL")
    financial["ai"] = {**(row.ai_result or {}), "run_at": row.ai_run_at.isoformat() if row.ai_run_at else None} if row and row.ai_result else None
    return {"medical": medical, "financial": financial}
