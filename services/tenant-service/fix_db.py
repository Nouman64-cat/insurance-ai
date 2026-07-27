import asyncio
from database import get_session
from sqlalchemy import text

async def main():
    async for session in get_session():
        try:
            await session.exec(text("ALTER TYPE policystatusenum RENAME VALUE 'Active' TO 'ACTIVE';"))
            await session.exec(text("ALTER TYPE policystatusenum RENAME VALUE 'GracePeriod' TO 'GRACE_PERIOD';"))
            await session.exec(text("ALTER TYPE policystatusenum RENAME VALUE 'Cancelled' TO 'CANCELLED';"))
            await session.exec(text("ALTER TYPE policystatusenum RENAME VALUE 'AcceptedWithLoadings' TO 'ACCEPTED_WITH_LOADINGS';"))
            await session.commit()
            print("Successfully renamed enum values")
        except Exception as e:
            print("Error renaming enum:", e)
            await session.rollback()

if __name__ == "__main__":
    asyncio.run(main())
