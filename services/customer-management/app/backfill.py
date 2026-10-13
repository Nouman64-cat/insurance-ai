"""Import the accounts the original post-issuance flow already issued.

    python -m app.backfill            # import
    python -m app.backfill --dry-run  # report only

Reads tenant-service's signed /legacy-accounts export (bcrypt hashes only) and creates the missing accounts here.
Idempotent: accounts that already exist are skipped, never overwritten, so it is safe to repeat and safe to run while
customers are signing in. Hashes are never printed."""
import asyncio
import logging
import sys
from collections import Counter

from app import accounts, db, tenant_client

log = logging.getLogger("customer-management.backfill")


async def run(dry_run: bool = False) -> Counter:
    client = tenant_client.get_client()
    result: Counter = Counter()
    offset, page = 0, 200
    while True:
        rows = await client.legacy_accounts(offset, page)
        for row in rows:
            if dry_run:
                result["would_import"] += 1
                continue
            async with db.transaction() as conn:
                result[await accounts.import_legacy(conn, row)] += 1
        if len(rows) < page:
            return result
        offset += page


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    summary = asyncio.run(run("--dry-run" in sys.argv))
    print(dict(summary) or "nothing to import")
