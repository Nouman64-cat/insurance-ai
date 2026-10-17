import asyncio
from uuid import UUID
from sqlmodel import select
from database import engine, get_session
from shared.models.core import Policy, Case, PolicyStatusEnum
from sqlmodel.ext.asyncio.session import AsyncSession

async def main():
    async with AsyncSession(engine) as session:
        cases = (await session.exec(select(Case))).all()
        policies = (await session.exec(select(Policy))).all()
        print(f"Total Cases: {len(cases)}")
        for c in cases:
            print(f"Case {c.id}: status={c.status}")
            
        print(f"\nTotal Policies: {len(policies)}")
        for p in policies:
            print(f"Policy {p.id}: status={p.status}")

asyncio.run(main())
