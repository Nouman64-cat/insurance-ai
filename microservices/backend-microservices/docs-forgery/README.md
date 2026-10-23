# Document Forensics Microservice

Detects edited, manipulated and machine-generated financial documents (payslips, bank statements, invoices,
receipts) **without needing the issuer's template and without training data**.

> **Status: research prototype.** It produces evidence for a human reviewer, not a decision. See
> [Limitations](#limitations) and [docs/EVALUATION.md](docs/EVALUATION.md) before relying on any number here.

## Public testing UI

A separate [Forgery Detection frontend](../../frontend-microservices/forgery-detection-app/README.md)
is available without login at [http://localhost:3012](http://localhost:3012). Start it and
this backend from the repository root with:

```sh
docker compose build docs-forgery forgery-detection-app
docker compose up -d docs-forgery forgery-detection-app
```

The UI supports file uploads, analysis options, findings and evidence, and JSON downloads.
It proxies requests to this service over Docker's internal network; browser CORS changes
are not needed. This FastAPI service contains no frontend; the Next.js app supplies the UI.

## Service API

This FastAPI service lives at `microservices/backend-microservices/docs-forgery`.
The existing `docforensics` package supplies detection logic; `main.py` supplies the HTTP interface.
The CLI remains available for local analysis and development.

From the repository root:

```sh
docker compose up -d --build docs-forgery
curl http://localhost:8032/health
curl -X POST http://localhost:8032/analyze \
  -F 'file=@statement.pdf' -F 'doc_type=bank_statement'
```

Interactive API documentation: [Swagger UI](http://localhost:8032/docs).
Containers on `insurance-net` call `http://docs-forgery:8022`. The host port is bound to loopback.
This service has no database or Kafka dependency, no authentication, and is not yet connected to
API Gateway routes or automatic document-upload processing.

`POST /analyze` accepts multipart form fields:

| Field | Default | Meaning |
|---|---|---|
| `file` | required | PDF or JPEG, PNG, WebP, TIFF, GIF, HEIC/HEIF, BMP; detected from bytes |
| `doc_type` | omitted | `bank_statement`, `payslip`, `invoice`, `receipt`, `other` |
| `layer2` | `false` | Send rendered pages to an external model provider for content checks |
| `provider` | `gemini` | `gemini` or `groq`; used only with Layer 2 |
| `visual` | `false` | Additional visual model inspection, used only with Layer 2 |
| `max_pages` | `4` | Layer 2/3 page limit, from 1 to 40; Layer 1 retains its own 40-page limit |
| `layer3` | `false` | Local experimental TruFor; CPU runtime and official weights bundled in Docker |

The response is the report JSON: `path`, `file_type`, `sha256`, `size`, `verdict`,
`layer2_status`, `layer3_status`, `incomplete`, `findings`, `errors`, and `pixel_forensics`.
When requested, `pixel_forensics` includes the model name, calibration flag, elapsed time,
and per-page scores, page numbers and base64 PNG anomaly heatmaps.
Findings include a code, severity, category, explanation, and evidence.
Empty uploads return 400, documents over 100 MiB return 413, unsupported content returns 415,
and invalid form options return 422. A recognized but unreadable document returns an
`inconclusive` report with HTTP 200. Requested analysis-layer failures remain visible in the report.
The application bounds its read before analysis; multipart uploads may be spooled to temporary
storage by the HTTP framework. No document archive is created by this service.

Layer 1 needs no credentials. For Layer 2 in Compose, put `GEMINI_API_KEY` or `GROQ_API_KEY`
in the repository-root `.env` (loaded by the shared Compose defaults). Model settings are
shown in `.env.example`; they are separate from the platform's shared LLM configuration.
For example:

```sh
curl -X POST http://localhost:8032/analyze \
  -F 'file=@statement.pdf' -F 'doc_type=bank_statement' \
  -F 'layer2=true' -F 'provider=gemini'
```

The default Docker image includes a CPU-only PyTorch environment at `/opt/pixel-venv` and
pinned upstream TruFor code and checksum-verified official weights at `/opt/trufor`. No host
venv, GPU, or manual model download is needed. The first build downloads the model and
runtime; subsequent builds reuse Docker layers. These paths stay outside `/app` so the
development source mount cannot hide them.

Enable `layer3=true` to return per-page scores and PNG heatmaps under `pixel_forensics`.
`GET /health` includes pixel availability and calibration status. There is no document-specific
calibration dataset in this repository: the UI labels these raw scores as uncalibrated and
they do not determine a verdict. To apply validated calibration, mount a thresholds JSON file
and set `PIXEL_THRESHOLDS` to its container path (see Layer 3 documentation).

TruFor's upstream licence limits use to informational and nonprofit purposes. The integration
is for the testing/research workspace; the model is not a commercially licensed detector.

For local development, from the service directory:

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn main:app --host 127.0.0.1 --port 8022 --reload
python -m unittest discover -s tests -t .
```

## The problem

An insurer receives documents from many employers and banks. Layouts differ and change, there are no originals to compare
against, and there is no labelled data to train on. Forgeries range from a retyped number in a PDF editor, to a Figma or
Photoshop rebuild, to a document generated end to end by an AI image model. Genuine documents arrive as compressed phone
photos and re-saved scans, so noise and compression must **not** be treated as evidence.

## How it works

Three analysis layers (the third is experimental). Each returns *findings* with a severity and an explanation; a small rule set turns them into a
verdict.

| Layer | Looks at | Needs | Catches |
|---|---|---|---|
| **1. File and metadata** | The file itself: edit history, draw order, fonts, signatures, producer tool, EXIF/XMP, AI provenance markers | Nothing. Runs locally | Edits that leave a trace in the file: incremental saves, white-out and retype, a second font for a changed value, Photoshop/Canva/AI-tool metadata, broken signatures |
| **2. Content consistency** | The page: figures and dates | A vision model (Gemini or Groq) to *read* the page | Edits that leave no trace in the file but break the document's own arithmetic: totals, running balances, payslip net pay, impossible dates, invalid IBANs |
| **3. Pixel forensics** *(experimental, opt-in, local)* | Rendered page images | PyTorch venv + TruFor weights (GRIP-UNINA, non-commercial) | Pixel-level manipulation anomalies; corroborating signal only — capped at LOW severity |

The key design rule of layer 2: **the model only reads; Python checks.** Arithmetic is exact (`Decimal`), figures are
verified against the PDF's own text or a second read, and a model failure is never treated as a clean result.

Handcrafted pixel heuristics (noise analysis, ELA) are deliberately **not** used: it is the part most likely to confuse compression with
tampering.

## Verdicts

| Verdict | Rule | Meaning |
|---|---|---|
| `high_risk` | any CRITICAL finding, or two HIGH | The file shows an edit, or several strong signals agree |
| `review` | one HIGH, or two MEDIUM | Send to a person; the findings say what and where |
| `no_evidence` | anything less | Nothing found. **Not proof the document is genuine** |
| `inconclusive` | file unreadable, or layer 2 requested but could not run, and nothing else found | Unverified, not clean |

## Quick start

The service Docker image uses Python 3.12. For the optional CLI, install dependencies from the service directory.

```powershell
python -m venv venv
venv\Scripts\activate
pip install -r requirements-dev.txt        # requirements.txt for runtime only
python -m unittest discover -s tests -t .  # offline engine, API and CLI tests
```

**Command line**

```powershell
python -m docforensics statement.pdf --doc-type bank_statement          # layer 1 only, local
python -m docforensics payslip.jpg --doc-type payslip --layer2           # + layer 2 (sends the page to the provider)
python -m docforensics doc.pdf --json
```

**Python**

```python
from docforensics import analyze_document, Layer2Options
from docforensics.gemini_client import make_client

a = analyze_document(open("slip.pdf", "rb").read(), "slip.pdf", "payslip",
                     layer2=True, client=make_client("groq"), options=Layer2Options(visual=False))
a.report.verdict, a.report.layer2_status, a.report.sorted_findings()
```

**Configuration:** copy `.env.example` to `.env` and add a key for the provider you use. `.env` is git-ignored.

## Results at a glance

Measured on public and synthetic documents, **not** on real insurance submissions. Details, caveats and how to reproduce:
[docs/EVALUATION.md](docs/EVALUATION.md).

| Test | Result |
|---|---|
| Layer 1, genuine PDFs (97 IRS forms, 11 invoices) | 0 of 108 flagged |
| Layer 1, genuine receipt photos | 0 of 825 flagged |
| Layer 1, PDF white-out + retype, incremental save / full rewrite | 106 of 106 / 106 of 106 caught |
| Layer 1, PDF text properly redacted and retyped | 1 of 106 (leaves no trace in the file) |
| Layer 1, receipt images edited in GIMP / in Paint, Paint 3D, Preview | 53 of 64 / 0 of 94 (only GIMP writes its name into the file) |
| Layer 2 (Groq, 20 documents), payslip / statement / invoice forgeries | 7 of 7 caught, each at the edited figure |
| Layer 2 (Groq), genuine documents falsely flagged | 0 of 10 after fixes (1 of 10 before) |
| Layer 2 (Groq), forged receipts | 0 of 3 |

Layer 2 was tuned after seeing these 20 documents, so they are development data. Treat the layer-2 numbers as "the design
works on these cases", not as an accuracy estimate.

## Repository layout

```
docforensics/            the package
  __init__.py            analyze / analyze_document entry points
  report.py              Finding, Report, Severity, verdict rules
  knowledge.py           catalogue of editing/AI/generator software names
  pdf/                   layer 1 for PDFs (revisions, signatures, layout, fonts, metadata, images)
  image_checks.py        layer 1 for images (EXIF/XMP, thumbnails, Photoshop traces)
  provenance.py, xmp.py  C2PA, IPTC, Stable Diffusion metadata
  layer2/                layer 2: schema, prompts, checks, render, runner
  gemini_client.py       provider-neutral client: rate limit, retries, typed errors, call log
  groq_client.py         Groq transport
main.py                  FastAPI service (/health, /analyze)
schemas.py               HTTP response contract
Dockerfile               service image
scripts/                 dataset download, forgery generation, test runner, replay
tests/                   offline engine, API and CLI tests
docs/                    documentation (below)
```

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Data flow, design principles, verdict model, failure semantics |
| [docs/LAYER1_FILE_CHECKS.md](docs/LAYER1_FILE_CHECKS.md) | Every file and metadata check, with codes and severities |
| [docs/LAYER2_CONTENT_CHECKS.md](docs/LAYER2_CONTENT_CHECKS.md) | The extraction schema, each equation, verification, severity rules |
| [docs/LAYER3_PIXEL_FORENSICS.md](docs/LAYER3_PIXEL_FORENSICS.md) | TruFor integration, thresholds, grading, failure semantics, setup |
| [docs/EXPERIMENTS_PIXEL_MODELS.md](docs/EXPERIMENTS_PIXEL_MODELS.md) | Model candidates evaluated for Layer 3; why TruFor was chosen |
| [docs/PROVIDERS_AND_LIMITS.md](docs/PROVIDERS_AND_LIMITS.md) | Gemini and Groq setup, observed rate limits, settings, cooldowns |
| [docs/EVALUATION.md](docs/EVALUATION.md) | Datasets, test sets, results, flaws found and fixed, how to reproduce |

## Limitations

- **Absence of evidence is common.** A screenshot, a "print to PDF", or an edit that keeps the arithmetic consistent leaves
  nothing for either layer to find. Layer 2 cannot see a forged figure that the forger also propagated to every dependent
  total.
- **Layer 2 depends on a model reading digits correctly.** Misreads cause false alarms, and a model can silently "correct"
  an edited figure. Several safeguards exist (see layer-2 doc) but the reader is the weakest link.
- **Tuned on a small set.** 20 documents, 10 per side. Intervals are wide.
- **Customer documents leave the machine in layer 2.** Agree data-processing terms with the provider first; free-tier
  terms differ. Layer 1 never sends anything anywhere.
- **Region-agnostic rules only.** Country-specific checks (tax rates, ID formats, trust lists for signatures) are not
  included. Signature integrity is checked; whether the certificate belongs to the bank is not.
- **No licence has been chosen yet.** Third-party datasets used for evaluation carry their own licences and are not
  redistributed here.
