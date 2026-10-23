"""Analyse pixel-model experiment results.

    venv_exp\\Scripts\\python.exe scripts/pixel_experiments/analyze.py [--models universal,jasirdeen,trufor,docverify]

Protocol (no training happens anywhere):
  * Genuine images are split by hash into `calibration` and `eval`; forged images are all `eval`.
  * A decision threshold is chosen from the CALIBRATION genuine scores in the `orig` condition only:
        t95 = their 95th percentile (aims at ~5% false alarms), tmax = their maximum (aims at ~0%).
  * For each condition (orig / jpeg75 / phone) report on the EVAL images:
        AUC            genuine vs forged
        FPR            fraction of eval-genuine scoring above the threshold  <- the compression test
        TPR            fraction of forged above the threshold, overall and per forgery group
  * A model earns a place only if it catches forgeries that layers 1 and 2 miss (Paint/Preview/Paint3D receipts,
    redact-and-retype PDFs) at a low FPR that does NOT blow up under compression.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "data" / "pixel_eval" / "results"
CONDITIONS = ["orig", "jpeg75", "phone"]
# groups that layers 1 and 2 do not catch: the gap a pixel model would have to fill
GAP_GROUPS = ["receipt_forged_paint", "receipt_forged_paint3d", "receipt_forged_preview", "pdf_forged_redact"]


def load(models: list[str]) -> pd.DataFrame:
    frames = []
    for m in models:
        p = RESULTS / f"{m}.jsonl"
        if p.exists():
            frames.append(pd.read_json(p, lines=True))
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def score_columns(df: pd.DataFrame, model: str) -> list[str]:
    skip = {"id", "condition", "model", "label", "group", "split", "seconds", "size", "error", "scale", "conf_mean", "p_auth", "p_genuine"}
    cols = [c for c in df.columns if c not in skip and pd.api.types.is_numeric_dtype(df[c]) and df.loc[df.model == model, c].notna().any()]
    return ["score"] + [c for c in cols if c != "score"]


def analyse(df: pd.DataFrame, model: str, column: str) -> dict:
    d = df[(df.model == model) & df[column].notna() & df.error.isna()]
    cal = d[(d.split == "calibration") & (d.condition == "orig") & (d.label == "genuine")][column]
    out = {"model": model, "score": column, "n_calibration": int(len(cal)), "conditions": {}}
    if len(cal) < 5:
        return out
    t95, tmax = float(np.percentile(cal, 95)), float(cal.max())
    out["t95"], out["tmax"] = t95, tmax
    for cond in CONDITIONS:
        c = d[(d.condition == cond) & (d.split == "eval")]
        g, f = c[c.label == "genuine"][column], c[c.label == "forged"][column]
        if len(g) < 3 or len(f) < 3:
            continue
        y = np.r_[np.zeros(len(g)), np.ones(len(f))]
        res = {"n_genuine": int(len(g)), "n_forged": int(len(f)),
               "auc": float(roc_auc_score(y, np.r_[g, f])),
               "fpr_t95": float((g > t95).mean()), "tpr_t95": float((f > t95).mean()),
               "fpr_tmax": float((g > tmax).mean()), "tpr_tmax": float((f > tmax).mean()),
               "median_genuine": float(g.median()), "median_forged": float(f.median()), "tpr_by_group_t95": {}}
        for grp, gg in c[c.label == "forged"].groupby("group"):
            res["tpr_by_group_t95"][grp] = (float((gg[column] > t95).mean()), int(len(gg)))
        gap = c[(c.label == "forged") & c.group.isin(GAP_GROUPS)][column]
        res["gap_tpr_t95"] = (float((gap > t95).mean()), int(len(gap))) if len(gap) else None
        for fam in ("receipt", "pdf", "l2"):
            sub = c[c.group.str.startswith(fam)]
            sg, sf = sub[sub.label == "genuine"][column], sub[sub.label == "forged"][column]
            if len(sg) >= 3 and len(sf) >= 3:
                res[f"auc_{fam}"] = float(roc_auc_score(np.r_[np.zeros(len(sg)), np.ones(len(sf))], np.r_[sg, sf]))
        out["conditions"][cond] = res
    return out


def pct(x) -> str:
    return "  -  " if x is None else f"{100 * x:4.0f}%"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="universal,jasirdeen,trufor,docverify")
    ap.add_argument("--all-scores", action="store_true", help="also report every secondary score column")
    args = ap.parse_args()
    models = args.models.split(",")
    df = load(models)
    if df.empty:
        print("no results yet")
        return 1
    summary = []
    for m in models:
        if m not in set(df.model):
            continue
        sub = df[df.model == m]
        n_err = int(sub.error.notna().sum())
        print("\n" + "=" * 100)
        print(f"{m}: {len(sub)} scored, {n_err} errors, {sub.seconds.mean():.2f}s/img mean")
        cols = score_columns(df, m) if args.all_scores else ["score"]
        for col in cols:
            r = analyse(df, m, col)
            summary.append(r)
            if "t95" not in r:
                print(f"  [{col}] not enough calibration data")
                continue
            print(f"\n  score = {col}   (threshold from {r['n_calibration']} calibration-genuine images: t95={r['t95']:.3f}, tmax={r['tmax']:.3f})")
            print(f"  {'condition':8s} {'AUC':>5s} {'rcpt':>5s} {'pdf':>5s} | at t95: {'FPR':>5s} {'TPR':>5s} {'gapTPR':>9s} | at tmax: {'FPR':>5s} {'TPR':>5s}")
            for cond, c in r["conditions"].items():
                gap = c["gap_tpr_t95"]
                print(f"  {cond:8s} {c['auc']:5.2f} {c.get('auc_receipt', float('nan')):5.2f} {c.get('auc_pdf', float('nan')):5.2f} | "
                      f"         {pct(c['fpr_t95'])} {pct(c['tpr_t95'])} {pct(gap[0]) + f' (n={gap[1]})' if gap else '      -   '} | "
                      f"          {pct(c['fpr_tmax'])} {pct(c['tpr_tmax'])}")
            c0 = r["conditions"].get("orig")
            if c0:
                print("  TPR by forgery group (orig, t95): " + ", ".join(f"{g}={pct(v[0]).strip()}({v[1]})" for g, v in sorted(c0["tpr_by_group_t95"].items())))
    (RESULTS / "summary.json").write_text(json.dumps(summary, indent=1, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
