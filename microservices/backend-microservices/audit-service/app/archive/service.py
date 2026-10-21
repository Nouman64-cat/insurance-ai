"""Wiring: builds the archive services from settings (used by main.py, the CLI and the tests)."""
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from app.archive import crypto
from app.archive.cleanup import CleanupService
from app.archive.retrieval import RetrievalService
from app.archive.store import ObjectStore, S3Store
from app.archive.verify import ArchiveVerifier
from app.archive.worker import ArchiveWorker
from app.checkpoints.storage import TrustedStorage
from app.config import Settings

log = logging.getLogger("audit.archive")


@dataclass
class ArchiveServices:
    worker: ArchiveWorker
    cleanup: CleanupService
    retrieval: RetrievalService
    verifier: ArchiveVerifier
    writer: ObjectStore
    reader: ObjectStore
    keyring: crypto.KeyRing
    storage: TrustedStorage


def guard_test_mode(config: Settings) -> None:
    if config.archive_test_mode and config.environment_label != "local-dev":
        raise RuntimeError("AUDIT_ARCHIVE_TEST_MODE shortens the hot window to seconds and is allowed only when AUDIT_ENVIRONMENT_LABEL=local-dev")


def build(config: Settings, signer, instance_id: str, *, writer: Optional[ObjectStore] = None, reader: Optional[ObjectStore] = None,
          storage: Optional[TrustedStorage] = None, keyring: Optional[crypto.KeyRing] = None, work_dir: Optional[Path] = None, clock=None) -> ArchiveServices:
    guard_test_mode(config)
    if config.archive_storage_provider != "minio":
        raise RuntimeError(f"unknown AUDIT_ARCHIVE_STORAGE_PROVIDER {config.archive_storage_provider!r}; only 'minio' (any S3-compatible server) is implemented")
    writer = writer or S3Store(config, "writer")
    reader = reader or S3Store(config, "reader")
    keyring = keyring or crypto.KeyRing(config.key_directory)
    storage = storage or TrustedStorage(config.checkpoint_directory)
    extra = {"clock": clock} if clock else {}
    worker = ArchiveWorker(signer, writer, reader, keyring, instance_id, config=config, storage=storage, work_dir=work_dir, **extra)
    return ArchiveServices(worker, CleanupService(worker.verifier, config=config, **extra),
                           RetrievalService(reader, keyring, worker.verifier, instance_id, config=config, **extra), worker.verifier, writer, reader, keyring, storage)
