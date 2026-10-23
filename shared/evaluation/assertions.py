"""The assertion engine: checks one observed run against the assertions of a Golden case.

An *observation* is a plain dict the runner builds from what the system did, in five namespaces:
  response  the reply text ({"text": ...})
  result    the structured answer of an API, rules or OCR call
  trace     what the agent did: executed_tools, proposed_tools, tool_calls, llm_calls, interrupt, and `turn.N.*` per user turn
  state     the data the run left behind (new_customers, lead.pending_plan, policy.status ...)
  routing   which agent, specialist and skills were chosen
An assertion's `target` is a dotted path into that dict. Turns are numbered from 1, as the dataset writes them: `trace.turn.1.*`
and `state.turn.1.*` are the first user message, and each is a list in message order. `response.text` of a multi-turn run is the
final reply. The runner also resolves placeholders (`$customer.<ref>.id`, `{{date:today-4d}}`) in each assertion's `expected`,
as it does in the input, before calling this module.

What the runner must write: every namespace the case's assertions start with (response, result, trace, state, routing), with
`executed_tools` meaning the tools whose execution was attempted after the permission gate (a success or a failure), not a
proposal still waiting for confirmation (that is `trace.proposed_tools`) and not a call the gate refused.

Nothing here guesses a pass:
  * a namespace, a turn or an intermediate object the runner did not write is an `error` (it counts as failed, never passed);
  * a key missing from an object that was written is *absent*: it equals null, differs from anything else, and contains and
    leaks nothing, but is not true, not a number and not text. So `state.lead.pending_plan equals null` holds when the lead
    has no pending plan, and `trace.tool_calls.select_customer_plan.arguments.plan_id` is absent when the tool never ran.
The engine is deterministic and has no I/O. The only heuristic is `refuses` (see REFUSAL_MARKERS); a result says which.
Meaning of the less obvious types:
  equals / not_equals  deep equality; numbers compare by value, True is not 1, strings are case-sensitive, lists keep their order
  contains             text: case-insensitive substring. List: an element equal to the value, or (for text lists other than
                       tool names) an element that contains it. Dict: the text is a key, or appears in a value, at any depth
  numeric_close        |actual - expected| <= tolerance, an ABSOLUTE amount (0 when not given)
  tool_called          the tool is in the executed tools of the whole conversation
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


# ── The target grammar ─────────────────────────────────────────────────────────────────────────────────────────────────
# One definition, used by the engine below and by the dataset verifier (evals/tools/verify_dataset.py), so a case cannot be
# written against a convention the engine does not follow (turns numbered from 1, which side of the run a root belongs to).
TOOL_TYPES = ("tool_called", "tool_not_called")
ROOTS = ("response", "result", "trace", "state", "routing")
CHAT_ROOTS = ("response", "trace", "state", "routing")   # what a conversation produces
CALL_ROOTS = ("result", "state")                         # what an API, rules or OCR call produces (plus trace.llm_calls)
CALL_TRACE = ("trace.llm_calls",)
TURN_BASE = 1
_TURN_RE = re.compile(r"(?:^|\.)turn\.([^.]*)(?:\.|$)")


def target_problems(assertion: Dict[str, Any], *, interface: str, user_turns: int) -> List[str]:
    """Why an assertion's target cannot be satisfied by a run of this kind of case (an empty list when it can)."""
    kind, target, aid = assertion["type"], assertion.get("target") or "", assertion.get("id", "?")
    chat = interface == "chat"
    if kind in TOOL_TYPES:
        problems = [] if chat else [f"{aid}: {kind} needs a chat case; only a conversation uses tools"]
        if not target or "." in target:
            problems.append(f"{aid}: {kind} target must be a tool name, got {target!r}")
        return problems
    root = target.split(".")[0]
    if root not in ROOTS:
        return [f"{aid}: target {target!r} must start with one of {', '.join(ROOTS)}"]
    if chat and root not in CHAT_ROOTS:
        return [f"{aid}: a chat case has no {root}.* (use {', '.join(CHAT_ROOTS)}): {target!r}"]
    if not chat and root not in CALL_ROOTS and target not in CALL_TRACE:
        return [f"{aid}: a {interface} case produces {', '.join(CALL_ROOTS)} (and trace.llm_calls), not {target!r}"]
    problems = []
    for match in _TURN_RE.finditer(target):
        n = match.group(1)
        if not chat or root not in ("trace", "state"):
            problems.append(f"{aid}: turn targets belong to trace.turn.N.* and state.turn.N.* of a chat case: {target!r}")
        elif not n.isdigit() or not TURN_BASE <= int(n) < TURN_BASE + user_turns:
            problems.append(f"{aid}: turn {n!r} is outside {TURN_BASE}..{TURN_BASE + user_turns - 1} "
                            f"(turns are numbered from {TURN_BASE}, and this case has {user_turns}): {target!r}")
    return problems


