import asyncio
from sqlmodel import select
from shared.models.core import Artifact, Case, Customer
from database import get_session
import uuid

async def test():
    async for session in get_session():
        cases = (await session.execute(select(Case).order_by(Case.createdAt.desc()).limit(1))).scalars().all()
        if not cases:
            print("No cases")
            return
        case = cases[0]
        print(f"Case: {case.caseld}")
        
        artifacts_stmt = select(Artifact).where(Artifact.customer_id == case.customer_id)
        arts = (await session.execute(artifacts_stmt)).scalars().all()
        print(f"Artifacts for {case.customer_id}: {[a.document_type for a in arts]}")
        break

if __name__ == "__main__":
    asyncio.run(test())
