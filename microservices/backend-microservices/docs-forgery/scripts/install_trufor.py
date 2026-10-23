"""Fetch pinned upstream inference code and checksum-verified official weights."""

import hashlib
import io
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

REVISION = "ae54475df6f41a491d7615100feb19263dec13f7"
CODE_URL = f"https://codeload.github.com/grip-unina/TruFor/tar.gz/{REVISION}"
WEIGHTS_URL = "https://www.grip.unina.it/download/prog/TruFor/TruFor_weights.zip"
# Published in upstream test_docker/README.md. Reject damaged or changed archives.
WEIGHTS_MD5 = "7bee48f3476c75616c3c5721ab256ff8"


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
        with urllib.request.urlopen(WEIGHTS_URL, timeout=120) as response:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                downloaded.write(chunk)
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
    print("TruFor source and weights installed", flush=True)


if __name__ == "__main__":
    install(Path(sys.argv[1]))
