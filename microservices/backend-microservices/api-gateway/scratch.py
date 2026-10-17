import asyncio
from sqlmodel.ext.asyncio.session import AsyncSession
from database import _session_factory
from shared.models.core import Case, Customer, Policy
from sqlmodel import select

async def main():
    async with _session_factory() as db:
        cases = (await db.exec(select(Case))).all()
        if cases:
            c = cases[-1]
            print(f"Case ID: {c.caseld}")
            customer = await db.get(Customer, c.customer_id)
            print(f"Customer dict: {customer.model_dump() if customer else None}")
            policy = (await db.exec(select(Policy).where(Policy.customer_id == c.customer_id))).first()
            print(f"Policy dict: {policy.model_dump() if policy else None}")

asyncio.run(main())
