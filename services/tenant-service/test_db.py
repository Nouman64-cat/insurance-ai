import asyncio
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

async def main():
    engine = create_async_engine("postgresql+asyncpg://postgres:1122@host.docker.internal:5432/insurance_ai")
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector;"))
        print("Success")

asyncio.run(main())
