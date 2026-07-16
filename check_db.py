import asyncio
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
import os

engine = create_async_engine(os.environ['DATABASE_URL'])

async def main():
    async with engine.connect() as conn:
        res = await conn.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name = 'policies'"))
        print([r[0] for r in res.fetchall()])

asyncio.run(main())
