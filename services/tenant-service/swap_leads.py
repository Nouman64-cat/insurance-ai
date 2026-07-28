import asyncio
from sqlalchemy import text
from database import get_session

async def main():
    async for session in get_session():
        hina_id = '4e86bb4b-66f4-43f2-af59-062d0cb15bce'
        tenant_id = '18e5aa3d-755c-44c6-ab2d-ae05ed80a964' # default tenant id, we can query it

        res = await session.execute(text(f"SELECT tenant_id FROM customers WHERE id = '{hina_id}'"))
        row = res.first()
        if not row:
            print("Hina not found.")
        else:
            tenant_id = row[0]
            
            # Delete dependent records manually using SQL
            # Policy events
            await session.execute(text(f"""
                DELETE FROM policy_events 
                WHERE policy_id IN (SELECT id FROM policies WHERE customer_id = '{hina_id}')
            """))
            # Any other policy dependents (premium_quotes, premium_schedules, renewal_transactions, policy_documents, policy_versions)
            await session.execute(text(f"DELETE FROM premium_quotes WHERE policy_id IN (SELECT id FROM policies WHERE customer_id = '{hina_id}')"))
            await session.execute(text(f"DELETE FROM premium_schedules WHERE policy_id IN (SELECT id FROM policies WHERE customer_id = '{hina_id}')"))
            await session.execute(text(f"DELETE FROM renewal_transactions WHERE policy_id IN (SELECT id FROM policies WHERE customer_id = '{hina_id}')"))
            await session.execute(text(f"DELETE FROM policy_documents WHERE policy_id IN (SELECT id FROM policies WHERE customer_id = '{hina_id}')"))
            await session.execute(text(f"DELETE FROM policy_versions WHERE policy_id IN (SELECT id FROM policies WHERE customer_id = '{hina_id}')"))

            # Policies
            await session.execute(text(f"DELETE FROM policies WHERE customer_id = '{hina_id}'"))
            
            # Cases & Risk Assessments
            await session.execute(text(f"DELETE FROM risk_assessments WHERE customer_id = '{hina_id}'"))
            await session.execute(text(f"DELETE FROM artifacts WHERE customer_id = '{hina_id}'"))
            await session.execute(text(f"DELETE FROM cases WHERE customer_id = '{hina_id}'"))

            # Finally, the customer
            await session.execute(text(f"DELETE FROM customers WHERE id = '{hina_id}'"))
            print("Deleted Hina Tariq")

        # Insert ALi Family Group
        # check if it exists already
        res = await session.execute(text(f"SELECT id FROM family_groups WHERE name = 'ALi' AND tenant_id = '{tenant_id}'"))
        if res.first():
            print("ALi already exists.")
        else:
            # We need an id and created_at
            import uuid
            from datetime import datetime
            new_id = str(uuid.uuid4())
            now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
            await session.execute(text(f"""
                INSERT INTO family_groups (id, tenant_id, name, profile_status, created_at) 
                VALUES ('{new_id}', '{tenant_id}', 'ALi', 'LEAD', '{now}')
            """))
            print("Added ALi family lead.")
            
        await session.commit()

asyncio.run(main())
