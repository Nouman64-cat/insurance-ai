"""The model installer must verify downloads and work without the upstream host."""

import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError

from scripts import install_trufor as installer


def source_tar():
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        data = b"# pinned test source"
        member = tarfile.TarInfo("TruFor/test_docker/src/config.py")
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


class InstallerTests(unittest.TestCase):
    def test_checksum_verified_mirror_fallback(self):
        checkpoint = b"checkpoint-fixture"
        with tempfile.TemporaryDirectory() as directory, patch.object(
            installer.urllib.request, "urlopen",
            side_effect=[io.BytesIO(source_tar()), URLError("upstream offline"), io.BytesIO(checkpoint)],
        ) as fetch, patch.object(installer, "WEIGHTS_SHA256", hashlib.sha256(checkpoint).hexdigest()):
            installer.install(Path(directory))
            self.assertEqual((Path(directory) / "weights/trufor.pth.tar").read_bytes(), checkpoint)
            self.assertTrue((Path(directory) / "code/test_docker/src/config.py").exists())
            self.assertIn(installer.MIRROR_REVISION, fetch.call_args.args[0])
            self.assertTrue((Path(directory) / "UPSTREAM-LICENSE-NOTICE.txt").exists())

    def test_changed_mirror_checkpoint_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            installer.urllib.request, "urlopen",
            side_effect=[io.BytesIO(source_tar()), URLError("offline"), io.BytesIO(b"changed")],
        ):
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                installer.install(Path(directory))
            self.assertFalse((Path(directory) / "weights/trufor.pth.tar").exists())

    def test_bad_official_archive_is_rejected_without_fallback(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            installer.urllib.request, "urlopen", side_effect=[io.BytesIO(source_tar()), io.BytesIO(b"corrupt")],
        ) as fetch:
            with self.assertRaisesRegex(ValueError, "checksum does not match"):
                installer.install(Path(directory))
            self.assertEqual(fetch.call_count, 2)
