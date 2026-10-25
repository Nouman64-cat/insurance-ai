import csv
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVAL = ROOT / "data" / "pixel_eval"
rows = list(csv.DictReader((EVAL / "manifest.csv").open(encoding="utf-8")))

rnd = random.Random(20261021)

# Pick calibration genuine (need >= 5)
cal_receipt = [r for r in rows if r["group"] == "receipt_genuine" and r["split"] == "calibration"]
cal_pdf = [r for r in rows if r["group"] == "pdf_genuine" and r["split"] == "calibration"]
cal_l2 = [r for r in rows if r["group"] == "l2_genuine" and r["split"] == "calibration"]
rnd.shuffle(cal_receipt)
rnd.shuffle(cal_pdf)
rnd.shuffle(cal_l2)
cal_chosen = cal_receipt[:3] + cal_pdf[:2] + cal_l2[:1]

# Pick eval genuine
eval_receipt = [r for r in rows if r["group"] == "receipt_genuine" and r["split"] == "eval"]
eval_pdf = [r for r in rows if r["group"] == "pdf_genuine" and r["split"] == "eval"]
eval_l2 = [r for r in rows if r["group"] == "l2_genuine" and r["split"] == "eval"]
rnd.shuffle(eval_receipt)
rnd.shuffle(eval_pdf)
rnd.shuffle(eval_l2)
eval_gen_chosen = eval_receipt[:3] + eval_pdf[:2] + eval_l2[:1]

# Pick eval forged (gap groups that layers 1 & 2 miss)
f_paint = [r for r in rows if r["group"] == "receipt_forged_paint"]
f_preview = [r for r in rows if r["group"] == "receipt_forged_preview"]
f_paint3d = [r for r in rows if r["group"] == "receipt_forged_paint3d"]
f_redact = [r for r in rows if r["group"] == "pdf_forged_redact"]
f_gimp = [r for r in rows if r["group"] == "receipt_forged_gimp"]
rnd.shuffle(f_paint)
rnd.shuffle(f_preview)
rnd.shuffle(f_paint3d)
rnd.shuffle(f_redact)
rnd.shuffle(f_gimp)
eval_forged_chosen = f_paint[:2] + f_preview[:2] + f_paint3d[:2] + f_redact[:2] + f_gimp[:2]

# Also ensure any images already scored in adcd.jsonl are included so no work is wasted
done_ids = []
p_jsonl = EVAL / "results" / "adcd.jsonl"
if p_jsonl.exists():
    import json
    for line in p_jsonl.read_text(encoding="utf-8").splitlines():
        if line.strip():
            done_ids.append(json.loads(line)["id"])
already_done = [r for r in rows if r["id"] in done_ids]

all_chosen = list({r["id"]: r for r in (already_done + cal_chosen + eval_gen_chosen + eval_forged_chosen)}.values())

out_file = EVAL / "subset_adcd.txt"
out_file.write_text("\n".join(r["id"] for r in all_chosen), encoding="utf-8")
g_cal = sum(r["label"] == "genuine" and r["split"] == "calibration" for r in all_chosen)
g_eval = sum(r["label"] == "genuine" and r["split"] == "eval" for r in all_chosen)
f_eval = sum(r["label"] == "forged" for r in all_chosen)
print(f"Created {out_file}: {len(all_chosen)} images (cal_genuine={g_cal}, eval_genuine={g_eval}, eval_forged={f_eval})")
