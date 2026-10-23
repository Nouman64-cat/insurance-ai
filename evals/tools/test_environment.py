"""Tests of the evaluation environment that need no running stack: the safety guards, the recording producer, the fixture
validation and the seeder's deterministic parts, and FIXTURE COVERAGE (every reference the 70 golden cases make exists in the
world the seeder builds). The tests that need the stack (reset, isolation, roles, cleanup) are in test_environment_integration.py.

    python evals/tools/test_environment.py      # also run by selftest.py
    pytest evals/tools/test_environment.py
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import casekit  # noqa: E402
from shared.evaluation import seeding  # noqa: E402
from shared.evaluation.recording_producer import RecordingProducer  # noqa: E402
from shared.evaluation.safety import (EvaluationGuardError, assert_evaluation_database, assert_evaluation_process,  # noqa: E402
                                      assert_no_external_credentials, parse_database_url)

EXTRAS = Path(__file__).resolve().parents[1] / "environment" / "world-extras.json"
GOOD_ENV = {"EVAL_ENVIRONMENT": "1", "DATABASE_URL": "postgresql+asyncpg://eval_app:x@eval-postgres:5432/insurance_eval"}
PROD_URL = "postgresql+asyncpg://postgres:1122@host.docker.internal:5432/insurance_ai"


def refused(fn, *args, **kwargs) -> str:
    try:
        fn(*args, **kwargs)
    except EvaluationGuardError as exc:
        return str(exc)
    raise AssertionError(f"{fn.__name__}{args} was accepted but must be refused")


# ── safety guards ──────────────────────────────────────────────────────────────────────────────────────────────────────

def test_an_evaluation_process_is_accepted() -> None:
    assert_evaluation_process(GOOD_ENV)
    assert parse_database_url(GOOD_ENV["DATABASE_URL"]) == ("eval-postgres", "insurance_eval")


def test_the_production_database_is_refused_whatever_its_name() -> None:
    assert "not an evaluation host" in refused(assert_evaluation_database, PROD_URL, env={})
    # even on an allowed host, a name that does not end in _eval is refused ...
    assert "does not end in" in refused(assert_evaluation_database, "postgresql+asyncpg://u:p@eval-postgres:5432/insurance_ai", env={})
    # ... and a production target is refused even if it were made to look like an evaluation one
    prod_like = "postgresql+asyncpg://u:p@eval-postgres:5432/insurance_eval"
    assert "production database" in refused(assert_evaluation_database, prod_like, production_urls=[prod_like], env={})
    assert "production database" in refused(assert_evaluation_database, prod_like, env={"PRODUCTION_DATABASE_URLS": prod_like})


def test_a_process_not_started_as_evaluation_is_refused() -> None:
    assert "EVAL_ENVIRONMENT=1" in refused(assert_evaluation_process, {"DATABASE_URL": GOOD_ENV["DATABASE_URL"]})
    assert "EVAL_ENVIRONMENT=1" in refused(assert_evaluation_process, {**GOOD_ENV, "EVAL_ENVIRONMENT": "true"})        # exactly "1"
    assert "no host or no database" in refused(assert_evaluation_process, {"EVAL_ENVIRONMENT": "1", "DATABASE_URL": ""})


def test_any_external_credential_is_refused() -> None:
    from shared.evaluation.safety import FORBIDDEN_CREDENTIALS
    for name in FORBIDDEN_CREDENTIALS:
        assert name in refused(assert_evaluation_process, {**GOOD_ENV, name: "real-looking-value"}), name
    assert_evaluation_process({**GOOD_ENV, "AWS_ACCESS_KEY_ID": "   "})                      # blank is not a credential
    # the OCR engine is allowed its model key only: it may hold that, and still nothing else
    assert_no_external_credentials({"OPENAI_API_KEY": "k"})
    assert "AWS_ACCESS_KEY_ID" in refused(assert_no_external_credentials, {"AWS_ACCESS_KEY_ID": "k", "OPENAI_API_KEY": "k"}, allow=("OPENAI_API_KEY",))


def test_the_recording_producer_exists_only_in_an_evaluation_process() -> None:
    saved = {k: os.environ.get(k) for k in ("EVAL_ENVIRONMENT", "DATABASE_URL")}
    try:
        os.environ.pop("EVAL_ENVIRONMENT", None)
        os.environ["DATABASE_URL"] = GOOD_ENV["DATABASE_URL"]
        refused(RecordingProducer)                                                           # a real deployment must not swallow events
        os.environ["DATABASE_URL"] = PROD_URL
        os.environ["EVAL_ENVIRONMENT"] = "1"
        refused(RecordingProducer)                                                           # the flag alone is not enough
        os.environ["DATABASE_URL"] = GOOD_ENV["DATABASE_URL"]
        producer = RecordingProducer()
        asyncio.run(producer.start())
        asyncio.run(producer.send_and_wait("topic", value="v", key="k"))
        assert producer.sent == [("topic", "k", "v")]
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)


# ── the token ledger's posters ─────────────────────────────────────────────────────────────────────────────────────────

POSTERS = ("ocr-engine/main.py", "text-summarizer/main.py", "risk-engine/usage.py", "chat-agent/usage.py")


def test_every_service_that_writes_to_the_ledger_sends_the_internal_secret() -> None:
    """POST /tokens/usage refuses callers without X-Internal-Secret, so a poster that loses the header silently stops
    recording spend. Each call to the endpoint must carry it, within the same call."""
    backend = Path(__file__).resolve().parents[2] / "microservices" / "backend-microservices"
    bare = []
    for rel in POSTERS:
        text = (backend / rel).read_text(encoding="utf-8")
        # only real post(...) calls count: a docstring that mentions the endpoint does not send anything
        calls = [m.start() for m in re.finditer(r"/tokens/usage", text) if "post(" in text[max(0, m.start() - 90):m.start()]]
        assert calls, f"{rel} no longer posts to the ledger: remove it from POSTERS if that is intended"
        bare += [rel for at in calls if "X-Internal-Secret" not in text[at:at + 500]]
    assert not bare, f"these posters send no internal secret: {sorted(set(bare))}"


def test_the_gateway_does_not_forward_ledger_writes() -> None:
    text = (Path(__file__).resolve().parents[2] / "microservices/backend-microservices/api-gateway/main.py").read_text(encoding="utf-8")
    route = text[text.index('"/tokens/usage"') - 80: text.index('"/tokens/usage"') + 120]
    assert "POST" not in route, "the gateway must not expose POST /tokens/usage"


def test_the_ledger_write_fails_closed() -> None:
    text = (Path(__file__).resolve().parents[2] / "microservices/backend-microservices/tenant-service/routers/tokens.py").read_text(encoding="utf-8")
    assert "def require_internal_service" in text and "compare_digest" in text
    assert 'dependencies=[Depends(require_internal_service)]' in text.split('@router.post("/usage"')[1].split("async def")[0] or \
        '@router.post("/usage", dependencies=[Depends(require_internal_service)])' in text
    assert "status_code=503" in text, "an unset secret must refuse writes, not allow them"


# ── model providers and prices ────────────────────────────────────────────────────────────────────────────────────────

def test_only_allowed_providers_may_hold_a_key() -> None:
    from shared.evaluation.safety import EvaluationGuardError, assert_provider_policy
    assert assert_provider_policy({}) == set(), "no key at all is fine: model-backed cases are blocked, not failed"
    assert assert_provider_policy({"OPENAI_API_KEY": "k"}) == {"openai"}
    assert assert_provider_policy({"GEMINI_API_KEY": "k", "EVAL_ALLOWED_PROVIDERS": "openai,gemini"}) == {"gemini"}
    for env in ({"OPENAI_API_KEY": "k", "GEMINI_API_KEY": "k"}, {"ANTHROPIC_API_KEY": "k"}, {"EVAL_ALLOWED_PROVIDERS": "openai", "GEMINI_API_KEY": "k"}):
        try:
            assert_provider_policy(env)
        except EvaluationGuardError:
            continue
        raise AssertionError(f"{sorted(env)} was accepted")
    assert assert_provider_policy({"OPENAI_API_KEY": "   "}) == set(), "a blank key is no key"


def test_prices_turn_tokens_into_money_and_unknown_models_are_unknown() -> None:
    from shared.evaluation.pricing import cost_of, cost_of_rows
    row = {"model_name": "gpt-4o-mini-2024-07-18", "input_tokens": 1_000_000, "cached_tokens": 400_000, "output_tokens": 100_000}
    assert abs(cost_of(row) - (600_000 * 0.15 + 400_000 * 0.075 + 100_000 * 0.60) / 1e6) < 1e-9
    assert cost_of({"model_name": "gpt-4o-2024-08-06", "input_tokens": 1_000_000, "output_tokens": 0}) == 2.5, "the longest listed name wins (gpt-4o, not gpt-4o-mini)"
    assert cost_of({"model_name": "something-new", "input_tokens": 5}) is None
    assert cost_of_rows([row, {"model_name": "x", "input_tokens": 1}])[1] == 1


# ── fixtures: validation and determinism ───────────────────────────────────────────────────────────────────────────────

def world() -> seeding.World:
    return seeding.load_world(casekit.FIXTURES, EXTRAS)


def test_the_fixtures_are_consistent() -> None:
    w = world()
    assert seeding.validate(w) == []
    assert {t["ref"] for t in w.tenants} == {"tenant-a", "tenant-b"}                          # a second tenant exists for isolation checks
    assert w.canaries and all(isinstance(c, str) for c in w.canaries)


def test_a_broken_reference_is_reported_not_seeded() -> None:
    w = copy.deepcopy(world())
    w.policies[0]["customer"] = "cust-nobody"
    w.policies[1]["plan"] = "NO_SUCH_PLAN"
    w.claims[0]["policy"] = "pol-nowhere"
    w.users[1]["tenant"] = "tenant-z"
    w.users.append(copy.deepcopy(w.users[0]))
    problems = seeding.validate(w)
    for needle in ("unknown customer", "unknown plan", "unknown policy", "unknown tenant", "duplicate user"):
        assert any(needle in p for p in problems), (needle, problems)


def test_ids_are_deterministic_and_distinct() -> None:
    assert seeding.sid("policy", "pol-term-faisal") == seeding.sid("policy", "pol-term-faisal")
    assert seeding.sid("policy", "x") != seeding.sid("customer", "x")
    assert seeding.sid("policy", "x") != seeding.sid("policy", "y")
    # pinned: if the namespace or the scheme ever changes, every seeded id (and every stored reference to one) would drift
    assert str(seeding.sid("policy", "pol-term-faisal")) == "d1bea091-3fe7-5118-9386-d0c828e1a43d"


def test_a_birth_date_gives_the_exact_age() -> None:
    for today in (date(2026, 10, 22), date(2026, 2, 28), date(2024, 2, 29), date(2026, 1, 1)):
        for age, past in ((35, 30), (52, 30), (28, 0), (41, 200)):
            dob = seeding.date_of_birth({"age_years": age, "days_past_birthday": past}, today)
            years = today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))
            assert years == age, (today, age, past, dob, years)


def test_the_second_tenants_canaries_exist_only_in_the_second_tenant() -> None:
    w = world()
    a_text = json.dumps([x for kind in (w.customers, w.policies, w.claims, w.payouts) for x in kind if x["_tenant"] == "tenant-a"])
    b_text = json.dumps([x for kind in (w.customers, w.policies, w.claims, w.payouts) for x in kind if x["_tenant"] == "tenant-b"])
    for canary in w.canaries:
        assert canary not in a_text, f"{canary!r} is in tenant A's data, so it can no longer prove a leak"
        assert canary in b_text, f"{canary!r} is not in tenant B's data"


# ── fixture coverage ───────────────────────────────────────────────────────────────────────────────────────────────────

def test_every_reference_in_the_cases_exists_in_the_seeded_world() -> None:
    """The 70 cases name users, tenants, policies, claims, customers and plans. Each must be something the seeder creates."""
    w = world()
    refs = {"user": {u["ref"] for u in w.users}, "tenant": {t["ref"] for t in w.tenants}, "policy": {p["ref"] for p in w.policies},
            "claim": {c["ref"] for c in w.claims}, "customer": {c["ref"] for c in w.customers}, "plan": {p["code"] for p in w.plans}}
    missing = []
    for _, raw in casekit.sources():
        case, _ = casekit.normalise(raw)
        cid, payload, actor = case["case_id"], case["input"].get("payload") or {}, case["input"].get("actor") or {}
        for kind, ref in (("user", actor.get("user_ref")), ("tenant", actor.get("tenant_ref")), ("policy", payload.get("policy")),
                          ("claim", payload.get("claim")), ("tenant", payload.get("tenant"))):
            if isinstance(ref, str) and ref and ref not in refs[kind]:      # `policy` is sometimes an inline object, not a reference
                missing.append(f"{cid}: {kind} {ref!r}")
        text = json.dumps(case)
        for ref in re.findall(r"\bcust-[a-z0-9-]+", text):
            if ref not in refs["customer"]:
                missing.append(f"{cid}: customer {ref!r}")
        for code in re.findall(r"\$plan\.([A-Z_]+)\.", text) + ([payload["plan_code"]] if payload.get("plan_code") else []):
            if code not in refs["plan"]:
                missing.append(f"{cid}: plan {code!r}")
    assert not missing, "; ".join(sorted(set(missing))[:8])


def test_every_actor_role_is_a_fixture_user_of_that_role() -> None:
    w = world()
    roles = {u["ref"]: u["role"] for u in w.users}
    wrong = []
    for _, raw in casekit.sources():
        case, _ = casekit.normalise(raw)
        actor = case["input"].get("actor") or {}
        if actor.get("user_ref") and roles.get(actor["user_ref"]) != actor.get("role"):
            wrong.append(f"{case['case_id']}: {actor.get('user_ref')} is {roles.get(actor['user_ref'])}, the case says {actor.get('role')}")
    assert not wrong, "; ".join(wrong)


TESTS = [test_only_allowed_providers_may_hold_a_key, test_prices_turn_tokens_into_money_and_unknown_models_are_unknown,
         test_every_service_that_writes_to_the_ledger_sends_the_internal_secret, test_the_gateway_does_not_forward_ledger_writes,
         test_the_ledger_write_fails_closed, test_an_evaluation_process_is_accepted, test_the_production_database_is_refused_whatever_its_name,
         test_a_process_not_started_as_evaluation_is_refused, test_any_external_credential_is_refused,
         test_the_recording_producer_exists_only_in_an_evaluation_process, test_the_fixtures_are_consistent,
         test_a_broken_reference_is_reported_not_seeded, test_ids_are_deterministic_and_distinct, test_a_birth_date_gives_the_exact_age,
         test_the_second_tenants_canaries_exist_only_in_the_second_tenant, test_every_reference_in_the_cases_exists_in_the_seeded_world,
         test_every_actor_role_is_a_fixture_user_of_that_role]


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
    print(f"{'PASS' if not failures else 'FAILED'}: {len(TESTS)} environment tests, {failures} failed")
    sys.exit(1 if failures else 0)
