# fintechdocs-forgery-perturbation

Detects edited, manipulated and machine-generated financial documents (payslips, bank statements, invoices,
receipts) **without needing the issuer's template and without training data**.

> **Status: research prototype.** It produces evidence for a human reviewer, not a decision. See
> [Limitations](#limitations) and [docs/EVALUATION.md](docs/EVALUATION.md) before relying on any number here.

## The problem

An insurer receives documents from many employers and banks. Layouts differ and change, there are no originals to compare
against, and there is no labelled data to train on. Forgeries range from a retyped number in a PDF editor, to a Figma or
Photoshop rebuild, to a document generated end to end by an AI image model. Genuine documents arrive as compressed phone
photos and re-saved scans, so noise and compression must **not** be treated as evidence.

## How it works

Two independent layers. Each returns *findings* with a severity and an explanation; a small rule set turns them into a
verdict.

| Layer | Looks at | Needs | Catches |
|---|---|---|---|
| **1. File and metadata** | The file itself: edit history, draw order, fonts, signatures, producer tool, EXIF/XMP, AI provenance markers | Nothing. Runs locally | Edits that leave a trace in the file: incremental saves, white-out and retype, a second font for a changed value, Photoshop/Canva/AI-tool metadata, broken signatures |
| **2. Content consistency** | The page: figures and dates | A vision model (Gemini or Groq) to *read* the page | Edits that leave no trace in the file but break the document's own arithmetic: totals, running balances, payslip net pay, impossible dates, invalid IBANs |
| **3. Pixel forensics** *(experimental, opt-in, local)* | Rendered page images | PyTorch venv + TruFor weights (GRIP-UNINA, non-commercial) | Pixel-level manipulation anomalies; corroborating signal only — capped at LOW severity |

The key design rule of layer 2: **the model only reads; Python checks.** Arithmetic is exact (`Decimal`), figures are
verified against the PDF's own text or a second read, and a model failure is never treated as a clean result.

Pixel-forensics (noise analysis, ELA) is deliberately **not** used: it is the part most likely to confuse compression with
tampering.

## Verdicts

| Verdict | Rule | Meaning |
|---|---|---|
| `high_risk` | any CRITICAL finding, or two HIGH | The file shows an edit, or several strong signals agree |
| `review` | one HIGH, or two MEDIUM | Send to a person; the findings say what and where |
| `no_evidence` | anything less | Nothing found. **Not proof the document is genuine** |
| `inconclusive` | file unreadable, or layer 2 requested but could not run, and nothing else found | Unverified, not clean |

## Quick start

Developed on Python 3.15 on Windows; nothing is platform-specific.

```powershell
python -m venv venv
venv\Scripts\activate
pip install -r requirements-dev.txt        # requirements.txt for runtime only; -app.txt adds Streamlit
python -m unittest discover -s tests -t .  # 197 tests, all offline
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

**Demo app** (local only, no login: do not expose it)

```powershell
pip install -r requirements-app.txt
streamlit run app.py        # http://localhost:8501
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
  demo.py                helpers for the app (no Streamlit imports)
app.py                   Streamlit demo
scripts/                 dataset download, forgery generation, test runner, replay
tests/                   197 offline tests
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
| [docs/DEMO_APP.md](docs/DEMO_APP.md) | Using and securing the Streamlit app |

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
