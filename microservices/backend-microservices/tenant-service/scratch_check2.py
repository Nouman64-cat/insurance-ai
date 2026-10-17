import asyncio
from sqlmodel import select
from database import engine
from shared.models.core import Policy, Case
from sqlmodel.ext.asyncio.session import AsyncSession

async def main():
    async with AsyncSession(engine) as session:
        cases = (await session.exec(select(Case))).all()
        policies = (await session.exec(select(Policy))).all()
        
        for p in policies:
            status = p.status.value if hasattr(p.status, 'value') else p.status
            if status in ("Approved", "AcceptedWithLoadings", "PendingPayment", "Issued"):
                print(f"Policy {p.id}: tenant={p.tenant_id} customer={p.customer_id} status={status}")

asyncio.run(main())
