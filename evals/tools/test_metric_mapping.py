"""Every metric name a dataset case asks the judge for is one the judge knows, and the judge service maps each to a DeepEval metric.

    docker run --rm -i --network none -v "$PWD":/work:ro -w /work -e PYTHONPATH=/work -e DISABLE_PGVECTOR=true insurance-ai-eval-backend python -B evals/tools/test_metric_mapping.py

A name in a case that the judge does not know would be silently unscored, so this is checked against the cases in the repository (every dataset file) and against the judge service's own source.
"""
import ast
import glob
import json
import re
import sys
import unittest
from pathlib import Path

from shared.evaluation import benchmark, judge

ROOT = Path("/work")
EXPECTED_DEEPEVAL = {"relevance": "AnswerRelevancyMetric", "faithfulness": "FaithfulnessMetric", "hallucination": "HallucinationMetric"}
GEVAL = {"correctness", "task_completion", "safety", "custom"}


def metrics_in_datasets():
    used = {}
    for f in sorted(glob.glob(str(ROOT / "evals/datasets/**/*.jsonl"), recursive=True)):
        for n, line in enumerate(Path(f).read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                case = json.loads(line)
            except ValueError:
                continue
            for crit in case.get("semantic_criteria") or []:
                used.setdefault(crit.get("metric", "correctness"), []).append(f"{Path(f).name}:{n}")
    return used


class Mapping(unittest.TestCase):
    def test_the_datasets_ask_for_something(self):
        self.assertGreaterEqual(sum(len(v) for v in metrics_in_datasets().values()), 10)

    def test_every_metric_a_case_uses_is_known_to_the_judge(self):
        unknown = {m: where[:3] for m, where in metrics_in_datasets().items() if m not in judge.METRICS}
        self.assertEqual(unknown, {}, "a case asks for a metric the judge does not know, so it would never be scored")

    def test_the_two_lists_of_metric_names_agree(self):
        self.assertEqual(set(judge.METRICS), set(benchmark.QUALITY_METRICS))          # the order differs (one is the judge's, one the report's); the names must not

    def test_the_judge_service_maps_every_metric_to_a_deepeval_metric(self):
        src = (ROOT / "evals/environment/judge/server.py").read_text(encoding="utf-8")
        tree = ast.parse(src)
        fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "build_metric")
        body = ast.get_source_segment(src, fn)
        explicit = {m: cls for m in EXPECTED_DEEPEVAL for cls in [EXPECTED_DEEPEVAL[m]] if re.search(rf'req\.metric == "{m}"[\s\S]{{0,120}}{cls}', body)}
        self.assertEqual(explicit, EXPECTED_DEEPEVAL, "relevance, faithfulness and hallucination each have their own DeepEval metric")
        self.assertIn("GEval(", body)
        self.assertEqual(set(judge.METRICS) - set(EXPECTED_DEEPEVAL), GEVAL, "everything else is judged by GEval with the criterion text")

    def test_a_metric_the_judge_does_not_know_is_left_unscored_and_never_sent_to_it(self):
        import asyncio

        class Client:
            posts = 0

            async def post(self, *a, **k):
                Client.posts += 1
                raise AssertionError("an unknown metric must not reach the judge service")
        case = {"semantic_criteria": [{"id": "C1", "metric": "faithfullness", "criterion": "x"}, {"id": "C2", "metric": "nonsense", "criterion": "y"}], "input": {"messages": [{"role": "user", "content": "hi"}]}}
        out = asyncio.run(judge.score_case(Client(), url="http://judge", judge_model="mock/mock-judge", case=case, observation={}))
        self.assertEqual(Client.posts, 0)
        self.assertEqual([m["status"] for m in out["metrics"]], ["judge_error", "judge_error"])
        self.assertTrue(all(m["score"] is None and m["passed"] is None for m in out["metrics"]), "unscored, never passed")
        self.assertIn("faithfullness", out["metrics"][0]["reason"])
        self.assertEqual((out["scored"], out["unscored"]), (0, 2))


if __name__ == "__main__":
    unittest.main(verbosity=1)
