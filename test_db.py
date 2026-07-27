import asyncio
from uuid import UUID
from database import engine
from sqlmodel.ext.asyncio.session import AsyncSession
from sqlmodel import select
from shared.models.core import FamilyGroup, Organization

async def main():
    async with AsyncSession(engine) as session:
        fams = await session.exec(select(FamilyGroup))
        print("Fams:", len(fams.all()))
        orgs = await session.exec(select(Organization))
        print("Orgs:", len(orgs.all()))

asyncio.run(main())
