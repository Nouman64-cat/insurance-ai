import asyncio
from sqlmodel import select
from database import engine
from shared.models.core import Policy, Case, CaseStatusEnum, PolicyStatusEnum
from sqlmodel.ext.asyncio.session import AsyncSession

async def main():
    async with AsyncSession(engine) as session:
        cases = (await session.exec(select(Case).where(Case.caseStatus == CaseStatusEnum.APPROVED))).all()
        
        for case in cases:
            policy_to_update = None
            if case.policy_id:
                policy_to_update = await session.get(Policy, case.policy_id)
            if not policy_to_update:
                policy_stmt = (
                    select(Policy)
                    .where(Policy.tenant_id == case.tenant_id, Policy.customer_id == case.customer_id)
                    .order_by(Policy.created_at.desc())
                )
                policy_to_update = (await session.execute(policy_stmt)).scalars().first()

            if policy_to_update:
                if policy_to_update.status != PolicyStatusEnum.APPROVED and policy_to_update.status != PolicyStatusEnum.ACCEPTED_WITH_LOADINGS and policy_to_update.status != PolicyStatusEnum.ISSUED:
                    print(f"Fixing Policy {policy_to_update.id} for Case {case.caseld}")
                    policy_to_update.status = PolicyStatusEnum.APPROVED
                    session.add(policy_to_update)
                    
        await session.commit()
        print("Done fixing stuck policies.")

asyncio.run(main())
