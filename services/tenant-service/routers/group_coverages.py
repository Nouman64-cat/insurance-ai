"""Benefits beyond Life on a group benefit class (GROUP_LIFE_PLAN.md Phase 6).

Every class carries Life at 100% of its base cover. This adds Accidental Death,
Disability, Pay Continuation and Fee Continuation to it — each a % of the member's
Life cover, optionally capped — which are priced into the quote at flat per-mille
rates (group_pricing.RIDER_RATES_PER_MILLE) and are the limit a claim under that
benefit is checked against (services/group_claims.py).

Editable until the employer accepts a quote. Changing one invalidates any open quote
(the premium moved), so it is superseded and the scheme goes back to "Proposed".
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from group_benefits import validate_coverage
from routers.organizations import _benefit_class_read, _get_master_policy
from routers.users import verify_admin
from schemas import BenefitClassRead, ClassCoverageCreate
from shared.models.core import GroupBenefitClass, GroupClassCoverage, GroupCoverageType, GroupQuote, GroupQuoteStatus

router = APIRouter(prefix="/tenants", tags=["Group Coverages"])

_EDITABLE = {"Pending", "Proposed", "Quoted", "Declined"}
_BASE = "/{tenant_id}/organizations/{org_id}/master-policies/{mp_id}/benefit-classes/{class_id}/coverages"


async def _class(session: AsyncSession, tenant_id: UUID, org_id: UUID, mp_id: UUID, class_id: UUID):
    mp = await _get_master_policy(tenant_id, org_id, mp_id, session)
    cls = await session.get(GroupBenefitClass, class_id)
    if cls is None or cls.master_policy_id != mp.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Benefit class not found.")
    if mp.status not in _EDITABLE:
        raise HTTPException(status.HTTP_409_CONFLICT, f"A {mp.status} scheme's benefits are fixed — the accepted quote priced them.")
    return mp, cls


async def _invalidate_quote(session: AsyncSession, mp) -> None:
    for q in (await session.exec(select(GroupQuote).where(GroupQuote.master_policy_id == mp.id, GroupQuote.status == GroupQuoteStatus.OPEN.value))).all():
        q.status = GroupQuoteStatus.SUPERSEDED.value
        session.add(q)
    if mp.status == "Quoted":
        mp.status = "Proposed"
        session.add(mp)


@router.post(_BASE, response_model=BenefitClassRead, status_code=status.HTTP_201_CREATED, dependencies=[Depends(verify_admin)])
async def add_class_coverage(tenant_id: UUID, org_id: UUID, mp_id: UUID, class_id: UUID, body: ClassCoverageCreate,
                             session: AsyncSession = Depends(get_session)):
    mp, cls = await _class(session, tenant_id, org_id, mp_id, class_id)
    errors = validate_coverage(body.model_dump())
    if errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, errors)
    existing = (await session.exec(select(GroupClassCoverage).where(
        GroupClassCoverage.benefit_class_id == cls.id, GroupClassCoverage.coverage_type == body.coverage_type))).first()
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{cls.name} already has {body.coverage_type} cover.")
    session.add(GroupClassCoverage(tenant_id=tenant_id, benefit_class_id=cls.id, coverage_type=body.coverage_type,
                                   percent_of_base=body.percent_of_base, max_amount=body.max_amount))
    await _invalidate_quote(session, mp)
    await session.commit()
    return await _benefit_class_read(cls, session)


@router.delete(_BASE + "/{coverage_id}", response_model=BenefitClassRead, dependencies=[Depends(verify_admin)])
async def remove_class_coverage(tenant_id: UUID, org_id: UUID, mp_id: UUID, class_id: UUID, coverage_id: UUID,
                                session: AsyncSession = Depends(get_session)):
    mp, cls = await _class(session, tenant_id, org_id, mp_id, class_id)
    row = await session.get(GroupClassCoverage, coverage_id)
    if row is None or row.benefit_class_id != cls.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Coverage not found on this class.")
    if row.coverage_type == GroupCoverageType.LIFE.value:
        raise HTTPException(status.HTTP_409_CONFLICT, "Life cover is part of every class and can't be removed.")
    await session.delete(row)
    await _invalidate_quote(session, mp)
    await session.commit()
    return await _benefit_class_read(cls, session)
