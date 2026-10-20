"""The signer's own record of the last checkpoint it signed for each chain: the independently trusted anchor.

The signer does not take the previous checkpoint from the audit database (an attacker there could lie). It keeps its own
copy, and if that copy is lost it rebuilds it from the signed files in the protected store, verifying every signature.
"""
import asyncio
import hashlib
import json
from pathlib import Path
from typing import Optional

from shared.audit.signer.files import dumps, replace_atomic

try:
    import fcntl
except ImportError:  # pragma: no cover - the signer runs in a Linux container on every host OS
    fcntl = None  # type: ignore[assignment]


class SignerState:
    def __init__(self, directory: Path):
        self.directory = Path(directory) / "chains"
        self._locks: dict[str, asyncio.Lock] = {}

    def _stem(self, chain_id: str) -> str:
        return hashlib.sha256(chain_id.encode()).hexdigest()[:40]

    def load(self, chain_id: str) -> Optional[dict]:
        try:
            return json.loads((self.directory / f"{self._stem(chain_id)}.json").read_text("ascii"))
        except FileNotFoundError:
            return None

    def save(self, chain_id: str, record: dict) -> None:
        replace_atomic(self.directory / f"{self._stem(chain_id)}.json", dumps(record), mode=0o600, dir_mode=0o700)

    def lock(self, chain_id: str):
        """One signing operation per chain at a time: within this process (asyncio) and across processes (flock)."""
        return _ChainLock(self, chain_id)


class _ChainLock:
    def __init__(self, state: SignerState, chain_id: str):
        self.state, self.chain_id, self.handle = state, chain_id, None

    async def __aenter__(self):
        lock = self.state._locks.setdefault(self.chain_id, asyncio.Lock())
        await lock.acquire()
        self.lock = lock
        if fcntl is not None:
            self.state.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.handle = open(self.state.directory / f"{self.state._stem(self.chain_id)}.lock", "a")
            while True:
                try:
                    fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    await asyncio.sleep(0.05)
        return self

    async def __aexit__(self, *exc):
        if self.handle is not None:
            fcntl.flock(self.handle, fcntl.LOCK_UN)
            self.handle.close()
        self.lock.release()
