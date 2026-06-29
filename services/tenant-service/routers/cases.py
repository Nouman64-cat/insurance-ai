from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel.ext.asyncio.session import AsyncSession
from sqlmodel import select, delete
from typing import List
from uuid import UUID
from datetime import datetime

from database import get_session
from shared.models.core import (
    Case,
    CaseHistory,
    CaseAssignment,
    CaseComment,
    CaseStatusEnum,
    ActionTypeEnum,
    CaseAuditTrail,
    AssignmentTypeEnum,
    AssignmentStatusEnum,
    User,
)
from schemas import (
    CaseCreate,
    CaseRead,
    CaseUpdate,
    CaseStatusUpdate,
    CaseAssignmentCreate,
    CaseCommentCreate
)

router = APIRouter(prefix="/tenants/{tenant_id}/cases", tags=["Cases"])

def generate_case_number() -> str:
    # Auto-generate CaseNumber: e.g., CASE-YYYY-XXXXXX
    import uuid
    random_hex = uuid.uuid4().hex[:6].upper()
    return f"CASE-{datetime.utcnow().year}-{random_hex}"

@router.post("", response_model=CaseRead, status_code=201)
async def create_case(
    tenant_id: UUID,
    body: CaseCreate,
    session: AsyncSession = Depends(get_session),
):
    # Fetch a valid user to satisfy FK constraints for audit logs
    user = (await session.execute(select(User).where(User.tenant_id == tenant_id))).scalars().first()
    if not user:
        raise HTTPException(status_code=400, detail="Tenant has no users to perform this action.")

    case = Case(
        tenant_id=tenant_id,
        applicant_id=body.applicant_id,
        caseNumber=generate_case_number(),
        caseType=body.caseType,
        caseStatus=CaseStatusEnum.NEW,
        priorityLevel=body.priorityLevel,
        sourceChannel=body.sourceChannel,
        assignedTeamld=body.assignedTeamld,
        assignedAgentId=body.assignedAgentId,
        createdAt=datetime.utcnow(),
        updatedAt=datetime.utcnow()
    )
    session.add(case)
    await session.commit()
    await session.refresh(case)

    # Generate Audit Trail
    audit = CaseAuditTrail(
        caseld=case.caseld,
        actionPerformed="Created new case",
        entityChanged="Case",
        newValue=case.caseStatus,
        performedBy=user.id,
        timestamp=datetime.utcnow()
    )
    session.add(audit)
    await session.commit()

    return case


@router.get("", response_model=List[CaseRead])
async def list_cases(
    tenant_id: UUID,
    applicant_id: UUID = Query(None, description="Filter by applicant"),
    status: CaseStatusEnum = Query(None, description="Filter by status"),
    assigned_user: UUID = Query(None, description="Filter by assignee"),
    session: AsyncSession = Depends(get_session)
):
    stmt = select(Case).where(Case.tenant_id == tenant_id)
    if applicant_id:
        stmt = stmt.where(Case.applicant_id == applicant_id)
    if status:
        stmt = stmt.where(Case.caseStatus == status)
    if assigned_user:
        stmt = stmt.where(Case.assignedAgentId == assigned_user)
    
    result = await session.execute(stmt)
    return result.scalars().all()


@router.get("/{case_id}", response_model=CaseRead)
async def get_case(tenant_id: UUID, case_id: UUID, session: AsyncSession = Depends(get_session)):
    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    result = await session.execute(stmt)
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    return case


@router.put("/{case_id}", response_model=CaseRead)
async def update_case(
    tenant_id: UUID,
    case_id: UUID,
    body: CaseUpdate,
    session: AsyncSession = Depends(get_session)
):
    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    result = await session.execute(stmt)
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    
    update_data = body.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(case, key, value)
        
    case.updatedAt = datetime.utcnow()
    session.add(case)
    await session.commit()
    await session.refresh(case)
    return case


@router.delete("/{case_id}", status_code=204)
async def delete_case(
    tenant_id: UUID,
    case_id: UUID,
    session: AsyncSession = Depends(get_session)
):
    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    result = await session.execute(stmt)
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    
    # Delete all child dependencies manually to avoid NotNullViolationError
    await session.execute(delete(CaseHistory).where(CaseHistory.caseld == case_id))
    await session.execute(delete(CaseAuditTrail).where(CaseAuditTrail.caseld == case_id))
    await session.execute(delete(CaseComment).where(CaseComment.caseld == case_id))
    await session.execute(delete(CaseAssignment).where(CaseAssignment.caseld == case_id))
    
    await session.delete(case)
    await session.commit()
    return None


@router.patch("/{case_id}/status", response_model=CaseRead)
async def update_case_status(
    tenant_id: UUID,
    case_id: UUID,
    body: CaseStatusUpdate,
    session: AsyncSession = Depends(get_session)
):
    user = (await session.execute(select(User).where(User.tenant_id == tenant_id))).scalars().first()
    if not user:
        raise HTTPException(status_code=400, detail="Tenant has no users.")

    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    result = await session.execute(stmt)
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    
    old_status = case.caseStatus
    case.caseStatus = body.status
    case.updatedAt = datetime.utcnow()
    
    history = CaseHistory(
        caseld=case.caseld,
        actionType=ActionTypeEnum.STATUS_CHANGE,
        fromStatus=old_status,
        toStatus=case.caseStatus,
        changedBy=user.id,
        changeTimestamp=datetime.utcnow()
    )
    session.add(history)
    session.add(case)
    await session.commit()
    await session.refresh(case)
    
    return case


@router.post("/{case_id}/assignments", status_code=201)
async def assign_case(
    tenant_id: UUID,
    case_id: UUID,
    body: CaseAssignmentCreate,
    session: AsyncSession = Depends(get_session)
):
    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    result = await session.execute(stmt)
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    
    case.assignedAgentId = body.assignedToUserld
    case.updatedAt = datetime.utcnow()

    assignment = CaseAssignment(
        caseld=case.caseld,
        assignedToUserld=body.assignedToUserld,
        assignedRole=body.assignedRole,
        assignmentType=AssignmentTypeEnum.PRIMARY,
        assignmentStatus=AssignmentStatusEnum.ACTIVE,
        assignedAt=datetime.utcnow()
    )
    session.add(assignment)
    session.add(case)
    await session.commit()
    
    return {"status": "assigned"}


@router.post("/{case_id}/comments", status_code=201)
async def add_case_comment(
    tenant_id: UUID,
    case_id: UUID,
    body: CaseCommentCreate,
    session: AsyncSession = Depends(get_session)
):
    user = (await session.execute(select(User).where(User.tenant_id == tenant_id))).scalars().first()
    if not user:
        raise HTTPException(status_code=400, detail="Tenant has no users.")

    stmt = select(Case).where(Case.tenant_id == tenant_id, Case.caseld == case_id)
    result = await session.execute(stmt)
    case = result.scalar_one_or_none()
    if not case:
        raise HTTPException(status_code=404, detail="Case not found")
    
    comment = CaseComment(
        caseld=case.caseld,
        authorld=user.id,
        commentText=body.commentText,
        commentType=body.commentType,
        visibilityLevel=body.visibilityLevel,
        createdAt=datetime.utcnow()
    )
    session.add(comment)
    await session.commit()
    
    return {"status": "comment added"}
