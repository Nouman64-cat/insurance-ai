import sys
import time
from pathlib import Path
import torch
import torch.nn.functional as F
import numpy as np
from PIL import Image
import io
import os

adcd_code = Path(__file__).resolve().parents[2] / "data" / "models" / "adcd" / "code"
sys.path.insert(0, str(adcd_code))
import cfg
cfg.docres_ckpt_path = str(Path(__file__).resolve().parents[2] / "data" / "models" / "adcd" / "docres.pkl")
cfg.ckpt = str(Path(__file__).resolve().parents[2] / "data" / "models" / "adcd" / "ADCDNet.pth")
from model.model import ADCDNet
import jpeglib

model = ADCDNet()
ckpt = torch.load(cfg.ckpt, map_location="cpu", weights_only=True)
model.load_state_dict({k.replace("module.", ""): v for k, v in ckpt["model"].items()})
model.eval()

def evaluate_img(path, use_text_mask=False):
    img = Image.open(path).convert("RGB")
    target_size = 512
    img_res = img.resize((target_size, target_size), Image.Resampling.BILINEAR)
    img_arr = np.asarray(img_res, dtype=np.float32) / 255.0
    mean = np.array([0.485, 0.455, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    img_norm = (img_arr - mean) / std
    img_t = torch.from_numpy(img_norm.transpose(2, 0, 1)).unsqueeze(0).float()
    
    buf = io.BytesIO()
    img_res.save(buf, "JPEG", quality=85)
    buf.seek(0)
    tmp_path = "tmp_test.jpg"
    with open(tmp_path, "wb") as f:
        f.write(buf.getvalue())
    dct_im = jpeglib.read_dct(tmp_path)
    dct_arr = dct_im.Y.transpose(0, 2, 1, 3).reshape(target_size, target_size)
    dct_t = torch.from_numpy(np.clip(np.abs(dct_arr), 0, 20)).unsqueeze(0).long()
    qt_t = torch.from_numpy(dct_im.qt[0]).unsqueeze(0).long()
    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    
    mask_dummy = torch.zeros((1, 1, target_size, target_size), dtype=torch.long)
    if use_text_mask:
        gray = np.asarray(img_res.convert("L"))
        text_mask = (gray < 160).astype(np.int64)
        ocr_mask = torch.from_numpy(text_mask).unsqueeze(0).unsqueeze(0)
    else:
        ocr_mask = torch.zeros((1, 1, target_size, target_size), dtype=torch.long)
        
    t0 = time.time()
    with torch.no_grad():
        logits, _, align_logits, _, _ = model(img_t, dct_t, qt_t, mask_dummy, ocr_mask, is_train=False)
    probs = F.softmax(logits, dim=1)
    heat = probs[0, 1].numpy()
    align_score = float(F.softmax(align_logits, dim=1)[0, -1])
    return {
        "time": time.time() - t0,
        "mean": float(heat.mean()),
        "p99": float(np.percentile(heat, 99)),
        "max": float(heat.max()),
        "align": align_score
    }

test_cases = [
    ("data/pixel_eval/images/l2_forged_invoice_coolblue1.png", "FORGED invoice"),
    ("data/pixel_eval/images/rc_X51005230616.png", "GENUINE receipt"),
    ("data/pixel_eval/images/pdf_forged_redact_000.png", "FORGED redact PDF"),
    ("data/pixel_eval/images/pdf_genuine_000.png", "GENUINE PDF")
]

for p, desc in test_cases:
    if Path(p).exists():
        r_zero = evaluate_img(p, use_text_mask=False)
        r_text = evaluate_img(p, use_text_mask=True)
        print(f"\n{desc} ({Path(p).name}) [{r_zero['time']:.1f}s]:")
        print(f"   [zero mask] p99={r_zero['p99']:.4f}, max={r_zero['max']:.4f}, mean={r_zero['mean']:.4f}")
        print(f"   [text mask] p99={r_text['p99']:.4f}, max={r_text['max']:.4f}, mean={r_text['mean']:.4f}")
