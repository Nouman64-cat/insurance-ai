import asyncio
from sqlalchemy import text
from database import get_session

async def main():
    async for session in get_session():
        # Get IDs of families to delete
        res = await session.execute(text("SELECT id FROM family_groups WHERE name != 'Chaudhry Family'"))
        fam_ids = [row[0] for row in res]

        if fam_ids:
            for fid in fam_ids:
                # Delete dependent records
                await session.execute(text(f"DELETE FROM family_policies WHERE family_group_id = '{fid}'"))
                await session.execute(text(f"DELETE FROM customers WHERE family_group_id = '{fid}'"))
                await session.execute(text(f"DELETE FROM family_groups WHERE id = '{fid}'"))

        # Get IDs of organizations to delete
        res = await session.execute(text("SELECT id FROM organizations WHERE name != 'Meridian Textiles (Pvt) Ltd'"))
        org_ids = [row[0] for row in res]
        
        if org_ids:
            for oid in org_ids:
                await session.execute(text(f"DELETE FROM master_policies WHERE organization_id = '{oid}'"))
                await session.execute(text(f"DELETE FROM customers WHERE organization_id = '{oid}'"))
                await session.execute(text(f"DELETE FROM organizations WHERE id = '{oid}'"))
        
        await session.commit()
        print(f"Deleted {len(fam_ids)} families and {len(org_ids)} organizations.")

asyncio.run(main())
