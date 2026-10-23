# Providers and rate limits

Layer 2 uses one provider at a time through the same client (`make_client`), so everything above the transport is
identical. Results from different models are **not interchangeable**: always report them per model.

```python
from docforensics.gemini_client import make_client
client = make_client("groq", min_interval_s=6)      # or "gemini"; default from LLM_PROVIDER, else gemini
```

## Settings

Environment variables (or `.env`; copy `.env.example`):

| Variable | Gemini default | Groq default | Meaning |
|---|---|---|---|
| `LLM_PROVIDER` | `gemini` | | Which provider `make_client()` uses |
| `*_API_KEY` | `GEMINI_API_KEY` | `GROQ_API_KEY` | Never logged: the client scrubs any `*_API_KEY` value from errors |
| `*_MODEL` | `gemini-2.5-flash` | `qwen/qwen3.8-27b` | The model |
| `*_MIN_INTERVAL_S` | 13 | 4 | Minimum seconds between request starts |
| `*_MAX_RETRIES` | 3 | 4 | Retries for per-minute limits, timeouts, 5xx |
| `*_BACKOFF_BASE_S`, `*_BACKOFF_CAP_S` | 10 / 120 | 6 / 90 | Retry delay when the server gives none |
| `*_TIMEOUT_S` | 90 | 60 | Per-request timeout |
| `*_MAX_OUTPUT_TOKENS` | 16384 | 4096 | Output cap |
| `GEMINI_THINKING_BUDGET` | unset | | `0` turns thinking off on 2.5 Flash |
| `GEMINI_CALL_LOG` / `GROQ_CALL_LOG` | unset | unset | JSONL of every attempt |

## Retry and quota behaviour

- **Per-minute limits** (HTTP 429): wait for the server's `retry-after`/`retryDelay`, then retry (up to the maximum).
- **Daily limits**: not retried. They end the call as `quota_exhausted`; the test runner stops at once.
- **A server-suggested wait over 5 minutes** is treated as a daily limit.
- Every attempt is recorded: purpose, status, seconds, time waited, tokens in/out, model.

## Observed limits (free tiers, October 2026)

These were measured on the keys used during development and **change**: check your provider's console.

**Google Gemini `gemini-2.5-flash`, free tier**

- 20 requests per day (the quota error said so). A document costs 1–3 calls, so about 7–20 documents a day.
- Reads up to 4 pages per document.

**Groq `qwen/qwen3.8-27b`** (the only vision-capable model on the key tested; Llama 4 was no longer listed)

| Limit | Value seen | Consequence |
|---|---|---|
| Requests per day | 1,000 | Not the constraint |
| Input tokens per minute | 7,000 | Waits between calls |
| **Output tokens per minute** | **1,000** | Output caps: read 4096, re-read 600, visual 700; a request whose expected output exceeds the limit is refused |
| **Tokens per day** | **200,000** | About 20 documents a day. Refills continuously at roughly 140 tokens a minute, so a spent allowance takes hours |
| Images per request | 5 (about 1,000 tokens each) | Reads at most 2 pages per document |

The Groq transport reads the `x-ratelimit-*` headers and waits for the per-minute window to refill instead of colliding with
it.

## Recommended settings

| Use | Provider | Cooldown | Notes |
|---|---|---|---|
| Free-tier testing | Groq | 6 s + 3 s per document | About 20 documents a day. Use `--no-visual` to roughly halve token use |
| Free-tier testing | Gemini | 15 s | Budget 18 calls a day: the runner stops before the quota does |
| Production | A paid tier of either | Per your quota | The free tiers are for development only |

## Privacy

The rendered pages are sent to the provider. Before real customer documents go through layer 2, agree a data-processing
and residency position (a paid tier or a cloud-hosted offering with a DPA). Free-tier terms differ and may allow the
provider to use inputs to improve its products. Layer 1 never sends anything anywhere.

## Re-scoring without spending quota

Every live run of `scripts/run_layer2_test.py` saves the model's raw replies. `scripts/replay_layer2.py` pushes them back
through the current checks and shows which verdicts changed, using no API calls. It can test changes to checks, thresholds
and severities; a change to a **prompt** can only be tested by a new run.
