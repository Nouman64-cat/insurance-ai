import sys
import time
from pathlib import Path
import torch
import torch.nn.functional as F
import numpy as np
from PIL import Image
import tempfile
import jpeglib

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "data" / "models"
src = MODELS / "adcd" / "code"
if str(src) not in sys.path:
    sys.path.insert(0, str(src))

import cfg
cfg.docres_ckpt_path = str(MODELS / "adcd" / "docres.pkl")
cfg.ckpt = str(MODELS / "adcd" / "ADCDNet.pth")
from model.model import ADCDNet

model = ADCDNet()
ckpt = torch.load(cfg.ckpt, map_location="cpu", weights_only=True)
model.load_state_dict({k.replace("module.", ""): v for k, v in ckpt["model"].items()})
model.eval()

def score_img(p):
    img = Image.open(p).convert("RGB")
    target_size = 512
    img_res = img.resize((target_size, target_size), Image.Resampling.BILINEAR)
    img_arr = np.asarray(img_res, dtype=np.float32) / 255.0
    mean = np.array([0.485, 0.455, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    img_t = torch.from_numpy(((img_arr - mean) / std).transpose(2, 0, 1)).unsqueeze(0).float()
    
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tname = tmp.name
    try:
        img_res.save(tname, "JPEG", quality=85)
        dim = jpeglib.read_dct(tname)
        dct_t = torch.from_numpy(np.clip(np.abs(dim.Y.transpose(0, 2, 1, 3).reshape(target_size, target_size)), 0, 20)).unsqueeze(0).long()
        qt_t = torch.from_numpy(dim.qt[0]).unsqueeze(0).long()
    finally:
        Path(tname).unlink(missing_ok=True)
        
    m = torch.zeros((1, 1, target_size, target_size), dtype=torch.long)
    t0 = time.time()
    with torch.no_grad():
        logits, _, align_logits, _, _ = model(img_t, dct_t, qt_t, m, m, is_train=False)
    probs = F.softmax(logits, dim=1)
    heat = probs[0, 1].numpy()
    align_score = float(F.softmax(align_logits, dim=1)[0, -1])
    return {
        "p99": float(np.percentile(heat, 99)),
        "max": float(heat.max()),
        "mean": float(heat.mean()),
        "align": align_score,
        "time": time.time() - t0
    }

pairs = [
    ("GENUINE receipt", ROOT / "data/pixel_eval/images/rc_X51005230621.png"),
    ("FORGED paint receipt", ROOT / "data/pixel_eval/images/rc_X51005710963.png"),
    ("GENUINE IRS PDF", ROOT / "data/pixel_eval/images/pg_irs_f8949.png"),
    ("FORGED redact PDF", ROOT / "data/pixel_eval/images/pf_redact_rewrite_irs_f8949.png")
]

print("Starting pair scoring...")
for label, p in pairs:
    s = score_img(p)
    print(f"{label:22s} ({p.name}): p99={s['p99']:.4f}, max={s['max']:.4f}, mean={s['mean']:.4f}, align={s['align']:.4f} ({s['time']:.1f}s)", flush=True)
