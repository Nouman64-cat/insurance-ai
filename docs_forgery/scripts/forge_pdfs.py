"""Make forged copies of genuine PDFs the way PDF editors do (test data only).

    python scripts/forge_pdfs.py data/pdf_genuine data/pdf_forged

For each source PDF, one number on page 1 is changed by three techniques:

  overlay_incremental  white box over the number, new number typed on top, incremental save
                       (Acrobat, Foxit and most desktop editors by default)
  overlay_rewrite      same edit, file rewritten from scratch (online editors, "Save As")
  redact_rewrite       original glyphs removed with a redaction, new number typed in the gap,
                       file rewritten: the cleanest edit a non-expert can make

Metadata is left untouched in every case, so producer-based checks get no help.
Requires PyMuPDF (AGPL), used only to generate test data.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pymupdf

NUMBER = re.compile(r"^\$?\d[\d,.]*\d$")


def _new_value(text: str) -> str:
    digits = [i for i, c in enumerate(text) if c.isdigit()]
    out = list(text)
    for i in digits[:2]:
        out[i] = str((int(out[i]) + 3) % 10)
    return "".join(out)


def _target(page: pymupdf.Page):
    for x0, y0, x1, y1, word, *_ in page.get_text("words"):
        if NUMBER.match(word) and len(word) >= 3 and (x1 - x0) > 4:
            return pymupdf.Rect(x0, y0, x1, y1), word
    return None, None


def _font_size(page: pymupdf.Page, rect: pymupdf.Rect) -> float:
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                if pymupdf.Rect(span["bbox"]).intersects(rect):
                    return span["size"]
    return rect.height * 0.8


def forge(src: Path, out_dir: Path) -> list[dict]:
    made = []
    for technique in ("overlay_incremental", "overlay_rewrite", "redact_rewrite"):
        dest = out_dir / technique / f"{src.parent.name}_{src.stem}.pdf"
        dest.parent.mkdir(parents=True, exist_ok=True)
        incremental = technique == "overlay_incremental"
        if incremental:
            dest.write_bytes(src.read_bytes())  # PyMuPDF appends an incremental save to the file it opened
        doc = pymupdf.open(dest if incremental else src)
        try:
            if doc.needs_pass or doc.page_count == 0:
                break
            page = doc[0]
            rect, old = _target(page)
            if rect is None:
                break
            new = _new_value(old)
            size = _font_size(page, rect)
            if technique == "redact_rewrite":
                page.add_redact_annot(rect, fill=(1, 1, 1))
                page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)
            else:
                page.draw_rect(rect, color=None, fill=(1, 1, 1), overlay=True)
            page.insert_text((rect.x0, rect.y1 - size * 0.22), new, fontsize=size, fontname="helv", color=(0, 0, 0))
            if incremental:
                doc.save(dest, incremental=True, encryption=pymupdf.PDF_ENCRYPT_KEEP)
            else:
                doc.save(dest, garbage=3, deflate=True)
        finally:
            doc.close()
        made.append({"path": str(dest), "technique": technique, "source": str(src), "old": old, "new": new})
    if len(made) < 3:
        for m in made:
            Path(m["path"]).unlink(missing_ok=True)
        stray = out_dir / "overlay_incremental" / f"{src.parent.name}_{src.stem}.pdf"
        stray.unlink(missing_ok=True)
        return []
    return made


def main() -> int:
    src_root, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    manifest = []
    for src in sorted(src_root.rglob("*.pdf")):
        try:
            manifest += forge(src, out_dir)
        except Exception as exc:
            print(f"  skip {src.name}: {exc}", file=sys.stderr)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"{len(manifest)} forged PDFs in {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
