"""Quality and runtime summaries with explicit abstentions and zero denominators."""

from performance import percentile


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def summarize(results, elapsed):
    resolved = [r for r in results if r.get("complete") and r.get("verdict") in ("no_evidence", "review", "high_risk")]
    tp = sum(r["label"] == "forged" and r["verdict"] != "no_evidence" for r in resolved)
    tn = sum(r["label"] == "genuine" and r["verdict"] == "no_evidence" for r in resolved)
    fp = sum(r["label"] == "genuine" and r["verdict"] != "no_evidence" for r in resolved)
    fn = sum(r["label"] == "forged" and r["verdict"] == "no_evidence" for r in resolved)
    latencies = [r["client_seconds"] for r in results]
    return {
        "requests": len(results), "resolved": len(resolved), "abstentions": len(results) - len(resolved),
        "http_failures": sum(r.get("http_status") != 200 for r in results),
        "coverage": ratio(len(resolved), len(results)),
        "quality": {
            "definition": "Verdict-level metrics on complete analyses only; inconclusive, incomplete and failed requests abstain.",
            "true_positive": tp, "true_negative": tn, "false_positive": fp, "false_negative": fn,
            "precision": ratio(tp, tp + fp), "recall": ratio(tp, tp + fn),
            "specificity": ratio(tn, tn + fp), "false_positive_rate": ratio(fp, fp + tn),
            "f1": ratio(2 * tp, 2 * tp + fp + fn), "resolved_accuracy": ratio(tp + tn, len(resolved)),
            "end_to_end_forged_detection_rate": ratio(tp, sum(r["label"] == "forged" for r in results)),
        },
        "runtime": {
            "wall_seconds": elapsed, "requests_per_second": ratio(len(results), elapsed),
            "mean_seconds": ratio(sum(latencies), len(latencies)),
            "p50_seconds": percentile(latencies, .5), "p95_seconds": percentile(latencies, .95),
            "min_seconds": min(latencies) if latencies else None, "max_seconds": max(latencies) if latencies else None,
        },
    }
