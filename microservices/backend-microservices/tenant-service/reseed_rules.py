import asyncio
from sqlmodel import select
from database import get_session
from shared.models.core import (
    ActualRule,
    Category,
    EligibilityProfile,
    RuleCriteria,
    RuleSet,
    RuleVersion,
    SubCategory,
)
from routers.rules import seed_rules_if_empty

async def reseed():
    async for session in get_session():
        # Delete children before parents: RuleCriteria -> ActualRule ->
        # RuleVersion -> RuleSet -> EligibilityProfile -> SubCategory ->
        # Category. seed_rules_if_empty() re-seeds from an empty Category
        # table, so everything must go for a clean reseed.
        try:
            print("Deleting existing rule engine hierarchy...")

            for model in (RuleCriteria, ActualRule, RuleVersion, RuleSet, EligibilityProfile, SubCategory, Category):
                rows = await session.exec(select(model))
                for row in rows:
                    await session.delete(row)
                await session.commit()

            print("Deleted successfully. Reseeding...")

            await seed_rules_if_empty(session)
            print("Reseed complete.")

        except Exception as e:
            print(f"Error: {e}")
            await session.rollback()

if __name__ == "__main__":
    asyncio.run(reseed())
