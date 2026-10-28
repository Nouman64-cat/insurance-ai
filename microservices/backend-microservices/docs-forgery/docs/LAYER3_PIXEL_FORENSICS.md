# Layer 3 — Pixel Forensics

Layer 3 scores each rendered page with a trained forgery-localisation model (**TruFor**). It is
**opt-in, local, and experimental**: no data ever leaves the machine, but it requires a separate
Python environment with PyTorch and the model weights from GRIP-UNINA.

> **Design note.** Pixel models trained on photographs transfer weakly to documents (phone photos,
> compression artefacts, and scanner noise all look similar to tampering). Layer 3 is therefore
> deliberately conservative. See [EXPERIMENTS_PIXEL_MODELS.md](EXPERIMENTS_PIXEL_MODELS.md) for the
> model candidates that were evaluated before TruFor was chosen.
>
> **Pixel checks that need no model run by default in Layer 1.** A digit copied from elsewhere on a
> scan and pasted over another is found by exact copy-move matching (`docforensics/pixels.py`,
> code `REGION_COPIED`), on every lossless image and lossless scan inside a PDF. It is fast, licence-free
> and measured on real forgeries ([EVALUATION.md](EVALUATION.md)). TruFor remains opt-in.

---

## When it runs

Layer 3 is only active when the caller explicitly requests it **and** the environment is set up.
Calling `availability()` returns a `(bool, reason)` pair; if `False`, the layer is marked
`unavailable` and the analysis continues without it. A layer-3 failure never hides findings from
layers 1 or 2.

---

## Architecture

```
Document bytes
      │
      ▼
render_pngs()          PNG per page, lossless (no JPEG hop)
   @ 130 DPI, ≤ max_pages pages
      │
      ▼
_subprocess_runner()   stdin/stdout framing protocol
      │  subprocess.run([pixel_python, trufor_worker.py, models_dir, max_side])
      ▼
trufor_worker.py       runs in the PyTorch venv
   load_model()  →  TruFor (myEncoderDecoder)
   score_image() →  {score, map_mean, map_p99, map_p99_conf, map_png_b64, …} per page
      │
      ▼
grade()                compare score against calibrated thresholds (thresholds.json)
      │
      ▼
Layer3Result           {status, findings, errors, pages, seconds}
```

### Why a subprocess?

The main application has no PyTorch dependency. Running the model worker as a child process with a
separate Python interpreter keeps the dependency out of the main environment. Communication is over
stdin/stdout using a simple length-prefixed frame protocol (4-byte big-endian length + PNG bytes; a
zero-length frame signals end-of-input).

---

## The model — TruFor

| Property | Detail |
|---|---|
| **Architecture** | `myEncoderDecoder` (CMX encoder–decoder with NP + confidence head) |
| **Weights file** | `trufor.pth.tar` (from GRIP-UNINA) |
| **Checkpoint loading** | `torch.load` in `weights_only=True` mode; only safe globals allow-listed (NumPy scalars, `_codecs.encode`, dtype objects) |
| **Inference device** | CPU (no GPU required; ~15 s / page on a laptop) |
| **Input** | RGB page image, longer side ≤ `max_side` (default 1 024 px), downscaled with LANCZOS |
| **Outputs** | Per-pixel manipulation probability map (`pred`), confidence map (`conf`), image-level detection score (`det`) |
| **Licence** | GRIP-UNINA — **informational and non-profit use only** |

