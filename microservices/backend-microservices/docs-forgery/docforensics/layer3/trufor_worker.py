"""Standalone TruFor worker. Run with the Python that has PyTorch (not the main app's interpreter):

    <pixel-python> docforensics/layer3/trufor_worker.py <trufor-models-dir> [max_side]

Protocol (no files are written):
    stdin  : repeated frames, each a 4-byte big-endian length followed by that many bytes of an image (PNG);
             a frame of length 0 ends the input.
    stdout : one JSON line per image: {"score", "map_mean", "map_p99", "map_p99_conf", "size", "scale", "seconds",
             "map_png_b64"} or {"error": "..."}; the first line is {"ready": true, "load_seconds": ...}.
    stderr : warnings and logs.

It must not import the docforensics package (the PyTorch environment does not have its dependencies).

TruFor is released by GRIP-UNINA for informational and NONPROFIT use only (see its LICENSE.txt); this file only drives
the authors' published code and weights, which are not part of this repository.
"""

from __future__ import annotations

import base64
import io
import json
import os
import struct
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

MAX_MAP_SIDE = 256


def load_model(models_dir: Path):
    src = models_dir / "code" / "test_docker" / "src"
    sys.path.insert(0, str(src))
    os.chdir(src)  # the authors' config loader reads trufor.yaml from the working directory
    from config import _C as config
    from config import update_config
    from models.cmx.builder_np_conf import myEncoderDecoder

    class Args:
        opts = None

    update_config(config, Args())
    weights = next(models_dir.rglob("trufor.pth.tar"))
    # The checkpoint also stores a NumPy scalar. Its pickle imports only tensors, an OrderedDict, a NumPy scalar/dtype and
    # _codecs.encode (checked with pickletools, nothing executable), so exactly those are allow-listed and the loader stays
    # in weights_only mode. NumPy 2 renamed numpy.core -> numpy._core, so register the object under the pickle's old name.
    import _codecs

    allowed = [np.dtype, _codecs.encode, (np._core.multiarray.scalar, "numpy.core.multiarray.scalar")]
    allowed += [t for t in vars(np.dtypes).values() if isinstance(t, type)]
    with torch.serialization.safe_globals(allowed):
        ckpt = torch.load(weights, map_location="cpu", weights_only=True)
    model = myEncoderDecoder(cfg=config)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    return model


def score_image(model, data: bytes, max_side: int) -> dict:
    t = time.time()
    img = Image.open(io.BytesIO(data)).convert("RGB")
    w, h = img.size
    scale = min(1.0, max_side / max(w, h))
    if scale < 1.0:
        img = img.resize((max(8, round(w * scale)), max(8, round(h * scale))), Image.Resampling.LANCZOS)
    x = torch.tensor(np.asarray(img).transpose(2, 0, 1), dtype=torch.float).unsqueeze(0) / 256.0
    with torch.no_grad():
        pred, conf, det, _ = model(x)
    heat = F.softmax(torch.squeeze(pred, 0), dim=0)[1].numpy()
    out = {"score": float(torch.sigmoid(det).item()), "map_mean": float(heat.mean()), "map_p99": float(np.percentile(heat, 99)),
           "size": [w, h], "scale": float(scale)}
    if conf is not None:
        c = torch.sigmoid(torch.squeeze(conf, 0))[0].numpy()
        out["map_p99_conf"] = float(np.percentile(heat * c, 99))
    small = Image.fromarray((heat * 255).clip(0, 255).astype(np.uint8))
    small.thumbnail((MAX_MAP_SIDE, MAX_MAP_SIDE))
    buf = io.BytesIO()
    small.save(buf, "PNG")
    out["map_png_b64"] = base64.b64encode(buf.getvalue()).decode("ascii")
    out["seconds"] = round(time.time() - t, 2)
    return out


def read_frame(stream) -> bytes | None:
    header = stream.read(4)
    if len(header) < 4:
        return None
    (n,) = struct.unpack(">I", header)
    if n == 0:
        return None
    data = stream.read(n)
    return data if len(data) == n else None


def main() -> int:
    models_dir = Path(sys.argv[1])
    max_side = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
    out = sys.stdout
    t = time.time()
    try:
        model = load_model(models_dir)
    except Exception as exc:  # noqa: BLE001 - report and stop: nothing can be scored
        print(json.dumps({"fatal": f"{type(exc).__name__}: {exc}"[:400]}), file=out, flush=True)
        return 2
    print(json.dumps({"ready": True, "load_seconds": round(time.time() - t, 1)}), file=out, flush=True)
    stdin = sys.stdin.buffer
    while True:
        frame = read_frame(stdin)
        if frame is None:
            break
        try:
            result = score_image(model, frame, max_side)
        except Exception as exc:  # noqa: BLE001
            result = {"error": f"{type(exc).__name__}: {exc}"[:300]}
        print(json.dumps(result), file=out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
