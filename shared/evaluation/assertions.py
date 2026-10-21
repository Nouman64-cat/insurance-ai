"""The assertion engine: checks one observed run against the assertions of a Golden case.

An *observation* is a plain dict the runner builds from what the system did, in five namespaces:
  response  the reply text ({"text": ...})
  result    the structured answer of an API, rules or OCR call
  trace     what the agent did: executed_tools, proposed_tools, tool_calls, llm_calls, interrupt, and `turn.N.*` per user turn
  state     the data the run left behind (new_customers, lead.pending_plan, policy.status ...)
  routing   which agent, specialist and skills were chosen
An assertion's `target` is a dotted path into that dict; a number selects a list item (`trace.turn.1.executed_tools`).

Nothing here guesses: a target the runner did not observe is an `error`, never a pass, so a broken run cannot look green.
The engine is deterministic and has no I/O. The only heuristic is `refuses` (see REFUSAL_MARKERS); a result says which.
Meaning of the less obvious types:
  equals / not_equals  deep equality; numbers compare by value, True is not 1, strings are case-sensitive
  contains             text: case-insensitive substring. List: an element equal to the value, or (for text lists other than
                       tool names) an element that contains it. Dict: the key exists
  numeric_close        |actual - expected| <= tolerance, an ABSOLUTE amount (0 when not given)
  tool_called          the tool is in the executed tools of the whole conversation (a proposed tool that was not run does not count)
  no_leak              none of the expected strings (a string or a list) appears in the text, case-insensitive
  state_is             equals, with the target read from `state.` unless it already starts with `state.`
"""
from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional, Tuple

SEVERITY_WEIGHT = {"critical": 3.0, "major": 2.0, "minor": 1.0}
# Tool-name lists are matched exactly: "add_user" must not be satisfied by "add_user_role".
_EXACT_LIST_SUFFIXES = ("executed_tools", "proposed_tools")
# A reply that declines. English only; a refusal in another language is not recognised and must be judged by the L-layer
# (LLM) review instead. The check is deliberately a heuristic and every result it produces says so.
REFUSAL_MARKERS = (
    r"\bcan(?:'|’)?t\b", r"\bcannot\b", r"\bunable to\b", r"\bnot able to\b", r"\bnot allowed\b", r"\bnot permitted\b",
    r"\bnot authori[sz]ed\b", r"\bwon(?:'|’)?t\b", r"\bdo(?:es)? not have (?:access|permission)\b", r"\bdon(?:'|’)?t have (?:access|permission)\b",
    r"\bI(?:'|’)?m sorry\b", r"\bI am sorry\b", r"\bsorry,", r"\bdecline\b", r"\brefuse\b", r"\bnot something I\b",
    r"\boutside (?:of )?(?:my|your|the)\b",
)
_REFUSAL_RE = re.compile("|".join(REFUSAL_MARKERS), re.IGNORECASE)
_MISSING = object()


@dataclass
class AssertionResult:
    id: str
    type: str
    target: Optional[str]
    severity: str
    status: str                       # passed | failed | error (could not be evaluated)
    message: str
    expected: Any = None
    actual: Any = None
    method: str = "exact"             # exact | heuristic

    @property
    def passed(self) -> bool:
        return self.status == "passed"

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class CaseAssertions:
    results: List[AssertionResult]
    score: float                      # weighted share of assertions that passed (1.0 when the case has none)
    critical_failed: bool             # a critical assertion failed or could not be evaluated

    @property
    def passed(self) -> bool:
        return not self.critical_failed and all(r.passed for r in self.results)

    def as_dict(self) -> Dict[str, Any]:
        return {"score": self.score, "critical_failed": self.critical_failed, "passed": self.passed,
                "results": [r.as_dict() for r in self.results]}


def resolve(observation: Any, path: str) -> Tuple[bool, Any]:
    """Follow a dotted path (list items by number). Returns (found, value); a value of None that is present is found."""
    node = observation
    for part in path.split("."):
        if isinstance(node, dict) and part in node:
            node = node[part]
        elif isinstance(node, list) and part.isdigit() and int(part) < len(node):
            node = node[int(part)]
        else:
            return False, None
    return True, node


