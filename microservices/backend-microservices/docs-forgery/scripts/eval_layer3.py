"""Measure how well a scorer separates forged from genuine documents (Layer 3 evaluation harness).

    python scripts/eval_layer3.py --genuine data/pdf_genuine --forged data/pdf_forged/manifest.json --scorer layer1
    python scripts/eval_layer3.py ... --scorer trufor-image --scorer trufor-p99 --out results.json

A scorer maps a document to one number, higher meaning more suspicious. Anything that produces such a number can be
measured the same way: the existing layers, TruFor's image score or map statistics, a future model, a new check.

Two operating points are reported per scorer:

- in-sample: the threshold allowing at most 5% false alarms is chosen on all genuine documents, then applied to the
  same documents. Descriptive only, because the false-alarm rate is fitted to the data it is measured on.
- out-of-sample (leave-one-source-out): each source document and its forgeries are judged by a threshold chosen
  without them. This is the number to hold against a gate.

Intervals are 95%. Detection-rate and AUC intervals come from a bootstrap that resamples whole source documents (a
genuine file and the forgeries made from it stay together); false-alarm intervals are exact (Clopper-Pearson).
A document a scorer could not score is excluded and counted, never treated as clean, and the detection rate is also
reported with such forgeries counted as misses.

``forged`` is the manifest written by scripts/forge_pdfs.py. Genuine documents are every PDF under ``--genuine``.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ALPHA = 0.05
CHUNK = 12  # pages per pixel-model worker call; each call has its own timeout, so one slow call loses few pages
CHUNK_TIMEOUT_S = 600.0


@dataclass
class Case:
    path: Path
    label: str  # "genuine" | "forged"
    source: str  # shared by a genuine file and every forgery made from it (the bootstrap cluster)
    technique: str = ""
    truth: dict = field(default_factory=dict)  # page and rect of the edit, when known


class ScorerUnavailable(RuntimeError):
    """The scorer cannot run in this environment (for example no PyTorch). Reported, never scored as clean."""


class DataError(ValueError):
    """The evaluation set is inconsistent. Raised before anything is scored."""


def source_key(path: str | Path) -> str:
    p = Path(path)
    return f"{p.parent.name}_{p.stem}"  # the same naming forge_pdfs.py uses for its outputs


def _resolve(path: str, base: Path) -> Path:
    p = Path(path)
    if p.is_absolute():
        return p
    return base / p if (base / p).exists() else p  # manifests list paths relative to their own folder


def load_cases(genuine_dir: Path, manifest: Path) -> tuple[list[Case], dict]:
    genuine = sorted(genuine_dir.rglob("*.pdf"))
    keys = Counter(source_key(p) for p in genuine)
    shared = sorted(k for k, n in keys.items() if n > 1)
    if shared:
        raise DataError(f"{len(shared)} source keys are shared by several genuine files, e.g. {shared[0]}")
    cases = [Case(p, "genuine", source_key(p)) for p in genuine]
    forged, missing = [], []
    for entry in json.loads(manifest.read_text(encoding="utf-8")):
        path = _resolve(entry["path"], manifest.parent)
        if not path.exists():
            missing.append(entry["path"])
        forged.append(Case(path, "forged", source_key(entry["source"]), entry["technique"],
                           {k: entry[k] for k in ("page", "rect", "page_size", "old", "new") if k in entry}))
    if missing:
        raise DataError(f"{len(missing)} forged files in the manifest do not exist, e.g. {missing[0]}")
    forged_sources = {c.source for c in forged}
    coverage = {"genuine_without_forgery": sum(1 for k in keys if k not in forged_sources),
                "forgeries_without_genuine": sum(1 for c in forged if c.source not in keys)}
    return cases + forged, coverage


# --- metrics -----------------------------------------------------------------------------------------------------

def auc(neg: np.ndarray, pos: np.ndarray) -> float:
    """Probability a forged score exceeds a genuine one; ties count half."""
    diff = pos[:, None] - neg[None, :]
    return float(((diff > 0).sum() + 0.5 * (diff == 0).sum()) / diff.size)


def threshold_at_fpr(neg: np.ndarray, alpha: float = ALPHA) -> float:
    """Lowest threshold t with mean(neg > t) <= alpha. A document is flagged when its score is strictly above t.

    Ties can keep the realised false-alarm rate below alpha: then alpha itself is not reachable."""
    allowed = math.floor(alpha * len(neg) + 1e-9)
    if allowed >= len(neg):
        return -math.inf
    return float(np.sort(neg)[::-1][allowed])


def tpr_at_fpr(neg: np.ndarray, pos: np.ndarray, alpha: float = ALPHA) -> float:
    return float((pos > threshold_at_fpr(neg, alpha)).mean())


def _binom_cdf(k: int, n: int, p: float) -> float:
    return sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k + 1))


def _root(f) -> float:
    lo, hi = 0.0, 1.0  # f increasing on [0, 1]
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if f(mid) < 0 else (lo, mid)
    return (lo + hi) / 2


def clopper_pearson(k: int, n: int, level: float = 0.95) -> list[float]:
    """Exact binomial interval for k events in n trials."""
    a = (1 - level) / 2
    lo = 0.0 if k == 0 else _root(lambda p: (1 - _binom_cdf(k - 1, n, p)) - a)
    hi = 1.0 if k == n else _root(lambda p: a - _binom_cdf(k, n, p))
    return [lo, hi]


@dataclass
class Cluster:
    """One source document: its genuine scores and its forgeries' scores."""
    neg: list[float] = field(default_factory=list)
    pos: list[float] = field(default_factory=list)
    techniques: list[str] = field(default_factory=list)


