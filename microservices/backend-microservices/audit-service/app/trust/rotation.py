"""Administrator-controlled key rotation.

Only a platform administrator can ask (the API route is SuperAdmin-only); the signer authorises the new key with the
current one, so the new key is trusted through a signed statement, not because someone inserted a row. Old public keys stay
in the registry, so every older checkpoint still verifies against the key that signed it.
"""
from app import db
from app.signing.interface import CheckpointSigner
from app.trust import key_registry


async def rotate_signing_key(signer: CheckpointSigner, requested_by: str) -> dict:
    new_key = await signer.rotate()
    registry = key_registry.load_registry(new_key["environment_id"])
    async with db.transaction() as conn:
        await key_registry.sync_to_db(conn, registry)
        from app.checkpoints import repository
        await repository.add_alert(conn, None, None, "KEY_ROTATED", "INFO", f"Signing key rotated to {new_key['key_id']} by {requested_by}",
                                   {"key_id": new_key["key_id"], "fingerprint": new_key["fingerprint"]})
    return new_key
