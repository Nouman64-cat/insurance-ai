# Evaluation

Everything here was measured on **public and synthetic documents, not on real insurance submissions**. Datasets are not
redistributed (they are large, regenerable and carry their own licences); the scripts below rebuild them.

Read the numbers with these caveats:

- Layer 2 was **tuned after seeing** the 20 test documents, so they are development data, not a fair accuracy estimate.
- Ten documents per side is small. Intervals are wide (a 0 of 10 false-alarm rate has a 95% upper bound near 28%).
- Synthetic forgeries come from one generator. Real forgers are more varied.

## Layer 1

### Data

| Set | Source | Files |
|---|---|---|
| Genuine PDFs | 97 IRS forms and 11 invoices (Amazon, Flipkart, OYO and others, from the invoice2data test suite) | 108 |
| Forged PDFs | `scripts/forge_pdfs.py` changes one number on page 1 of each source, three ways | 318 |
| Receipt images | "Find it again!" (L3i, ICDAR 2023), derived from SROIE; real forgeries with the editing program recorded | 987 (825 genuine, 162 forged) |

### Results

| Test | Files | Result |
|---|---|---|
| Genuine PDFs | 108 | **0 flagged** |
| Genuine receipt images | 825 | **0 flagged** before the copy-move check; with it, 3 flagged `review` (1 of the 342 held out) |
| White box + retyped number, incremental save | 106 | 106 caught |
| White box + retyped number, file rewritten | 106 | 106 caught |
| Original text properly redacted, number retyped, file rewritten | 106 | 1 caught: leaves no trace in the file |
| Receipts edited in GIMP | 64 | 53 caught (83%): GIMP writes its name into the file |
| Receipts edited in Paint, Paint 3D, Preview | 94 | 0 caught from metadata (they write nothing); the copy-move check now catches most of them (below) |
| All forged receipts, whole service (`analyze_bytes`) | 162 | **136 flagged** (96 review, 40 high risk), up from 53; copy-move fired on 121. Includes the `train` split used to choose the two copy-move settings |

What this means: layer 1 is very quiet on genuine files, catches what leaves a trace, and cannot see a clean edit. That is
the job of layer 2.

### Copied regions in receipt images (pixels)

