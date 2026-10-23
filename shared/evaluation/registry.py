"""The model registry's rules, kept apart from the web layer so they can be tested without a database: what a model entry must look
like, what a price needs, which price applied on a given day, and the entries a fresh platform starts with.

A model is identified the way the runner names it: `provider/model_id` (openai/gpt-4o-mini, gemini/gemini-2.5-flash,
anthropic/claude-sonnet-4-5, mock/mock-oracle). `mock` models are the scripted stand-ins of the evaluation stack: synthetic by
definition, price zero, never a quality result. Every other provider is real, and a real model is never marked synthetic.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from shared.evaluation.pricing import PRICES, PRICING_VERSION
from shared.models.evaluation import MODEL_PROVIDERS, MODEL_ROLES, MODEL_STATUSES

MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
CAPABILITY_FLAGS = ("streaming", "tool_calling", "json_mode", "vision")
CAPABILITY_NUMBERS = ("context_window", "max_output_tokens")
CONFIG_LIMITS = {"temperature": (0.0, 2.0), "top_p": (0.0, 1.0), "max_tokens": (1, 1_000_000), "timeout_s": (1, 3600)}
CONFIG_KEYS = set(CONFIG_LIMITS) | {"seed"}


class RegistryError(ValueError):
    """A registry entry or price that cannot be accepted; the message says what to change."""


def label(provider: str, model_id: str) -> str:
    return f"{provider}/{model_id}"


def split_label(text: str) -> Tuple[str, str]:
    provider, sep, model = (text or "").partition("/")
    if not sep or not model:
        raise RegistryError(f"{text!r} is not provider/model")
    return provider, model


def check_capabilities(caps: Dict[str, Any]) -> Dict[str, Any]:
    unknown = set(caps) - set(CAPABILITY_FLAGS) - set(CAPABILITY_NUMBERS)
    if unknown:
        raise RegistryError(f"unknown capabilities: {', '.join(sorted(unknown))}")
    for k in CAPABILITY_FLAGS:
        if k in caps and not isinstance(caps[k], bool):
            raise RegistryError(f"capability {k} must be true or false")
    for k in CAPABILITY_NUMBERS:
        if k in caps and (isinstance(caps[k], bool) or not isinstance(caps[k], int) or caps[k] < 1):
            raise RegistryError(f"capability {k} must be a positive whole number")
    return dict(caps)


def check_configuration(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """The settings a benchmark applies to the model. Anything else would silently change nothing, so it is refused."""
    unknown = set(cfg) - CONFIG_KEYS
    if unknown:
        raise RegistryError(f"unknown settings: {', '.join(sorted(unknown))} (allowed: {', '.join(sorted(CONFIG_KEYS))})")
    for k, (lo, hi) in CONFIG_LIMITS.items():
        if k in cfg and (isinstance(cfg[k], bool) or not isinstance(cfg[k], (int, float)) or not lo <= cfg[k] <= hi):
            raise RegistryError(f"{k} must be a number from {lo} to {hi}")
    if "seed" in cfg and (isinstance(cfg["seed"], bool) or not isinstance(cfg["seed"], int)):
        raise RegistryError("seed must be a whole number")
    return dict(cfg)


def check_model(provider: str, model_id: str, *, synthetic: Optional[bool] = None, status: str = "active", roles: Sequence[str] = ("candidate",),
                capabilities: Optional[Dict[str, Any]] = None, configuration: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The cleaned fields of an entry, or a RegistryError."""
    if provider not in MODEL_PROVIDERS:
        raise RegistryError(f"provider must be one of {', '.join(MODEL_PROVIDERS)}")
    if not MODEL_ID.fullmatch(model_id or ""):
        raise RegistryError("model id may use letters, digits and . _ : - (up to 80 characters)")
    if status not in MODEL_STATUSES:
        raise RegistryError(f"status must be one of {', '.join(MODEL_STATUSES)}")
    roles = list(dict.fromkeys(roles))
    if not roles or any(r not in MODEL_ROLES for r in roles):
        raise RegistryError(f"roles are chosen from {', '.join(MODEL_ROLES)}")
    is_mock = provider == "mock"
    if synthetic is not None and synthetic != is_mock:
        raise RegistryError("only mock models are synthetic, and every mock model is" if is_mock else "a real provider's model cannot be marked synthetic")
    return {"provider": provider, "model_id": model_id, "status": status, "synthetic": is_mock, "roles": roles,
            "capabilities": check_capabilities(capabilities or {}), "configuration": check_configuration(configuration or {})}


