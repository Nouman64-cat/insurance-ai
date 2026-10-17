"""Specialists own their track's working tools, never the full issuance workflow."""
import re
from fastapi import HTTPException
from fastapi.responses import JSONResponse
from sqlmodel import select
import database
from routers.auth import _get_current_user, _role_name
from shared.models.core import Case, CaseUnderwritingTrack, CaseTypeEnum

MEDICAL_ACTIONS = {'assess', 'invite', 'schedule', 'lab-link', 'ai-review', 'result', 'confirm-reports', 'waive'}
FINANCIAL_ACTIONS = {'run', 'clear', 'fail'}
# Track tools that are not under medical-exam/ or insurance-history/.
TRACK_TOOLS = {'medical': set(), 'financial': {'financial-underwriting/run'}}
# Customer-facing forms a specialist can email — only their own track's
# e-application questionnaire — and neither needs a linked proposal.
def customer_forms(track: str) -> set:
    return {'underwriting-questionnaire/invite', f'e-application/{track}/invite', f'e-application/{track}/waive'}
# Application requirements a document upload can meet: code -> (document type
# that satisfies it, the track that collects it — None means either may).
APPLICATION_DOCUMENTS = {
    'CNIC': ('CNIC', None),
    'PHYSICIAN_REPORT': ('Physician Report', 'medical'), 'MEDICAL_EXAMINATION': ('Medical Report', 'medical'),
    'ECG': ('ECG', 'medical'), 'LAB_REPORTS': ('Lab Report', 'medical'),
    'SALARY_SLIP': ('Salary Slip', 'financial'), 'BANK_STATEMENT': ('Bank Statement', 'financial'), 'TAX_DOCUMENT': ('Tax Return', 'financial'),
}
DOCUMENT_TYPES = {'medical': {'Medical Report', 'X-Ray', 'MRI Scan', 'Lab Report', 'ECG', 'Blood Test'}, 'financial': {'Salary Slip', 'Bank Statement', 'Tax Return', 'Income Certificate', 'Financial Statement', 'Proof of Income'}}

async def restrict_specialist_writes(request, call_next):
    if request.method not in {'POST', 'PUT', 'PATCH', 'DELETE'} or not request.url.path.startswith('/tenants/'):
        return await call_next(request)
    authorization = request.headers.get('authorization', '')
    if not authorization.lower().startswith('bearer '):
        return await call_next(request)
    try:
        async with database._session_factory() as session:
            user = await _get_current_user(authorization[7:], session)
            role = await _role_name(user, session)
            if role not in {'Medical Underwriter', 'Financial Underwriter'}:
                return await call_next(request)
            track = 'medical' if role == 'Medical Underwriter' else 'financial'
            match = re.fullmatch(r'/tenants/([0-9a-f-]+)/cases/([0-9a-f-]+)/(.*?)/?', request.url.path)
            allowed = False
            if match:
                tail = match[3]
                if request.method == 'PUT' and tail == 'underwriting-tracks/' + track:
                    return await call_next(request)  # endpoint checks ownership and permits picking up work
                allowed = request.method == 'POST' and tail in TRACK_TOOLS[track] or request.method == 'POST' and (tail.startswith('medical-exam/') and tail.split('/')[-1] in MEDICAL_ACTIONS if track == 'medical' else tail.startswith('insurance-history/') and tail.split('/')[-1] in FINANCIAL_ACTIONS)
            allowed = allowed or bool(match and request.method == 'POST' and match[3] in {'underwriting-documents', 'underwriting-documents/classify', 'underwriting-documents/demo-complete'} | customer_forms(track))
            document_retry = bool(match and request.method == 'POST' and re.fullmatch(r'underwriting-documents/[0-9a-f-]+/retry', match[3]))
            allowed = allowed or document_retry
            if not allowed:
                raise HTTPException(403, 'This action is outside your medical or financial underwriting responsibilities.')
            from uuid import UUID
            tenant_id, case_id = UUID(match[1]), UUID(match[2])
            case = await session.get(Case, case_id)
            if user.tenant_id != tenant_id or not case or case.tenant_id != tenant_id or case.caseType != CaseTypeEnum.UNDERWRITING:
                raise HTTPException(403, 'This application is not accessible to your role.')
            review = (await session.exec(select(CaseUnderwritingTrack).where(CaseUnderwritingTrack.case_id == case_id, CaseUnderwritingTrack.track == track.upper()))).first()
            if not review or review.assigned_user_id != user.id:
                raise HTTPException(403, 'Start your review or ask an admin to assign this track to you before using its tools.')
            if case.on_hold or str(getattr(case.caseStatus, 'value', case.caseStatus)) in {'Approved', 'Closed', 'Rejected'}:
                raise HTTPException(409, 'This application is held or closed for specialist work.')
            from routers.underwriting_tracks import resolve_review_policy
            if not document_retry and match[3] not in {'underwriting-documents', 'underwriting-documents/classify', 'underwriting-documents/demo-complete'} | customer_forms(track) and await resolve_review_policy(session, case) is None:
                raise HTTPException(409, 'No proposal is linked to this application. Ask an admin to link the correct proposal before running underwriting checks.')
    except HTTPException as exc:
        return JSONResponse(status_code=exc.status_code, content={'detail': exc.detail})
    return await call_next(request)
