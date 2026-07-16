import asyncio
from sqlmodel.ext.asyncio.session import AsyncSession
from database import _session_factory
from shared.models.core import Customer, Policy

async def main():
    async with _session_factory() as db:
        print("Connected to DB")

if __name__ == "__main__":
    asyncio.run(main())
