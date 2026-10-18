"""Human underwriting advice for Claims: separate from AI output and claim adjudication.

Append-only CaseAuditTrail records bind an Admin's outcome to the exact assessment
and specialist reviews they considered. New evidence invalidates old advice.
"""
import json
from sqlmodel import select
from shared.models.core import CaseAuditTrail, CaseUnderwritingTrack, RiskAssessment

ACTION = 'Claim underwriting outcome recorded'
SUBMITTED = {'CLEARED', 'REFERRED', 'DECLINED'}


def review_snapshot(tracks):
    return {t.track: {'status': t.status, 'note': t.note,
                     'updated_at': t.updated_at.isoformat() if t.updated_at else None,
                     'assigned_user_id': str(t.assigned_user_id) if t.assigned_user_id else None}
            for t in tracks}


async def opinion_state(session, case):
    tracks = (await session.exec(select(CaseUnderwritingTrack).where(
        CaseUnderwritingTrack.case_id == case.caseld, CaseUnderwritingTrack.tenant_id == case.tenant_id))).all()
    snapshot = review_snapshot(tracks)
    assessment = (await session.exec(select(RiskAssessment).where(
        RiskAssessment.case_id == case.caseld, RiskAssessment.tenant_id == case.tenant_id,
        RiskAssessment.superseded_at == None).order_by(RiskAssessment.created_at.desc(), RiskAssessment.id.desc()))).first()  # noqa: E711
    audit = (await session.exec(select(CaseAuditTrail).where(CaseAuditTrail.caseld == case.caseld,
        CaseAuditTrail.actionPerformed == ACTION).order_by(CaseAuditTrail.timestamp.desc(), CaseAuditTrail.auditld.desc()))).first()
    outcome = None
    if audit:
        try:
            value = json.loads(audit.newValue or '{}')
            if value.get('decision') in {'PROCEED', 'DECLINE'}:
                outcome = {**value, 'recorded_by': str(audit.performedBy), 'recorded_at': audit.timestamp.isoformat(),
                           'current': bool(assessment and value.get('assessment_id') == str(assessment.id)
                                           and value.get('reviews') == snapshot)}
        except (ValueError, TypeError, AttributeError):
            pass
    return {'reviews_complete': all(snapshot.get(t, {}).get('status') in SUBMITTED for t in ('MEDICAL', 'FINANCIAL')),
            'review_snapshot': snapshot, 'assessment_id': str(assessment.id) if assessment else None,
            'ai_recommendation': str(getattr(assessment.ai_decision, 'value', assessment.ai_decision)) if assessment else None,
            'outcome': outcome}
