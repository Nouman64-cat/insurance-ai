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
| **Draw order** | Text covered by an opaque box and retyped on top; text hidden under a shape; translucent highlights are excluded | `TEXT_REPLACED_UNDER_BOX`, `TEXT_OVERLAID`, `TEXT_WHITED_OUT`, `TEXT_HIDDEN_UNDER_SHAPE`, `TEXT_UNDER_BLACK_BOX` (low: looks like a redaction) | CRITICAL / HIGH |
| **Scans with typed text** | Real text on top of a scanned page | `TEXT_ON_SCANNED_PAGE` | MEDIUM / LOW |
| **Annotations** | A FreeText or shape annotation placed over page text | `ANNOTATION_OVER_TEXT` | HIGH / MEDIUM |
| **Font subsets** | A second copy of the same font drawing a few digits, which is what a PDF editor leaves when it changes a value | `DUPLICATE_FONT_SUBSET` | HIGH / MEDIUM / LOW |
| **Producer / creator** | Editors, design tools, AI generators, office suites, report engines (catalogue in `knowledge.py`) | `PDF_TOOL_<KIND>` | by kind and document type |
| **Script defaults** | Library-default metadata (e.g. ReportLab "anonymous"/"untitled") typical of one-off scripts, including AI-written ones | `SCRIPT_DEFAULT_METADATA` | MEDIUM |
| **Dates** | Modified before created; future dates; Info and XMP disagree; tolerant of missing timezones | `MODDATE_BEFORE_CREATION`, `DATE_IN_FUTURE`, `XMP_*_DATE_MISMATCH`, `MODIFIED_AFTER_CREATION`, `PRODUCER_MISMATCH` | MEDIUM / LOW |
| **Structure** | Data before the header or after `%%EOF`, repaired damage, attachments, JavaScript, password protection | `PDF_HEADER_OFFSET`, `PDF_TRAILING_DATA`, `PDF_STRUCTURE_REPAIRED`, `PDF_ATTACHMENTS`, `PDF_JAVASCRIPT`, `PDF_PASSWORD_PROTECTED` | LOW / MEDIUM |
| **Embedded images** | EXIF/XMP/C2PA of every embedded JPEG. A scan edited in Photoshop and wrapped in a PDF still says so | as for images | as for images |

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

## AI provenance (images and PDFs)

| Check | Codes | Severity |
|---|---|---|
| **C2PA content credentials** declaring AI involvement, edits, or a hash that no longer matches | `C2PA_AI_GENERATED`, `C2PA_EDITED`, `C2PA_HASH_MISMATCH`, `C2PA_PRESENT` (info) | CRITICAL / HIGH |
| **IPTC `DigitalSourceType`** (`trainedAlgorithmicMedia` etc.) | `IPTC_AI_SOURCE_TYPE`, `IPTC_EDITED_SOURCE_TYPE` | CRITICAL / LOW |
| **Generation parameters** written by Stable Diffusion, ComfyUI, InvokeAI | `AI_GENERATION_PARAMETERS`, `AI_GENERATOR_NAMED` | CRITICAL |

Presence is near-certain evidence; absence proves nothing (screenshots and messaging apps strip metadata). Google SynthID
watermarks cannot be checked offline.

## What layer 1 cannot see

- An edit that was properly redacted and retyped, then saved as a fresh file (measured: 1 of 106 caught).
- An image edited in Paint, Paint 3D or Preview (they write no software tag; measured: 0 of 94).
- Anything flattened by a screenshot or print-to-PDF.

These are what layer 2 and, if you add it, pixel forensics are for.
