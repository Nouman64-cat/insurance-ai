"""Stage 1 vs Stage 2, side by side, against real tampering. Safe to run any time: it builds its own disposable database,
signer, keys and protected store, and deletes them afterwards. It never touches the real audit ledger.

    docker compose exec -T audit-service python -m tests.demo_tamper

For each scenario it prints what the Stage 1 hash-chain check says and what the Stage 2 anchored check says.
"""
import asyncio
import json
import shutil
import tempfile
from pathlib import Path
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app import db
from app.checkpoints.storage import TrustedStorage
from app.services import audit_service, chain_verifier
from app.verification import integrity_verifier as iv
from shared.audit import hashing
from tests.signing_support import SignerHarness, override_settings
from tests.support import TestDatabase, intent


async def owner_tamper(owner, fn):
    """A database administrator: switches the append-only triggers off, edits, switches them back on."""
    async with owner.begin() as conn:
        for table in ("events", "chains", "checkpoints"):
            await conn.execute(text(f"ALTER TABLE {table} DISABLE TRIGGER USER"))
        await fn(conn)
        for table in ("events", "chains", "checkpoints"):
            await conn.execute(text(f"ALTER TABLE {table} ENABLE TRIGGER USER"))


async def rewrite_everything(conn, chain):
    rows = (await conn.execute(text("SELECT * FROM events WHERE chain_id = :c ORDER BY sequence_number"), {"c": chain})).mappings().all()
    previous = hashing.genesis_hash(chain)
    for row in rows:
        data = dict(row)
        if data["sequence_number"] == 3:
            data["new_value"] = {"status": "Rewritten by an attacker", "amount": 1}
        data["previous_hash"] = previous
        data["current_hash"] = hashing.compute_event_hash(chain, data["sequence_number"], previous, data)
        await conn.execute(text("UPDATE events SET new_value = CAST(:nv AS jsonb), previous_hash = :p, current_hash = :h WHERE event_id = :e"),
                           {"nv": json.dumps(data["new_value"]), "p": previous, "h": data["current_hash"], "e": data["event_id"]})
        previous = data["current_hash"]
    await conn.execute(text("UPDATE chains SET head_hash = :h WHERE chain_id = :c"), {"h": previous, "c": chain})


async def main() -> None:
    database = TestDatabase()
    await database.create()
    tmp = Path(tempfile.mkdtemp(prefix="audit-demo-"))
    owner = create_async_engine(database.owner_url, connect_args={"server_settings": {"search_path": "audit"}})
    db.configure(database.app_url)
    harness = SignerHarness(database, tmp)
    try:
        await harness.init()
        storage = TrustedStorage(str(harness.checkpoints_dir))
        with override_settings(checkpoint_directory=str(harness.checkpoints_dir), checkpoint_retry_base_seconds=0.0):
            env = await harness.service.source.environment_id()

            async def prepare() -> str:
                tenant = uuid4()
                await audit_service.ingest([intent(tenant, i) for i in range(10)])
                chain = f"{env}:{tenant}"
                assert (await harness.generator("demo").checkpoint_chain(chain)).status == "CREATED"
                return chain

            async def report(title: str, chain: str) -> None:
                stage1 = await chain_verifier.verify_chain(chain)
                stage2 = await iv.verify_anchored(chain, storage=storage)
                print(f"\n== {title}")
                print(f"   Stage 1 (hash chain only) : {stage1.status:8} {stage1.reason or ''}")
                print(f"   Stage 2 (signed anchors)  : {stage2.state}   " + ", ".join(sorted({f.code for f in stage2.findings})))

            clean = await prepare()
            await report("0. Untouched history", clean)

            chain = await prepare()
            async def edit(conn):
                await conn.execute(text("""UPDATE events SET new_value = '{"status": "Hacked"}'::jsonb WHERE chain_id = :c AND sequence_number = 3"""), {"c": chain})
            await owner_tamper(owner, edit)
            await report("1. One event edited in the database", chain)

            chain = await prepare()
            await owner_tamper(owner, lambda conn: rewrite_everything(conn, chain))
            await report("2. WHOLE chain rewritten consistently (every hash + the chain head recomputed)", chain)

            chain = await prepare()
            async def truncate(conn):
                await conn.execute(text("DELETE FROM events WHERE chain_id = :c AND sequence_number > 6"), {"c": chain})
                head = (await conn.execute(text("SELECT current_hash FROM events WHERE chain_id = :c AND sequence_number = 6"), {"c": chain})).scalar_one()
                await conn.execute(text("UPDATE chains SET head_sequence = 6, head_hash = :h WHERE chain_id = :c"), {"h": head, "c": chain})
            await owner_tamper(owner, truncate)
            await report("3. Latest events deleted and the chain head rolled back", chain)

            chain = await prepare()
            async def delete_checkpoint(conn):
                await conn.execute(text("DELETE FROM checkpoints WHERE chain_id = :c"), {"c": chain})
            await owner_tamper(owner, delete_checkpoint)
            await report("4. Signed checkpoint deleted from the database", chain)

            print("\nStage 1 trusts the database it is checking, so scenarios 2 and 3 pass it. Stage 2 compares against signed checkpoints "
                  "stored outside the database, which a database-only attacker cannot forge.")
    finally:
        await harness.close()
        await owner.dispose()
        await db.dispose()
        shutil.rmtree(tmp, ignore_errors=True)
        await database.drop()


if __name__ == "__main__":
    asyncio.run(main())
