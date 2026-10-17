import asyncio
from sqlmodel.ext.asyncio.session import AsyncSession
from database import engine
from sqlalchemy import text
from datetime import datetime, timedelta, date

async def main():
    async with AsyncSession(engine) as session:
        # Find active policy using raw SQL
        result = await session.execute(text("SELECT id, policy_number, expiry_date FROM policies WHERE status = 'ACTIVE'"))
        policy = result.first()
        if not policy:
            print("No active policies found.")
            return

        print(f"Found active policy: {policy.policy_number} (Expiry: {policy.expiry_date})")

        # Time travel: set the expiry date to 15 days from today
        today = date.today()
        new_expiry = today + timedelta(days=15)
        new_grace = new_expiry + timedelta(days=30)
        
        # We use raw SQL to avoid the SQLModel Enum casting mismatch
        await session.execute(
            text("UPDATE policies SET expiry_date = :expiry, grace_period_end_date = :grace WHERE status = 'ACTIVE'"),
            {"expiry": new_expiry, "grace": new_grace}
        )
        await session.commit()

        print(f"Time travel complete! New expiry date: {new_expiry}")

asyncio.run(main())
