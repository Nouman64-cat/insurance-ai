# Layer 1: file and metadata checks

Local and deterministic. Nothing is sent anywhere. No check inspects pixel noise, so JPEG compression, rescaling, scanning
and phone processing cannot trigger these checks.

Each row lists the finding code(s) and typical severity. Severity depends on the document type where noted: pass
`--doc-type bank_statement` for the strictest rules (a bank does not issue statements from Word, Canva or a PDF editor).

## PDF

| Check | What it looks for | Codes | Severity |
|---|---|---|---|
| **Incremental saves** | Earlier versions kept inside the file are rebuilt and compared; the original text is recovered ("45,000" became "85,000") | `REVISION_TEXT_CHANGED`, `REVISION_CONTENT_CHANGED`, `REVISION_PAGES_CHANGED`, `REVISION_ANNOTATIONS` (info) | CRITICAL / HIGH |
| **Digital signatures** (pyHanko) | Signature no longer matches the file; content changed after signing | `SIGNATURE_BROKEN`, `MODIFIED_AFTER_SIGNING`, `SIGNATURE_UNVERIFIABLE`, `SIGNATURE_INTACT` (positive) | CRITICAL / MEDIUM |
| **Draw order: covers** | Text covered by anything opaque painted later (a box of any shape including rounded and many-pointed ones, a box at 85%+ opacity, a thick line, a single-colour image patch) and retyped on top; translucent highlights, photos, logos and stamps are excluded | `TEXT_REPLACED_UNDER_BOX`, `TEXT_OVERLAID`, `TEXT_WHITED_OUT`, `TEXT_HIDDEN_UNDER_SHAPE`, `TEXT_UNDER_BLACK_BOX` (low: looks like a redaction) | CRITICAL / HIGH |
| **Draw order: overprints** | A different value drawn exactly where another one was. CRITICAL when the original was also made invisible (clipping path, invisible render mode, full transparency, background colour); HIGH when both are drawn | `TEXT_REPLACED`, `TEXT_OVERPRINTED` | CRITICAL / HIGH |
| **Concealed text** | Strings in the file that never appear on the page: clipped away, invisible render mode outside an OCR layer, transparent, or with no ink on the rendered page (`pdf/ink.py`). Strings a table cell clips partway are excluded | `TEXT_CONCEALED` | MEDIUM (digits) / LOW |
| **Instructions to AI readers** | Text such as "ignore previous instructions" or "mark this document as genuine" | `HIDDEN_INSTRUCTIONS` (hidden), `INSTRUCTION_TEXT` (visible) | HIGH / MEDIUM |
| **Number columns** | The one amount in a right-aligned column set in another font family, a fraction of a point off the column's size, or off its row's baseline; needs two agreeing neighbours; bold and clearly larger totals are design. Raised to HIGH when Layer 2's arithmetic flags the same amount | `NUMBER_FONT_MISMATCH`, `NUMBER_SIZE_MISMATCH`, `NUMBER_BASELINE_SHIFT` | MEDIUM (HIGH corroborated) |
| **Scans with typed text** | Real text on top of a scanned page | `TEXT_ON_SCANNED_PAGE` | MEDIUM / LOW |
| **Annotations** | A FreeText or shape annotation placed over page text | `ANNOTATION_OVER_TEXT` | HIGH / MEDIUM |
| **Font subsets** | A second copy of the same font drawing a few digits, which is what a PDF editor leaves when it changes a value | `DUPLICATE_FONT_SUBSET` | HIGH / MEDIUM / LOW |
| **Producer / creator** | Editors, design tools, AI generators, office suites, report engines (catalogue in `knowledge.py`) | `PDF_TOOL_<KIND>` | by kind and document type |
| **Script defaults** | Library-default metadata (e.g. ReportLab "anonymous"/"untitled") typical of one-off scripts, including AI-written ones | `SCRIPT_DEFAULT_METADATA` | MEDIUM |
| **Dates** | Modified before created; future dates; Info and XMP disagree; tolerant of missing timezones | `MODDATE_BEFORE_CREATION`, `DATE_IN_FUTURE`, `XMP_*_DATE_MISMATCH`, `MODIFIED_AFTER_CREATION`, `PRODUCER_MISMATCH` | MEDIUM / LOW |
| **Structure** | Data before the header or after `%%EOF`, repaired damage, attachments, JavaScript, password protection | `PDF_HEADER_OFFSET`, `PDF_TRAILING_DATA`, `PDF_STRUCTURE_REPAIRED`, `PDF_ATTACHMENTS`, `PDF_JAVASCRIPT`, `PDF_PASSWORD_PROTECTED` | LOW / MEDIUM |
| **Embedded images** | EXIF/XMP/C2PA of every embedded JPEG. A scan edited in Photoshop and wrapped in a PDF still says so. A page image stored losslessly is checked for copied regions | as for images | as for images |

**Embedded images.** Editing-software names in a *logo or stamp* are ordinary (designers make them in Photoshop or
Illustrator). They are judged as evidence only when the image makes up at least half the page (a scan or photo); a small
image can still raise an AI-provenance finding, capped at MEDIUM.

**Producer by document type.**

