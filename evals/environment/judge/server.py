"""The judge service of the evaluation stack: scores one semantic criterion of one answer with a DeepEval metric.

    POST /score   {criterion_id, metric, criterion, threshold, input, actual_output, expected_output, context, tools_called, judge_model}
               -> {status, score (0..1, higher is better), reason, input_tokens, output_tokens, judge_model, metric_class}
    GET  /health

Metrics (the case's `semantic_criteria[].metric`):
  correctness, task_completion, safety, custom  ->  DeepEval GEval, with the criterion text as its criteria
  relevance                                      ->  AnswerRelevancyMetric
  faithfulness                                   ->  FaithfulnessMetric, against the case's reference context
  hallucination                                  ->  HallucinationMetric, against the case's reference context; reported as 1 - the
                                                    hallucination rate so that for every metric a higher score is better

The judge model is `provider/model`. `mock/...` is the scripted stand-in (SYNTHETIC: it proves the pipeline works and says nothing about
answer quality). A real provider is used only if it is in EVAL_ALLOWED_PROVIDERS and its key is present in this container's environment;
otherwise the answer is `blocked_missing_credentials`, never a made-up score. Every model call is counted, so the cost can be priced.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")

app = FastAPI(title="Evaluation judge (DeepEval)")
MOCK_URL = os.environ.get("EVAL_MOCK_LLM_URL", "")
ALLOWED = {p.strip().lower() for p in os.environ.get("EVAL_ALLOWED_PROVIDERS", "").split(",") if p.strip()}
ENDPOINTS = {"openai": ("https://api.openai.com/v1", "OPENAI_API_KEY"),
             "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY"),
             "anthropic": ("https://api.anthropic.com/v1", "ANTHROPIC_API_KEY")}


class ScoreRequest(BaseModel):
    criterion_id: str
    metric: str = "correctness"
    criterion: str
    threshold: float = 0.7
    input: str = ""
    actual_output: str = ""
    expected_output: Optional[str] = None
    context: List[str] = Field(default_factory=list)
    tools_called: List[str] = Field(default_factory=list)
    judge_model: str


class GenerateRequest(BaseModel):
    model: str                                    # provider/model
    messages: List[Dict[str, str]]
    settings: Dict[str, Any] = Field(default_factory=dict)      # temperature, top_p, max_tokens, seed
    timeout_s: float = Field(default=120.0, gt=0, le=900)
    mock_hint: Optional[Dict[str, Any]] = None


class NoCredentials(Exception):
    pass


def strict_schema(node: Any) -> Any:
    """A JSON schema with every object closed (additionalProperties false) and every property required, which is what a strict structured-output endpoint accepts. Works through nested models ($defs, items, anyOf)."""
    if isinstance(node, list):
        return [strict_schema(x) for x in node]
    if not isinstance(node, dict):
        return node
    out = {k: strict_schema(v) for k, v in node.items()}
    if out.get("type") == "object" or "properties" in out:
        out["additionalProperties"] = False
        out["required"] = list((out.get("properties") or {}).keys())
    return out


def endpoint_for(judge_model: str) -> Dict[str, str]:
    provider, _, model = judge_model.partition("/")
    provider = provider.lower()
    if provider == "mock":
        if not MOCK_URL:
            raise NoCredentials("the scripted judge is not available: EVAL_MOCK_LLM_URL is not set in this stack")
        return {"base_url": MOCK_URL, "api_key": "mock-key", "model": model}
    if provider not in ENDPOINTS:
        raise NoCredentials(f"unknown judge provider {provider!r}")
    if provider not in ALLOWED:
        raise NoCredentials(f"{provider} is not in EVAL_ALLOWED_PROVIDERS: this evaluation may not call it")
    url, key_name = ENDPOINTS[provider]
    key = (os.environ.get(key_name) or "").strip()
    if not key:
        raise NoCredentials(f"no {provider} key in this evaluation stack ({key_name} is empty)")
    return {"base_url": url, "api_key": key, "model": model}


def _json_from(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.S)
        if not match:
            raise
        return json.loads(match.group(0))


def make_judge(cfg: Dict[str, str]):
    """A DeepEval model that speaks the OpenAI chat API (OpenAI, Gemini and Anthropic all offer one), and counts what it uses."""
    from deepeval.models import DeepEvalBaseLLM

    class CompatJudge(DeepEvalBaseLLM):
        def __init__(self) -> None:
            self.cfg = cfg
            self.input_tokens = self.output_tokens = self.calls = 0
            super().__init__(cfg["model"])

        def load_model(self):
            return self

        def get_model_name(self) -> str:
            return self.cfg["model"]

        def _request(self, prompt: str, schema: Any) -> Dict[str, Any]:
            body: Dict[str, Any] = {"model": self.cfg["model"], "messages": [{"role": "user", "content": prompt}], "temperature": 0}
            if schema is not None:
                spec: Dict[str, Any] = {"name": schema.__name__, "schema": schema.model_json_schema()}
                if "api.anthropic.com" in self.cfg["base_url"]:
                    # Anthropic's OpenAI-compatible endpoint accepts only a strict schema: `strict` must be true and every object must say additionalProperties is false
                    # (OpenAI takes the schema as it is, so the other providers are left alone).
                    spec = {"name": spec["name"], "schema": strict_schema(spec["schema"]), "strict": True}
                body["response_format"] = {"type": "json_schema", "json_schema": spec}
            return body

        def _finish(self, data: Dict[str, Any], schema: Any):
            usage = data.get("usage") or {}
            self.calls += 1
            self.input_tokens += int(usage.get("prompt_tokens") or 0)
            self.output_tokens += int(usage.get("completion_tokens") or 0)
            text = data["choices"][0]["message"]["content"] or ""
            return schema(**_json_from(text)) if schema is not None else text

        def generate(self, prompt: str, schema: Any = None):
            r = httpx.post(f"{self.cfg['base_url']}/chat/completions", headers={"Authorization": f"Bearer {self.cfg['api_key']}"},
                           json=self._request(prompt, schema), timeout=120)
            r.raise_for_status()
            return self._finish(r.json(), schema)

        async def a_generate(self, prompt: str, schema: Any = None):
            async with httpx.AsyncClient(timeout=120) as client:
                r = await client.post(f"{self.cfg['base_url']}/chat/completions", headers={"Authorization": f"Bearer {self.cfg['api_key']}"},
                                      json=self._request(prompt, schema))
            r.raise_for_status()
            return self._finish(r.json(), schema)

    return CompatJudge()


def build_metric(req: ScoreRequest, judge):
    from deepeval.metrics import AnswerRelevancyMetric, FaithfulnessMetric, GEval, HallucinationMetric
    from deepeval.test_case import LLMTestCase
    try:
        from deepeval.test_case import SingleTurnParams as Params       # DeepEval 3.9
    except ImportError:                                                 # older releases
        from deepeval.test_case import LLMTestCaseParams as Params

    actual = req.actual_output
    if req.metric in ("task_completion", "safety") and req.tools_called:
        actual = f"{actual}\n\n[Tools the agent called: {', '.join(req.tools_called)}]"
    case = LLMTestCase(input=req.input or "(no input)", actual_output=actual or "(no reply)", expected_output=req.expected_output,
                       context=req.context or None, retrieval_context=req.context or None)
    common = dict(threshold=req.threshold, model=judge, async_mode=False)
    if req.metric == "relevance":
        return AnswerRelevancyMetric(include_reason=True, **common), case, False
    if req.metric == "faithfulness":
        return FaithfulnessMetric(include_reason=True, **common), case, False
    if req.metric == "hallucination":
        return HallucinationMetric(include_reason=True, **common), case, True      # lower is better: the caller inverts it
    params = [Params.INPUT, Params.ACTUAL_OUTPUT] + ([Params.EXPECTED_OUTPUT] if req.expected_output else [])
    return GEval(name=f"{req.metric}-{req.criterion_id}", criteria=req.criterion, evaluation_params=params, **common), case, False


def score_sync(req: ScoreRequest) -> Dict[str, Any]:
    try:
        cfg = endpoint_for(req.judge_model)
    except NoCredentials as exc:
        return {"status": "blocked_missing_credentials", "reason": str(exc), "judge_model": req.judge_model}
    judge = make_judge(cfg)
    try:
        metric, case, invert = build_metric(req, judge)
        metric.measure(case)
        score = float(metric.score)
        if invert:
            score = 1.0 - score
        return {"status": "scored", "score": round(max(0.0, min(1.0, score)), 4), "reason": getattr(metric, "reason", None), "judge_model": req.judge_model,
                "metric_class": type(metric).__name__, "input_tokens": judge.input_tokens, "output_tokens": judge.output_tokens, "calls": judge.calls}
    except Exception as exc:                                         # noqa: BLE001 — a judge failure is a result the runner records, not a crash
        return {"status": "judge_error", "reason": f"{type(exc).__name__}: {str(exc)[:300]}", "judge_model": req.judge_model,
                "input_tokens": judge.input_tokens, "output_tokens": judge.output_tokens}


@app.post("/score")
async def score(req: ScoreRequest):
    return await run_in_threadpool(score_sync, req)


@app.post("/generate")
async def generate_endpoint(req: GenerateRequest):
    """One candidate answer for a direct benchmark. Same provider rules as scoring."""
    import generate as gen
    try:
        cfg = endpoint_for(req.model)
    except NoCredentials as exc:
        return {"status": "blocked_missing_credentials", "error": str(exc)}
    return await gen.generate(cfg, req.messages, req.settings, timeout_s=req.timeout_s, mock=req.model.lower().startswith("mock/"), mock_hint=req.mock_hint)


@app.get("/health")
async def health():
    import deepeval
    return {"status": "ok", "deepeval": getattr(deepeval, "__version__", "installed"), "allowed_providers": sorted(ALLOWED)}
