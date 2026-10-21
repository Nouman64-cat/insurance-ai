"""The Golden case document (schema version 1.0) and its validation.

A case says what is sent to the system under test (`input`), what must happen (`expected`, `assertions`) and how the
answer is judged when it is free text (`semantic_criteria`). It records where its expectation comes from (`source`) and
how far that expectation has been verified, so a business rule nobody has signed off is never passed off as ground truth.

Message text, payloads and expected values are stored exactly as written: adversarial and malformed inputs are the point
of many cases, so nothing in `input` is trimmed, normalised or "fixed".
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from shared.evaluation.canonical import content_hash
from shared.evaluation.workflows import get_workflow

SCHEMA_VERSION = "1.0"

TurnMode = Literal["single_turn", "multi_turn"]
Difficulty = Literal["easy", "medium", "hard", "adversarial"]
Severity = Literal["critical", "high", "medium", "low"]
ScenarioType = Literal["positive", "negative", "boundary", "edge", "adversarial", "missing_information",
                       "conflicting_data", "complex_workflow"]
Verification = Literal["code_verified", "independently_verified", "business_approved", "pending_domain_approval"]
LayerName = Literal["L1", "L2", "L3", "L4", "L5", "L6"]
AssertionType = Literal["equals", "not_equals", "contains", "not_contains", "matches_regex", "in_range", "numeric_close",
                        "one_of", "is_true", "is_false", "tool_called", "tool_not_called", "state_is", "refuses", "no_leak"]

_ID = r"^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$"
CASE_ID_RE = re.compile(_ID)
_SHORT_ID = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$"
_FIXTURE_KEY = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$"
_TAG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
MAX_CASE_BYTES = 256 * 1024


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Actor(_Model):
    """Who is acting. `tenant_ref` and `user_ref` name synthetic fixtures, never production records."""
    role: str = Field(min_length=1, max_length=60)
    tenant_ref: Optional[str] = Field(default=None, max_length=120)
    user_ref: Optional[str] = Field(default=None, max_length=120)


class Message(_Model):
    role: Literal["user", "assistant", "system", "tool"]
    content: str
    name: Optional[str] = Field(default=None, max_length=120)

    @field_validator("content")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("message content must not be blank")
        return v


class CaseInput(_Model):
    messages: List[Message] = Field(default_factory=list)
    payload: Dict[str, Any] = Field(default_factory=dict)
    fixture_refs: List[str] = Field(default_factory=list)
    actor: Optional[Actor] = None

    @field_validator("fixture_refs")
    @classmethod
    def _fixture_refs(cls, refs: List[str]) -> List[str]:
        for ref in refs:
            if not re.match(_FIXTURE_KEY, ref):
                raise ValueError(f"fixture reference {ref!r} is not a valid fixture key")
        if len(set(refs)) != len(refs):
            raise ValueError("fixture_refs lists the same fixture twice")
        return refs


class ToolCallExpectation(_Model):
    tool: str = Field(min_length=1, max_length=120)
    arguments: Dict[str, Any] = Field(default_factory=dict)
    match: Literal["exact", "subset", "any"] = "subset"      # how the actual arguments are compared
    required: bool = True
    order: Optional[int] = Field(default=None, ge=1)


class StateTransition(_Model):
    entity: str = Field(min_length=1, max_length=80)
    from_state: Optional[str] = Field(default=None, max_length=80)
    to_state: str = Field(min_length=1, max_length=80)


class Routing(_Model):
    """Which agent, subagent and skills are expected to handle the request."""
    agent: Optional[str] = Field(default=None, max_length=120)
    subagent: Optional[str] = Field(default=None, max_length=120)
    skills: List[str] = Field(default_factory=list)


class ExpectedOutcome(_Model):
    summary: str = Field(min_length=1, max_length=2000)
    outcome: Optional[str] = Field(default=None, max_length=120)       # e.g. approved, rejected, refused, escalated
    permitted_actions: List[str] = Field(default_factory=list)
    forbidden_actions: List[str] = Field(default_factory=list)
    tool_calls: List[ToolCallExpectation] = Field(default_factory=list)
    state_transitions: List[StateTransition] = Field(default_factory=list)
    routing: Optional[Routing] = None


class ReferenceContext(_Model):
    source: str = Field(min_length=1, max_length=500)
    text: str = Field(min_length=1)
    kind: Literal["code", "business_rule", "policy_document", "regulation", "fixture", "other"] = "other"


class Assertion(_Model):
    id: str = Field(pattern=_SHORT_ID)
    type: AssertionType
    target: Optional[str] = Field(default=None, max_length=300)      # what is inspected, e.g. response.text, state.policy.status
    expected: Any = None
    tolerance: Optional[float] = Field(default=None, ge=0)
    severity: Literal["critical", "major", "minor"] = "major"
    description: Optional[str] = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def _shape(self) -> "Assertion":
        given = "expected" in self.model_fields_set
        if self.type in ("equals", "not_equals", "contains", "not_contains", "state_is") and not given:
            raise ValueError(f"assertion {self.id!r} ({self.type}) needs an 'expected' value")
        if self.type == "matches_regex":
            if not isinstance(self.expected, str) or not self.expected:
                raise ValueError(f"assertion {self.id!r} (matches_regex) needs a pattern string")
            try:
                re.compile(self.expected)
            except re.error as exc:
                raise ValueError(f"assertion {self.id!r} has an invalid regular expression: {exc}") from exc
        if self.type == "in_range":
            e = self.expected
            if not (isinstance(e, list) and len(e) == 2 and all(_is_number(x) for x in e) and e[0] <= e[1]):
                raise ValueError(f"assertion {self.id!r} (in_range) needs expected = [min, max]")
        if self.type == "numeric_close" and not _is_number(self.expected):
            raise ValueError(f"assertion {self.id!r} (numeric_close) needs a numeric 'expected'")
        if self.type == "one_of" and not (isinstance(self.expected, list) and self.expected):
            raise ValueError(f"assertion {self.id!r} (one_of) needs a non-empty list")
        if self.type in ("tool_called", "tool_not_called") and not self.target:
            raise ValueError(f"assertion {self.id!r} ({self.type}) needs the tool name as 'target'")
        return self


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


class SemanticCriterion(_Model):
    id: str = Field(pattern=_SHORT_ID)
    criterion: str = Field(min_length=1, max_length=2000)
    metric: Literal["correctness", "faithfulness", "relevance", "hallucination", "task_completion", "safety", "custom"] = "correctness"
    threshold: float = Field(default=0.7, ge=0, le=1)
    weight: float = Field(default=1.0, gt=0)


class LayerConfig(_Model):
    layer: LayerName
    enabled: bool = True
    threshold: Optional[float] = Field(default=None, ge=0, le=1)


def _all_layers() -> List[LayerConfig]:
    return [LayerConfig(layer=name) for name in ("L1", "L2", "L3", "L4", "L5", "L6")]


class EvaluationSpec(_Model):
    layers: List[LayerConfig] = Field(default_factory=_all_layers)
    pass_threshold: float = Field(default=0.7, ge=0, le=1)
    # A failed critical assertion fails the case whatever the other scores say.
    critical_overrides_score: bool = True
    repetitions_hint: Optional[int] = Field(default=None, ge=1, le=100)

    @field_validator("layers")
    @classmethod
    def _unique_layers(cls, layers: List[LayerConfig]) -> List[LayerConfig]:
        names = [l.layer for l in layers]
        if len(set(names)) != len(names):
            raise ValueError("evaluation.layers lists a layer twice")
        return layers


class Source(_Model):
    """Where the expectation comes from and how far it has been checked."""
    kind: Literal["code", "business_rule", "regulation", "synthetic", "trace", "manual", "other"]
    reference: str = Field(min_length=1, max_length=500)
    verification: Verification
    code_refs: List[str] = Field(default_factory=list)
    notes: Optional[str] = Field(default=None, max_length=2000)


class Approval(_Model):
    """Stamped from the review record when a version is published; whatever an imported file says here is ignored."""
    status: Literal["draft", "in_review", "approved", "rejected"] = "draft"
    approved_by: Optional[str] = Field(default=None, max_length=255)
    approved_at: Optional[str] = None
    notes: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("approved_at")
    @classmethod
    def _iso(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            try:
                datetime.fromisoformat(v.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValueError("approved_at must be an ISO 8601 timestamp") from exc
        return v


class GoldenCase(_Model):
    schema_version: Literal["1.0"] = "1.0"
    case_id: str = Field(pattern=_ID)
    title: str = Field(min_length=3, max_length=300)
    workflow: str
    turn_mode: TurnMode
    stage: str
    category: str
    scenario_type: ScenarioType
    difficulty: Difficulty
    severity: Severity
    tags: List[str] = Field(default_factory=list)
    input: CaseInput
    expected: ExpectedOutcome
    reference_context: List[ReferenceContext] = Field(default_factory=list)
    assertions: List[Assertion] = Field(default_factory=list)
    semantic_criteria: List[SemanticCriterion] = Field(default_factory=list)
    evaluation: EvaluationSpec = Field(default_factory=EvaluationSpec)
    source: Source
    approval: Approval = Field(default_factory=Approval)
    metadata: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("tags")
    @classmethod
    def _tags(cls, tags: List[str]) -> List[str]:
        for t in tags:
            if not _TAG.match(t):
                raise ValueError(f"tag {t!r} must be lower-case letters, digits, underscore or hyphen (max 40)")
        if len(set(tags)) != len(tags):
            raise ValueError("tags lists the same tag twice")
        return tags

    @model_validator(mode="after")
    def _consistency(self) -> "GoldenCase":
        profile = get_workflow(self.workflow)
        if self.category not in profile.categories:
            raise ValueError(f"category {self.category!r} is not a {profile.name} category ({', '.join(sorted(profile.categories))})")
        if self.stage not in profile.stages:
            raise ValueError(f"stage {self.stage!r} is not a {profile.name} stage ({', '.join(profile.stages)})")
        users = [m for m in self.input.messages if m.role == "user"]
        if self.turn_mode == "single_turn" and len(users) > 1:
            raise ValueError("a single_turn case carries at most one user message")
        if self.turn_mode == "multi_turn" and len(users) < 2:
            raise ValueError("a multi_turn case needs at least two user messages")
        if not self.input.messages and not self.input.payload:
            raise ValueError("input needs messages or a payload")
        if not (self.assertions or self.semantic_criteria or self.expected.tool_calls or self.expected.state_transitions):
            raise ValueError("nothing to evaluate: add an assertion, a semantic criterion, a tool call or a state transition")
        for label, items in (("assertions", self.assertions), ("semantic_criteria", self.semantic_criteria)):
            ids = [i.id for i in items]
            if len(set(ids)) != len(ids):
                raise ValueError(f"{label} reuses an id")
        if self.severity == "critical" and not self.assertions:
            raise ValueError("a critical case needs at least one deterministic assertion")
        return self


# One entry per schema version, so older snapshots stay readable when 1.1 exists.
SCHEMAS: Dict[str, type] = {SCHEMA_VERSION: GoldenCase}


def json_schema() -> dict:
    return GoldenCase.model_json_schema()


def _error_list(exc: ValidationError) -> List[dict]:
    return [{"loc": ".".join(str(p) for p in e["loc"]) or "(case)", "msg": e["msg"], "type": e["type"]} for e in exc.errors()]


def _non_finite_path(value: Any, path: str = "") -> Optional[str]:
    """Where a NaN or Infinity sits in a JSON-like value, or None."""
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        return path or "(case)"
    if isinstance(value, dict):
        for k, v in value.items():
            found = _non_finite_path(v, f"{path}.{k}" if path else str(k))
            if found:
                return found
    elif isinstance(value, list):
        for i, v in enumerate(value):
            found = _non_finite_path(v, f"{path}.{i}" if path else str(i))
            if found:
                return found
    return None


def validate_case(raw: Any) -> Tuple[Optional[dict], List[dict]]:
    """(normalised case document, []) when valid, else (None, [{loc, msg, type}, ...]).

    The normalised document has every default filled in, so it is complete and its hash does not depend on what the
    author left out."""
    if not isinstance(raw, dict):
        return None, [{"loc": "(case)", "msg": "a case must be a JSON object", "type": "type_error"}]
    bad = _non_finite_path(raw)
    if bad is not None:      # pydantic would quietly turn these into null, changing the value under test
        return None, [{"loc": bad, "msg": "NaN and Infinity are not valid JSON values", "type": "value_error"}]
    version = raw.get("schema_version", SCHEMA_VERSION)
    model = SCHEMAS.get(version) if isinstance(version, str) else None
    if model is None:
        return None, [{"loc": "schema_version", "msg": f"unsupported schema version {version!r}; supported: {', '.join(SCHEMAS)}", "type": "value_error"}]
    try:
        case = model.model_validate(raw)
    except ValidationError as exc:
        return None, _error_list(exc)
    return case.model_dump(mode="json"), []


def clean_case(raw: Any) -> Any:
    """Tidy the identifying fields of a raw record before validation; never touches `input`, `expected` or any value
    under test. Tags are lower-cased, de-duplicated and sorted, identifiers are trimmed, a missing schema_version means
    the current one, and the approval block is reset (approval is decided by the review record, not by the file)."""
    if not isinstance(raw, dict):
        return raw
    out = dict(raw)
    for field in ("case_id", "title", "workflow", "turn_mode", "stage", "category", "scenario_type", "difficulty", "severity"):
        if isinstance(out.get(field), str):
            out[field] = out[field].strip()
    if isinstance(out.get("tags"), list) and all(isinstance(t, str) for t in out["tags"]):
        out["tags"] = sorted({t.strip().lower() for t in out["tags"] if t.strip()})
    out.setdefault("schema_version", SCHEMA_VERSION)
    out["approval"] = Approval().model_dump(mode="json")
    return out


def _normal_text(text: str) -> str:
    return " ".join(text.lower().split())


def dedupe_key(case: dict) -> str:
    """Fingerprint of what a case sends, ignoring case, spacing and everything it expects. Two cases with the same
    fingerprint test the same input twice."""
    inp = case.get("input") or {}
    signature = {
        "workflow": case.get("workflow"),
        "turn_mode": case.get("turn_mode"),
        "messages": [[m.get("role"), _normal_text(m.get("content", ""))] for m in inp.get("messages", [])],
        "payload": inp.get("payload", {}),
        "fixtures": sorted(inp.get("fixture_refs", [])),
        "actor": inp.get("actor"),
    }
    return content_hash(signature)


def summary_fields(case: dict) -> dict:
    """The few fields kept beside the document for filtering."""
    return {
        "category": case.get("category"),
        "scenario_type": case.get("scenario_type"),
        "difficulty": case.get("difficulty"),
        "severity": case.get("severity"),
        "schema_version": case.get("schema_version"),
    }
