import asyncio
from sqlmodel import select
from database import engine
from shared.models.core import Policy, Case
from sqlmodel.ext.asyncio.session import AsyncSession

async def main():
    async with AsyncSession(engine) as session:
        cases = (await session.exec(select(Case))).all()
        policies = (await session.exec(select(Policy))).all()
        
        print(f"Total Cases: {len(cases)}")
        approved_cases = 0
        for c in cases:
            status = c.caseStatus.value if hasattr(c.caseStatus, 'value') else c.caseStatus
            if status == "Approved":
                approved_cases += 1
            # print(f"Case {c.caseld}: status={status} policy_id={c.policy_id}")
            
        print(f"Approved Cases: {approved_cases}")
            
        print(f"\nTotal Policies: {len(policies)}")
        approved_policies = 0
        for p in policies:
            status = p.status.value if hasattr(p.status, 'value') else p.status
            if status == "Approved" or status == "AcceptedWithLoadings":
                approved_policies += 1
            # print(f"Policy {p.id}: status={status}")
            
        print(f"Approved Policies: {approved_policies}")

asyncio.run(main())
