"""Scripted behaviour for the stand-in model (evals/environment/mock_llm), built from a golden case.

THIS IS SYNTHETIC. A run that used a `mock-*` model proves that the harness works (conversations are driven, tools are traced, state
is observed, assertions and costs are recorded, models can be compared) and says NOTHING about the quality of any real model. Runs
that used it are marked `synthetic_model` and are never mixed with real model results in a benchmark.

Three behaviours, chosen by the model name the agent asks for:
  mock-oracle    does what the case says should happen: makes the expected tool calls with the expected arguments, then answers in
                 words that satisfy the case's text assertions. It shows the harness can judge a correct agent as correct.
  mock-lazy      never calls a tool and answers "Okay." It shows the harness can judge an agent that does nothing as failing.
  mock-reckless  calls a tool the case forbids. It shows the harness can catch a dangerous agent, and that a critical failure
                 overrides everything else.

The plan of a conversation is {"turns": [{"calls": [{"name", "args"}], "reply": "..."}]}: per scripted user message, the tool calls
the model makes (one per model call; the agent allows one per step) and then the words it answers with.
"""
from __future__ import annotations

import re
from itertools import product
from typing import Any, Dict, List, Optional

from shared.evaluation.assertions import evaluate_assertion

# Tools a vague first message makes the agent call before anything else (the customer-type question).
FIRST_TURN_TOOLS = {"resolve_customer_type"}
BEHAVIOURS = ("mock-oracle", "mock-lazy", "mock-reckless")
_TURN = re.compile(r"turn\.(\d+)\.")


def user_texts(case: Dict[str, Any]) -> List[str]:
    return [m["content"] for m in (case.get("input") or {}).get("messages", []) if m.get("role") == "user"]


# ── sampling a string that matches a regular expression ─────────────────────────────────────────────────────────────────

def regex_samples(pattern: str, limit: int = 40) -> List[str]:
    """Strings that match `pattern`, enough of them to find one that also satisfies the case's other assertions. Walks the parsed
    pattern: each alternative of a branch is tried, a repeat is taken at its minimum (at least once), a character class gives its
    first member. Anything it cannot expand is left out; callers must still test the sample with the pattern."""
    import re._parser as sre  # type: ignore[import-not-found]

    def expand(nodes) -> List[str]:
        out = [""]
        for op, av in nodes:
            opts = expand_node(op, av)
            out = [a + b for a, b in product(out, opts[:6])][:limit]
        return out

    def expand_node(op, av) -> List[str]:
        name = str(op)
        if name == "LITERAL":
            return [chr(av)]
        if name == "NOT_LITERAL":
            return ["x" if chr(av) != "x" else "y"]
        if name == "IN":
            for kind, v in av:
                if str(kind) == "LITERAL":
                    return [chr(v)]
                if str(kind) == "RANGE":
                    return [chr(v[0])]
                if str(kind) == "CATEGORY":
                    return [{"CATEGORY_DIGIT": "1", "CATEGORY_SPACE": " ", "CATEGORY_WORD": "a"}.get(str(v), "a")]
            return ["a"]
        if name == "ANY":
            return ["a"]
        if name == "BRANCH":
            return [s for branch in av[1] for s in expand(branch)[:4]]
        if name == "SUBPATTERN":
            return expand(av[3])
        if name in ("MAX_REPEAT", "MIN_REPEAT"):
            lo, _hi, sub = av
            unit = expand(sub)[:4] or [""]
            times = max(lo, 1) if lo else 1
            return [u * times for u in unit] + ([""] if lo == 0 else [])
        if name == "CATEGORY":
            return [{"CATEGORY_DIGIT": "1", "CATEGORY_SPACE": " ", "CATEGORY_WORD": "a"}.get(str(av), "a")]
        if name in ("AT", "ASSERT", "ASSERT_NOT"):
            return [""]
        return [""]

    try:
        return list(dict.fromkeys(expand(sre.parse(pattern))))[:limit]
    except Exception:                                              # noqa: BLE001 — an unparsable pattern simply gives no sample
        return []


# ── the words of a reply ────────────────────────────────────────────────────────────────────────────────────────────────

