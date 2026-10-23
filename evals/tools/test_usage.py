"""Tests of the usage meter (shared/evaluation/usage.py) and of how the OCR operation uses it.

    python evals/tools/test_usage.py      # also run by selftest.py
    pytest evals/tools/test_usage.py

The rule they hold: a gap in the ledger is never turned into "this cost nothing". A late row is waited for, a missing row makes
the cost unknown (and the case's `trace.llm_calls` unobserved), an unreadable ledger is "unavailable", and a stray row on a
call that should not have used a model is reported, not hidden.
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))   # the repo root, for `shared`

from shared.evaluation.assertions import evaluate_assertion  # noqa: E402
from shared.evaluation.operations import OperationError, RunContext, execute  # noqa: E402
from shared.evaluation.usage import OverlappingExecution, UsageMeter  # noqa: E402


def run(coro):
    return asyncio.run(coro)


class Ledger:
    """A fake ledger. `add` appends a row now; `add_later` appends one after a delay (the poster's background task)."""
    def __init__(self):
        self.rows, self.broken, self.n = [], False, 0

    def add(self, model="gpt-4o-mini", inp=900, out=40):
        self.n += 1
        self.rows.append({"id": f"r{self.n}", "service_name": "OCR Engine", "model_name": model, "input_tokens": inp, "output_tokens": out,
                          "cached_tokens": 0})

    async def add_later(self, delay, **kw):
        await asyncio.sleep(delay)
        self.add(**kw)

    async def fetch(self):
        if self.broken:
            raise ConnectionError("ledger down")
        return list(self.rows)


def meter(ledger, **kw):
    return UsageMeter(ledger.fetch, poll_seconds=0.02, quiet_seconds=0.1, max_wait_seconds=0.6, **kw)


def test_a_call_that_is_recorded_is_attributed() -> None:
    async def go():
        ledger = Ledger(); m = meter(ledger); mark = await m.begin("e1")
        ledger.add()
        return await m.end(mark, expected_min_calls=1)
    r = run(go())
    assert (r.status, r.calls, r.input_tokens, r.output_tokens) == ("attributed", 1, 900, 40) and r.by_model["gpt-4o-mini"]["calls"] == 1


def test_a_late_write_is_waited_for() -> None:
    async def go():
        ledger = Ledger(); m = meter(ledger); mark = await m.begin("e2")
        asyncio.create_task(ledger.add_later(0.25))
        return await m.end(mark, expected_min_calls=1)
    r = run(go())
    assert r.status == "attributed" and r.calls == 1 and r.waited_seconds >= 0.2


def test_a_call_with_no_row_is_unknown_not_free() -> None:
    async def go():
        ledger = Ledger(); m = meter(ledger); mark = await m.begin("e3")
        return await m.end(mark, expected_min_calls=1, reported_tokens={"input": 900, "output": 40, "total": 940})
    r = run(go())
    assert r.status == "missing" and r.calls is None and r.input_tokens is None            # cost unknown: not 0
    assert r.reported_tokens == {"input": 900, "output": 40, "total": 940}                  # what the reply itself said is kept, as such


def test_an_unreadable_ledger_is_unavailable() -> None:
    async def go():
        ledger = Ledger(); m = meter(ledger); mark = await m.begin("e4")
        ledger.broken = True
        return await m.end(mark, expected_min_calls=0)
    r = run(go())
    assert r.status == "unavailable" and r.calls is None


def test_a_ledger_unreadable_before_the_call_is_unavailable() -> None:
    async def go():
        ledger = Ledger(); ledger.broken = True; m = meter(ledger); mark = await m.begin("e5")
        return await m.end(mark)
    assert run(go()).status == "unavailable"


def test_a_row_that_arrives_after_the_wait_is_reconciled_not_lost() -> None:
    async def go():
        ledger = Ledger(); m = meter(ledger); mark = await m.begin("e6")
        first = await m.end(mark, expected_min_calls=1)
        ledger.add()                                              # arrives after the meter gave up
        return first, await m.reconcile(mark, first)
    first, later = run(go())
    assert first.status == "missing" and first.calls is None                    # what was reported at the time is unchanged
    assert later.status == "attributed" and later.calls == 1 and len(later.late_rows) == 1


def test_only_one_execution_is_measured_at_a_time() -> None:
    async def go():
        ledger = Ledger(); m = meter(ledger); mark = await m.begin("e7")
        try:
            await m.begin("e8")
        except OverlappingExecution:
            await m.end(mark)
            return True
        return False
    assert run(go())


def test_rows_from_before_the_window_are_not_counted() -> None:
    async def go():
        ledger = Ledger(); ledger.add(); ledger.add()             # earlier executions' rows
        m = meter(ledger); mark = await m.begin("e9")
        ledger.add()
        return await m.end(mark, expected_min_calls=1)
    assert run(go()).calls == 1


def test_an_ambiguous_window_is_not_attributed() -> None:
    async def go():
        ledger = Ledger(); m = meter(ledger); mark = await m.begin("e10")
        return await m.end(mark, ambiguous=True)
    r = run(go())
    assert r.status == "ambiguous" and r.calls is None


# ── the OCR operation on top of the meter ────────────────────────────────────────────────────────────────────────────────

class Resp:
    def __init__(self, status_code, body):
        self.status_code, self._b = status_code, body

    def json(self):
        return self._b


class OcrHttp:
    def __init__(self, ledger, status, body=None, record=True):
        self.ledger, self.status, self.body, self.record = ledger, status, body or {}, record
        self.uploads = []

    async def post(self, url, json=None, headers=None, files=None):
        self.uploads.append((url, files))
        if self.record:
            self.ledger.add()
        return Resp(self.status, self.body)


READ = {"fields": {"first_name": "Ayesha", "cnic": "35202-6781234-5"}, "found": 2, "token_usage": {"input": 900, "output": 40, "total": 940}}
REFUSED = {"detail": "Unsupported format. Upload a PDF, PNG or JPG file."}


def ocr_case(name, role="Agent"):
    return {"input": {"payload": {"operation": "ocr.extract_customer", "file": name}, "actor": {"role": role}}, "metadata": {"env_mode": "any"}}


def ocr_ctx(http, ledger, **kw):
    return RunContext(http=http, ocr_url="http://ocr", files={"card.png": b"\x89PNG", "bank-statement.txt": b"x", "empty-file.png": b""},
                      usage_meter=meter(ledger) if ledger is not None else None, execution_id="exec-1", **kw)


def test_ocr_reading_a_document_reports_the_calls_it_caused() -> None:
    ledger = Ledger(); http = OcrHttp(ledger, 200, READ)
    obs = run(execute(ocr_case("card.png"), ocr_ctx(http, ledger)))
    assert http.uploads[0][1]["file"] == ("card.png", b"\x89PNG", "image/png")
    assert obs["trace"]["llm_calls"] == 1 and obs["usage"]["status"] == "attributed" and "Ayesha" in obs["result"]["fields_json"]


def test_ocr_refusal_proves_zero_model_calls() -> None:
    ledger = Ledger(); http = OcrHttp(ledger, 400, REFUSED, record=False)
    obs = run(execute(ocr_case("bank-statement.txt"), ocr_ctx(http, ledger)))
    assert obs["result"]["status_code"] == 400 and obs["trace"]["llm_calls"] == 0 and obs["usage"]["status"] == "attributed"
    assert evaluate_assertion({"id": "A", "type": "equals", "target": "trace.llm_calls", "expected": 0}, obs).status == "passed"


def test_ocr_refusal_that_still_called_a_model_is_not_hidden() -> None:
    ledger = Ledger(); http = OcrHttp(ledger, 400, REFUSED, record=True)       # a stray model call on a refused upload
    obs = run(execute(ocr_case("bank-statement.txt"), ocr_ctx(http, ledger)))
    assert obs["trace"]["llm_calls"] == 1
    assert evaluate_assertion({"id": "A", "type": "equals", "target": "trace.llm_calls", "expected": 0}, obs).status == "failed"


def test_ocr_unknown_cost_leaves_llm_calls_unobserved() -> None:
    ledger = Ledger(); http = OcrHttp(ledger, 200, READ, record=False)         # read a document but no ledger row ever arrives
    obs = run(execute(ocr_case("card.png"), ocr_ctx(http, ledger)))
    assert "trace" not in obs and obs["usage"]["status"] == "missing" and obs["usage"]["calls"] is None
    assert evaluate_assertion({"id": "A", "type": "equals", "target": "trace.llm_calls", "expected": 0}, obs).status == "error"


def test_ocr_without_a_meter_does_not_claim_zero_calls() -> None:
    ledger = Ledger(); http = OcrHttp(ledger, 400, REFUSED, record=False)
    obs = run(execute(ocr_case("bank-statement.txt"), ocr_ctx(http, None)))
    assert "trace" not in obs and "usage" not in obs


def test_ocr_engine_without_a_model_is_an_environment_error() -> None:
    ledger = Ledger(); http = OcrHttp(ledger, 503, {"detail": "No provider configured"}, record=False)
    m = ocr_ctx(http, ledger)
    try:
        run(execute(ocr_case("card.png"), m))
    except OperationError as exc:
        assert "no model provider" in str(exc)
        assert m.usage_meter._open is None                                         # the window was closed, so the next case can be measured
    else:
        raise AssertionError("a 503 from the engine must be a could-not-perform, not a failed case")


def test_ocr_missing_pieces_are_errors() -> None:
    ledger = Ledger()
    for bad, message in ((ocr_case("nope.png"), "not loaded"), ({**ocr_case("x"), "input": {"payload": {"operation": "ocr.extract_customer"}}}, "missing file")):
        try:
            run(execute(bad, ocr_ctx(OcrHttp(ledger, 200, READ), ledger)))
        except OperationError as exc:
            assert message in str(exc), (message, str(exc))
        else:
            raise AssertionError(f"{message}: no error")
    try:
        run(execute(ocr_case("card.png"), RunContext()))
    except OperationError as exc:
        assert "OCR engine's URL" in str(exc)
    else:
        raise AssertionError("no error without the OCR engine")


TESTS = [test_a_call_that_is_recorded_is_attributed, test_a_late_write_is_waited_for, test_a_call_with_no_row_is_unknown_not_free,
         test_an_unreadable_ledger_is_unavailable, test_a_ledger_unreadable_before_the_call_is_unavailable,
         test_a_row_that_arrives_after_the_wait_is_reconciled_not_lost, test_only_one_execution_is_measured_at_a_time,
         test_rows_from_before_the_window_are_not_counted, test_an_ambiguous_window_is_not_attributed,
         test_ocr_reading_a_document_reports_the_calls_it_caused, test_ocr_refusal_proves_zero_model_calls,
         test_ocr_refusal_that_still_called_a_model_is_not_hidden, test_ocr_unknown_cost_leaves_llm_calls_unobserved,
         test_ocr_without_a_meter_does_not_claim_zero_calls, test_ocr_engine_without_a_model_is_an_environment_error,
         test_ocr_missing_pieces_are_errors]


def run_all() -> int:
    failed = 0
    for test in TESTS:
        try:
            test()
            print(f"ok   {test.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {test.__name__}: {exc}")
    return failed


if __name__ == "__main__":
    failures = run_all()
    print(f"{'PASS' if not failures else 'FAILED'}: {len(TESTS)} usage tests, {failures} failed")
    sys.exit(1 if failures else 0)
