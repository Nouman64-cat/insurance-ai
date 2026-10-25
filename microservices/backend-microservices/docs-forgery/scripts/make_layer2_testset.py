"""Build the 20-document layer-2 test set (10 genuine, 10 forged) with ground truth.

    python scripts/make_layer2_testset.py data/layer2_testset

Every forgery here is the kind layer 2 is meant to catch: a careless edit that changes one
figure and leaves the rest of the document untouched. Edits that keep the arithmetic
consistent (the "Find it again!" receipts were forged that way) are marked
``expectation: unknown``: some keep the arithmetic consistent (invisible to content checks), some do not.

Composition
  genuine  3 real invoices, 3 real receipts, 2 payslips (PDF + phone-style JPEG), 2 bank statements
  forged   3 real invoices (grand total changed), 3 real receipts (edited in Paint / GIMP / Preview),
           2 payslips (net pay inflated; PDF + JPEG), 2 bank statements (one amount, one balance)

Needs PyMuPDF (AGPL) to draw the synthetic documents. It is a test-data tool only and is not
imported by the docforensics package.
"""

from __future__ import annotations

import ast
import csv
import io
import json
import random
import re
import shutil
import sys
from pathlib import Path

import pymupdf
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
GENUINE_INVOICES = ["AzureInterior", "QualityHosting", "SammyMaystoneLinesTest"]
FORGED_INVOICES = ["coolblue1", "NetpresseInvoice", "FlipkartInvoice"]
MONEY = re.compile(r"^\d[\d,]*[.,]\d{2}$")
TOTAL_LABEL = re.compile(r"grand total|total ttc|total\b|totaal|amount due|balance due", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Drawing helpers
# ---------------------------------------------------------------------------

class Page:
    def __init__(self, width=595, height=842):
        self.doc = pymupdf.open()
        self.page = self.doc.new_page(width=width, height=height)

    def text(self, x, y, s, size=10, bold=False, color=(0, 0, 0)):
        self.page.insert_text((x, y), s, fontsize=size, fontname="hebo" if bold else "helv", color=color)

    def right(self, x_right, y, s, size=10, bold=False):
        width = pymupdf.get_text_length(s, fontname="hebo" if bold else "helv", fontsize=size)
        self.text(x_right - width, y, s, size, bold)

    def line(self, x0, y0, x1, y1):
        self.page.draw_line((x0, y0), (x1, y1), color=(0.3, 0.3, 0.3), width=0.6)

    def bytes(self) -> bytes:
        return self.doc.tobytes(garbage=3, deflate=True)


def money(v: float, currency="") -> str:
    return f"{currency}{v:,.2f}"


def render_jpeg(pdf: bytes, seed: int, quality=58) -> bytes:
    """A phone-photo-like JPEG of the first page: slight tilt, blur, shading and heavy compression."""
    rnd = random.Random(seed)
    pix = pymupdf.open(stream=pdf, filetype="pdf")[0].get_pixmap(dpi=120)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    img = img.rotate(rnd.uniform(-1.6, 1.6), resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(228, 226, 222))
    img = img.filter(ImageFilter.GaussianBlur(0.7))
    shade = Image.linear_gradient("L").resize(img.size).point(lambda p: 215 + p // 9)
    img = Image.composite(img, Image.new("RGB", img.size, (190, 190, 185)), shade)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Synthetic payslips
# ---------------------------------------------------------------------------

def build_payslip(seed: int, variant: str, override: dict | None = None) -> tuple[bytes, dict]:
    """Returns the PDF and the true figures. ``override`` changes what is PRINTED for one figure only."""
    rnd = random.Random(seed)
    company = rnd.choice(["Indus Textile Mills (Pvt) Ltd", "Karakoram Software Solutions", "Margalla Logistics Co", "Sapphire Foods Pakistan"])
    employee = rnd.choice(["Ayesha Khan", "Bilal Ahmed", "Hira Malik", "Usman Tariq"])
    basic = rnd.randrange(90_000, 260_000, 5_000)
    earnings = [("Basic Salary", basic), ("House Rent Allowance", round(basic * 0.4)), ("Conveyance Allowance", rnd.choice([8_000, 10_000, 12_000])),
                ("Medical Allowance", round(basic * 0.1)), ("Fuel Allowance", rnd.choice([15_000, 20_000, 25_000]))]
    gross = sum(v for _, v in earnings)
    deductions = [("Income Tax", round(gross * rnd.uniform(0.04, 0.1), 2)), ("Provident Fund", round(basic * 0.1)),
                  ("EOBI", 370), ("Loan Recovery", rnd.choice([0, 5_000, 12_500]))]
    deductions = [(k, v) for k, v in deductions if v]
    total_ded = round(sum(v for _, v in deductions), 2)
    net = round(gross - total_ded, 2)
    truth = {"gross_pay": gross, "total_deductions": total_ded, "net_pay": net, "earnings": earnings, "deductions": deductions}
    shown = {"gross_pay": gross, "total_deductions": total_ded, "net_pay": net, **(override or {})}

    p = Page()
    p.text(50, 60, company, 15, True)
    p.text(50, 80, "PAYSLIP", 12, True)
    p.text(50, 105, f"Employee: {employee}", 10)
    p.text(50, 120, f"Employee ID: EMP-{rnd.randrange(1000, 9999)}", 10)
    p.text(330, 105, "Pay period: September 2026", 10)
    p.text(330, 120, "Pay date: 2026-09-28", 10)
    p.line(50, 135, 545, 135)
    if variant == "side_by_side":
        p.text(50, 155, "Earnings", 11, True)
        p.text(320, 155, "Deductions", 11, True)
        y = 175
        for label, v in earnings:
            p.text(50, y, label, 10)
            p.right(270, y, money(v))
            y += 16
        y2 = 175
        for label, v in deductions:
            p.text(320, y2, label, 10)
            p.right(545, y2, money(v))
            y2 += 16
        y = max(y, y2) + 10
        p.line(50, y - 6, 545, y - 6)
        p.text(50, y + 8, "Gross Pay", 10, True), p.right(270, y + 8, money(shown["gross_pay"]), 10, True)
        p.text(320, y + 8, "Total Deductions", 10, True), p.right(545, y + 8, money(shown["total_deductions"]), 10, True)
        p.line(50, y + 24, 545, y + 24)
        p.text(50, y + 46, "NET PAY (PKR)", 12, True), p.right(545, y + 46, money(shown["net_pay"]), 12, True)
    else:
        p.text(50, 155, "Description", 10, True), p.right(400, 155, "Earnings", 10, True), p.right(545, 155, "Deductions", 10, True)
        p.line(50, 160, 545, 160)
        y = 178
        for label, v in earnings:
            p.text(50, y, label, 10)
            p.right(400, y, money(v))
            y += 16
        for label, v in deductions:
            p.text(50, y, label, 10)
            p.right(545, y, money(v))
            y += 16
        p.line(50, y - 6, 545, y - 6)
        p.text(50, y + 8, "Totals", 10, True), p.right(400, y + 8, money(shown["gross_pay"]), 10, True)
        p.right(545, y + 8, money(shown["total_deductions"]), 10, True)
        p.text(50, y + 40, "Net salary payable", 12, True), p.right(545, y + 40, "PKR " + money(shown["net_pay"]), 12, True)
    return p.bytes(), truth


# ---------------------------------------------------------------------------
# Synthetic bank statements
# ---------------------------------------------------------------------------

def make_iban(bank: str, digits: str) -> str:
    body = bank + digits
    rearranged = body + "PK00"
    check = 98 - int("".join(str(int(c, 36)) for c in rearranged)) % 97
    return f"PK{check:02d}{body}"


def build_statement(seed: int, newest_first: bool, override: dict | None = None) -> tuple[bytes, dict]:
    """``override`` = {"row": i, "field": "debit"|"credit"|"balance", "value": v} changes one PRINTED cell only."""
    rnd = random.Random(seed)
    bank = rnd.choice([("Meezan Bank", "MEZN"), ("Habib Metropolitan Bank", "MPBL"), ("Bank Alfalah", "ALFH")])
    holder = rnd.choice(["Sana Rahim", "Fatima Noor", "Hamza Sheikh"])
    account = "".join(str(rnd.randrange(10)) for _ in range(14))
    iban = make_iban(bank[1], "".join(str(rnd.randrange(10)) for _ in range(16)))
    opening = round(rnd.uniform(60_000, 350_000), 2)
    descriptions = ["Salary Credit", "ATM Cash Withdrawal", "IBFT Transfer Out", "K-Electric Bill Payment", "POS Purchase - Carrefour",
                    "SNGPL Gas Bill", "IBFT Transfer In", "Mobile Top-up", "Cheque Deposit", "Online Purchase - Daraz", "PTCL Bill Payment"]
    rows, balance = [], opening
    for i in range(18):
        credit = debit = None
        if i in (0, 9) or rnd.random() < 0.18:
            credit = round(rnd.uniform(15_000, 160_000), 2)
        else:
            debit = round(rnd.uniform(800, 28_000), 2)
        balance = round(balance + (credit or 0) - (debit or 0), 2)
        rows.append({"date": f"2026-09-{i + 2:02d}", "description": rnd.choice(descriptions), "debit": debit, "credit": credit, "balance": balance})
    credits_total = round(sum(r["credit"] or 0 for r in rows), 2)
    debits_total = round(sum(r["debit"] or 0 for r in rows), 2)
    truth = {"opening": opening, "closing": balance, "credits": credits_total, "debits": debits_total, "rows": rows, "iban": iban}

    shown = [dict(r) for r in rows]
    if override:
        shown[override["row"]][override["field"]] = override["value"]
    if newest_first:
        shown = shown[::-1]

    p = Page()
    p.text(50, 55, bank[0], 15, True)
    p.text(50, 75, "STATEMENT OF ACCOUNT", 11, True)
    p.text(50, 97, f"Account title: {holder}", 9), p.text(50, 110, f"Account no: {account}", 9), p.text(50, 123, f"IBAN: {iban}", 9)
    p.text(360, 97, "Statement period: 2026-09-01 to 2026-09-30", 9), p.text(360, 110, "Currency: PKR", 9)
    p.line(50, 134, 545, 134)
    for x, label, bold in ((50, "Date", True), (115, "Description", True)):
        p.text(x, 150, label, 9, bold)
    for x, label in ((365, "Debit"), (440, "Credit"), (545, "Balance")):
        p.right(x, 150, label, 9, True)
    p.line(50, 155, 545, 155)
    y = 170
    for r in shown:
        p.text(50, y, r["date"], 8.5), p.text(115, y, r["description"], 8.5)
        if r["debit"]:
            p.right(365, y, money(r["debit"]), 8.5)
        if r["credit"]:
            p.right(440, y, money(r["credit"]), 8.5)
        p.right(545, y, money(r["balance"]), 8.5)
        y += 15
    p.line(50, y - 5, 545, y - 5)
    y += 14
    for label, value in (("Opening balance", opening), ("Total credits", credits_total), ("Total debits", debits_total), ("Closing balance", balance)):
        p.text(330, y, label, 9, True), p.right(545, y, money(value), 9, True)
        y += 14
    return p.bytes(), truth


# ---------------------------------------------------------------------------
# Real invoices: change the grand total
# ---------------------------------------------------------------------------

def _to_float(printed: str) -> float:
    """'1,234.56' and '1.234,56' and '56,02' alike."""
    if printed.rfind(",") > printed.rfind("."):
        return float(printed.replace(".", "").replace(",", "."))
    return float(printed.replace(",", ""))


def forge_invoice_total(src: Path, dest: Path) -> dict | None:
    """Replace the last 'total' amount on page 1 (text removed, not painted over). None if there is no such figure."""
    doc = pymupdf.open(src)
    page = doc[0]
    # Group words into visual rows by vertical centre: in tables a label and its amount are separate text blocks.
    rows: list[list] = []
    for w in sorted(page.get_text("words"), key=lambda w: (w[1] + w[3]) / 2):
        centre = (w[1] + w[3]) / 2
        if rows and abs(centre - rows[-1][0]) <= 4:
            rows[-1][1].append(w)
        else:
            rows.append([centre, [w]])
    # For every total-like label, the amount right after it (several blocks can share one visual row, so the
    # right-most amount on the row may belong to a different line). The grand total is the largest such figure;
    # ties go to the right-most, then the lowest, one.
    best = None
    for centre, words in rows:
        words = sorted(words, key=lambda w: w[0])
        text = " ".join(w[4] for w in words)
        for label in (w for w in words if TOTAL_LABEL.search(w[4])):
            after = [w for w in words if w[0] >= label[2] - 1 and MONEY.match(re.sub(r"[^\d.,]", "", w[4]))]
            if not after:
                continue
            amount = after[0]
            cleaned = re.sub(r"[^\d.,]", "", amount[4])
            value = _to_float(cleaned)
            key = (value, amount[2], centre)
            if best is None or key > best[0]:
                best = (key, amount, text)
    if best is None:
        return None
    _, (x0, y0, x1, y1, printed, *_), context = best
    old = re.sub(r"[^\d.,]", "", printed)
    value = _to_float(old)
    new_value = round(value * 1.34 + 7, 2)
    comma_decimal = old.rfind(",") > old.rfind(".")
    new = f"{new_value:,.2f}"
    if comma_decimal:
        new = new.replace(",", "X").replace(".", ",").replace("X", ".")
    rect = pymupdf.Rect(x0, y0, x1, y1)
    size = max(6.0, (y1 - y0) * 0.78)
    page.add_redact_annot(rect, fill=(1, 1, 1))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE)
    width = pymupdf.get_text_length(new, fontname="helv", fontsize=size)
    page.insert_text((x1 - width, y1 - (y1 - y0) * 0.2), new, fontsize=size, fontname="helv")
    doc.save(dest, garbage=3, deflate=True)
    return {"old": old, "new": new, "line": context[:100], "value_new": f"{new_value:.2f}"}


# ---------------------------------------------------------------------------
# Real receipts
# ---------------------------------------------------------------------------

def pick_receipts(root: Path, rnd: random.Random) -> tuple[list[tuple[Path, str]], list[tuple[Path, str, str]]]:
    """(genuine, forged) receipts. Forged ones: one per editing program, preferring a modified Total/payment figure."""
    base = root / "findit2" / "findit2"
    genuine, forged_by_software = [], {}
    for split in ("train", "val", "test"):
        with (base / f"{split}.txt").open(newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                path = base / split / r["image"]
                if not path.exists():
                    continue
                if r["forged"] == "0" and r["digital annotation"] == "0" and r["handwritten annotation"] == "0":
                    genuine.append((path, r["image"]))
                elif r["forged"] == "1":
                    try:
                        info = ast.literal_eval(r["forgery annotations"])
                    except (ValueError, SyntaxError):
                        continue
                    if not isinstance(info, dict):
                        continue  # some forged rows carry no annotation record
                    software = str(info.get("file_attributes", {}).get("Software used", "")).lower()
                    entities = {str(g["region_attributes"].get("Entity type")) for g in info.get("regions", [])
                                if g["region_attributes"].get("Original area") == "no"}
                    key = "preview" if "aper" in software or "preview" in software else software
                    if key in ("paint", "gimp", "preview") and "Total/payment" in entities:
                        forged_by_software.setdefault(key, []).append((path, r["image"], f"{key} (modified: {', '.join(sorted(entities))})"))
    rnd.shuffle(genuine)
    forged = [rnd.choice(forged_by_software[k]) for k in ("paint", "gimp", "preview") if forged_by_software.get(k)]
    return genuine[:3], forged


# ---------------------------------------------------------------------------
# Assemble
# ---------------------------------------------------------------------------

def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "data" / "layer2_testset")
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    rnd = random.Random(20261020)
    docs: list[dict] = []

    def add(doc_id, data, ext, label, kind, doc_type, fmt, expectation, **extra):
        path = out / f"{doc_id}.{ext}"
        path.write_bytes(data)
        docs.append({"id": doc_id, "path": path.name, "label": label, "kind": kind, "doc_type": doc_type, "format": fmt,
                     "expectation": expectation, **extra})

    # real invoices
    inv = ROOT / "data" / "pdf_genuine" / "invoices"
    for name in GENUINE_INVOICES:
        add(f"genuine_invoice_{name}", (inv / f"{name}.pdf").read_bytes(), "pdf", "genuine", "invoice", "invoice", "pdf", "clean",
            source=f"invoice2data/{name}")
    for name in FORGED_INVOICES:
        tmp = out / "_tmp.pdf"
        info = forge_invoice_total(inv / f"{name}.pdf", tmp)
        if info is None:
            print(f"  skipped {name}: no total figure found")
            continue
        add(f"forged_invoice_{name}", tmp.read_bytes(), "pdf", "forged", "invoice", "invoice", "pdf", "arithmetic",
            source=f"invoice2data/{name}", forged={"what": "grand total", **info})
        tmp.unlink()

    # real receipts
    genuine_r, forged_r = pick_receipts(ROOT / "data", rnd)
    for path, name in genuine_r:
        add(f"genuine_receipt_{path.stem}", path.read_bytes(), "png", "genuine", "receipt", "receipt", "image", "clean", source=f"findit2/{name}")
    for path, name, how in forged_r:
        add(f"forged_receipt_{path.stem}", path.read_bytes(), "png", "forged", "receipt", "receipt", "image", "unknown",
            source=f"findit2/{name}", forged={"what": how})

    # synthetic payslips
    pdf, truth = build_payslip(11, "side_by_side")
    add("genuine_payslip_pdf", pdf, "pdf", "genuine", "payslip", "payslip", "pdf", "clean", truth=_jsonable(truth))
    pdf, truth = build_payslip(12, "single_table")
    add("genuine_payslip_photo", render_jpeg(pdf, 12), "jpg", "genuine", "payslip", "payslip", "image", "clean", truth=_jsonable(truth))
    for doc_id, seed, variant, as_photo in (("forged_payslip_pdf", 13, "side_by_side", False), ("forged_payslip_photo", 14, "single_table", True)):
        _, truth = build_payslip(seed, variant)
        new_net = round(truth["net_pay"] * 1.45 + 3_000, 2)
        pdf, _ = build_payslip(seed, variant, {"net_pay": new_net})
        add(doc_id, render_jpeg(pdf, seed) if as_photo else pdf, "jpg" if as_photo else "pdf", "forged", "payslip", "payslip",
            "image" if as_photo else "pdf", "arithmetic", truth=_jsonable(truth),
            forged={"what": "net pay inflated", "key": "net_pay", "old": f"{truth['net_pay']:.2f}", "value_new": f"{new_net:.2f}"})

    # synthetic bank statements
    pdf, truth = build_statement(21, newest_first=False)
    add("genuine_statement_oldest_first", pdf, "pdf", "genuine", "statement", "bank_statement", "pdf", "clean")
    pdf, truth = build_statement(22, newest_first=True)
    add("genuine_statement_newest_first", pdf, "pdf", "genuine", "statement", "bank_statement", "pdf", "clean")
    for doc_id, seed, newest, field, row in (("forged_statement_amount", 23, False, "debit", 8), ("forged_statement_balance", 24, True, "balance", 11)):
        _, truth = build_statement(seed, newest)
        r = truth["rows"][row]
        if field == "debit" and not r["debit"]:
            row, r = next((i, x) for i, x in enumerate(truth["rows"]) if x["debit"] and i > 4)
        old = r[field]
        new = round(old * 3.1 + 1_000, 2) if field == "debit" else round(old + 48_000, 2)
        pdf, _ = build_statement(seed, newest, {"row": row, "field": field, "value": new})
        add(doc_id, pdf, "pdf", "forged", "statement", "bank_statement", "pdf", "arithmetic",
            forged={"what": f"row {row + 1} {field}", "old": f"{old:.2f}", "value_new": f"{new:.2f}"})

    rnd.shuffle(docs)  # balanced partial runs: any prefix of the manifest mixes kinds and labels
    docs.sort(key=lambda d: 0)  # keep shuffled order
    (out / "manifest.json").write_text(json.dumps(docs, indent=2), encoding="utf-8")
    forged_n = sum(d["label"] == "forged" for d in docs)
    print(f"{len(docs)} documents ({forged_n} forged, {len(docs) - forged_n} genuine) -> {out}")
    for d in docs:
        info = d.get("forged", {})
        print(f"  {d['id']:44s} {d['label']:8s} {d['expectation']:12s} {info.get('old', '')} -> {info.get('value_new', info.get('new', ''))}")
    return 0


def _jsonable(truth: dict) -> dict:
    return json.loads(json.dumps(truth, default=str))


if __name__ == "__main__":
    sys.exit(main())
