import asyncio
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text
import json

engine = create_async_engine("postgresql+asyncpg://postgres:postgres@localhost:5432/insurance_ai_tenant")
async_session = sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

async def main():
    async with async_session() as session:
        # Get Zara Siddiqi's latest quote
        res = await session.execute(text("SELECT id, tenant_id FROM premiumquote ORDER BY created_at DESC LIMIT 1"))
        quote = res.fetchone()
        if not quote:
            print("No quotes")
            return
        quote_id, tenant_id = quote[0], quote[1]
        
        print(f"Tenant: {tenant_id}, Quote: {quote_id}")

if __name__ == "__main__":
    asyncio.run(main())
