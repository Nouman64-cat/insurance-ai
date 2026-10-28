# Experiments: Pixel Forensics Models

This document records the model candidates evaluated for Layer 3 (pixel forensics) and explains why
TruFor was chosen as the current implementation.

> **Status.** Layer 3 is experimental. The numbers below were measured on a small calibration set of
> genuine documents (phone photos, scanned PDFs, synthetic payslips). See
> [EVALUATION.md](EVALUATION.md) for caveats on sample size.

---

## Why pixel forensics is hard on financial documents

Pixel-level forgery detectors (Error Level Analysis, noise inconsistency, CNN-based localisation)
were designed for photographs. Financial documents introduce several confounding factors:

| Factor | Effect on pixel models |
|---|---|
| JPEG re-saves (phone photos, scan-to-email) | Compression artefacts mimic localised tampering noise |
| Thermal receipt paper + scanner | Non-uniform background texture resembles splice boundaries |
| PDF-to-image rendering at different DPIs | Resampling changes local frequency content |
| Font hinting and sub-pixel rendering | Sharp edges at glyph boundaries score high on noise maps |
| Genuine multi-part documents (header image + body text) | Region boundary looks like a splice |

The design decision was: **use a pixel model only as a corroborating signal, never as a primary
detector, and gate findings at a threshold calibrated on genuine documents of the same type.**

---

## Candidates evaluated

### TruFor ✅ (selected)

