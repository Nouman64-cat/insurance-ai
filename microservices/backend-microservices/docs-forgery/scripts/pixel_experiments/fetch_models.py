"""Download the candidate pixel-forensics models into data/models/ (git-ignored).

    venv_exp\\Scripts\\python.exe scripts/pixel_experiments/fetch_models.py

Weights come from untrusted third-party repositories: they are only ever loaded by the adapters in this folder, with
``torch.load(..., weights_only=True)``. TruFor's weights are released by GRIP-UNINA for research / non-profit use only.
"""

from __future__ import annotations

import sys
import urllib.request
import zipfile
from pathlib import Path

from huggingface_hub import hf_hub_download, list_repo_files

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "data" / "models"

HF = [
    ("docverify", "ghostsas001/docverify", "model", None),
    ("universal", "Sumit0098073e5/Universal-Deepfake-Detector", "space", None),
    ("jasirdeen", "Jasirdeen/efficientnet-b3-image-forgery-detection", "model", None),
]
TRUFOR_WEIGHTS = "https://www.grip.unina.it/download/prog/TruFor/TruFor_weights.zip"
TRUFOR_REPO = "https://github.com/grip-unina/TruFor.git"


def fetch_hf() -> None:
    for name, repo, kind, _ in HF:
        dest = MODELS / name
        dest.mkdir(parents=True, exist_ok=True)
        files = list_repo_files(repo, repo_type=kind)
        print(f"\n{name}: {repo} ({kind}): {len(files)} files")
        for f in files:
            if f.startswith(".git") or f.endswith((".png", ".jpg", ".jpeg", ".gif")) and "/" in f:
                continue
            path = hf_hub_download(repo, f, repo_type=kind, local_dir=dest)
            print(f"   {f}  ({Path(path).stat().st_size / 1e6:.1f} MB)")


def fetch_trufor() -> None:
    dest = MODELS / "trufor"
    dest.mkdir(parents=True, exist_ok=True)
    zip_path = dest / "TruFor_weights.zip"
    if not zip_path.exists():
        print(f"\ntrufor weights: {TRUFOR_WEIGHTS}")
        urllib.request.urlretrieve(TRUFOR_WEIGHTS, zip_path)
    print(f"   {zip_path.stat().st_size / 1e6:.1f} MB")
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(dest)
    print("   extracted:", sorted(p.name for p in dest.iterdir()))


if __name__ == "__main__":
    which = sys.argv[1:] or ["hf", "trufor"]
    if "hf" in which:
        fetch_hf()
    if "trufor" in which:
        fetch_trufor()