def clusters_of(cases: list[Case], scores: list[float | None]) -> list[Cluster]:
    by_source: dict[str, Cluster] = defaultdict(Cluster)
    for case, score in zip(cases, scores):
        if score is None:
            continue
        cluster = by_source[case.source]
        if case.label == "genuine":
            cluster.neg.append(score)
        else:
            cluster.pos.append(score)
            cluster.techniques.append(case.technique)
    return [by_source[k] for k in sorted(by_source)]


def measure(clusters: list[Cluster], picked: np.ndarray) -> dict | None:
    """Both operating points on the clusters at the given indices (repeats allowed). None if not measurable."""
    neg = np.array([s for i in picked for s in clusters[i].neg])
    neg_origin = np.array([i for i in picked for _ in clusters[i].neg])
    pos = np.array([s for i in picked for s in clusters[i].pos])
    pos_origin = np.array([i for i in picked for _ in clusters[i].pos])
    techniques = np.array([t for i in picked for t in clusters[i].techniques])
    if not len(neg) or not len(pos) or len(np.unique(neg_origin)) < 2:
        return None
    t = threshold_at_fpr(neg)
    flagged = np.zeros(len(pos), dtype=bool)
    false_alarms = 0
    for origin in np.unique(np.concatenate([neg_origin, pos_origin])):
        held_out = threshold_at_fpr(neg[neg_origin != origin])  # every copy of this source is left out
        false_alarms += int((neg[neg_origin == origin] > held_out).sum())
        mine = pos_origin == origin
        flagged[mine] = pos[mine] > held_out
    return {"auc": auc(neg, pos), "threshold": t, "false_alarms": int((neg > t).sum()), "tpr": float((pos > t).mean()),
            "oos_false_alarms": false_alarms, "oos_tpr": float(flagged.mean()), "n_neg": len(neg), "n_pos": len(pos),
            "oos_by_technique": {str(k): (int(flagged[techniques == k].sum()), int((techniques == k).sum()))
                                 for k in np.unique(techniques)}}


def bootstrap(cases: list[Case], scores: list[float | None], rounds: int = 1000, seed: int = 0) -> dict:
    """Point estimates and 95% intervals. The bootstrap resamples source documents with replacement."""
    clusters = clusters_of(cases, scores)
    n_neg = sum(len(c.neg) for c in clusters)
    n_pos = sum(len(c.pos) for c in clusters)
    point = measure(clusters, np.arange(len(clusters)))
    if point is None:
        return {"n_genuine": n_neg, "n_forged": n_pos, "tpr": None}
    rng = np.random.default_rng(seed)
    samples: dict[str, list[float]] = defaultdict(list)
    skipped = 0
    for _ in range(rounds):
        m = measure(clusters, rng.integers(0, len(clusters), len(clusters)))
        if m is None:
            skipped += 1
            continue
        for key in ("auc", "tpr", "oos_tpr"):
            samples[key].append(m[key])
        for technique, (hits, n) in m["oos_by_technique"].items():
            samples["technique:" + technique].append(hits / n)
    interval = lambda xs: [float(np.percentile(xs, 2.5)), float(np.percentile(xs, 97.5))] if xs else None  # noqa: E731
    return {
        "n_genuine": n_neg, "n_forged": n_pos, "bootstrap_rounds": rounds, "bootstrap_skipped": skipped,
        "auc": point["auc"], "auc_ci": interval(samples["auc"]),
        "in_sample": {"threshold": point["threshold"], "fpr": point["false_alarms"] / n_neg,
                      "tpr": point["tpr"], "tpr_ci": interval(samples["tpr"])},
        "out_of_sample": {"fpr": point["oos_false_alarms"] / n_neg,
                          "fpr_ci": clopper_pearson(point["oos_false_alarms"], n_neg),
                          "tpr": point["oos_tpr"], "tpr_ci": interval(samples["oos_tpr"]),
                          "detected": round(point["oos_tpr"] * n_pos)},
        "per_technique": {k: {"n": n, "tpr": hits / n, "tpr_ci": interval(samples["technique:" + k])}
                          for k, (hits, n) in point["oos_by_technique"].items()},
    }


