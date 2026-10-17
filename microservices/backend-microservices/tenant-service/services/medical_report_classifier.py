"""Work out which required tests an uploaded medical report covers.

Customers upload a pile of lab files at once; asking them to sort each one into
the right test is slow and error-prone (a combined lab printout usually covers
several tests). The report itself is read by the OCR model chosen on the LLM Configuration page, else the
platform's configured LLM (primary, then fallback); when no model can read it or none decides, the filename is matched
against test keywords. Only codes from the order's required panel are ever
returned, so a misread can never attach a report to a test that wasn't ordered.
"""
import re

from sqlmodel.ext.asyncio.session import AsyncSession

from services.report_llm import ask_json

# Filename keywords per test code, matched as whole words on a normalised name.
_KEYWORDS: dict[str, tuple[str, ...]] = {
    "MER": ("mer", "medical examiner", "examiner report", "physical exam", "medical exam"),
    "FBS": ("fbs", "fasting blood sugar", "fasting sugar", "fasting glucose", "blood sugar", "glucose"),
    "URINE_RE": ("urine re", "urine routine", "urinalysis", "urine r e", "urine dr", "urine complete"),
    "LIPID": ("lipid", "cholesterol", "triglyceride", "triglycerides", "hdl", "ldl"),
    "CBC": ("cbc", "complete blood count", "blood count", "esr", "haemogram", "hemogram"),
    "LFT": ("lft", "liver function", "liver", "alt", "sgpt", "bilirubin"),
    "RFT": ("rft", "renal function", "kidney function", "creatinine", "urea", "kft"),
    "HBA1C": ("hba1c", "a1c", "glycated", "glycosylated"),
    "ECG": ("ecg", "ekg", "electrocardiogram"),
    "CXR": ("cxr", "chest x ray", "chest xray", "xray", "x ray", "radiograph"),
    "TMT": ("tmt", "treadmill", "stress", "exercise ecg", "ett"),
    "ECHO": ("echo", "echocardiography", "echocardiogram"),
    "HIV": ("hiv",),
    "HEPATITIS": ("hepatitis", "hbsag", "hcv", "anti hcv", "hep b", "hep c", "hbv"),
    "PSA": ("psa", "prostate"),
    "COTININE": ("cotinine", "nicotine"),
    "PAP": ("pap", "pap smear", "cervical"),
}


def classify_by_filename(filename: str, required: list[dict]) -> list[str]:
    stem = (filename or "").rsplit(".", 1)[0].lower()
    name = " " + re.sub(r"[^a-z0-9]+", " ", stem).strip() + " "
    matched = []
    for test in required:
        code = test.get("code")
        words = _KEYWORDS.get(code, ()) + (str(code).lower().replace("_", " "), (test.get("name") or "").lower())
        if any(w and f" {re.sub(r'[^a-z0-9]+', ' ', w).strip()} " in name for w in words):
            matched.append(code)
    # A "stress ECG" / "exercise ECG" is the treadmill test, not a resting ECG.
    if "TMT" in matched and "ECG" in matched:
        matched.remove("ECG")
    return matched


def _prompt(required: list[dict], filename: str) -> str:
    tests = "\n".join(f'- {t.get("code")}: {t.get("name")} — {t.get("description", "")}' for t in required)
    return (
        "You are sorting a life-insurance applicant's medical documents. Read the attached file "
        f'(original filename "{filename}") and decide which of the required tests below it contains '
        "actual results or a completed report for. A combined lab printout can cover several tests. "
        "Only list a test if its results are present in the document — a mere mention, request form "
        "or receipt does not count.\n\nRequired tests:\n"
        f"{tests}\n\n"
        'Respond ONLY with JSON: {"test_codes": ["CODE", ...]} using codes from the list above, '
        'or {"test_codes": []} if the document matches none of them or is unreadable.'
    )


async def classify_with_model(session: AsyncSession, data: bytes, mime: str, filename: str,
                              required: list[dict]) -> list[str] | None:
    """Codes the configured model found, [] when it found none, None when no
    provider could read the file (unsupported format, no key, provider down)."""
    answer = await ask_json(session, [(data, mime)], _prompt(required, filename), filename)
    if answer is None:
        return None
    allowed = {t.get("code") for t in required}
    return [c for c in dict.fromkeys(str(c).upper() for c in answer.get("test_codes") or []) if c in allowed]


async def classify_report(session: AsyncSession, data: bytes, mime: str, filename: str,
                          required: list[dict]) -> tuple[list[str], str]:
    """(test codes, method) where method is "content", "filename" or "none"."""
    by_model = await classify_with_model(session, data, mime, filename, required)
    if by_model:
        return by_model, "content"
    by_name = classify_by_filename(filename, required)
    if by_name:
        return by_name, "filename"
    return [], "none"
