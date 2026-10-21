"""Builders for throwaway cases used by the evaluation lake tests. These are test scaffolding, not Golden data: the real
dataset lives in the database and MinIO and is never written in Python.
"""
from __future__ import annotations

import copy
import json
from typing import Any, List


def make_case(case_id: str = "IND-TST-001", *, message: str | None = None, **overrides: Any) -> dict:
    case = {
        "schema_version": "1.0",
        "case_id": case_id,
        "title": f"Premium question {case_id}",
        "workflow": "individual-insurance",
        "turn_mode": "single_turn",
        "stage": "premium_payment",
        "category": "premium-payment",
        "scenario_type": "positive",
        "difficulty": "easy",
        "severity": "medium",
        "tags": ["premium", "quotation"],
        "input": {
            "messages": [{"role": "user", "content": message or f"What does cover case {case_id} cost per year?"}],
            "payload": {"coverage_amount": 5_000_000, "term_years": 20},
            "fixture_refs": [],
        },
        "expected": {
            "summary": "Gives the yearly premium from the pricing engine.",
            "outcome": "answered",
            "tool_calls": [{"tool": "calculate_premium", "arguments": {"term_years": 20}}],
        },
        "reference_context": [{"source": "pricing_engine.py", "text": "Premium = rate x cover.", "kind": "code"}],
        "assertions": [{"id": "A1", "type": "contains", "target": "response.text", "expected": "premium", "severity": "major"}],
        "semantic_criteria": [{"id": "S1", "criterion": "States a premium amount and what it is based on.", "metric": "correctness"}],
        "source": {"kind": "synthetic", "reference": "test scaffolding", "verification": "code_verified"},
    }
    case.update(copy.deepcopy(overrides))
    return case


def make_multi_turn(case_id: str = "IND-TST-MT1", **overrides: Any) -> dict:
    return make_case(case_id, turn_mode="multi_turn", stage="lead", category="lead-onboarding", **{
        "input": {"messages": [{"role": "user", "content": f"Hello, I want to buy cover ({case_id})"},
                               {"role": "user", "content": "I am 35 and do not smoke"}], "payload": {}, "fixture_refs": []},
        **overrides})


def jsonl_bytes(*cases: dict) -> bytes:
    return "".join(json.dumps(c) + "\n" for c in cases).encode("utf-8")


def many(n: int, prefix: str = "IND-TST") -> List[dict]:
    return [make_case(f"{prefix}-{i:03d}") for i in range(1, n + 1)]