# --- scorers -----------------------------------------------------------------------------------------------------

class Scorer:
    name = ""

    def score_all(self, cases: list[Case]) -> list[float | None]:
        raise NotImplementedError


class Layer1(Scorer):
    """The file and metadata layer.

    By default each finding adds 2**severity (INFO and positive evidence add nothing), so weak LOW findings count.
    With ``by_verdict`` the score is the verdict itself (0 no evidence, 1 review, 2 high risk), which is what the
    service reports and what docs/EVALUATION.md counts as flagged. Inconclusive is unscored, never 0.
    """

    def __init__(self, by_verdict: bool = False, name: str = "layer1"):
        self.by_verdict, self.name = by_verdict, name

    def score_all(self, cases):
        from docforensics import Category, Severity, Verdict, analyze

        verdict_scores = {Verdict.NO_EVIDENCE: 0.0, Verdict.REVIEW: 1.0, Verdict.HIGH_RISK: 2.0}
        out = []
        for case in cases:
            report = analyze(case.path)
            if not report.parsed:
                out.append(None)
            elif self.by_verdict:
                out.append(verdict_scores.get(report.verdict))
            else:
                out.append(float(sum(2 ** f.severity for f in report.findings
                                     if f.severity > Severity.INFO and f.category is not Category.AUTHENTICITY)))
        return out


class TruFor(Scorer):
    """First page of each PDF through the pixel model, read as one field of its output.

    Pages go to the worker in chunks, each with its own timeout. A chunk that fails, or returns a different number of
    results than pages, leaves its documents unscored. Worker output is cached per file, so scoring several fields
    runs the model once.
    """

    _cache: dict[Path, dict] = {}

    def __init__(self, field_name: str, name: str, runner=None):
        self.field, self.name, self.runner = field_name, name, runner

    def _run(self, cases):
        from docforensics import layer3 as l3

        if self.runner is None:
            ok, why = l3.availability()
            if not ok:
                raise ScorerUnavailable(why)
        runner = self.runner or l3._subprocess_runner
        options = l3.Layer3Options(max_pages=1, timeout_s=CHUNK_TIMEOUT_S)
        todo = []
        for case in cases:
            if case.path in self._cache:
                continue
            try:
                todo.append((case.path, l3.render_pngs(case.path.read_bytes(), "pdf", 1)[0]))
            except Exception as exc:  # noqa: BLE001 - an unrenderable file is reported, not scored
                print(f"  {self.name}: cannot render {case.path.name}: {type(exc).__name__}", file=sys.stderr)
        for start in range(0, len(todo), CHUNK):
            chunk = todo[start:start + CHUNK]
            try:
                scored = runner([png for _, png in chunk], options)
            except Exception as exc:  # noqa: BLE001 - a failed chunk leaves its documents unscored, not clean
                print(f"  {self.name}: pages {start + 1}-{start + len(chunk)} failed: {type(exc).__name__}: {exc}",
                      file=sys.stderr)
                continue
            if len(scored) != len(chunk):
                print(f"  {self.name}: worker returned {len(scored)} results for {len(chunk)} pages; chunk unscored",
                      file=sys.stderr)
                continue
            for (path, _), page in zip(chunk, scored):
                self._cache[path] = page
            print(f"  {self.name}: {min(start + CHUNK, len(todo))}/{len(todo)} pages", file=sys.stderr)

    def score_all(self, cases):
        self._run(cases)
        return [self._cache.get(c.path, {}).get(self.field) for c in cases]


SCORERS = {
    "layer1": lambda: Layer1(),
    "layer1-verdict": lambda: Layer1(by_verdict=True, name="layer1-verdict"),
    "trufor-image": lambda: TruFor("score", "trufor-image"),
    "trufor-p99": lambda: TruFor("map_p99", "trufor-p99"),
    "trufor-p99conf": lambda: TruFor("map_p99_conf", "trufor-p99conf"),
}


