"""The judge's structured-output request, per provider. Pure test (no network): the Anthropic request must carry a strict, closed schema (its endpoint refuses anything else, which blocked every judged check with a 400), and every other provider's request must stay exactly as it was.

    docker run --rm -i --network none -v "$PWD":/work:ro -w /work -e PYTHONPATH=/work insurance-ai-eval-backend python -B evals/tools/test_judge_schema.py"""
import re
import sys
from typing import Any, List, Optional

from pydantic import BaseModel

src = open("evals/environment/judge/server.py", encoding="utf-8").read()
ns: dict = {"Any": Any}
exec(re.search(r"def strict_schema.*?\n\n\n", src, re.S).group(0), ns)       # the function itself, without importing the web app and its heavy dependencies
strict_schema = ns["strict_schema"]
FAILS = 0


def check(name, ok, detail=""):
    global FAILS
    FAILS += 0 if ok else 1
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f"\n       {detail}" if detail and not ok else ""))


class Item(BaseModel):
    verdict: str
    reason: Optional[str] = None


class Verdicts(BaseModel):
    verdicts: List[Item]
    score: float


raw = Verdicts.model_json_schema()
s = strict_schema(raw)


def objects(n):
    if isinstance(n, dict):
        if n.get("type") == "object" or "properties" in n:
            yield n
        for v in n.values():
            yield from objects(v)
    elif isinstance(n, list):
        for v in n:
            yield from objects(v)


check("every object in the schema, including nested models, is closed (additionalProperties false)", all(o.get("additionalProperties") is False for o in objects(s)) and len(list(objects(s))) >= 2, s)
check("every property is required, so an optional field is still asked for (a strict endpoint needs it)", all(set(o["required"]) == set(o.get("properties", {})) for o in objects(s)))
check("the original schema is not changed (the OpenAI request still uses it as it was)", "additionalProperties" not in raw and raw["required"] == ["verdicts", "score"], raw)
check("the request code adds strict only for Anthropic, and leaves the other providers' request as it was", 'if "api.anthropic.com" in self.cfg["base_url"]' in src and '"strict": True' in src
      and 'spec: Dict[str, Any] = {"name": schema.__name__, "schema": schema.model_json_schema()}' in src)
print("PASS: all judge schema tests, 0 failed" if not FAILS else f"FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
