"""Fetch pinned upstream inference code and checksum-verified official weights."""

import hashlib
import io
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import urllib.error
import zipfile

REVISION = "ae54475df6f41a491d7615100feb19263dec13f7"
CODE_URL = f"https://codeload.github.com/grip-unina/TruFor/tar.gz/{REVISION}"
WEIGHTS_URL = "https://www.grip.unina.it/download/prog/TruFor/TruFor_weights.zip"
# Published in upstream test_docker/README.md. Reject damaged or changed archives.
WEIGHTS_MD5 = "7bee48f3476c75616c3c5721ab256ff8"
MIRROR_REVISION = "1eb63112bc3219694c93dc5a8b826e2593bbc8a0"
MIRROR_URL = f"https://huggingface.co/spaces/jatin-tech/Tru_Image_Classifier/resolve/{MIRROR_REVISION}/weights/trufor.pth.tar"
WEIGHTS_SHA256 = "ac1d90e329a72e0d66e8665e123a19e94bfae3209c3ef8a4f9ca3b91578c7844"


def install(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    print(f"Downloading TruFor source at {REVISION}", flush=True)
    with urllib.request.urlopen(CODE_URL, timeout=120) as response:
        archive = response.read()
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as source:
        for member in source.getmembers():
            relative = Path(*Path(member.name).parts[1:])
            if not member.isfile() or relative.parts[:2] != ("test_docker", "src"):
                continue
            target = destination / "code" / relative
            if not target.resolve().is_relative_to(destination.resolve()):
                raise ValueError("Unsafe source archive path")
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as src, target.open("wb") as out:
                shutil.copyfileobj(src, out)
    print("Downloading official TruFor weights (first build only)", flush=True)
    with tempfile.TemporaryFile() as downloaded:
        digest = hashlib.md5(usedforsecurity=False)
        try:
            with urllib.request.urlopen(WEIGHTS_URL, timeout=20) as response:
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                    downloaded.write(chunk)
        except (urllib.error.URLError, TimeoutError, OSError):
            print("Upstream weights server unavailable; using pinned, SHA-256 verified mirror", flush=True)
            downloaded.seek(0)
            downloaded.truncate()
            sha256 = hashlib.sha256()
            with urllib.request.urlopen(MIRROR_URL, timeout=120) as response:
                while chunk := response.read(1024 * 1024):
                    sha256.update(chunk)
                    downloaded.write(chunk)
            if sha256.hexdigest() != WEIGHTS_SHA256:
                raise ValueError("Mirrored TruFor checkpoint SHA-256 mismatch")
            downloaded.seek(0)
            target = destination / "weights" / "trufor.pth.tar"
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("wb") as out:
                shutil.copyfileobj(downloaded, out)
        else:
            if digest.hexdigest() != WEIGHTS_MD5:
                raise ValueError("TruFor archive checksum does not match upstream")
            downloaded.seek(0)
            with zipfile.ZipFile(downloaded) as weights:
                for member in weights.infolist():
                    if member.is_dir():
                        continue
                    name = Path(member.filename).name
                    if name != "trufor.pth.tar" and not name.lower().startswith("license"):
                        continue
                    target = destination / "weights" / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with weights.open(member) as src, target.open("wb") as out:
                        shutil.copyfileobj(src, out)
    if not (destination / "weights" / "trufor.pth.tar").is_file():
        raise ValueError("Official weights archive contained no checkpoint")
    (destination / "REVISION").write_text(REVISION + "\n")
    (destination / "UPSTREAM-LICENSE-NOTICE.txt").write_text(
        "TruFor is copyright GRIP-UNINA. Upstream limits use to informational and nonprofit purposes.\n"
        "See https://github.com/grip-unina/TruFor#license for the upstream terms.\n"
        f"Fallback checkpoint mirror: {MIRROR_URL}\nSHA256: {WEIGHTS_SHA256}\n"
    )
    print("TruFor source and weights installed", flush=True)


if __name__ == "__main__":
    install(Path(sys.argv[1]))