# --- report ------------------------------------------------------------------------------------------------------

def _finite(score) -> float | None:
    if score is None:
        return None
    score = float(score)
    return score if math.isfinite(score) else None  # NaN would otherwise compare as "not flagged", i.e. clean


def evaluate(cases: list[Case], scorer: Scorer, rounds: int = 1000) -> dict:
    scores = [_finite(s) for s in scorer.score_all(cases)]
    result = bootstrap(cases, scores, rounds)
    result["scorer"] = scorer.name
    result["unscored"] = {label: sum(1 for c, s in zip(cases, scores) if c.label == label and s is None)
                          for label in ("genuine", "forged")}
    if "out_of_sample" in result:
        oos = result["out_of_sample"]
        oos["tpr_unscored_as_missed"] = oos["detected"] / (result["n_forged"] + result["unscored"]["forged"])
    result["scores"] = [{"path": str(c.path), "label": c.label, "technique": c.technique, "score": s}
                        for c, s in zip(cases, scores)]
    return result


def _pct(ci) -> str:
    return f"{ci[0]:.1%} to {ci[1]:.1%}" if ci else "n/a"


def show(result: dict) -> None:
    print(f"\n{result['scorer']}: {result['n_genuine']} genuine, {result['n_forged']} forged scored"
          f"  (unscored: {result['unscored']['genuine']} genuine, {result['unscored']['forged']} forged)")
    if "out_of_sample" not in result:
        print("  not enough scored documents to measure")
        return
    oos, ins = result["out_of_sample"], result["in_sample"]
    print(f"  out-of-sample (leave one source out), the number for a gate:")
    print(f"    detection {oos['tpr']:.1%} (95% CI {_pct(oos['tpr_ci'])}); with unscored forgeries as misses "
          f"{oos['tpr_unscored_as_missed']:.1%}")
    print(f"    false alarms {oos['fpr']:.1%} (exact 95% CI {_pct(oos['fpr_ci'])})")
    print(f"  in-sample (threshold fitted on these genuine files, descriptive): detection {ins['tpr']:.1%} "
          f"(95% CI {_pct(ins['tpr_ci'])}) at {ins['fpr']:.1%} false alarms, threshold score > {ins['threshold']:.4g}")
    if ins["fpr"] < ALPHA:
        print(f"    note: ties keep false alarms below the {ALPHA:.0%} target; that operating point is not reachable")
    print(f"  AUC {result['auc']:.3f} (95% CI {_pct(result['auc_ci'])})")
    print("  out-of-sample detection by technique:")
    for technique, stats in result["per_technique"].items():
        print(f"    {technique:<22} {stats['tpr']:.1%} of {stats['n']} (95% CI {_pct(stats['tpr_ci'])})")
    if result["bootstrap_skipped"]:
        print(f"  bootstrap: {result['bootstrap_skipped']} of {result['bootstrap_rounds']} rounds had nothing to measure")
    if result["n_genuine"] < 20:
        print("  warning: fewer than 20 genuine documents; the false-alarm threshold is unreliable")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--genuine", required=True, help="folder of genuine PDFs")
    parser.add_argument("--forged", required=True, help="manifest.json written by scripts/forge_pdfs.py")
    parser.add_argument("--scorer", action="append", choices=sorted(SCORERS), help="repeatable; default layer1")
    parser.add_argument("--rounds", type=int, default=1000, help="bootstrap rounds")
    parser.add_argument("--out", help="write full results, including every score, to this JSON file")
    args = parser.parse_args()

    try:
        cases, coverage = load_cases(Path(args.genuine), Path(args.forged))
    except DataError as exc:
        print(f"evaluation set rejected: {exc}", file=sys.stderr)
        return 2
    print(f"{sum(c.label == 'genuine' for c in cases)} genuine, {sum(c.label == 'forged' for c in cases)} forged; "
          f"{coverage['genuine_without_forgery']} genuine files have no forgery, "
          f"{coverage['forgeries_without_genuine']} forgeries have no genuine source")
    results = []
    for name in args.scorer or ["layer1"]:
        try:
            result = evaluate(cases, SCORERS[name](), args.rounds)
        except ScorerUnavailable as exc:
            print(f"\n{name}: unavailable: {exc}", file=sys.stderr)
            continue
        result["coverage"] = coverage
        show(result)
        results.append(result)
        if args.out:  # written after every scorer, so a later failure cannot lose earlier results
            Path(args.out).write_text(json.dumps(results, indent=1), encoding="utf-8")
    return 0 if results else 1


if __name__ == "__main__":
    sys.exit(main())
