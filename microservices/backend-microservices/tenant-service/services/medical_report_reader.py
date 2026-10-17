"""Read the result of every required test out of the customer's uploaded reports.

The underwriter used to open each report and key its value in by hand. Here the
configured vision LLM reads each test's reports and answers in exactly the
vocabulary services/medical_findings.evaluate rates on — a number in the
manual's unit for range tests, "normal"/"negative" or the abnormal finding for
qualitative ones — together with the line it read the value from. The answer is
a pre-fill for the underwriter's review, never a recorded result: only
record_medical_result rates findings and completes the gate.
"""
import asyncio
import hashlib

from sqlmodel.ext.asyncio.session import AsyncSession

from services import medical_findings
from services.report_llm import ask_json

_CONCURRENCY = 4


def _expected(code: str) -> tuple[str, str]:
    """(answer instructions, kind) for one test code."""
    if code in medical_findings.REFERENCE_RANGES:
        spec = medical_findings.REFERENCE_RANGES[code]
        low, high = spec["normal"]
        return (f'"value" is the {spec["label"]} result as a plain number in {spec["unit"]} '
                f'(convert units if the report uses others; reference {low}–{high} {spec["unit"]}).', "numeric")
    if code in medical_findings.UNINSURABLE_TESTS:
        return ('"value" is "negative" if the screen is negative / non-reactive, otherwise "reactive".', "screen")
    if code in medical_findings.QUALITATIVE_TESTS:
        return ('"value" is "normal" if the report concludes normal / NAD / within normal limits / '
                'unremarkable, otherwise a short description of the abnormal finding (max 12 words).', "qualitative")
    return ('"value" is the headline result as stated on the report, in a few words.', "other")


def _prompt(test: dict, instructions: str) -> str:
    return (
        "You are assisting a life-insurance medical underwriter. The attached file(s) were uploaded by the "
        f'applicant as their "{test.get("name")}" ({test.get("code")}) report. Read the result of this test only.\n'
        f"{instructions}\n"
        'Respond ONLY with JSON: {"readable": true|false, "value": ..., "abnormal": true|false, '
        '"evidence": "the exact line(s) you read the result from"}. '
        'Set "readable" to false (and "value" to null) if the files do not contain this test\'s result '
        "or it cannot be read with confidence — never guess."
    )


def _normalise(code: str, kind: str, answer: dict | None) -> dict:
    if not answer or not answer.get("readable") or answer.get("value") in (None, ""):
        return {"value": None, "abnormal": None, "evidence": (answer or {}).get("evidence") or None, "readable": False}
    value, abnormal = answer["value"], bool(answer.get("abnormal"))
    if kind == "numeric":
        number = medical_findings._as_float(value)
        if number is None:
            return {"value": None, "abnormal": None, "evidence": answer.get("evidence"), "readable": False}
        value = f"{number:g}"
        low, high = medical_findings.REFERENCE_RANGES[code]["normal"]
        abnormal = not (low <= number <= high)
    elif kind in ("screen", "qualitative"):
        normal_words = (medical_findings.UNINSURABLE_TESTS.get(code) or medical_findings.QUALITATIVE_TESTS[code])["normal_values"]
        abnormal = str(value).strip().lower() not in normal_words
        if abnormal and kind == "screen":
            value = "reactive"
    else:
        value = str(value)
    return {"value": str(value), "abnormal": abnormal, "evidence": answer.get("evidence"), "readable": True}


async def read_results(session: AsyncSession, tests: list[dict], reports: list, fetch) -> dict:
    """{test_code: {value, abnormal, evidence, readable, report_ids}} for every
    required test. `fetch(artifact)` returns (bytes, mime) for a stored report."""
    by_test: dict[str, list] = {}
    for report in reports:
        by_test.setdefault(report.document_type.split(": ", 1)[-1], []).append(report)
    from routers.llm_config import ocr_providers
    providers = await ocr_providers(session)
    gate = asyncio.Semaphore(_CONCURRENCY)

    async def one(test: dict) -> tuple[str, dict]:
        code = test.get("code")
        files_for_test = by_test.get(code, [])
        if not files_for_test:
            return code, {"value": None, "abnormal": None, "evidence": None, "readable": False, "report_ids": []}
        async with gate:
            files, seen = [], set()
            for artifact in files_for_test:
                data, mime = await fetch(artifact)
                digest = hashlib.sha256(data).hexdigest()
                if digest not in seen:  # the same file uploaded twice is read once
                    seen.add(digest)
                    files.append((data, mime))
            instructions, kind = _expected(code)
            answer = await ask_json(None, files, _prompt(test, instructions), f"{code} report", providers)
        return code, {**_normalise(code, kind, answer), "report_ids": sorted(str(a.id) for a in files_for_test)}

    return dict(await asyncio.gather(*(one(test) for test in tests)))
