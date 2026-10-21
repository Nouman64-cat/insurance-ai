"""Read-only view of the protected checkpoint store (written only by the signer; mounted read-only into this service)."""
from pathlib import Path
from typing import Optional

from app.config import settings
from shared.audit.signer.errors import SignerError
from shared.audit.signer.files import ArchiveManifestStore, CheckpointStore


class TrustedStorage:
    def __init__(self, directory: Optional[str] = None):
        self.root = Path(directory or settings.checkpoint_directory)
        self.store = CheckpointStore(self.root)
        self.archive_store = ArchiveManifestStore(self.root)

    def available(self) -> bool:
        return self.root.is_dir()

    def numbers(self, environment_id: str, tenant_id: Optional[str]) -> list[int]:
        return self.store.numbers(environment_id, tenant_id)

    def read(self, environment_id: str, tenant_id: Optional[str], number: int) -> Optional[dict]:
        try:
            return self.store.read(environment_id, tenant_id, number)
        except SignerError:
            return {"unreadable": True}

    def relative_path(self, environment_id: str, tenant_id: Optional[str], number: int) -> str:
        return str(self.store.path(environment_id, tenant_id, number).relative_to(self.root.resolve()))

    # signed archive manifests (Stage 3), same protected root
    def archive_numbers(self, environment_id: str, tenant_id: Optional[str]) -> list[int]:
        return self.archive_store.numbers(environment_id, tenant_id)

    def read_archive(self, environment_id: str, tenant_id: Optional[str], number: int) -> Optional[dict]:
        try:
            return self.archive_store.read(environment_id, tenant_id, number)
        except SignerError:
            return {"unreadable": True}