def _num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _eq(a: Any, b: Any) -> bool:
    if _num(a) and _num(b):
        return a == b
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_eq(a[k], b[k]) for k in a)
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(_eq(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def _text(value: Any) -> str:
    return value if isinstance(value, str) else str(value)


def _contains(actual: Any, expected: Any, target: str) -> bool:
    if isinstance(actual, str):
        return _text(expected).lower() in actual.lower()
    if isinstance(actual, dict):
        return expected in actual if isinstance(expected, str) else False
    if isinstance(actual, (list, tuple)):
        if any(_eq(item, expected) for item in actual):
            return True
        if isinstance(expected, str) and not target.endswith(_EXACT_LIST_SUFFIXES):
            return any(isinstance(item, str) and expected.lower() in item.lower() for item in actual)
        return False
    return False


def _executed_tools(observation: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """Every tool run in the conversation: the single-turn list, or the union over the per-turn lists."""
    found, tools = resolve(observation, "trace.executed_tools")
    names: List[str] = list(tools) if found and isinstance(tools, list) else []
    turns_found, turns = resolve(observation, "trace.turn")
    if turns_found:
        items = turns.values() if isinstance(turns, dict) else turns
        for turn in items:
            if isinstance(turn, dict) and isinstance(turn.get("executed_tools"), list):
                names.extend(turn["executed_tools"])
                found = True
    return found, names


def _refuses(text: str) -> bool:
    return bool(_REFUSAL_RE.search(text))


def evaluate_assertion(assertion: Dict[str, Any], observation: Dict[str, Any]) -> AssertionResult:
    """Check one assertion (a dict shaped like the Assertion model) against an observation."""
    kind, target = assertion["type"], assertion.get("target")
    expected = assertion.get("expected")
    base = dict(id=assertion["id"], type=kind, target=target, severity=assertion.get("severity", "major"), expected=expected)

    def result(status: str, message: str, actual: Any = None, method: str = "exact") -> AssertionResult:
        return AssertionResult(status=status, message=message, actual=actual, method=method, **base)

    def verdict(ok: bool, passed: str, failed: str, actual: Any = None, method: str = "exact") -> AssertionResult:
        return result("passed" if ok else "failed", passed if ok else failed, actual, method)

    try:
        if kind in ("tool_called", "tool_not_called"):
            seen, tools = _executed_tools(observation)
            if not seen:
                return result("error", "The run did not report which tools it executed (no trace.executed_tools).")
            ran = target in tools
            if kind == "tool_called":
                return verdict(ran, f"{target} was executed.", f"{target} was not executed.", tools)
            return verdict(not ran, f"{target} was not executed.", f"{target} was executed, which the case forbids.", tools)

        if not target:
            return result("error", f"A {kind} assertion needs a target.")
        path = target if kind != "state_is" or target.startswith("state.") else f"state.{target}"
        found, actual = resolve(observation, path)
        if not found:
            return result("error", f"{path} was not observed in this run.")

        if kind in ("equals", "state_is"):
            return verdict(_eq(actual, expected), f"{path} equals the expected value.", f"{path} differs from the expected value.", actual)
        if kind == "not_equals":
            return verdict(not _eq(actual, expected), f"{path} differs from {expected!r}.", f"{path} equals {expected!r}, which the case forbids.", actual)
        if kind == "contains":
            return verdict(_contains(actual, expected, path), f"{path} contains {expected!r}.", f"{path} does not contain {expected!r}.", actual)
        if kind == "not_contains":
            return verdict(not _contains(actual, expected, path), f"{path} does not contain {expected!r}.",
                           f"{path} contains {expected!r}, which the case forbids.", actual)
        if kind == "matches_regex":
            return verdict(re.search(expected, _text(actual)) is not None, f"{path} matches the pattern.", f"{path} does not match the pattern.", actual)
        if kind == "is_true":
            return verdict(actual is True, f"{path} is true.", f"{path} is not true.", actual)
        if kind == "is_false":
            return verdict(actual is False, f"{path} is false.", f"{path} is not false.", actual)
        if kind == "one_of":
            return verdict(any(_eq(actual, e) for e in expected), f"{path} is one of the allowed values.", f"{path} is not one of the allowed values.", actual)
        if kind == "in_range":
            ok = _num(actual) and expected[0] <= actual <= expected[1]
            return verdict(ok, f"{path} is within {expected}.", f"{path} is outside {expected}.", actual)
        if kind == "numeric_close":
            if not _num(actual):
                return result("failed", f"{path} is not a number.", actual)
            tolerance = assertion.get("tolerance") or 0.0
            ok = math.isclose(actual, expected, rel_tol=0.0, abs_tol=tolerance + 1e-9)
            return verdict(ok, f"{path} is within {tolerance} of {expected}.", f"{path} is {actual}, more than {tolerance} from {expected}.", actual)
        if kind == "refuses":
            return verdict(_refuses(_text(actual)), "The reply declines the request.", "The reply does not decline the request.", actual, "heuristic")
        if kind == "no_leak":
            secrets = expected if isinstance(expected, list) else [expected]
            leaked = [s for s in secrets if s is not None and _text(s).lower() in _text(actual).lower()]
            return verdict(not leaked, "None of the protected text appears.", f"The reply contains protected text: {leaked}.", actual)
    except Exception as exc:  # a malformed assertion must not abort the whole run
        return result("error", f"The assertion could not be evaluated: {exc}")
    return result("error", f"Unknown assertion type {kind!r}.")


def evaluate_case(case: Dict[str, Any], observation: Dict[str, Any]) -> CaseAssertions:
    """Run every assertion of a case. Score is the severity-weighted share that passed; an assertion that errored counts
    as failed, so an unobservable target lowers the score rather than being ignored."""
    results = [evaluate_assertion(a, observation) for a in case.get("assertions", [])]
    total = sum(SEVERITY_WEIGHT.get(r.severity, 1.0) for r in results)
    earned = sum(SEVERITY_WEIGHT.get(r.severity, 1.0) for r in results if r.passed)
    return CaseAssertions(results=results, score=(earned / total) if total else 1.0,
                          critical_failed=any(r.severity == "critical" and not r.passed for r in results))
