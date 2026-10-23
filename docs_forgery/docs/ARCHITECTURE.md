# Architecture

## Data flow

```
 upload / file path
        │
        ▼
 detect type (PDF / JPEG / PNG / WebP / TIFF / GIF / HEIC / BMP)  ──► unknown: inconclusive
        │
        ├──────────────► LAYER 1  (local, deterministic, no network)
        │                 PDF:   metadata, revisions, signatures, draw order, annotations, fonts, embedded images
        │                 image: EXIF/XMP, Photoshop traces, thumbnail, C2PA / IPTC / prompt metadata
        │                 ──► findings
        │
        └──(opt-in)────► LAYER 2  (sends rendered pages to a vision model)
                          render pages ─► read once (model) ─► validate ─► check in code ─► verify ─► findings
                                                                            │
                                                  text layer (PDF) or second read (photo/scan)
        findings from both layers
                 │
                 ▼
        verdict rules (report.py)  ──►  no_evidence | review | high_risk | inconclusive
```

Layers never depend on each other, so a layer-2 outage cannot hide a layer-1 finding.

## Design principles

1. **Evidence, not decisions.** Every finding carries a severity, a plain-language explanation and structured evidence
   (the figures, the rows, the fonts). A person decides.
2. **No templates, no training.** Everything is derived from the document itself: its structure, or its own arithmetic.
3. **Compression is never evidence.** No check looks at pixel noise. The one pixel comparison (the EXIF preview thumbnail
   against the image) is coarse correlation that JPEG recompression does not move.
4. **The model reads; code checks.** Language models are unreliable at arithmetic and confident when wrong. The model only
   transcribes figures; every sum, balance and date comparison is exact `Decimal` arithmetic in Python.
5. **A failure is never "clean".** Quota, timeouts, blocked or unparseable replies end as `layer2_status: failed`. If
   nothing else was found the verdict is `inconclusive`, not `no_evidence`.
6. **Weak signals cannot decide alone.** A single MEDIUM finding never changes the verdict. Opinions (visual inspection)
   are capped and need corroboration.
7. **Verified before trusted.** A figure the model read is checked against the PDF's own text layer, or re-read, before a
   mismatch is allowed to be HIGH.
8. **Untrusted input.** The document is data. Prompts tell the model so, and text from the document is never pasted into
   later prompts (a "second-order" prompt-injection route).

## Verdict model (`docforensics/report.py`)

Severity: `INFO < LOW < MEDIUM < HIGH < CRITICAL`. Positive evidence (an intact signature) is category `authenticity` and is
excluded from the count.

| Verdict | Condition |
|---|---|
| `high_risk` | any CRITICAL, or ≥ 2 HIGH |
| `review` | 1 HIGH, or ≥ 2 MEDIUM |
| `no_evidence` | otherwise |
| `inconclusive` | file not parsed; or `no_evidence` while a requested layer is in `incomplete` |

`Report.layer2_status` is `None` (not requested), `ok`, `partial` (a secondary call failed, the main read succeeded) or
`failed` (the document was not read).

## Modules

| Module | Role |
|---|---|
| `__init__.py` | `analyze`, `analyze_bytes`, `analyze_document` (returns `Analysis` with the layer-2 result), `analyze_with_content` |
| `report.py` | `Finding`, `Report`, `Severity`, `Verdict`, `verdict_from_findings` |
| `knowledge.py` | Catalogue of editors, design tools, AI generators, report engines; severity by tool kind and document type |
| `pdf/` | `meta.py` producer/dates, `revisions.py` incremental saves, `signatures.py` (pyHanko), `layout.py` draw order and annotations, `fonts.py` font subsets, `images.py` embedded images |
| `image_checks.py` | EXIF/XMP software and dates, Photoshop segments, thumbnail comparison |
| `provenance.py`, `xmp.py` | C2PA manifests, IPTC `DigitalSourceType`, Stable Diffusion/ComfyUI parameters |
| `layer2/schema.py` | The extraction schema and strict validation of the model's reply |
| `layer2/prompts.py` | Extraction, second-read and visual prompts |
| `layer2/checks.py` | The deterministic checks (`Candidate` objects) |
| `layer2/render.py` | Page rendering (pypdfium2) and the PDF text layer |
| `layer2/runner.py` | Orchestration, verification, severity, `Layer2Result` |
| `gemini_client.py` | Provider-neutral `GeminiClient`: rate limiter, retries, typed errors, call log. The name is historical |
| `groq_client.py` | Groq transport (OpenAI-compatible), token-window handling |
| `demo.py` | UI-independent helpers for `app.py` |

## Failure semantics

Provider errors are typed (`GeminiError` subclasses): `config`, `auth`, `quota_exhausted` (daily, not retried),
`rate_limited` (per-minute, retried after the server's delay), `timeout`, `service_error`, `bad_request`, `blocked`,
`bad_response`. Nothing is swallowed. Every API attempt is recorded in a call log (purpose, status, seconds, time waited,
tokens, model).

## Extension points

- **A new provider:** implement `transport(request, settings) -> Reply`, raise typed errors, and register it in
  `make_client`. Checks, verification and the test runner need no change.
- **A new check:** add a function in `layer2/checks.py` returning `Candidate` objects, call it from `run_checks`. Numeric
  candidates are verified automatically from their `involved` figures.
- **New software names:** add a pattern to `knowledge.py`; it feeds the producer/creator and EXIF checks.
- **Country rules** (tax rates, ID formats): add as separate, opt-in checks. None are built in.
