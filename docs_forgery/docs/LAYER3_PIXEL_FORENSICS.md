# Layer 3 — Pixel Forensics

Layer 3 scores each rendered page with a trained forgery-localisation model (**TruFor**). It is
**opt-in, local, and experimental**: no data ever leaves the machine, but it requires a separate
Python environment with PyTorch and the model weights from GRIP-UNINA.

> **Design note.** Pixel models trained on photographs transfer weakly to documents (phone photos,
> compression artefacts, and scanner noise all look similar to tampering). Layer 3 is therefore
> deliberately conservative. See [EXPERIMENTS_PIXEL_MODELS.md](EXPERIMENTS_PIXEL_MODELS.md) for the
> model candidates that were evaluated before TruFor was chosen.

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

Calibrated thresholds are stored in `thresholds.json` (next to `__init__.py`). They are derived from
scoring a set of **known-genuine** calibration pages at 130 DPI and recording:

| Key | Meaning |
|---|---|
| `t95` | Score at the 95th percentile of genuine pages |
| `tmax` | Highest score any genuine calibration page reached |
| `severity_at_tmax` | Severity (`LOW` / `MEDIUM`) to assign when `score ≥ tmax` |
| `n_calibration` | Number of genuine pages used for calibration |
| `model` | Model identifier logged in the finding's evidence |
| `measured` | Optional: `tpr_gap_tmax`, `fpr_phone_tmax` from a paired evaluation |

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
    status:   str            # "ok" | "unavailable" | "failed"
    findings: list[Finding]  # PIXEL_ANOMALY findings
    errors:   list[str]      # human-readable error messages
    pages:    list[dict]     # per-page scores + heatmap (for display)
    seconds:  float          # wall-clock time for the whole layer
```

`status` is `"ok"` even if some pages failed, as long as at least one was scored successfully.

---

## Failure semantics

| Situation | `status` | Effect on verdict |
|---|---|---|
| PyTorch venv / weights not found | `unavailable` | `inconclusive` if no other findings |
| Page rendering failed | `failed` | `inconclusive` if no other findings |
| Worker subprocess timed out | `failed` | `inconclusive` if no other findings |
| Worker fatal error (no JSON output) | `failed` | `inconclusive` if no other findings |
| Some pages scored, some failed | `ok` (partial) | scored pages contribute |
| `thresholds.json` missing | `ok` | scores shown but no `Finding` raised |

Layer 3 exceptions are fully caught; they can never bring down the main analysis.

---

## Setup

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
