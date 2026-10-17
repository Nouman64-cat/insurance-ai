import asyncio
from sqlalchemy.ext.asyncio import create_async_engine

DATABASE_URL = "postgresql+asyncpg://postgres:1122@host.docker.internal:5432/insurance_ai"

async def main():
    engine = create_async_engine(DATABASE_URL)
    async with engine.begin() as conn:
        from sqlalchemy import text
        await conn.execute(text("ALTER TABLE agent_confidential_reports ADD COLUMN IF NOT EXISTS terms_explained_to_proposer BOOLEAN;"))
        await conn.execute(text("ALTER TABLE agent_confidential_reports ADD COLUMN IF NOT EXISTS identity_verified_kyc BOOLEAN;"))
        await conn.execute(text("ALTER TABLE agent_confidential_reports ADD COLUMN IF NOT EXISTS signature_obtained_in_presence BOOLEAN;"))
    await engine.dispose()
    print("Columns added successfully")

asyncio.run(main())
