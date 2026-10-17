import asyncio
from uuid import UUID
from database import get_session
from shared.models.core import Policy, PolicyStatusEnum
from sqlmodel import select

async def main():
    async for session in get_session():
        # find a policy
        res = await session.exec(select(Policy).limit(1))
        policy = res.first()
        if not policy:
            print("No policy found")
            return
        
        print("Current status:", policy.status)
        try:
            policy.status = "Active"
            session.add(policy)
            await session.commit()
            print("Successfully saved 'Active' as string")
        except Exception as e:
            print("Failed to save 'Active' as string:", e)
            await session.rollback()
            
        try:
            policy.status = PolicyStatusEnum.ACTIVE
            session.add(policy)
            await session.commit()
            print("Successfully saved PolicyStatusEnum.ACTIVE")
        except Exception as e:
            print("Failed to save PolicyStatusEnum.ACTIVE:", e)
            await session.rollback()

if __name__ == "__main__":
    asyncio.run(main())
