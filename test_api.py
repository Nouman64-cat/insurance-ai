import asyncio
from httpx import AsyncClient
import uuid

async def main():
    async with AsyncClient() as client:
        # Assuming the API gateway is at localhost:8010 or tenant service at 8011
        # Let's get the list of policies first to find Sadia Noor's policy ID
        tenant_id = "197e64ed-6519-4d2b-bbf8-5d82c20f01af"
        res = await client.get(f"http://localhost:8011/tenants/{tenant_id}/policies")
        if res.status_code != 200:
            print("Failed to get policies", res.status_code)
            return
        policies = res.json()
        sadia_policy = next((p for p in policies if "Sadia" in p.get("customer_name", "")), None)
        if not sadia_policy:
            print("Sadia Noor policy not found")
            return
        
        pid = sadia_policy['id']
        print("Found policy ID:", pid)
        print("Status:", sadia_policy['status'])
        
        # Now let's try to issue it and see the EXACT error
        res = await client.post(f"http://localhost:8011/tenants/{tenant_id}/policies/{pid}/issue")
        print("Issue status:", res.status_code)
        print("Issue response:", res.text)

asyncio.run(main())
