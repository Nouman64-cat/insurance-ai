"""Best-effort reconstruction of docverify's UNDOCUMENTED preprocessing, and a sanity check of each variant.

docverify's ONNX graph takes
    x   [1, 6, H, W]   channels 0-2 = RGB in 0..1 (ImageNet normalisation happens inside the graph); channels 3-5 UNKNOWN
    dct [1, 64, H/8, W/8]   64 DCT coefficients per 8x8 block (scaling UNKNOWN)
and the model card / GitHub repository do not say how the unknown parts are built (the repository holds only a README).
This module builds several plausible variants. Because none can be verified, a variant is judged only by whether the
model's own published threshold (page threshold 7.86 on the mean of the top-200 logits, "5% false alarms on genuine
payslips") behaves sensibly on the images: genuine mostly below it, forged mostly above. That is a plausibility check,
NOT validation, and any result from this adapter must be reported as "reconstructed docverify".

    venv_exp\\Scripts\\python.exe scripts/pixel_experiments/docverify_recon.py
"""

from __future__ import annotations

import csv
import io
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy.fft import dctn

sys.path.insert(0, str(Path(__file__).resolve().parent))
from adapters import ROOT, Adapter  # noqa: E402

MODEL = ROOT / "data" / "models" / "docverify"
EVAL = ROOT / "data" / "pixel_eval"
THRESHOLD = json.loads((MODEL / "threshold.json").read_text())["threshold"]
BASE_Q = np.array([[16, 11, 10, 16, 24, 40, 51, 61], [12, 12, 14, 19, 26, 58, 60, 55], [14, 13, 16, 24, 40, 57, 69, 56],
                   [14, 17, 22, 29, 51, 87, 80, 62], [18, 22, 37, 56, 68, 109, 103, 77], [24, 35, 55, 64, 81, 104, 113, 92],
                   [49, 64, 78, 87, 103, 121, 120, 101], [72, 92, 95, 98, 112, 100, 103, 99]], dtype=np.float32)


def pad32(img: Image.Image) -> Image.Image:
    w, h = img.size
    W, H = -(-w // 32) * 32, -(-h // 32) * 32
    if (W, H) == (w, h):
        return img
    canvas = Image.new("RGB", (W, H), (255, 255, 255))
    canvas.paste(img, (0, 0))
    return canvas


def ela(img: Image.Image, quality: int = 90) -> np.ndarray:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    re = Image.open(io.BytesIO(buf.getvalue())).convert("RGB")
    d = np.abs(np.asarray(img, dtype=np.float32) - np.asarray(re, dtype=np.float32))
    return d / max(float(d.max()), 1.0)


def highpass(img: Image.Image) -> np.ndarray:
    a = np.asarray(img, dtype=np.float32)
    b = np.asarray(img.filter(ImageFilter.GaussianBlur(1.0)), dtype=np.float32)
    return np.clip((a - b) / 255.0 * 4 + 0.5, 0, 1)


def block_dct(img: Image.Image, mode: str) -> np.ndarray:
    y = np.asarray(img.convert("L"), dtype=np.float32) - 128.0
    h, w = y.shape
    blocks = y.reshape(h // 8, 8, w // 8, 8).transpose(0, 2, 1, 3)           # (H/8, W/8, 8, 8)
    coef = dctn(blocks, type=2, norm="ortho", axes=(2, 3))                    # orthonormal 2-D DCT per block
    if mode == "q75":                                                         # JPEG quality-75 quantisation indices
        q = np.maximum(1, np.floor((BASE_Q * 50 + 50) / 100))
        coef = np.round(coef / q)
    elif mode == "raw100":
        coef = coef / 100.0
    return coef.reshape(h // 8, w // 8, 64).transpose(2, 0, 1)               # (64, H/8, W/8)


VARIANTS = {
    "A_ela_q75": ("ela", "q75"),
    "B_ela_raw": ("ela", "raw100"),
    "C_hp_q75": ("highpass", "q75"),
    "D_rgb_q75": ("rgb", "q75"),
}


class DocverifyRecon(Adapter):
    name = "docverify"
    variant = "A_ela_q75"

    def load(self) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 4
        self.sess = ort.InferenceSession(str(MODEL / "tampernet.onnx"), opts, providers=["CPUExecutionProvider"])

    def logits(self, img: Image.Image, variant: str) -> np.ndarray:
        extra_kind, dct_mode = VARIANTS[variant]
        img = pad32(img.convert("RGB"))
        rgb = np.asarray(img, dtype=np.float32) / 255.0
        extra = {"ela": lambda: ela(img), "highpass": lambda: highpass(img), "rgb": lambda: rgb}[extra_kind]()
        x = np.concatenate([rgb, extra], axis=2).transpose(2, 0, 1)[None].astype(np.float32)
        dct = block_dct(img, dct_mode)[None].astype(np.float32)
        return self.sess.run(None, {"x": x, "dct": dct})[0][0, 0]

    def score(self, img: Image.Image) -> dict[str, float]:
        z = self.logits(img, self.variant)
        top = np.sort(z.reshape(-1))[-200:]
        return {"score": float(top.mean()), "logit_max": float(z.max()), "frac_pos": float((z > 0).mean())}


def sanity() -> None:
    """Judge each variant by the model's own threshold on a small mixed sample (orig condition only)."""
    rows = list(csv.DictReader((EVAL / "manifest.csv").open(encoding="utf-8")))
    pick = lambda grp, n: [r for r in rows if r["group"] == grp][:n]  # noqa: E731
    sample = pick("pdf_genuine", 10) + pick("l2_genuine", 10) + pick("pdf_forged_overlay", 6) + pick("pdf_forged_redact", 6) + pick("l2_forged", 10)
    print(f"sanity sample: {len(sample)} images ({sum(r['label'] == 'forged' for r in sample)} forged); model threshold = {THRESHOLD:.2f}")
    ad = DocverifyRecon()
    ad.load()
    from sklearn.metrics import roc_auc_score

    for variant in VARIANTS:
        ad.variant = variant
        t = time.time()
        s = np.array([ad.score(Image.open(EVAL / r["path"]))["score"] for r in sample])
        y = np.array([r["label"] == "forged" for r in sample])
        print(f"{variant:10s} AUC {roc_auc_score(y, s):.2f} | genuine above model threshold {np.mean(s[~y] > THRESHOLD):4.0%} | "
              f"forged above {np.mean(s[y] > THRESHOLD):4.0%} | median genuine {np.median(s[~y]):7.2f} forged {np.median(s[y]):7.2f} | {time.time() - t:.0f}s", flush=True)


if __name__ == "__main__":
    sanity()
