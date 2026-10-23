"""Download a corpus of genuine PDFs from different issuers for false-alarm testing.

    python scripts/download_pdf_corpus.py data/pdf_genuine

Sources: IRS forms (official documents produced by Adobe tooling, many with
incremental saves and form fields) and real invoices from the invoice2data
test suite (Amazon, Flipkart, OYO and others, each from its own billing system).
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

IRS_FORMS = """
f1040 f1040s1 f1040s2 f1040s3 f1040sa f1040sb f1040sc f1040sd f1040se f1040sse f1040es f1040x f1040sr f1040v
f1065 f1120 f1120s f2441 f4562 f4868 f5695 f8812 f8829 f8863 f8867 f8879 f8888 f8889 f8936 f8949 f8962 f8995
f9465 fw2 fw3 fw4 fw4p fw7 fw8ben fw8bene fw9 fss4 f941 f940 f943 f944 f945 f1096 f1098 f1098e f1098t f1099a
f1099b f1099c f1099div f1099g f1099int f1099k f1099msc f1099nec f1099r f1099s f2848 f8821 f706 f709 f990
f990ez f1041 f1116 f2106 f2210 f3800 f4506 f4506t f4797 f6251 f8283 f8606 f8615 f8822 f8853 f8880 f8919
f8938 f8959 f8960 f1310 f3903 f5329 f8332 f8453 f8822b fw2c f14039 f8962 f1040nr f1040ss f4868 f8843
""".split()

INVOICE2DATA = "https://raw.githubusercontent.com/invoice-x/invoice2data/master/tests/compare/"
INVOICES = ["AmazonWebServices", "AzureInterior", "FlipkartInvoice", "NetpresseInvoice", "QualityHosting",
            "SammyMaystoneLinesTest", "coolblue1", "coolblue2", "free_fiber", "oyo", "saeco"]


def fetch(url: str, dest: Path) -> bool:
    if dest.exists():
        return True
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "docforensics-eval"}), timeout=60) as r:
            data = r.read()
    except Exception as exc:
        print(f"  skip {url}: {exc}", file=sys.stderr)
        return False
    if not data.startswith(b"%PDF"):
        print(f"  skip {url}: not a PDF", file=sys.stderr)
        return False
    dest.write_bytes(data)
    return True


def main() -> int:
    out = Path(sys.argv[1])
    (out / "irs").mkdir(parents=True, exist_ok=True)
    (out / "invoices").mkdir(parents=True, exist_ok=True)
    got = []
    for name in dict.fromkeys(IRS_FORMS):
        if fetch(f"https://www.irs.gov/pub/irs-pdf/{name}.pdf", out / "irs" / f"{name}.pdf"):
            got.append(f"irs/{name}.pdf")
        time.sleep(0.3)
    for name in INVOICES:
        if fetch(f"{INVOICE2DATA}{name}.pdf", out / "invoices" / f"{name}.pdf"):
            got.append(f"invoices/{name}.pdf")
    (out / "manifest.json").write_text(json.dumps(got, indent=1))
    print(f"{len(got)} PDFs in {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
