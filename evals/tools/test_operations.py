"""Wiring tests of the HTTP operations (shared/evaluation/operations.py) against a fake service, plus a guard that the registry
and the dataset agree about operation names.

    python evals/tools/test_operations.py      # also run by selftest.py
    pytest evals/tools/test_operations.py

These prove how each call is BUILT (the route, the body, which seeded id is used, what is read back as state) and that a missing
piece is reported as "cannot perform", never as an answer. What the real endpoint answers is checked later, against the
test tenant. The function-mode operations are run on the real code by run_function_cases.py.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import casekit  # noqa: E402
from shared.evaluation.operations import OPERATIONS, OperationError, RunContext, execute  # noqa: E402


class Resp:
    def __init__(self, status_code, body):
        self.status_code, self._body = status_code, body

    def json(self):
        return self._body


class FakeHttp:
    """Records every call and answers from a route table: {("GET", path-suffix): Resp}."""
    def __init__(self, routes=None):
        self.routes, self.calls = routes or {}, []

    async def _answer(self, method, url, json=None):
        self.calls.append((method, url, json))
        for (m, suffix), resp in self.routes.items():
            if m == method and url.endswith(suffix):
                return resp
        return Resp(404, {"detail": "no such route in the fake"})

    async def get(self, url, headers=None):
        return await self._answer("GET", url)

    async def post(self, url, json=None, headers=None, files=None):
        if files is not None:
            self.uploads = getattr(self, "uploads", []) + [files]
        return await self._answer("POST", url, json)

    async def patch(self, url, json=None, headers=None):
        return await self._answer("PATCH", url, json)


def case(operation, payload, role="Agent"):
    return {"input": {"payload": {"operation": operation, **payload}, "actor": {"role": role}}, "metadata": {"env_mode": "any"}}


def ctx(http, **extra):
    return RunContext(http=http, base_url="http://svc", tenant_id="T1", headers={"Authorization": "Bearer x"},
                      ids={"policies": {"pol-a": "P1"}}, tenant_ids={"tenant-a": "T1", "tenant-b": "T2"}, **extra)


def run(coro):
    return asyncio.run(coro)


def test_early_check_calls_the_tenants_rule_engine() -> None:
    http = FakeHttp({("POST", "/rules/early-check"): Resp(200, {"decision": "DECLINE", "rule_codes": ["KO-AGE-01"]})})
    obs = run(execute(case("rules.early_check", {"body": {"age": 17, "occupation": "Teacher"}}), ctx(http)))
    assert http.calls == [("POST", "http://svc/tenants/T1/rules/early-check", {"age": 17, "occupation": "Teacher"})]
    assert obs["result"]["decision"] == "DECLINE" and obs["result"]["status_code"] == 200


def test_list_payments_asks_for_the_other_tenant() -> None:
    http = FakeHttp({("GET", "/claims/payments"): Resp(403, {"detail": "Not your organization or your account is inactive."})})
    obs = run(execute(case("claims.list_payments", {"tenant": "tenant-b"}, role="Finance"), ctx(http)))
    assert http.calls[0][1] == "http://svc/tenants/T2/claims/payments"          # tenant B's id, not the caller's
    assert obs["result"]["status_code"] == 403 and "Not your organization" in obs["result"]["detail"]


def test_ipp_initiate_reads_back_the_payment_as_state() -> None:
    http = FakeHttp({("POST", "/ipp/initiate"): Resp(200, {"amount": 4212}), ("GET", "/ipp"): Resp(200, {"status": "Initiated", "method": "JazzCash"})})
    obs = run(execute(case("ipp.initiate", {"policy": "pol-a", "body": {"method": "JazzCash"}}), ctx(http)))
    assert [(m, u) for m, u, _ in http.calls] == [("POST", "http://svc/tenants/T1/policies/P1/ipp/initiate"), ("GET", "http://svc/tenants/T1/policies/P1/ipp")]
    assert http.calls[0][2] == {"method": "JazzCash"}
    assert obs["result"]["amount"] == 4212 and obs["state"]["ipp"]["status"] == "Initiated"


def test_ipp_confirm_with_no_reference_sends_the_empty_body() -> None:
    http = FakeHttp({("POST", "/ipp/confirm"): Resp(400, {"detail": "Payment cannot be confirmed without the transaction reference"}),
                     ("GET", "/ipp"): Resp(200, {"status": "Initiated"})})
    obs = run(execute(case("ipp.confirm", {"policy": "pol-a", "body": {}}), ctx(http)))
    assert http.calls[0][2] == {} and obs["result"]["status_code"] == 400 and obs["state"]["ipp"]["status"] == "Initiated"


def test_a_failed_state_read_is_not_a_state() -> None:
    http = FakeHttp({("POST", "/ipp/initiate"): Resp(409, {"detail": "already been paid"})})      # the GET falls through to a 404
    obs = run(execute(case("ipp.initiate", {"policy": "pol-a", "body": {}}), ctx(http)))
    assert obs["state"]["ipp"] is None                                                           # so `state.ipp.status` is "not observed"


def test_pre_issuance_reads_the_readiness_checklist() -> None:
    http = FakeHttp({("GET", "/pre-issuance"): Resp(200, {"ready_to_issue": False, "blockers": ["x"]})})
    obs = run(execute(case("policies.pre_issuance", {"policy": "pol-a"}, role="Underwriter"), ctx(http)))
    assert http.calls[0][1] == "http://svc/tenants/T1/policies/P1/pre-issuance"
    assert obs["result"]["ready_to_issue"] is False and obs["result"]["body"]["blockers"] == ["x"]


def test_a_missing_piece_is_an_error_not_an_answer() -> None:
    http = FakeHttp()
    for bad, message in ((case("policies.pre_issuance", {"policy": "pol-unseeded"}), "has not seeded"),
                         (case("policies.pre_issuance", {}), "missing policy"),
                         (case("claims.list_payments", {"tenant": "tenant-z"}, role="Finance"), "no test tenant")):
        try:
            run(execute(bad, ctx(http)))
        except OperationError as exc:
            assert message in str(exc), (message, str(exc))
        else:
            raise AssertionError(f"{message}: no error was raised")
    try:
        run(execute(case("policies.pre_issuance", {"policy": "pol-a"}), RunContext()))
    except OperationError as exc:
        assert "needs the service URL" in str(exc)
    else:
        raise AssertionError("no error without a service")
    assert http.calls == []                                                                      # nothing was called with a bad setup


class Customers(FakeHttp):
    """A tenant whose customer list grows by one when a create is accepted."""
    def __init__(self, accept: bool):
        super().__init__()
        self.accept, self.rows = accept, [{"id": "c1", "cnic": "35201-9876543-2"}]

    async def _answer(self, method, url, json=None):
        self.calls.append((method, url, json))
        if method == "POST":
            if self.accept:
                self.rows.append({"id": "c2", "cnic": "35202-1122334-4"})
                return Resp(201, {"id": "c2", "cnic": "35202-1122334-4"})
            return Resp(409, {"detail": "This CNIC is already registered for this tenant."})
        return Resp(200, self.rows)


def test_customers_create_counts_what_was_really_created() -> None:
    made = run(execute(case("customers.create", {"body": {"cnic": "3520211223344"}}), ctx(Customers(accept=True))))
    assert made["result"]["status_code"] == 201 and made["state"]["new_customers"] == 1
    assert "35202-1122334-4" in made["state"]["customers"]["cnics"]
    refused = run(execute(case("customers.create", {"body": {"cnic": "35201-9876543-2"}}), ctx(Customers(accept=False))))
    assert refused["result"]["status_code"] == 409 and refused["state"]["new_customers"] == 0


def test_customers_create_cannot_count_without_a_customer_list() -> None:
    try:
        run(execute(case("customers.create", {"body": {}}), ctx(FakeHttp())))          # the list route answers 404
    except OperationError as exc:
        assert "could not list" in str(exc)
    else:
        raise AssertionError("a failed list must stop the case, not read as zero new customers")


def test_quote_status_goes_to_the_gateway_and_reads_the_policy_back() -> None:
    http = FakeHttp({("PATCH", "/quotes/Q1"): Resp(403, {"detail": "Setting status to 'Approved' requires one of: Admin, SuperAdmin, Underwriter (you are Agent)."}),
                     ("GET", "/policies/P1"): Resp(200, {"status": "Proposed", "policy_number": None})})
    c = ctx(http, gateway_url="http://gw")
    c.ids["quotes"] = {"pol-a": "Q1"}
    obs = run(execute(case("quotes.update_status", {"policy": "pol-a", "body": {"status": "Approved"}}), c))
    assert http.calls[0] == ("PATCH", "http://gw/quotes/Q1", {"status": "Approved"})
    assert obs["result"]["status_code"] == 403 and obs["state"]["policy"] == {"status": "Proposed", "policy_number_is_null": True}
    try:
        run(execute(case("quotes.update_status", {"policy": "pol-unseeded", "body": {}}), c))
    except OperationError as exc:
        assert "has not seeded a quote" in str(exc)
    else:
        raise AssertionError("an unseeded quote must be an error")


def test_policy_issue_reads_back_status_and_number() -> None:
    http = FakeHttp({("POST", "/issue"): Resp(400, {"detail": "Policy must be Approved, AcceptedWithLoadings, Issued to issue (current: Declined)"}),
                     ("GET", "/policies/P1"): Resp(200, {"status": "Declined", "policy_number": None})})
    obs = run(execute(case("policies.issue", {"policy": "pol-a", "body": {}}, role="Underwriter"), ctx(http)))
    assert http.calls[0][1] == "http://svc/tenants/T1/policies/P1/issue"
    assert obs["state"]["policy"] == {"status": "Declined", "policy_number_is_null": True}
    issued = FakeHttp({("POST", "/issue"): Resp(200, {}), ("GET", "/policies/P1"): Resp(200, {"status": "Issued", "policy_number": "POL-1"})})
    assert run(execute(case("policies.issue", {"policy": "pol-a", "body": {}}), ctx(issued)))["state"]["policy"]["policy_number_is_null"] is False


def test_every_registered_operation_is_one_a_case_names() -> None:
    """A typo in an operation name would register something no case can reach."""
    used = {(raw.get("input") or {}).get("payload", {}).get("operation") for _, raw in casekit.sources()}
    unused = sorted(set(OPERATIONS) - used)
    assert not unused, f"registered but named by no case: {unused}"
    assert all(op.mode in ("function", "http", "chat") for op in OPERATIONS.values())


TESTS = [test_early_check_calls_the_tenants_rule_engine, test_list_payments_asks_for_the_other_tenant,
         test_ipp_initiate_reads_back_the_payment_as_state, test_ipp_confirm_with_no_reference_sends_the_empty_body,
         test_a_failed_state_read_is_not_a_state, test_pre_issuance_reads_the_readiness_checklist,
         test_a_missing_piece_is_an_error_not_an_answer, test_customers_create_counts_what_was_really_created,
         test_customers_create_cannot_count_without_a_customer_list, test_quote_status_goes_to_the_gateway_and_reads_the_policy_back,
         test_policy_issue_reads_back_status_and_number, test_every_registered_operation_is_one_a_case_names]


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
    print(f"{'PASS' if not failures else 'FAILED'}: {len(TESTS)} operation tests, {failures} failed")
    sys.exit(1 if failures else 0)