def _turn_of(target: str, last_turn: int) -> Optional[int]:
    """The turn a text target belongs to: `response.text` is the last turn's, `trace.turn.N.response.text` is turn N's."""
    if target == "response.text":
        return last_turn
    m = _TURN.search(target or "")
    return int(m.group(1)) if m and (target or "").endswith("response.text") else None


def _passes(case: Dict[str, Any], turn: int, text: str, last_turn: int) -> bool:
    for a in case.get("assertions", []):
        if _turn_of(a.get("target") or "", last_turn) != turn:
            continue
        obs = {"response": {"text": text}, "trace": {"turn": [{"response": {"text": text}} if i + 1 == turn else {} for i in range(last_turn)]}}
        probe = {**a, "target": "response.text" if a["target"] == "response.text" else f"trace.turn.{turn}.response.text"}
        if evaluate_assertion(probe, obs).status != "passed":
            return False
    return True


def reply_for(case: Dict[str, Any], turn: int, last_turn: int) -> str:
    """Words for turn `turn` (1-based) that satisfy every text assertion the case makes about that turn's reply."""
    wanted = [a for a in case.get("assertions", []) if _turn_of(a.get("target") or "", last_turn) == turn]
    outcome = ((case.get("expected") or {}).get("outcome") or "").lower()
    refusing = outcome.startswith(("refused", "forbidden", "out_of_scope")) or any(a["type"] == "refuses" for a in wanted)
    base = "I'm sorry, I can't do that. That is outside what your role may do here." if refusing else "Done. Here is what I found."
    literals = [str(a["expected"]) for a in wanted if a["type"] == "contains" and a.get("expected") is not None]
    candidates: List[str] = []
    regex_options = [regex_samples(a["expected"]) or [""] for a in wanted if a["type"] == "matches_regex"]
    for combo in (product(*[o[:6] for o in regex_options]) if regex_options else [()]):
        candidates.append(" ".join([base, *literals, *[c for c in combo if c]]))
    candidates.append(" ".join([base, *literals]))
    for text in candidates:
        if _passes(case, turn, text, last_turn):
            return text
    return candidates[0]


# ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────────────────

def _call_turns(case: Dict[str, Any], calls: List[Dict[str, Any]], n_turns: int) -> List[int]:
    """The turn (1-based) each expected call is made in: where an assertion says so, the first turn for the customer-type question,
    otherwise the last turn (the details that make the call possible arrive last)."""
    placed: List[int] = []
    for call in calls:
        name, turn = call["tool"], n_turns
        for a in case.get("assertions", []):
            m = _TURN.search(a.get("target") or "")
            if m and a["type"] == "contains" and str(a.get("expected")) == name and (a["target"] or "").endswith("executed_tools"):
                turn = int(m.group(1))
        if name in FIRST_TURN_TOOLS:
            turn = 1
        placed.append(min(max(turn, 1), n_turns))
    return placed


def build_plan(case: Dict[str, Any], behaviour: str = "mock-oracle") -> Dict[str, Any]:
    """The scripted conversation for `case` (placeholders already substituted) under one behaviour."""
    texts = user_texts(case)
    n = max(len(texts), 1)
    plan: List[Dict[str, Any]] = [{"calls": [], "reply": ""} for _ in range(n)]
    if behaviour == "mock-lazy":
        for t in plan:
            t["reply"] = "Okay."
        return {"behaviour": behaviour, "case_id": case["case_id"], "user_texts": texts, "turns": plan}
    expected_calls = [c for c in (case.get("expected") or {}).get("tool_calls") or [] if c.get("required", True)]
    expected_calls.sort(key=lambda c: c.get("order") or 0)
    if behaviour == "mock-reckless":
        forbidden = [a["target"] for a in case.get("assertions", []) if a["type"] == "tool_not_called"]
        if forbidden:
            plan[-1]["calls"].append({"name": forbidden[0], "args": {}})
    else:
        for call, turn in zip(expected_calls, _call_turns(case, expected_calls, n)):
            plan[turn - 1]["calls"].append({"name": call["tool"], "args": dict(call.get("arguments") or {})})
    for i, t in enumerate(plan, start=1):
        t["reply"] = reply_for(case, i, n)
    return {"behaviour": behaviour, "case_id": case["case_id"], "user_texts": texts, "turns": plan}
