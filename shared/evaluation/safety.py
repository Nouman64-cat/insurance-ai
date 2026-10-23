"""Hard guards that keep evaluation work away from production data and from real-world side effects.

A tenant id is not a barrier: a worker holding the wrong database URL can read every tenant. So the checks here look at the
*process*: which database it would connect to, what credentials it was handed, and whether it was told it is an evaluation
process. Each check raises EvaluationGuardError, which the callers (the seeder, the reset, the runner, and the services
themselves when EVAL_MOCK_EXTERNALS is on) do not catch.

The rules, all of which must hold:
  * EVAL_ENVIRONMENT=1 is set: the process was deliberately started as an evaluation process;
  * the database it would use is on an allowed evaluation host and its name ends in `_eval`;
  * it is not any production database the process can see (PRODUCTION_DATABASE_URLS, a comma-separated list, plus the
    repo-level DATABASE_URL names the operator passes to `provision`);
  * it holds none of the credentials that would let it send mail, write to S3, call sanctions screening or reach other
    production systems (FORBIDDEN_CREDENTIALS), except those a given role is explicitly allowed (the OCR engine's model key).
Nothing here connects to anything: it only reads strings, so it is safe to run first and cheap to test.
"""
from __future__ import annotations

import os
from typing import Iterable, Mapping, Optional, Sequence
from urllib.parse import urlsplit

EVAL_DB_SUFFIX = "_eval"
DEFAULT_EVAL_HOSTS = ("eval-postgres",)

# Presence of any of these means the process could affect real customers or spend real money outside the model call.
FORBIDDEN_CREDENTIALS = (
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SES_USERNAME", "AWS_SES_PASSWORD", "AWS_SES_FROM_EMAIL",
    "EMAIL_PROVIDER", "OPENSANCTIONS_API_KEY", "CUSTOMER_MANAGEMENT_URL", "AUDIT_SERVICE_URL", "SMTP_PASSWORD",
)


class EvaluationGuardError(RuntimeError):
    """The process or the database is not safe for evaluation work. Never retry; fix the setup."""


def parse_database_url(url: str) -> tuple[str, str]:
    """(host, database name) of a SQLAlchemy-style URL, lower-cased. Raises if either is missing."""
    parts = urlsplit(url or "")
    host, name = (parts.hostname or "").lower(), (parts.path or "").lstrip("/").split("?")[0].lower()
    if not host or not name:
        raise EvaluationGuardError("the database URL has no host or no database name")
    return host, name


def _production_targets(extra: Iterable[str], env: Mapping[str, str]) -> set[tuple[str, str]]:
    urls = [u.strip() for u in (env.get("PRODUCTION_DATABASE_URLS") or "").split(",") if u.strip()] + [u for u in extra if u]
    targets = set()
    for u in urls:
        try:
            targets.add(parse_database_url(u))
        except EvaluationGuardError:
            continue
    return targets


def assert_evaluation_database(url: str, *, production_urls: Iterable[str] = (), allowed_hosts: Optional[Sequence[str]] = None,
                               env: Optional[Mapping[str, str]] = None) -> tuple[str, str]:
    """The database is an evaluation database: allowed host, name ending in `_eval`, and not a production target."""
    env = os.environ if env is None else env
    host, name = parse_database_url(url)
    hosts = tuple(h.lower() for h in (allowed_hosts or [h for h in (env.get("EVAL_DB_HOSTS") or "").split(",") if h.strip()] or DEFAULT_EVAL_HOSTS))
    if host not in hosts:
        raise EvaluationGuardError(f"database host {host!r} is not an evaluation host ({', '.join(hosts)})")
    if not name.endswith(EVAL_DB_SUFFIX):
        raise EvaluationGuardError(f"database {name!r} does not end in {EVAL_DB_SUFFIX!r}; refusing to touch it")
    if (host, name) in _production_targets(production_urls, env):
        raise EvaluationGuardError(f"{host}/{name} is a production database")
    return host, name


def assert_no_external_credentials(env: Optional[Mapping[str, str]] = None, *, allow: Iterable[str] = ()) -> None:
    """The process was not handed credentials that could send mail, write to S3 or call regulated services."""
    env = os.environ if env is None else env
    allowed = set(allow)
    held = sorted(k for k in FORBIDDEN_CREDENTIALS if k not in allowed and (env.get(k) or "").strip())
    if held:
        raise EvaluationGuardError("an evaluation process must not hold " + ", ".join(held))


# Model providers and the environment variable holding each one's key.
PROVIDER_KEYS = {"openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY", "anthropic": "ANTHROPIC_API_KEY"}


def allowed_providers(env: Optional[Mapping[str, str]] = None) -> set[str]:
    """The providers this evaluation may call (EVAL_ALLOWED_PROVIDERS, comma-separated; default: openai, the OCR baseline)."""
    env = os.environ if env is None else env
    return {p.strip().lower() for p in (env.get("EVAL_ALLOWED_PROVIDERS") or "openai").split(",") if p.strip()}


def configured_providers(env: Optional[Mapping[str, str]] = None) -> set[str]:
    """The providers the environment holds a key for."""
    env = os.environ if env is None else env
    return {name for name, var in PROVIDER_KEYS.items() if (env.get(var) or "").strip()}


def assert_provider_policy(env: Optional[Mapping[str, str]] = None) -> set[str]:
    """No key for a provider outside the allow-list. A provider without a key cannot be called, so holding only the allowed keys is
    what keeps the one network-enabled service (the OCR engine) from spending on anything else. Returns the providers that can
    actually be called (allowed and keyed); an empty set is fine: model-backed cases are then blocked, not failed.
    This limits WHICH provider; it does not limit the network destination (the OCR engine has general egress)."""
    env = os.environ if env is None else env
    stray = sorted(configured_providers(env) - allowed_providers(env))
    if stray:
        raise EvaluationGuardError(f"keys for {', '.join(stray)} are present but only {', '.join(sorted(allowed_providers(env)))} may be called "
                                   "(EVAL_ALLOWED_PROVIDERS); remove them from eval.env or allow the provider on purpose")
    return configured_providers(env) & allowed_providers(env)


def assert_evaluation_process(env: Optional[Mapping[str, str]] = None, *, needs_database: bool = True,
                              allow_credentials: Iterable[str] = (), production_urls: Iterable[str] = ()) -> None:
    """Every guard at once. Call it before any seed, reset or run, and when a service switches its external calls to mocks."""
    env = os.environ if env is None else env
    if (env.get("EVAL_ENVIRONMENT") or "").strip() != "1":
        raise EvaluationGuardError("EVAL_ENVIRONMENT=1 is not set: this process was not started as an evaluation process")
    if needs_database:
        assert_evaluation_database(env.get("DATABASE_URL", ""), production_urls=production_urls, env=env)
    assert_no_external_credentials(env, allow=allow_credentials)
    assert_provider_policy(env)
