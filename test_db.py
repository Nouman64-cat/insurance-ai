import asyncio
from uuid import UUID
from database import get_session
from shared.models.core import Policy, PolicyStatusEnum
from sqlmodel import select
from sqlalchemy import cast
from sqlalchemy.dialects.postgresql import ENUM

async def main():
    async for session in get_session():
        res = await session.exec(select(Policy).limit(1))
        policy = res.first()
        if not policy:
            print("No policy found")
            return
        
        try:
            # what if we assign the raw value via an update?
            await session.exec(
                "UPDATE policies SET status='Active' WHERE id='{}'".format(policy.id)
            )
            await session.commit()
            print("Successfully saved via raw SQL")
        except Exception as e:
            print("Failed:", e)

if __name__ == "__main__":
    asyncio.run(main())
