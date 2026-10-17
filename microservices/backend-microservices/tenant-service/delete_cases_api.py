import asyncio
import os
import httpx
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text
from sqlmodel.ext.asyncio.session import AsyncSession

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql+asyncpg://postgres:postgres@localhost:5432/insurance_ai")
engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

async def main():
    async with AsyncSessionLocal() as session:
        result = await session.execute(text("""
            SELECT "caseld", customer_id, "caseNumber", tenant_id
            FROM "cases"
            WHERE "caseNumber" IN ('CASE-2026-341A19', 'CASE-2026-331E4C', 'CASE-2026-27D3C2')
        """))
        cases_to_keep = result.fetchall()
        
        customer_ids = [str(r.customer_id) for r in cases_to_keep]
        keep_caselds = [str(r.caseld) for r in cases_to_keep]
        tenant_id = str(cases_to_keep[0].tenant_id)

        result = await session.execute(text(f"""
            SELECT "caseld", "caseNumber" 
            FROM "cases" 
            WHERE customer_id IN ('{customer_ids[0]}', '{customer_ids[1]}', '{customer_ids[2]}')
              AND "caseld" NOT IN ('{keep_caselds[0]}', '{keep_caselds[1]}', '{keep_caselds[2]}')
        """))
        to_delete = result.fetchall()
        
    async with httpx.AsyncClient() as client:
        for row in to_delete:
            print(f"Deleting via API: {row.caseNumber} ({row.caseld})")
            resp = await client.delete(f"http://localhost:8001/tenants/{tenant_id}/cases/{row.caseld}")
            print(resp.status_code)
            
asyncio.run(main())