def check_price(provider: str, input_per_m: float, cached_per_m: float, output_per_m: float, source: str) -> Dict[str, Any]:
    for name, v in (("input", input_per_m), ("cached", cached_per_m), ("output", output_per_m)):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0:
            raise RegistryError(f"the {name} price must be a number, zero or more (US dollars per million tokens)")
    if cached_per_m > input_per_m:
        raise RegistryError("the cached input price cannot be above the normal input price")
    if not (source or "").strip():
        raise RegistryError("a price needs its source (a pricing page, an invoice, a contract), so it can be checked later")
    if provider == "mock" and (input_per_m or cached_per_m or output_per_m):
        raise RegistryError("a scripted model costs nothing: its price is zero")
    return {"input_per_m": float(input_per_m), "cached_per_m": float(cached_per_m), "output_per_m": float(output_per_m), "source": source.strip()[:300]}


def price_on(history: Iterable[Dict[str, Any]], when: datetime) -> Optional[Dict[str, Any]]:
    """The price in force at `when`: the newest entry that took effect on or before it. None before the first entry."""
    best = None
    for p in history:
        if p["effective_from"] <= when and (best is None or p["effective_from"] > best["effective_from"]):
            best = p
    return best


def seed_entries() -> List[Dict[str, Any]]:
    """What a fresh platform starts with: the models the Token Economy page prices, and the scripted stand-ins. Prices are the page's own
    figures (shared/evaluation/pricing.py) with that table's version as the source. Capabilities are the ones every listed model offers;
    anything not certain (context size, output limit) is left out rather than guessed."""
    out: List[Dict[str, Any]] = []
    provider_of = (("gpt-", "openai"), ("claude-", "anthropic"), ("gemini-", "gemini"))
    for name, (inp, cached, outp) in PRICES.items():
        if name.endswith("-") or name.startswith("mock"):
            continue
        provider = next(p for prefix, p in provider_of if name.startswith(prefix))
        out.append({**check_model(provider, name, roles=("candidate", "judge"), capabilities={"streaming": True, "tool_calling": True, "json_mode": True}),
                    "display_name": name, "notes": None,
                    "price": {"input_per_m": inp, "cached_per_m": cached, "output_per_m": outp, "source": f"Token Economy page prices, table {PRICING_VERSION}"}})
    for name, roles, note in (("mock-oracle", ("candidate",), "Does exactly what the case's expected tool calls say. Proves the harness can pass a case."),
                              ("mock-lazy", ("candidate",), "Answers 'Okay.' and does nothing. Proves the harness can fail a case."),
                              ("mock-reckless", ("candidate",), "Calls a tool it must not. Proves critical failures are caught."),
                              ("mock-judge", ("judge",), "Scripted judge that is favourable to anything but an empty answer. Fails calibration by design."),
                              ("mock-judge-strict", ("judge",), "Scripted judge that is unfavourable to everything. Fails calibration by design.")):
        out.append({**check_model("mock", name, roles=roles, capabilities={"streaming": True, "tool_calling": "judge" not in roles, "json_mode": True}),
                    "display_name": name, "notes": note,
                    "price": {"input_per_m": 0.0, "cached_per_m": 0.0, "output_per_m": 0.0, "source": "scripted stand-in: no money is spent"}})
    return out
