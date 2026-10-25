"""Run-to-run comparison on constructed runs: every figure is worked out by hand here.

    docker run --rm -i --network none -v "$PWD":/work:ro -w /work -e PYTHONPATH=/work -e DISABLE_PGVECTOR=true insurance-ai-eval-backend python -B evals/tools/test_run_compare.py
"""
import unittest

from shared.evaluation.run_compare import case_outcomes, compare_runs


def row(case, status, rep=1, lat=100.0, cost=0.01, known=True):
    return {"case": case, "repetition": rep, "status": status, "latency_ms": lat, "cost_usd": cost if known else None, "cost_known": known}


A = [row("C1", "passed"), row("C2", "passed"), row("C3", "failed"), row("C4", "passed"), row("C5", "blocked", cost=0.0), row("C6", "passed")]
B = [row("C1", "passed"), row("C2", "failed"), row("C3", "passed"), row("C4", "blocked", cost=0.0), row("C5", "passed"), row("C7", "passed")]


class Outcomes(unittest.TestCase):
    def test_a_case_passes_only_when_every_verdict_passed(self):
        o = case_outcomes([row("X", "passed", 1), row("X", "passed", 2), row("Y", "passed", 1), row("Y", "failed", 2), row("Z", "skipped"), row("W", "passed", 1), row("W", "blocked", 2)])
        self.assertEqual(o["X"]["outcome"], "passed")
        self.assertEqual((o["Y"]["outcome"], o["Y"]["pass_fraction"]), ("failed", 0.5))
        self.assertEqual((o["Z"]["outcome"], o["Z"]["pass_fraction"]), ("no_verdict", None))
        self.assertEqual((o["W"]["outcome"], o["W"]["ran"], o["W"]["executions"]), ("passed", 1, 2))          # a blocked repetition is not a verdict


class Compare(unittest.TestCase):
    def setUp(self):
        self.c = compare_runs(A, B, meta_a={"dataset": "d", "version": "1.0.0", "model": "m"}, meta_b={"dataset": "d", "version": "1.0.0", "model": "m"})

    def test_newly_failing_newly_passing_and_other_changes(self):
        self.assertEqual([x["case"] for x in self.c["newly_failing"]], ["C2"])
        self.assertEqual([x["case"] for x in self.c["newly_passing"]], ["C3"])
        self.assertEqual(sorted(x["case"] for x in self.c["changed"]), ["C4", "C5"])               # passed to blocked, blocked to passed
        self.assertEqual(self.c["unchanged"], 1)                                                    # C1
        self.assertEqual(self.c["cases_compared"], 5)

    def test_cases_in_only_one_run_are_listed_not_compared(self):
        self.assertEqual((self.c["only_in_a"], self.c["only_in_b"]), (["C6"], ["C7"]))
        self.assertTrue(any("only in" in n for n in self.c["notes"]))

    def test_totals_by_hand(self):
        # A: C1 C2 C3 C4 C6 produced a verdict (C5 was blocked): 4 passed, 1 failed. B: C1 C2 C3 C5 C7 produced one (C4 blocked): 4 passed (C1 C3 C5 C7), 1 failed (C2).
        self.assertEqual((self.c["a"]["executions"], self.c["a"]["ran"], self.c["a"]["passed"], self.c["a"]["failed"]), (6, 5, 4, 1))
        self.assertEqual((self.c["b"]["executions"], self.c["b"]["ran"], self.c["b"]["passed"], self.c["b"]["failed"]), (6, 5, 4, 1))

    def test_pass_rates_by_hand(self):
        self.assertAlmostEqual(self.c["a"]["pass_rate"], 4 / 5)
        self.assertAlmostEqual(self.c["b"]["pass_rate"], 4 / 5)
        self.assertAlmostEqual(self.c["delta"]["pass_rate"], 0.0)

    def test_cost_and_latency_differences(self):
        self.assertAlmostEqual(self.c["a"]["cost_usd"], 0.05)                                        # five rows at 0.01 and the blocked one at 0
        self.assertAlmostEqual(self.c["b"]["cost_usd"], 0.05)
        self.assertAlmostEqual(self.c["delta"]["cost_usd"], 0.0)
        self.assertEqual(self.c["delta"]["latency_p50_ms"], 0.0)

    def test_a_difference_in_model_or_version_is_said_not_hidden(self):
        c = compare_runs(A, B, meta_a={"model": "m1", "version": "1.0.0"}, meta_b={"model": "m2", "version": "1.0.1"})
        self.assertEqual(sum("not like for like" in n for n in c["notes"]), 2)

    def test_an_unknown_cost_means_no_cost_difference(self):
        b = B + [row("C8", "passed", known=False)]
        c = compare_runs(A, b)
        self.assertIsNone(c["delta"]["cost_usd"])
        self.assertEqual(c["b"]["unknown_cost_executions"], 1)
        self.assertTrue(any("unknown cost" in n for n in c["notes"]))

    def test_a_better_run_shows_the_gain_and_the_extra_cost(self):
        better = [row(r["case"], "passed", lat=r["latency_ms"] + 50, cost=0.02) for r in A if r["status"] in ("passed", "failed")]
        c = compare_runs(A, better)
        self.assertEqual(len(c["newly_passing"]), 1)
        self.assertAlmostEqual(c["delta"]["pass_rate"], 1.0 - 4 / 5)
        self.assertAlmostEqual(c["delta"]["latency_p50_ms"], 50.0)
        self.assertGreater(c["delta"]["cost_usd"], 0)

    def test_empty_runs_do_not_divide_by_zero(self):
        c = compare_runs([], [])
        self.assertIsNone(c["a"]["pass_rate"])
        self.assertIsNone(c["delta"]["pass_rate"])
        self.assertEqual(c["cases_compared"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=1)
