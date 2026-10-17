import asyncio
import os
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text
from sqlmodel.ext.asyncio.session import AsyncSession

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql+asyncpg://postgres:postgres@localhost:5432/insurance_ai")
engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

async def main():
    async with AsyncSessionLocal() as session:
        # Get cases for the family
        result = await session.execute(text("""
            SELECT c."caseld", c."caseNumber", c.customer_id, c."createdAt", p.product_name 
            FROM "cases" c 
            LEFT JOIN policies p ON c.policy_id = p.id
            ORDER BY c."createdAt" DESC
        """))
        rows = result.fetchall()
        print(f"Total cases: {len(rows)}")
        for row in rows:
            print(row)

asyncio.run(main())
