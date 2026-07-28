import asyncio
from sqlalchemy import text
from database import get_session

async def main():
    async for session in get_session():
        res1 = await session.execute(text("SELECT id, name FROM customers WHERE name ILIKE '%Hina%'"))
        print("Customers:")
        for r in res1: print(r)
        
        res2 = await session.execute(text("SELECT id, name FROM family_groups WHERE name ILIKE '%Hina%'"))
        print("Family Groups:")
        for r in res2: print(r)

asyncio.run(main())
