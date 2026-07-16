import asyncio
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
import os

engine = create_async_engine(os.environ['DATABASE_URL'])

async def main():
    async with engine.connect() as conn:
        res = await conn.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"))
        print([r[0] for r in res.fetchall()])

asyncio.run(main())
