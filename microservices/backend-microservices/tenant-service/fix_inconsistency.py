import asyncio
from database import engine
from sqlalchemy import text
from sqlmodel.ext.asyncio.session import AsyncSession
from shared.models.core import PolicyStatusEnum

async def main():
    async with AsyncSession(engine) as session:
        # Find all APPROVED cases
        result = await session.execute(text("SELECT caseld, customer_id, policy_id FROM cases WHERE \"caseStatus\" = 'APPROVED'"))
        cases = result.all()
        
        for case in cases:
            case_id, customer_id, policy_id = case
            
            # Find the most recent policy for this customer
            p_res = await session.execute(text(f"SELECT id, status FROM policies WHERE customer_id = '{customer_id}' ORDER BY created_at DESC LIMIT 1"))
            policy = p_res.first()
            
            if not policy:
                print(f"Case {case_id}: No policy found! Closing case.")
                await session.execute(text(f"UPDATE cases SET \"caseStatus\" = 'CLOSED' WHERE caseld = '{case_id}'"))
                continue
                
            p_id, p_status = policy
            
            if p_status.upper() in ('ACTIVE', 'ISSUED'):
                print(f"Case {case_id}: Policy {p_id} is already {p_status}. Closing case.")
                await session.execute(text(f"UPDATE cases SET \"caseStatus\" = 'CLOSED' WHERE caseld = '{case_id}'"))
            elif p_status.upper() == 'QUOTED':
                print(f"Case {case_id}: Policy {p_id} is QUOTED. Updating policy to APPROVED.")
                await session.execute(text(f"UPDATE policies SET status = 'APPROVED' WHERE id = '{p_id}'"))
            else:
                print(f"Case {case_id}: Policy {p_id} is {p_status}. Leaving as is.")
                
        await session.commit()
        print("Done fixing inconsistency.")

asyncio.run(main())
