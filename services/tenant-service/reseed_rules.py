import asyncio
from sqlmodel import select
from database import get_session
from shared.models.core import RuleSet, RuleVersion, BusinessRule, RuleEvaluationLog
from routers.rules import seed_rules_if_empty

async def reseed():
    async for session in get_session():
        # delete logs since they fk constraint on ruleset code/version
        # Wait, if rule sets are deleted, logs might need to be dropped or cascaded
        try:
            print("Deleting existing rule sets and rules...")
            
            rules = await session.exec(select(BusinessRule))
            for rule in rules:
                await session.delete(rule)
                
            versions = await session.exec(select(RuleVersion))
            for version in versions:
                await session.delete(version)
                
            sets = await session.exec(select(RuleSet))
            for rs in sets:
                await session.delete(rs)
                
            await session.commit()
            print("Deleted successfully. Reseeding...")
            
            await seed_rules_if_empty(session)
            print("Reseed complete.")
            
        except Exception as e:
            print(f"Error: {e}")
            await session.rollback()

if __name__ == "__main__":
    asyncio.run(reseed())
