import asyncio
from database import get_session
from sqlalchemy import text

async def main():
    async for session in get_session():
        res = await session.exec(text("SELECT enumlabel FROM pg_enum WHERE enumtypid = 'policystatusenum'::regtype;"))
        print("DB ENUM LABELS:", res.all())

if __name__ == "__main__":
    asyncio.run(main())
