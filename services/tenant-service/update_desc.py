import asyncio
from sqlmodel.ext.asyncio.session import AsyncSession
from database import engine
from sqlmodel import select
from shared.models.core import RuleSet

async def update_desc():
    async with AsyncSession(engine) as session:
        result = await session.exec(select(RuleSet).where(RuleSet.rule_code == "underwriting.six_gates"))
        rule_set = result.first()
        if rule_set:
            rule_set.description = ""
            session.add(rule_set)
            await session.commit()
            print("Successfully updated description.")
        else:
            print("RuleSet not found.")

if __name__ == "__main__":
    asyncio.run(update_desc())