| Property | Value |
|---|---|
| **Source** | GRIP-UNINA ([github.com/grip-unina/TruFor](https://github.com/grip-unina/TruFor)) |
| **Architecture** | CMX encoder–decoder with Noiseprint++ (NP++) noise extractor and confidence head |
| **Input** | RGB image, any resolution (downscaled internally) |
| **Outputs** | Per-pixel manipulation map, confidence map, image-level detection score |
| **Weights** | `trufor.pth.tar` — non-commercial licence (GRIP-UNINA) |
| **Inference** | CPU-only, ~15 s/page on a laptop |

**Why selected:**
- Produces an image-level score (`sigmoid(det)`) and a per-pixel heatmap in a single forward pass,
  which allows both a threshold check and a visual display in experiment tooling.
- The confidence map (`conf`) lets the grader compute `map_p99_conf`, a hot-spot score that
  down-weights uncertain regions — useful on noisy scanned documents.
- Can be loaded safely in `weights_only=True` mode (checkpoint contains only tensors, an
  `OrderedDict`, NumPy scalars, and `_codecs.encode` — verified with `pickletools`).
- Calibration on genuine documents showed a separable score distribution at a conservative threshold
  (`tmax`).

**Known weaknesses on documents:**
- False-alarm rate on phone-style recompressed genuine pages is non-trivial; measured as
  `fpr_phone_tmax` in `thresholds.json` once calibrated.
- True-positive rate at `tmax` for forgeries the other layers miss: measured as `tpr_gap_tmax`.
- Model must be loaded from the working directory where `trufor.yaml` resides (the authors' config
  loader uses a relative path), requiring an `os.chdir` in the worker.

---

### Error Level Analysis (ELA) ❌ (rejected)

ELA re-saves the image at a fixed JPEG quality and measures the per-pixel difference. Regions that
were previously re-saved show less change (lower ELA residual) than untouched regions.

**Why rejected:**
- Phone photos of documents are re-saved multiple times before upload; the ELA residual is dominated
  by the upload chain, not by edits.
- Thermal receipts produce high ELA residuals across the entire background — indistinguishable from
  tampering.
- Gives no image-level score; requires manual threshold tuning per document type.
- Not suitable as an automated signal without a large labelled dataset to set thresholds.

---

### Noiseprint (standalone) ❌ (not adopted separately)

Noiseprint extracts camera fingerprint residuals and detects regions inconsistent with the dominant
camera pattern.

**Why not adopted separately:**
- Financial documents are not photographs; there is no "camera fingerprint" in a scanned or
  digitally produced PDF.
- Noiseprint++ is embedded inside TruFor's encoder, which already benefits from it.
- Running Noiseprint standalone would duplicate part of TruFor at extra cost with no clear gain.

---

### EXIF-based inconsistency checks ✅ (implemented in Layer 1)

Checking for EXIF software tags, creation/modification timestamps, and Photoshop APP13 segments
does not require a pixel model — it is deterministic and already covered by
[LAYER1_FILE_CHECKS.md](LAYER1_FILE_CHECKS.md). Not a candidate for Layer 3.

---

### Training-free pixel checks (October 2026)

Three checks that need no model were tried on the "Find it again!" receipts (real forgeries, mostly made in Paint and
GIMP; 355 of about 490 edited regions are a digit copied from elsewhere on the same receipt).

| Check | Idea | Outcome |
|---|---|---|
| JPEG compatibility | Untouched 8x8 blocks of a once-JPEG image re-quantise to themselves; new pixels do not | ❌ Not applicable to this data: no receipt kept a JPEG lattice at any quality (they were resampled after compression). On text over white, clipping also breaks the test unless clipped pixels are treated as bounds. Worth revisiting for lossless saves of unresized JPEG scans |
| Flat ink | Typed or drawn digits are filled with one exact grey; scanned ink always varies | ❌ Rejected: 50 of 240 genuine receipts have large flat dark areas (logos, black bars, saturated ink); it caught 2-3 forgeries on the edit |
| Copy-move (exact) | A pasted region repeats another place pixel for pixel; a scan never does | ✅ Adopted in Layer 1 (`docforensics/pixels.py`). Results in [EVALUATION.md](EVALUATION.md) |

Copy-move false alarms found and fixed on the way: ruled lines and page borders (identical along their length: patches
must now vary in both directions), saturated near-binary scans (chance repeats: patches must hold mid-tones, and a
region must outweigh the image's own chance matches), and rendered images (every glyph repeats: not judged).
JPEG compression after the paste removes the evidence (0 of 10 Paint forgeries found after a JPEG save at quality 75 or
92), so JPEG pixels are not compared. A copy-move check robust to JPEG needs approximate matching and its own
false-alarm study.

### LLM / VLM visual opinion (Layer 2, not Layer 3)

Asking a vision model "does this page look authentic?" is covered by the **visual inspection** call
in Layer 2 (see [LAYER2_CONTENT_CHECKS.md](LAYER2_CONTENT_CHECKS.md), §Visual inspection). It is
capped at LOW and requires corroboration. Not a pixel model.

---

## Calibration procedure

To generate `thresholds.json` for a new document population:

1. Collect ≥ 100 **known-genuine** pages of the target type (e.g. phone-photo payslips).
2. Render each at **130 DPI** lossless PNG (use `layer3.render_pngs` or the same pipeline).
3. Run them through the worker at `max_side=1024` (match production settings).
4. Record the `score` field for each page.
5. Compute `t95 = percentile(scores, 95)` and `tmax = max(scores)`.
6. Choose `severity_at_tmax` (`LOW` is recommended until a paired forgery evaluation is done).
7. Write `thresholds.json`:

```json
{
  "t95": 0.47,
  "tmax": 0.61,
  "severity_at_tmax": "LOW",
  "n_calibration": 143,
  "model": "trufor-v1",
  "measured": {
    "tpr_gap_tmax": 0.0,
    "fpr_phone_tmax": 0.0
  }
}
```

8. Measure `tpr_gap_tmax` (fraction of forgeries the other layers miss that Layer 3 catches at
   `tmax`) and `fpr_phone_tmax` (false-alarm rate on phone-recompressed genuine pages) from a
   paired evaluation and fill in `measured`.

> **The 130 DPI render resolution and `max_side=1024` are baked into the threshold values.**
> Changing either invalidates the calibration and requires a full re-run.

---

## What would improve Layer 3

1. **GPU acceleration.** The subprocess design already supports a GPU-equipped PyTorch environment;
   setting `PIXEL_PYTHON` to a CUDA-enabled interpreter is sufficient.
2. **Document-type-specific calibration.** Separate `thresholds.json` files for payslips, bank
   statements, invoices, and phone-photo receipts would reduce cross-type false alarms.
3. **A forgery evaluation set.** `tpr_gap_tmax` is currently unmeasured; a small set of
   pixel-level forgeries (inpainting, splice) on genuine document backgrounds would fill this in.
4. **Alternative localisation models.** CAT-Net, IML-ViT, and UniFD were identified as candidates
   but not evaluated due to the non-commercial licence constraint and the small calibration set.
   Evaluation is deferred until a commercial-licence model or an in-house trained model is available.
