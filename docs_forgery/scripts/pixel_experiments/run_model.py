"""Score the evaluation set with one model under several image conditions. Resumable; one JSONL line per image.

    venv_exp\\Scripts\\python.exe scripts/pixel_experiments/run_model.py --model universal
    ... --model trufor --conditions orig,phone --limit 20 --threads 4

Conditions (applied identically to genuine and forged images):
    orig     the image as stored
    jpeg75   re-encoded once as JPEG quality 75
    phone    downscaled to 70% then JPEG quality 55 (a WhatsApp / phone-share style hop)
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import time
from pathlib import Path

import torch
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
EVAL = ROOT / "data" / "pixel_eval"


def condition(img: Image.Image, name: str) -> Image.Image:
    img = img.convert("RGB")
    if name == "orig":
        return img
    if name == "jpeg75":
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=75)
        return Image.open(io.BytesIO(buf.getvalue())).convert("RGB")
    if name == "phone":
        small = img.resize((max(8, round(img.width * 0.7)), max(8, round(img.height * 0.7))), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        small.save(buf, "JPEG", quality=55)
        return Image.open(io.BytesIO(buf.getvalue())).convert("RGB")
    raise ValueError(name)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--conditions", default="orig,jpeg75,phone")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--out", default=str(EVAL / "results"))
    ap.add_argument("--ids-file", help="text file of image ids to run (one per line), e.g. a stratified subset")
    ap.add_argument("--max-side", type=int, help="TruFor only: downscale so the longer side is at most this")
    args = ap.parse_args()
    torch.set_num_threads(args.threads)

    from adapters import ADAPTERS  # after sys.path insert; TruFor changes cwd on load

    rows = list(csv.DictReader((EVAL / "manifest.csv").open(encoding="utf-8")))
    if args.ids_file:
        wanted = set(Path(args.ids_file).read_text(encoding="utf-8").split())
        rows = [r for r in rows if r["id"] in wanted]
    if args.limit:  # a balanced prefix: alternate genuine and forged so a short run still has both classes
        g = [r for r in rows if r["label"] == "genuine"]
        f = [r for r in rows if r["label"] == "forged"]
        rows = [x for pair in zip(g, f) for x in pair][: args.limit]
    conditions = args.conditions.split(",")
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{args.model}.jsonl"
    done = set()
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            done.add((r["id"], r["condition"]))

    adapter = ADAPTERS[args.model]()
    if args.max_side and hasattr(adapter, "max_side"):
        adapter.max_side = args.max_side
    t0 = time.time()
    adapter.load()
    print(f"{args.model} loaded in {time.time() - t0:.1f}s; {len(rows)} images x {len(conditions)} conditions; {len(done)} already done", flush=True)

    todo = [(r, c) for c in conditions for r in rows if (r["id"], c) not in done]
    started = time.time()
    for i, (r, c) in enumerate(todo, 1):
        img = condition(Image.open(EVAL / r["path"]), c)
        t = time.time()
        try:
            scores = adapter.score(img)
            err = None
        except Exception as exc:  # noqa: BLE001 - a failing image is recorded, not hidden
            scores, err = {}, f"{type(exc).__name__}: {exc}"[:300]
        rec = {"id": r["id"], "condition": c, "model": args.model, "label": r["label"], "group": r["group"], "split": r["split"],
               "seconds": round(time.time() - t, 2), "size": list(img.size), "error": err, **scores}
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        if i % 10 == 0 or i == len(todo):
            el = time.time() - started
            print(f"  {i}/{len(todo)}  {el / i:.2f}s/img  eta {(len(todo) - i) * el / i / 60:.1f} min", flush=True)
    print("done", path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
