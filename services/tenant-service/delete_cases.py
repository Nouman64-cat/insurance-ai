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
        # Get cases to keep
        result = await session.execute(text("""
            SELECT "caseld", customer_id, "caseNumber"
            FROM "cases"
            WHERE "caseNumber" IN ('CASE-2026-341A19', 'CASE-2026-331E4C', 'CASE-2026-27D3C2')
        """))
        cases_to_keep = result.fetchall()
        print(f"Cases to keep: {cases_to_keep}")

        customer_ids = [str(r.customer_id) for r in cases_to_keep]
        keep_caselds = [str(r.caseld) for r in cases_to_keep]

        if not customer_ids:
            print("Could not find customer IDs.")
            return

        # Find all other cases for these customers
        result = await session.execute(text(f"""
            SELECT "caseld", "caseNumber" 
            FROM "cases" 
            WHERE customer_id IN ('{customer_ids[0]}', '{customer_ids[1]}', '{customer_ids[2]}')
              AND "caseld" NOT IN ('{keep_caselds[0]}', '{keep_caselds[1]}', '{keep_caselds[2]}')
        """))
        to_delete = result.fetchall()
        print(f"Found {len(to_delete)} duplicate cases to delete.")

        for row in to_delete:
            caseld = row.caseld
            print(f"Deleting case {row.caseNumber}...")
            # delete dependencies first
            await session.execute(text(f"DELETE FROM case_history WHERE caseld = '{caseld}'"))
            await session.execute(text(f"DELETE FROM case_audit_trail WHERE caseld = '{caseld}'"))
            await session.execute(text(f"DELETE FROM case_assignments WHERE caseld = '{caseld}'"))
            await session.execute(text(f"DELETE FROM case_comments WHERE caseld = '{caseld}'"))
            await session.execute(text(f"DELETE FROM risk_assessments WHERE case_id = '{caseld}'"))
            await session.execute(text(f"DELETE FROM artifacts WHERE case_id = '{caseld}'"))
            await session.execute(text(f"DELETE FROM cases WHERE caseld = '{caseld}'"))

        await session.commit()
        print("Done.")

asyncio.run(main())
