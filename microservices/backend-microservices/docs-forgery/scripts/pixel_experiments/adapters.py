"""Adapters that give every candidate pixel-forensics model the same interface.

    adapter = ADAPTERS["universal"]()
    adapter.load()
    adapter.score(pil_image) -> {"score": float, ...}      # higher = more likely tampered / generated

Only Pillow and NumPy are used for image handling (OpenCV is blocked on the dev machine by Smart App Control).
Weights are third-party files: they are loaded with ``torch.load(weights_only=True)`` wherever the format allows.

Each model's own code is reproduced or imported from its published source:
  * universal : Hybrid Swin + Bayar/EfficientNet-B0 network from the Space's app.py (MIT)
  * jasirdeen : timm EfficientNet-B3, usage from its model card (MIT)
  * trufor    : GRIP-UNINA code in data/models/trufor/code (nonprofit/informational licence, not redistributed)
  * docverify : ONNX graph; its preprocessing is NOT published, so this adapter is a documented reconstruction
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "data" / "models"
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def to_chw(img: Image.Image, mean=IMAGENET_MEAN, std=IMAGENET_STD) -> torch.Tensor:
    arr = (np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0 - mean) / std
    return torch.from_numpy(arr.transpose(2, 0, 1)).unsqueeze(0)


class Adapter:
    name = "base"

    def load(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def score(self, img: Image.Image) -> dict[str, float]:  # pragma: no cover - interface
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Universal-Deepfake-Detector (Space by Sumit0098073e5): Real / Edited / AI-generated
# ---------------------------------------------------------------------------

class BayarConv2d(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_size=5, padding=2):
        super().__init__()
        self.kernel_size = kernel_size
        self.conv = nn.Conv2d(in_channels, out_channels, kernel_size, padding=padding, bias=False)

    def forward(self, x):
        k = self.kernel_size // 2
        self.conv.weight.data[:, :, k, k] = 0.0
        s = self.conv.weight.data.sum(dim=(2, 3), keepdim=True)
        s[s == 0] = 1
        self.conv.weight.data /= s
        self.conv.weight.data[:, :, k, k] = -1.0
        return self.conv(x)


class HybridForgeryDetector(nn.Module):
    def __init__(self, num_classes=3):
        super().__init__()
        import timm

        self.stream_a = timm.create_model("swin_tiny_patch4_window7_224", pretrained=False, num_classes=0)
        self.bayar = BayarConv2d(3, 3)
        self.stream_b = timm.create_model("efficientnet_b0", pretrained=False, num_classes=0)
        self.fusion = nn.Sequential(nn.Linear(self.stream_a.num_features + self.stream_b.num_features, 512),
                                    nn.BatchNorm1d(512), nn.ReLU(), nn.Dropout(0.5), nn.Linear(512, num_classes))

    def forward(self, x):
        f1 = self.stream_a(x)
        f1 = f1.mean(dim=[2, 3]) if f1.dim() > 2 else f1
        f2 = self.stream_b(self.bayar(x))
        f2 = f2.mean(dim=[2, 3]) if f2.dim() > 2 else f2
        return self.fusion(torch.cat((f1, f2), dim=1))


class Universal(Adapter):
    name = "universal"

    def load(self) -> None:
        self.model = HybridForgeryDetector()
        state = torch.load(MODELS / "universal" / "universal_forgery_FINAL.pth", map_location="cpu", weights_only=True)
        self.model.load_state_dict(state)
        self.model.eval()

    def _probs(self, patch: Image.Image) -> np.ndarray:
        with torch.no_grad():
            return F.softmax(self.model(to_chw(patch)), dim=1)[0].numpy()

    def score(self, img: Image.Image) -> dict[str, float]:
        img = img.convert("RGB")
        w, h = img.size
        glob = self._probs(img.resize((224, 224), Image.Resampling.BILINEAR))  # the app's "Global View"
        out = {"p_auth": float(glob[0]), "p_edit": float(glob[1]), "p_ai": float(glob[2]), "score": float(1 - glob[0])}
        # the app's patch scan: five 224 px crops (centre and corners) of the full-resolution image
        patch_nonauth, patch_ai, patch_edit = [], [], []
        if h > 300 and w > 300:
            for y, x in ((h // 2 - 112, w // 2 - 112), (0, 0), (0, w - 224), (h - 224, 0), (h - 224, w - 224)):
                if y >= 0 and x >= 0 and y + 224 <= h and x + 224 <= w:
                    p = self._probs(img.crop((x, y, x + 224, y + 224)))
                    patch_nonauth.append(1 - p[0]), patch_ai.append(p[2]), patch_edit.append(p[1])
        out["patch_max_nonauth"] = float(max(patch_nonauth)) if patch_nonauth else out["score"]
        out["patch_max_ai"] = float(max(patch_ai)) if patch_ai else out["p_ai"]
        out["patch_max_edit"] = float(max(patch_edit)) if patch_edit else out["p_edit"]
        return out


# ---------------------------------------------------------------------------
# Jasirdeen EfficientNet-B3: genuine vs forged identity documents
# ---------------------------------------------------------------------------

class Jasirdeen(Adapter):
    name = "jasirdeen"

    def load(self) -> None:
        import timm

        self.model = timm.create_model("efficientnet_b3", pretrained=False, num_classes=2)
        self.model.load_state_dict(torch.load(MODELS / "jasirdeen" / "efficientnet_b3_finetuned.pt", map_location="cpu", weights_only=True))
        self.model.eval()

    def score(self, img: Image.Image) -> dict[str, float]:
        from torchvision import transforms

        x = transforms.Compose([transforms.Resize((300, 300)), transforms.ToTensor(),
                                transforms.Normalize(tuple(IMAGENET_MEAN), tuple(IMAGENET_STD))])(img.convert("RGB")).unsqueeze(0)
        with torch.no_grad():
            p = torch.softmax(self.model(x), dim=1)[0]
        return {"score": float(p[1]), "p_genuine": float(p[0])}


# ---------------------------------------------------------------------------
# TruFor (GRIP-UNINA)
# ---------------------------------------------------------------------------

class TruFor(Adapter):
    name = "trufor"
    max_side = 1280  # CPU budget: larger images are downscaled first (recorded in the results)

    def load(self) -> None:
        src = MODELS / "trufor" / "code" / "test_docker" / "src"
        sys.path.insert(0, str(src))
        import os

        os.chdir(src)  # their config loader reads 'trufor.yaml' from the working directory
        from config import _C as config
        from config import update_config
        from models.cmx.builder_np_conf import myEncoderDecoder

        class A:  # the parts of argparse's namespace that update_config reads
            opts = None

        update_config(config, A())
        weights = next((MODELS / "trufor").rglob("trufor.pth.tar"))
        # The official checkpoint also stores a NumPy scalar. scan_pickle.py shows its pickle imports only tensors, an
        # OrderedDict, a NumPy scalar/dtype and _codecs.encode (nothing executable), so those exact types are allow-listed
        # and the loader stays in weights_only mode.
        import _codecs

        # NumPy 2 renamed numpy.core -> numpy._core; the pickle uses the old name, so register the object under it.
        allowed = [np.dtype, _codecs.encode, (np._core.multiarray.scalar, "numpy.core.multiarray.scalar")]
        allowed += [t for t in vars(np.dtypes).values() if isinstance(t, type)]
        with torch.serialization.safe_globals(allowed):
            ckpt = torch.load(weights, map_location="cpu", weights_only=True)
        self.model = myEncoderDecoder(cfg=config)
        self.model.load_state_dict(ckpt["state_dict"])
        self.model.eval()

    def score(self, img: Image.Image) -> dict[str, float]:
        img = img.convert("RGB")
        w, h = img.size
        scale = min(1.0, self.max_side / max(w, h))
        if scale < 1.0:
            img = img.resize((max(8, round(w * scale)), max(8, round(h * scale))), Image.Resampling.LANCZOS)
        x = torch.tensor(np.asarray(img).transpose(2, 0, 1), dtype=torch.float).unsqueeze(0) / 256.0
        with torch.no_grad():
            pred, conf, det, _ = self.model(x)
        heat = F.softmax(torch.squeeze(pred, 0), dim=0)[1].numpy()
        out = {"score": float(torch.sigmoid(det).item()), "map_mean": float(heat.mean()), "map_p99": float(np.percentile(heat, 99)),
               "scale": float(scale)}
        if conf is not None:
            c = torch.sigmoid(torch.squeeze(conf, 0))[0].numpy()
            out["conf_mean"] = float(c.mean())
            out["map_p99_conf"] = float(np.percentile(heat * c, 99))
        return out


# ---------------------------------------------------------------------------
# ADCD-Net (ICCV 2025: Adaptive DCT & Hierarchical Content Disentanglement)
# ---------------------------------------------------------------------------

class ADCD(Adapter):
    name = "adcd"
    target_size = 512

    def load(self) -> None:
        src = MODELS / "adcd" / "code"
        if str(src) not in sys.path:
            sys.path.insert(0, str(src))
        import cfg
        cfg.docres_ckpt_path = str(MODELS / "adcd" / "docres.pkl")
        cfg.ckpt = str(MODELS / "adcd" / "ADCDNet.pth")
        from model.model import ADCDNet

        self.model = ADCDNet()
        ckpt = torch.load(cfg.ckpt, map_location="cpu", weights_only=True)
        clean_state = {k.replace("module.", ""): v for k, v in ckpt["model"].items()}
        self.model.load_state_dict(clean_state)
        self.model.eval()

    def score(self, img: Image.Image) -> dict[str, float]:
        import tempfile
        import jpeglib

        img = img.convert("RGB")
        img_res = img.resize((self.target_size, self.target_size), Image.Resampling.BILINEAR)
        img_arr = np.asarray(img_res, dtype=np.float32) / 255.0
        mean = np.array([0.485, 0.455, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        img_norm = (img_arr - mean) / std
        img_t = torch.from_numpy(img_norm.transpose(2, 0, 1)).unsqueeze(0).float()

        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp_name = tmp.name
        try:
            img_res.save(tmp_name, "JPEG", quality=85)
            dct_im = jpeglib.read_dct(tmp_name)
            dct_arr = dct_im.Y.transpose(0, 2, 1, 3).reshape(self.target_size, self.target_size)
            dct_t = torch.from_numpy(np.clip(np.abs(dct_arr), 0, 20)).unsqueeze(0).long()
            qt_t = torch.from_numpy(dct_im.qt[0]).unsqueeze(0).long()
        finally:
            if Path(tmp_name).exists():
                Path(tmp_name).unlink(missing_ok=True)

        mask_dummy = torch.zeros((1, 1, self.target_size, self.target_size), dtype=torch.long)
        ocr_mask = torch.zeros((1, 1, self.target_size, self.target_size), dtype=torch.long)

        with torch.no_grad():
            logits, _, align_logits, _, _ = self.model(img_t, dct_t, qt_t, mask_dummy, ocr_mask, is_train=False)

        probs = F.softmax(logits, dim=1)
        heat = probs[0, 1].numpy()
        p99 = float(np.percentile(heat, 99))
        p95 = float(np.percentile(heat, 95))
        m_mean = float(heat.mean())
        m_max = float(heat.max())
        align_score = float(F.softmax(align_logits, dim=1)[0, -1])

        return {
            "score": p99,
            "map_p99": p99,
            "map_p95": p95,
            "map_max": m_max,
            "map_mean": m_mean,
            "align_score": align_score
        }


ADAPTERS: dict[str, type[Adapter]] = {
    "universal": Universal,
    "jasirdeen": Jasirdeen,
    "trufor": TruFor,
    "adcd": ADCD,
}
