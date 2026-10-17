import asyncio
from database import engine
from sqlmodel.ext.asyncio.session import AsyncSession
from sqlalchemy import text

async def main():
    async with AsyncSession(engine, expire_on_commit=False) as session:
        # First, find duplicates using SQL
        query = """
        WITH RankedCases AS (
            SELECT
                caseld,
                customer_id,
                ROW_NUMBER() OVER(PARTITION BY customer_id ORDER BY "createdAt" ASC) as rn
            FROM cases
        )
        SELECT caseld, customer_id
        FROM RankedCases
        WHERE rn > 1
        """
        
        result = await session.execute(text(query))
        rows = result.fetchall()
        
        for row in rows:
            cid = row[0]
            print(f"Deleting duplicate case {cid}")
            
            await session.execute(
                text("DELETE FROM risk_assessments WHERE case_id = :case_id"),
                {"case_id": cid}
            )
            await session.execute(
                text("DELETE FROM artifacts WHERE case_id = :case_id"),
                {"case_id": cid}
            )
            await session.execute(
                text('DELETE FROM case_histories WHERE "caseld" = :case_id'),
                {"case_id": cid}
            )
            await session.execute(
                text('DELETE FROM cases WHERE "caseld" = :case_id'),
                {"case_id": cid}
            )
        
        await session.commit()
        print("Done!")

if __name__ == '__main__':
    asyncio.run(main())
