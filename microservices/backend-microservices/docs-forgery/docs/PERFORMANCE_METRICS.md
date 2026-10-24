The dashboard requires SuperAdmin sign-in. Engine `/performance` and `/metrics` endpoints require `X-Internal-Secret`. The former public port 3012 analysis and metrics proxies are closed.

# Performance metrics

The [performance dashboard](http://localhost:3000/super-admin/document-forgery/performance) displays measured runtime and
completion statistics. Each analysis also includes a `performance` object, rendered in its
report and included in JSON downloads. Use **Load benchmark JSON** in the Detection quality section to display a generated benchmark
report, its confusion matrix, coverage and quality metrics. The JSON is parsed locally in the
browser (20 MiB limit), not uploaded. The viewer validates sample counts and metric ranges.
Synthetic reports retain their explicit smoke-test qualification. Detection accuracy is evaluated separately against
known labels; a model score is never converted into an accuracy estimate.

## Runtime measurements

| Metric | Definition |
|---|---|
| `total_seconds` | Engine wall time, including all requested layers. Excludes upload/download, API provider-client construction, and browser rendering. |
| `layer_seconds` | Actual wall time spent in each requested layer, including failed attempts. Absent layers were not requested. |
| `model_calls` | Layer 2 transport attempts, including logged retries/failures. |
| `model_input_tokens`, `model_output_tokens` | Sum of available provider-reported token counts. `null` means unavailable, not zero. |
| `pixel_pages_scored` | Pages that returned a pixel result. |
| `pixel_inference_seconds` | Sum of worker-reported per-page inference time. Layer 3 wall time also includes queueing, rendering and model loading. |
| `complete` | File parsed, no requested layer unavailable/failed, and no partial Layer 2/3 result. This does not mean genuine or correct. |

`GET /performance` returns aggregate JSON. `GET /metrics` exposes Prometheus-compatible
histograms/counters. These endpoints contain no filenames or document content. The public
frontend proxies the JSON via `GET /api/performance`.

```sh
curl http://localhost:8032/performance
curl http://localhost:8032/metrics
```

Aggregates are **per API process** and reset on restart/reload. Modes are separate:
`file_only`, `content`, `pixel`, `content_pixel`. Means and counters cover the process lifetime;
P50/P95 use the latest 256 durations per mode with linear interpolation. Histograms use fixed
cumulative buckets in seconds, from 0.1 through 600 plus infinity. P50/P95 are descriptive for
small samples, not a service-level guarantee. HTTP status counts include invalid requests;
analysis counts include only generated reports. HTTP 200 can still mean incomplete/inconclusive.

The observed analysis rate divides generated reports by time since process start, including
idle time. It is not maximum service throughput. API and finished-worker peak RSS values are
process-lifetime high-water marks (MiB in the UI), not memory attributable to a particular
request or the total simultaneous memory footprint. Unsupported platforms report memory as
unavailable. Multiple API workers/replicas require an external scraper to aggregate them.

## Repeatable HTTP benchmark

From the repository root, run a synthetic functional check inside the service container:

```sh
docker compose exec docs-forgery python scripts/benchmark.py \
  --synthetic --url http://127.0.0.1:8022 --repeat 5 \
  --out data/benchmarks/synthetic-file.json
```

Include the local pixel model:

```sh
docker compose exec docs-forgery python scripts/benchmark.py \
  --synthetic --url http://127.0.0.1:8022 --layer3 --max-pages 1 \
  --out data/benchmarks/synthetic-pixel.json
```

The two synthetic invoices exercise clean parsing and an opaque-box/retyped-value edit.
**Their classification results are a functional smoke test, not a real-world accuracy estimate.**
Outputs are written under the service's bind-mounted `data/benchmarks` directory (git-ignored).
No warmup is discarded: first-use model loading is included. The worker reloads the model on
each analysis. Benchmarks record options, repetition and concurrency, UTC creation time,
per-case timing, completion, outcomes and overall/group summaries.

For a meaningful quality evaluation, prepare a held-out labelled CSV in the service directory:

```csv
path,label,group
samples/original-invoice.pdf,genuine,invoices
samples/edited-invoice.pdf,forged,invoices
samples/original-statement.pdf,genuine,statements
samples/edited-statement.pdf,forged,statements
```

Paths are relative to the CSV directory unless absolute. Then run:

```sh
docker compose exec docs-forgery python scripts/benchmark.py \
  --labels data/labels.csv --url http://127.0.0.1:8022 \
  --repeat 1 --concurrency 1 --out data/benchmarks/held-out.json
```

Layer 2 is opt-in (`--layer2 --provider gemini` or `groq`); it sends labelled document pages to
the configured external provider. A frontend benchmark can use `--url http://forgery-detection-app:3012
--frontend`. Concurrency defaults to 1 and can be set from 1 to 32. Pixel inference is serialized
within an API process to bound memory, so concurrent pixel requests include queueing latency.
A higher concurrency setting is not a claim that this mode can infer in parallel.

## Detection-quality definitions

Positive means a `review` or `high_risk` verdict; negative means `no_evidence`.
Inconclusive, incomplete and failed requests **abstain**. They do not become true negatives.

- Precision = TP / (TP + FP).
- Recall = TP / (TP + FN), among resolved cases.
- Specificity = TN / (TN + FP).
- False-positive rate = FP / (FP + TN).
- F1 = 2 TP / (2 TP + FP + FN).
- Resolved accuracy = (TP + TN) / resolved cases.
- Coverage = resolved cases / all attempts.
- End-to-end forged detection rate = TP / all forged attempts, including abstentions.

Undefined denominators return `null`, not zero or 100%. Report coverage alongside conditional
quality values: a detector that refuses difficult cases must not appear more accurate without
that qualification. Runtime percentiles use client-observed durations including HTTP transport
and failures; requests/second uses total benchmark wall time, including the configured concurrency.
Read errors and transport failures remain in the report.

The benchmark assesses **the complete verdict pipeline**, not pixel localization quality.
Uncalibrated pixel scores do not affect verdicts. Pixel-mask IoU/AUC and calibrated score quality
need a separate ground-truth mask/score dataset. Do not tune thresholds on the held-out evaluation
set or present synthetic or previously tuned development results as insurance-submission accuracy.

## Authenticated benchmarks

For a private engine benchmark, set `INTERNAL_API_SECRET` in the process environment. For tenant Admin analysis (which persists results), use `--admin --url http://localhost:8010` and set `DOCUMENT_INTELLIGENCE_TOKEN` to an existing tenant Admin JWT. The script reads credentials from environment variables rather than command-line arguments. `--frontend` is retired. Benchmark inputs may be sent to a model provider when `--layer2` is enabled; use non-sensitive evaluation data. Persisted benchmark runs remain in that tenant's history.