The model weights are **not** part of this repository. Download them from the
[GRIP-UNINA TruFor release](https://github.com/grip-unina/TruFor).

### Output fields (per page, from the worker)

| Field | Meaning |
|---|---|
| `score` | `sigmoid(det)` — image-level forgery probability [0, 1] |
| `map_mean` | Mean of the softmax forgery-class map |
| `map_p99` | 99th-percentile of the map (hot-spot indicator) |
| `map_p99_conf` | 99th-percentile of `map × conf` (confidence-weighted hot-spot) |
| `map_png_b64` | Base64-encoded thumbnail heatmap (PNG, ≤ 256 × 256) for display |
| `size` | Original image dimensions `[w, h]` before downscaling |
| `scale` | Scale factor applied (`1.0` if the image was already small enough) |
| `seconds` | Inference time for this page |

---

## Rendering

Pages are rendered at **130 DPI** (lossless PNG, no JPEG re-encoding). This is the exact resolution
used during calibration; changing it invalidates `thresholds.json`.

Only the first `max_pages` pages are scored (default: **1**). Each page takes ~15 s on a laptop CPU
plus a one-time ~10 s model load time.

---

## Thresholds and grading

Optional calibrated thresholds are loaded from `PIXEL_THRESHOLDS`, or `thresholds.json` next to `__init__.py`. A provisional public-reference calibration file is shipped; it is not validated for customer submissions. They must be derived from
scoring a set of **known-genuine** calibration pages at 130 DPI and recording:

| Key | Meaning |
|---|---|
| `t95` | Score at the 95th percentile of genuine pages |
| `tmax` | Highest score any genuine calibration page reached |
| `severity_at_tmax` | Severity (`INFO` / `LOW` only) to assign when `score ≥ tmax` |
| `n_calibration` | Number of genuine pages used for calibration |
| `model` | Model identifier logged in the finding's evidence |
| `measured` | Optional: `tpr_gap_tmax`, `fpr_phone_tmax` from a paired evaluation |

### Packaged reference baseline

The current measured cutoffs are `t95 = 0.5256373882293701` and
`tmax = 0.7155507206916809`, using 21 calibration first pages and 9 separate
validation first pages. None of the 9 validation references reached either cutoff.
This small, source-specific result is not a customer-document false-positive guarantee.
No forged-case detection rate was measured in this calibration run. The JSON records
all source hashes and scores, plus model/software provenance.

### Grading logic (`grade()`)

```
score < t95           →  no finding (INFO suppressed)
t95 ≤ score < tmax   →  Finding severity INFO  ("slightly elevated")
score ≥ tmax          →  Finding severity = severity_at_tmax  ("unusual")
```

A finding is **never raised** if `thresholds.json` is absent (scores are still returned for display).

### Finding code

| Code | Category | Maximum severity |
|---|---|---|
| `PIXEL_ANOMALY` | `TAMPERING` | `LOW` (current calibration) |

The finding evidence block includes: `score`, `t95`, `tmax`, `map_p99`, `page` number, `model`,
and `source: "layer3"`.

> **Severity cap.** A single MEDIUM finding cannot change the verdict (architecture rule 6). Layer 3
> findings are currently capped at LOW, so they can never decide the verdict alone — they act as a
> corroborating signal.

---

## `Layer3Result`

```python
@dataclass
class Layer3Result:
    status:   str            # "ok" | "partial" | "unavailable" | "failed"
    findings: list[Finding]  # PIXEL_ANOMALY findings
    errors:   list[str]      # human-readable error messages
    pages:    list[dict]     # per-page scores + heatmap (for display)
    seconds:  float          # wall-clock time for the whole layer
```

`status` is `"partial"` if some pages fail or are missing; the report lists Layer 3 as incomplete.

---

## Failure semantics

| Situation | `status` | Effect on verdict |
|---|---|---|
| PyTorch venv / weights not found | `unavailable` | `inconclusive` if no other findings |
| Page rendering failed | `failed` | `inconclusive` if no other findings |
| Worker subprocess timed out before scoring any page | `failed` | `inconclusive` if no other findings |
| Worker timed out after scoring some pages | `partial` | pages already scored are kept and graded; the rest are listed as not scored |
| Worker fatal error (no JSON output) | `failed` | `inconclusive` if no other findings |
| Some pages scored, some failed | `partial` | incomplete; cannot produce a clean result |
| `thresholds.json` missing | `ok` | scores shown but no `Finding` raised |

Layer 3 exceptions are fully caught; they can never bring down the main analysis.

---

## Docker setup (default)

From the repository root:

```sh
docker compose build docs-forgery forgery-detection-app
docker compose up -d --wait docs-forgery forgery-detection-app
curl http://localhost:8032/health
```

Open http://localhost:3012, upload a document, enable Pixel forensics and analyze.
The backend image installs PyTorch 2.6.0 (CPU), torchvision 0.21.0 and the pinned
`requirements-pixel.txt` dependencies in `/opt/pixel-venv`. It downloads upstream source
revision `ae54475df6f41a491d7615100feb19263dec13f7` and the official weights into `/opt/trufor`.
The official archive must match the MD5 published by upstream. If its server is unreachable,
the installer uses the checkpoint mirrored in Hugging Face Space `jatin-tech/Tru_Image_Classifier`,
pinned to revision `1eb63112bc3219694c93dc5a8b826e2593bbc8a0`, and verifies SHA-256
`ac1d90e329a72e0d66e8665e123a19e94bfae3209c3ef8a4f9ca3b91578c7844`.
A checksum mismatch fails the build. The asset directory records source and licence information.
No downloads happen during an analysis. The model assets are outside the development mount.

`PIXEL_PYTHON` and `TRUFOR_DIR` are set by Compose; no host setup is needed. CPU inference is
serialized within each API process to bound peak memory; two CPU threads are used by default.
The API includes per-page scores and base64 PNG heatmaps in `pixel_forensics`; the UI renders them.

The image ships a measured, provisional public-reference baseline. Its JSON records the
input document hashes, source URLs, split membership, raw scores and held-out genuine-reference
exceedance rates. No forged-case sensitivity or customer-document performance is claimed.
The UI presents these limits alongside the cutoffs. In the API, `calibrated: true` means
a compatible threshold file was loaded; it does not certify validation for your document population. Scores are never forgery probabilities.
You can replace the baseline using your own disjoint genuine calibration and validation sets.

## Manual setup (running outside Docker)

### 1. Create a PyTorch virtual environment

```bash
python -m venv venv_exp
venv_exp/bin/pip install torch torchvision timm yacs pillow numpy
```

Set `PIXEL_PYTHON` to the interpreter path, or place the venv at `<repo>/venv_exp/`.

### 2. Download TruFor

Clone or download the GRIP-UNINA TruFor release so that the directory contains:
```
code/test_docker/src/   ← authors' source (trufor.yaml is read from here)
weights/trufor.pth.tar  ← or any path matched by rglob("trufor.pth.tar")
```

Set `TRUFOR_DIR` to that directory, or place it at `<repo>/data/models/trufor/`.

### 3. Check availability

```python
from docforensics.layer3 import availability
ok, reason = availability()
print(ok, reason)
```

### 4. Run

```python
from docforensics.layer3 import run_layer3, Layer3Options

result = run_layer3(file_bytes, "pdf", Layer3Options(max_pages=1))
print(result.status, result.findings, result.pages)
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PIXEL_PYTHON` | `<repo>/venv_exp/bin/python` | Python interpreter with PyTorch |
| `TRUFOR_DIR` | `<repo>/data/models/trufor` | Root of TruFor code + weights |
| `PIXEL_THRESHOLDS` | optional package `thresholds.json` | Validated document calibration JSON |

---

## `Layer3Options`

| Option | Default | Notes |
|---|---|---|
| `max_pages` | `1` | Pages to score. Each adds ~15 s on CPU |
| `max_side` | `1024` | Longer side capped before inference. Must match calibration |
| `timeout_s` | `300.0` | Subprocess timeout in seconds |

---

## Limitations

- **Photograph-domain bias.** TruFor was trained on manipulated photographs, not on financial
  documents. False-alarm rates on phone-scanned genuine documents are non-trivial (see
  [EXPERIMENTS_PIXEL_MODELS.md](EXPERIMENTS_PIXEL_MODELS.md)).
- **CPU-only, slow.** Approximately 15 s per page plus 10 s model-load overhead. Not suitable for
  high-volume pipelines without GPU acceleration.
- **Conservative by design.** The grading threshold is `tmax` (the maximum genuine score), so many
  forgeries score below the threshold and produce no finding.
- **Non-commercial licence.** TruFor weights are released for informational and non-profit use only
  (GRIP-UNINA). Confirm compliance before deploying in a commercial product.
- **Calibration is document-type specific.** `thresholds.json` must be re-calibrated for the actual
  document population (see [EVALUATION.md](EVALUATION.md)).

## Calibrating thresholds

To reproduce the public-reference baseline from the repository root:

```sh
docker compose exec -T docs-forgery python scripts/calibrate_pixel.py --reference
```

The command downloads 20 official IRS PDFs and 10 public invoice2data fixtures, rendering
only their first pages at 130 DPI and scoring with a 1024-pixel maximum side. It assigns
21 documents to calibration and 9 to validation using a source-stratified split chosen
before scores are observed. PDFs stay in the ignored `data/calibration` cache. The model
loads once and prints progress for every page. It can take several minutes on CPU.

`t95` is the linearly interpolated 95th percentile of calibration scores; `tmax` is their
maximum. Validation pages do not influence either value. Exceedance uses `>=`, including
at exact boundaries. Thresholds are written atomically only after every page succeeds.
Public source files can change over time; the recorded SHA-256 hashes identify the exact
download snapshot used. A rerun on updated sources produces a new dated baseline.
The JSON is included in Docker images and loaded per request; source mounts expose the
same file in development. Rebuild images when deploying updated thresholds.

The reference set is a development baseline: blank tax forms and public invoice test
fixtures are not representative verified customer submissions, and the invoices are
assumed untampered rather than issuer-verified. The validation set is small and contains
no forged cases, phone captures or recompressed scans. Its exceedance rates are sample
measurements, not an operational false-positive guarantee or sensitivity estimate.

For your own genuine corpus, create CSV with `path,label,split`:

```csv
path,label,split
genuine/cal-001.pdf,genuine,calibration
genuine/val-001.pdf,genuine,validation
```

Supply at least 20 calibration documents and 5 separate validation documents. Duplicate
content is rejected across the whole set. Paths are relative to the CSV directory.

```sh
docker compose exec -T docs-forgery python scripts/calibrate_pixel.py \
  --labels data/genuine-split.csv --out docforensics/layer3/thresholds.json
```

Evaluate detection separately with held-out genuine and forged documents using the benchmark
runner. Do not reuse the validation set for tuning and then describe it as held-out.
`PIXEL_THRESHOLDS` can override the packaged file. Invalid numbers, cutoffs out of order,
severities above LOW, and incompatible rendering settings are rejected. Results scored at
a different image size do not use the cutoffs. The service fails back to visibly uncalibrated
raw output rather than applying an invalid configuration.
