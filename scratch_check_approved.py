import asyncio
from sqlmodel.ext.asyncio.session import AsyncSession
from services.tenant_service.database import engine
from sqlalchemy import text

async def main():
    async with AsyncSession(engine) as session:
        result = await session.execute(text("SELECT id, status, customer_id FROM policies WHERE status = 'Approved' OR status = 'APPROVED'"))
        for row in result.all():
            print(row)

asyncio.run(main())