The copy-move check (`docforensics/pixels.py`) was measured on all 987 "Find it again!" receipts. Its two settings (a
region of at least 24 matching patches, at least twice the image's largest chance match) were chosen on the dataset's
`train` split only, allowing at most 0.5% false alarms there; `val` and `test` were not looked at while choosing. "Caught"
means a reported region overlaps a region the dataset's annotators marked as edited.

| Split | Genuine flagged | Forged caught on the edit |
|---|---|---|
| train (settings chosen here) | 2 of 483 | 70 of 94 (74%) |
| **val + test (held out)** | **1 of 342** (95% upper bound 1.6%) | **50 of 68 (74%**, 95% CI 61-83%) |

Held out, by editor: Paint 23/31, GIMP 18/24, Preview 5/8, Paint 3D 3/3, KolourPaint 1/2. The three genuine receipts
flagged show a dotted rule, faint speckle and one glyph repeated by the printer. Misses are mostly edits that are not
copies (typed or drawn digits, erasures) and copies too small or too saturated to tell from chance.

Limits of this measurement: one dataset, scanned receipts saved as PNG. A paste saved as JPEG is not caught at all (0 of
10 in a spot check), and rendered images and screenshots are not judged.

### Two false-alarm bugs found by testing on real files

- 17% of genuine PDFs were first flagged "Photoshop edited" because Adobe's own logos embedded in IRS forms carry designer-tool
  metadata. Editing-software names inside a small logo or stamp are now context; only an image that makes up the page is
  judged. False alarms fell to 0 of 108.
- PyMuPDF-made edits draw their white box as a closed path rather than a rectangle, which the detector missed. Fixed and
  covered by a test.

## Layer 2

### Test set

`scripts/make_layer2_testset.py` builds 20 documents with known ground truth:

| | Genuine | Forged |
|---|---|---|
| Real invoices | 3 | 3: grand total changed (text removed, new figure typed) |
| Real receipts | 3 | 3: edited in Paint, GIMP, Preview (from the dataset above) |
| Synthetic payslips (PDF and phone-style JPEG) | 2 | 2: net pay inflated |
| Synthetic bank statements (oldest-first, newest-first) | 2 | 2: one amount edited; one balance edited |

The forged receipts are labelled `expectation: unknown`: the dataset's forgers sometimes kept the arithmetic consistent,
which no content check can see.

### Runs

| Run | Documents | Genuine falsely flagged | Forged (payslip, statement, invoice) caught | Forged receipts caught |
|---|---|---|---|---|
| Gemini, first session (7 documents) | 7 | 1 of 5 | 2 of 2 (one payslip, one receipt) | |
| Gemini, same 7 re-scored after fixes (no API calls) | 7 | 0 of 5 | 2 of 2 | |
| Groq `qwen/qwen3.8-27b`, all 20, as first run | 20 | 1 of 10 | 7 of 7, each at the edited figure | 0 of 3 |
| Groq, same 20 re-scored after the review fixes (no API calls) | 20 | **0 of 10** | **7 of 7** | **0 of 3** |

Re-scored runs replay the saved model replies through the current checks. They show the effect of changes to the checks;
they are not independent tests.

### Flaws found by analysing the results, and what fixed them

| Observed | Cause | Fix |
|---|---|---|
| Genuine receipt flagged HIGH (total) | A "You saved 3.49" message was read as a discount and subtracted twice | The total accepts any consistent reading (tax added or included; discount subtracted or already in the prices); the prompt says savings messages are not discounts |
| Genuine invoice MEDIUM (line amount) | A per-line "Disc.%" column the schema had no field for | Per-line `discount_percent` is read and applied; an amount below quantity × price is only LOW |
| Genuine invoice invalid IBAN | The model misread `DE30…` as `DE78…`; the PDF text had it right | Identifiers are trusted only if found in the PDF's own text (else LOW) |
| Genuine receipt flagged HIGH (items ≠ subtotal) | Items listed at list price (sum = subtotal) with discounted nets printed beside them | Accepts the list-price reading, but only when amounts are at or below list price |
| 3 of 10 genuine receipts got a MEDIUM visual opinion | Font and sharpness differ on thermal receipts | Visual opinion is LOW unless it points at a figure another check flagged |
| Forged receipt total (6,868.41) missed on Groq | The reader transcribed it as 68.41 ("auto-correct"); the visual call quoted 6868.41 | Key-figure re-read on photos and scans (unit-tested, **not yet validated live**) |
| Net pay reported twice | "Net above gross" and "net ≠ gross − deductions" are one root cause | Reported once |
| Provider rate limits tripped 15 times | An output-tokens-per-minute limit (1,000) and a daily token cap (200,000) not modelled | Output caps, one visual page, header-driven waits, token usage logged |

### An earlier test that was withdrawn

An early layer-2 "ceiling test" was discarded. It made five model calls per document with no rate limit, and the code
swallowed every error, so quota failures (HTTP 429) were silently counted as "no findings". From the call timings, about
12 of its 20 documents were probably never analysed, and its "0% false alarms" rested on four documents. That is why failures
are now typed, why a failed layer 2 yields `inconclusive`, and why the runner stops on a spent quota.

## Reproduce

```powershell
# Layer 1
python scripts/download_pdf_corpus.py data/pdf_genuine
python scripts/forge_pdfs.py data/pdf_genuine data/pdf_forged            # needs requirements-dev.txt
python scripts/make_labels.py data/pdf_eval.csv genuine=data/pdf_genuine forged=data/pdf_forged
python scripts/evaluate.py data/pdf_eval.csv
# receipts: download findit2.zip from the L3i page (http://l3i-share.univ-lr.fr/2023Finditagain/) to data/findit2_raw,
# extract to data/findit2, then:
python scripts/labels_findit2.py data/findit2/findit2 data/findit2_eval.csv
python scripts/evaluate.py data/findit2_eval.csv

# Layer 2
python scripts/make_layer2_testset.py data/layer2_testset
python scripts/run_layer2_test.py --provider groq --dry-run              # plan and cost, no calls
python scripts/run_layer2_test.py --provider groq                        # saves after every document; resumes
python scripts/replay_layer2.py --run data/layer2_run_groq               # re-score with current checks, free
```

`run_layer2_test.py` options: `--cooldown` (seconds between requests), `--doc-gap`, `--max-calls` (session budget),
`--no-visual`, `--only IDS`, `--reset`. It stops at once on a spent quota or bad key, and after three unreadable documents in a
row. Documents that could not be read are listed as **failed** and excluded from the rates, never counted as clean.

## What would make these numbers trustworthy

1. Hundreds of **real** genuine submissions per channel (PDF, scan, phone photo) to measure the false-alarm rate that
   matters. Run layer 1 over them first: any `review` on a genuine file points at a rule to fix or a producer string to add
   to `knowledge.py`.
2. Forgeries made by people with the tools forgers actually use (Figma, Photoshop, AI inpainting), not a script.
3. A held-out layer-2 set that was never used to tune, on a paid tier so a run finishes in one sitting.
4. A live validation of the key-figure re-read on photos, and a comparison of more than one reader.
