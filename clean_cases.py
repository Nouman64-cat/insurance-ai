import asyncio
from sqlmodel import select
from shared.models.core import Case, Policy, Customer, FamilyGroup
from services.tenant_service.database import engine
from sqlmodel.ext.asyncio.session import AsyncSession
import os

async def main():
    async with AsyncSession(engine) as session:
        # Get all family groups
        result = await session.execute(select(FamilyGroup))
        families = result.scalars().all()
        
        for fam in families:
            print(f"Family: {fam.name} ({fam.id})")
            
            # Get members
            cust_res = await session.execute(
                select(Customer).where(Customer.family_group_id == fam.id)
            )
            customers = cust_res.scalars().all()
            
            for cust in customers:
                # Get cases
                case_res = await session.execute(
                    select(Case).where(Case.customer_id == cust.id).order_by(Case.createdAt.asc())
                )
                cases = case_res.scalars().all()
                if len(cases) > 1:
                    print(f"Customer {cust.name} ({cust.cnic}) has {len(cases)} cases!")
                    # keep the first one
                    keep = cases[0]
                    for drop in cases[1:]:
                        print(f"  Deleting case {drop.caseld}...")
                        await session.delete(drop)
                        
                        # also drop policy if needed? Policies are 1:1 with cases
                        # await session.delete(drop.policy)
            
        await session.commit()
        print("Done!")

if __name__ == '__main__':
    asyncio.run(main())