FOUND, ABSENT, UNOBSERVED = "found", "absent", "unobserved"


def lookup(observation: Any, path: str) -> Tuple[str, Any]:
    """Follow a dotted path. Returns (FOUND, value), (ABSENT, None) or (UNOBSERVED, None).

    A list item is picked by number, from 1 under `turn` (the dataset's numbering) and from 0 anywhere else.
    ABSENT: the last key is missing from an object that was written, or a tool is missing under `trace.tool_calls` (it never ran).
    Anything else that cannot be followed is UNOBSERVED: the runner did not write it."""
    node, parts = observation, path.split(".")
    for i, part in enumerate(parts):
        last = i == len(parts) - 1
        if isinstance(node, dict):
            if part in node:
                node = node[part]
                continue
            return (ABSENT, None) if last or parts[:i] == ["trace", "tool_calls"] else (UNOBSERVED, None)
        if isinstance(node, list) and part.isdigit():
            index = int(part) - TURN_BASE if parts[i - 1] == "turn" else int(part)
            if 0 <= index < len(node):
                node = node[index]
                continue
        return UNOBSERVED, None
    return FOUND, node


def resolve(observation: Any, path: str) -> Tuple[bool, Any]:
    """(found, value) for a path; an absent or unobserved path is (False, None)."""
    status, value = lookup(observation, path)
    return status == FOUND, value


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


def _nested_has(node: Any, text: str) -> bool:
    """`text` is a key, or appears in a text value, anywhere inside a JSON structure (case-insensitive)."""
    needle = text.lower()
    if isinstance(node, dict):
        return any(needle in str(k).lower() or _nested_has(v, text) for k, v in node.items())
    if isinstance(node, (list, tuple)):
        return any(_nested_has(item, text) for item in node)
    return isinstance(node, str) and needle in node.lower()


def _contains(actual: Any, expected: Any, target: str) -> bool:
    if isinstance(actual, str):
        return _text(expected).lower() in actual.lower()
    if isinstance(actual, dict):
        # A key, or text anywhere inside: "the answer holds no payee_name" must also see one nested in a list of items.
        return _nested_has(actual, expected) if isinstance(expected, str) else False
    if isinstance(actual, (list, tuple)):
        if any(_eq(item, expected) for item in actual):
            return True
        if isinstance(expected, str) and not target.endswith(_EXACT_LIST_SUFFIXES):
            # Text items by substring; object items (a validation error's {"loc", "msg"}) by the text anywhere inside them.
            return any(expected.lower() in item.lower() if isinstance(item, str) else _nested_has(item, expected) for item in actual)
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
        status, actual = lookup(observation, path)
        if status == UNOBSERVED:
            return result("error", f"{path} was not observed in this run.")
        if status == ABSENT:
            if kind in ("equals", "state_is"):
                return verdict(expected is None, f"{path} is absent, which equals null.", f"{path} is absent; the case expects a value.")
            if kind == "not_equals":
                return verdict(expected is not None, f"{path} is absent, so it differs from {expected!r}.", f"{path} is absent, which equals null.")
            if kind in ("not_contains", "no_leak"):
                return result("passed", f"{path} is absent, so it holds nothing forbidden.")
            return result("failed", f"{path} is absent from what the run produced.")

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