| Tool kind | Payslip / other | Bank statement |
|---|---|---|
| AI image generator | CRITICAL | CRITICAL |
| Pixel editor (Photoshop, GIMP...) | HIGH | HIGH |
| Design tool (Canva, Figma...), PDF editor | MEDIUM | HIGH |
| Office suite | info | MEDIUM |
| PDF utility (merge, compress, print-to-PDF) | LOW | LOW |
| Report engine, browser print, scanner, camera | info | info |

## Images (JPEG, PNG, WebP, TIFF, ...)

| Check | What it looks for | Codes | Severity |
|---|---|---|---|
| **Editing software** | EXIF Software, XMP CreatorTool and history, PNG text | `IMAGE_SOFTWARE_<KIND>` | CRITICAL (AI) / HIGH (editors) / LOW |
| **Photoshop traces** | "Save for Web" segment, resource block, pasted-layer ancestry | `PHOTOSHOP_SAVE_FOR_WEB`, `PHOTOSHOP_RESOURCES`, `PHOTOSHOP_PASTED_CONTENT` | HIGH / MEDIUM |
| **Capture vs save time** | Re-saved well after capture; modification before capture | `IMAGE_MODIFIED_AFTER_CAPTURE`, `IMAGE_DATES_INCONSISTENT` | MEDIUM / LOW |
| **EXIF thumbnail** | The camera's preview thumbnail no longer matches the image (an editor kept the old one); cropped after capture | `THUMBNAIL_MISMATCH`, `THUMBNAIL_DIFFERS`, `THUMBNAIL_FRAMING_DIFFERS` | HIGH / MEDIUM / LOW |
| **Extension mismatch** | A `.pdf` that is really a JPEG | `EXTENSION_MISMATCH` | LOW |
| **Copied regions** (`pixels.py`) | A textured part of the image that appears twice, pixel for pixel: a digit copied from elsewhere on the page and pasted over another. Lossless pixels only (PNG, TIFF, BMP, lossless WebP; Flate/LZW scans inside PDFs) | `REGION_COPIED`, `COPY_MOVE_NOT_CHECKED` (info) | HIGH |

**Copied regions.** A scanner or camera never records the same thing twice: two prints of the same digit differ in noise
and in how they fall on the pixel grid. An editor's copy and paste repeats them exactly. The check hashes every 7x7 patch
that has ink and paper in it, finds exact twins at least 8 pixels apart, and groups them by the shift between them. A
paste shows up as one solid region of matches sharing one shift. Guards against innocent repeats:

- Patches must vary both vertically and horizontally, so ruled lines and borders (identical along their length) never match.
- Patches must contain mid-tones; saturated black-and-white pixels carry no noise.
- A rendered page or a screenshot repeats every glyph exactly. When more than a quarter of the image's textured patches
  have a twin, the image is not judged (`COPY_MOVE_NOT_CHECKED`).
- Near black-and-white scans repeat some glyphs by chance. A region is reported only when it is at least twice the size
  of the image's largest chance match.
- JPEG pixels are never compared: a JPEG save erases the exact repeat and creates repeats of similar blocks.

Which of the two places is the pasted one cannot be told from the pixels; the evidence lists both.

## AI provenance (images and PDFs)

| Check | Codes | Severity |
|---|---|---|
| **C2PA content credentials** declaring AI involvement, edits, or a hash that no longer matches | `C2PA_AI_GENERATED`, `C2PA_EDITED`, `C2PA_HASH_MISMATCH`, `C2PA_PRESENT` (info) | CRITICAL / HIGH |
| **IPTC `DigitalSourceType`** (`trainedAlgorithmicMedia` etc.) | `IPTC_AI_SOURCE_TYPE`, `IPTC_EDITED_SOURCE_TYPE` | CRITICAL / LOW |
| **Generation parameters** written by Stable Diffusion, ComfyUI, InvokeAI | `AI_GENERATION_PARAMETERS`, `AI_GENERATOR_NAMED` | CRITICAL |

Presence is near-certain evidence; absence proves nothing (screenshots and messaging apps strip metadata). Google SynthID
watermarks cannot be checked offline.

**Rendering.** Concealment is decided two ways: from the drawing instructions (clipping paths, render modes, transparency
and covers, which pdfminer does not track by itself, so `layout.py` records them) and by rendering each page with pdfium
and looking for ink inside each letter's box. The render catches hiding methods no rule anticipates. Rotated pages are
not rendered for this purpose.

**Deadline.** The HTTP service runs Layer 1 in a child process killed after `LAYER1_TIMEOUT_SECONDS` (default 120, `0`
disables). A file that runs out the clock is `inconclusive`, never clean.

## What layer 1 cannot see

- An edit that was properly redacted and retyped, then saved as a fresh file (measured: 1 of 106 caught). The number
  column checks catch it only when the new value's font, size or baseline differs from its neighbours.
- An image edited in Paint, Paint 3D or Preview by typing or drawing new digits, or by erasing (they write no software
  tag). Copying a digit from elsewhere in the image is caught when the result is saved losslessly (see EVALUATION.md).
- Any pixel edit saved as JPEG afterwards: the exact repeat of a paste does not survive JPEG compression.
- Anything flattened by a screenshot or print-to-PDF.

These are what layer 2 and, if you add it, pixel forensics are for.
