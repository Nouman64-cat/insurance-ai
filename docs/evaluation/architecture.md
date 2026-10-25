# AI Evaluation Platform: architecture

The platform evaluates the agents of the Individual Insurance workflow against versioned Golden Datasets and compares
LLMs on the same data. It is built stage by stage; this note records what exists and how Stage 1 (the data lake) works.

## What was in the repository before Stage 1

| Area | Finding |
|---|---|
| Evaluation code | None. `evals/`, `docs/evaluation/` and `super-admin/evaluation-costs/` were empty folders left by a revert. |
| MinIO / DeepEval | Not present anywhere. Object storage was AWS S3 through boto3, with a local-disk fallback (`routers/artifacts.py`). |
| Reusable | tenant-service migrations (`migrate.py`), shared models (`shared/models`), SuperAdmin auth (`require_roles`), gateway proxies, token metering (`token_usage`, `services/usage_meter.py`), the chat agent's skills ON/OFF switch (`PlatformAgentConfig`), unittest conventions, the Super Admin sidebar. |
| Agents under test | `chat-agent` (LangGraph: coordinator, specialists, skills, tools, permission gate), `risk-engine`, `ocr-engine`, `text-summarizer`. Model choice and fallback come from the SuperAdmin LLM configuration. |

## Where each stage lives

| Stage | Lives in |
|---|---|
| 1. Data lake (this stage) | `shared/evaluation/` (library), `shared/models/evaluation.py` (tables), `tenant-service/services/eval_lake.py`, `eval_lake_cli.py`, the `minio` service |
| 2. Golden cases | Data in PostgreSQL and MinIO, created through the lake. Generation and verification utilities in Python, never the records. |
| 3. Dataset Manager | tenant-service routers under `/platform/evaluation/...` (proxied by the gateway) and Super Admin pages in `frontend` |
| 4-5. Harness and benchmarking | An evaluation runner using the lake to load a published version; DeepEval metrics; results and traces back into PostgreSQL and MinIO `artifacts/` |
| 6-8. Drift, cost, Evaluation Center | Built on the same tables and the existing token usage records |

## Stage 1: the data lake

**Layers.** Bronze is what came in, untouched. Silver is what passed validation. Gold is what was approved and published.

| Layer | PostgreSQL | MinIO |
|---|---|---|
| Bronze | `eval_ingestions`; each record is an `eval_cases` row with `tier = bronze` | `bronze/<source>/<yyyy>/<mm>/<dd>/<ingestion>/raw/<file>` and `report.json` |
| Silver | `eval_cases` rows with `tier = silver` (JSONB content, checksum, input fingerprint) | `silver/<workflow>/<dataset>/<batch>/cases.jsonl`, `rejects.json`, `report.json` |
| Gold | `eval_dataset_versions`, `eval_version_cases` (index) | `gold/<workflow>/<dataset>/<version>/cases.jsonl` and `manifest.json` |
| Fixtures | `eval_fixtures` | `fixtures/<sha256[:2]>/<sha256>/<file>`, addressed by content |
| Artifacts | later stages | `artifacts/<run>/<name>` |

`eval_storage_objects` registers every object with the checksum it must keep. Single-turn and multi-turn cases are
separate datasets (`eval_datasets.turn_mode`). Workflows and their categories are listed in `workflows.py`.

**Formats.** JSONL is the exchange and snapshot format (one canonical case per line). JSON accepts an array or
`{"cases": [...]}`. CSV keeps identifying fields as columns and structured fields as JSON text, so it round-trips.
Draft content is JSONB. Cell values that look like spreadsheet formulas are guarded on CSV export.

**The case document** is `shared/evaluation/case_schema.py` (schema 1.0; `eval_lake_cli.py schema` prints the JSON
Schema). Message text and payloads are kept exactly as written, since adversarial input is the point of many cases. Each
case records its `source.verification`: `code_verified`, `independently_verified`, `business_approved` or
`pending_domain_approval`. Whatever a file says about approval is ignored; approval comes from the review record.

**Bronze to Silver.** Identifying fields are tidied, the document is validated against the schema, must match the
dataset's workflow and turn mode, must be filed under its own id, and must not send the same input as another case
(case and spacing ignored). Failures stay Bronze with their errors. Editing a case sends it back to Bronze and draft.

**Publishing** (`DataLake.publish`), because MinIO and PostgreSQL cannot commit together:

1. One transaction with the dataset row locked: re-check every approved case (schema, checksum, approver), check fixtures
   exist, build the snapshot and manifest in memory, and record the version as `publishing` with the checksums it must have.
2. Upload `cases.jsonl`, then `manifest.json`. Nothing is overwritten; identical existing content is adopted. Both are read
   back and compared, fixtures are checked, and every object is put under object lock.
3. One transaction: add the case index, mark the version `published`, set the dataset's latest version.

A failure before step 3 marks the version `failed` and removes what the attempt created, so the same version number can be
tried again. A crash after the objects are locked leaves it `publishing`; `reconcile()` (also run at tenant-service
start) completes it if the objects verify, or fails it and cleans up. Versions must increase (`1.0.0`, `1.1.0`...).

**Immutability, three ways.** MinIO object lock (governance mode by default) on gold objects and the fixtures they pin;
write-once puts that refuse to replace different content; and database triggers (`shared/evaluation/ddl.py`) that reject
any UPDATE or DELETE of a published version or its case index. `load_version` re-checks the manifest, snapshot and every
case against their checksums and raises if anything differs, so an evaluation never runs on altered data.

## Configuration

`.env` (see `.env.example`): `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `EVAL_LAKE_BUCKET`, `EVAL_LAKE_RETENTION_MODE`
(`GOVERNANCE`, `COMPLIANCE` or `NONE`), `EVAL_LAKE_RETENTION_DAYS`. The bucket is created with object lock and
versioning on first use. Object lock can only be enabled when a bucket is created, so choose the mode before first start.
The MinIO image tag can be overridden with `MINIO_IMAGE`.

## Commands and tests

```
docker compose up -d minio
docker compose up -d --build tenant-service
docker compose exec tenant-service python eval_lake_cli.py init
docker compose exec tenant-service python eval_lake_cli.py smoke

docker compose exec -T tenant-service python test_eval_lake_pure.py
docker compose exec -T tenant-service python test_eval_lake_publish.py
docker compose exec -T tenant-service python test_migrations.py
```

The full command list is in the header of `eval_lake_cli.py`.

## Phase 4: the evaluation harness

The harness runs a published, checksum-verified dataset version against the real Individual Insurance agents inside the isolated
stack (`evals/environment/`, compose project `insurance-ai-eval`: own Postgres, internal network only). The host-side worker is the only
bridge between the platform (jobs, MinIO, results database) and that stack.

```
platform (SuperAdmin API, MinIO, results DB)  <--worker (envctl.py worker)-->  eval-runner  -->  eval-gateway / eval-tenant-service
                                                                                         |-->  eval-chat-agent  -->  eval-mock-llm (scripted) or a real provider
                                                                                         '-->  eval-judge (DeepEval)
```

**Six layers per execution** (`shared/evaluation/layers.py`; each case's `evaluation` block says which are enabled):
L1 inputs and fixtures, L2 output quality (text checks plus judged criteria), L3 agent / skill / tool trajectory, L4 workflow and
state, L5 security, permissions, business rules and money, L6 latency, tokens and cost (fails only against limits the run set).
A failed critical assertion fails the case whatever the aggregate score. When no judge is configured L2 is `not_scored` and the
verdict says it is incomplete; it is never silently passed.

**Judge.** `eval-judge` is a separate service with DeepEval 3.9.9 (GEval for correctness, task completion, safety and custom;
AnswerRelevancy; Faithfulness; Hallucination inverted to "1 minus the rate"). The judge may not be the model under test unless forced
(`--allow-same-judge`). A real provider needs `EVAL_ALLOWED_PROVIDERS` and a key in `eval.env`, otherwise the score is
`blocked_missing_credentials`. **Calibration:** `evals/calibration/judge-calibration-v1.json` holds answers of known quality; `--calibrate`
(or `envctl.py calibrate --judge P/M`) scores them and reports agreement; below 80% the judge is `NOT TRUSTED` and the run says so.

**What a run can vary:** `--model P/M` (`mock/<name>` is a scripted stand-in), `--skills on|off`, `--prompt-version V` (files in
`evals/prompts/`, pinned by sha256), `--repeat N|auto`, `--judge`, `--max-latency-ms/--max-tokens/--max-cost-usd`, `--stop-on-critical`,
`--gate`. `envctl.py variants --vary skills=on,off|prompt=none,v1|model=a,b` runs the same cases once per value and compares them case by
case. **Everything run with a scripted model is SYNTHETIC: it proves the harness, not model quality.**

**Jobs.** `eval_jobs` / `eval_job_events` (platform DB); SuperAdmin `POST/GET /eval/jobs`, `/eval/jobs/{id}/stream` (SSE, `Last-Event-ID`),
`.../cancel`; the worker claims through `X-Internal-Secret` endpoints, sends heartbeats (a silent job is marked lost), cancels by signalling the
runner (finishes the case in flight, writes what exists).

**Chat-agent hooks** (only when `EVAL_ENVIRONMENT=1`): headers `X-Eval-Model`, `X-Eval-Skills`, `X-Eval-Prompt` and
`GET /chat/eval/trace/{thread}`. In production the trace route answers 404 (checked against `insurance-chat-agent`), and in the stack
another user's thread answers 403 (integration test).

```
python evals/environment/envctl.py run --dataset individual-insurance-single-turn --version 1.0.6 --model mock/mock-oracle --judge mock/mock-judge --repeat 3 --gate --calibrate
python evals/environment/envctl.py variants --vary skills=on,off --model mock/mock-oracle --from-source --case IND-LEAD-001
python evals/environment/envctl.py worker            # executes queued jobs
python evals/environment/envctl.py calibrate --judge mock/mock-judge
python evals/environment/envctl.py test-chat | test-runner | test-runs
docker compose exec tenant-service python eval_lake_cli.py job-submit | jobs | job-events --follow | job-cancel | run-reliability <run_id>
```

**Not built in this phase:** the runs API and Evaluation Center pages, a
dedicated real-provider key (so no real-model or real-judge result exists yet), and a budget stop in the middle of a conversation
(the budget is checked before each execution and judge call).

## Phase 5: model registry and multi-LLM benchmarking

**Model registry** (`eval_models`, `eval_model_prices`; rules in `shared/evaluation/registry.py`; API `/eval/models`, Super Admin only,
proxied by the gateway). An entry is `provider/model_id` (providers: `openai`, `gemini`, `anthropic`, `mock`) with its roles
(`candidate`, `judge`), status, capabilities, the configuration a benchmark applies (temperature, top_p, max_tokens, seed, timeout_s) and
an append-only price history: every price has an effective date and a source, and a price without a source is refused. The provider and
model id of an entry never change. `mock` models are the scripted stand-ins: synthetic by definition, price zero.
`eval_lake_cli.py models-seed` registers the models of the Token Economy page and the stand-ins; `models` lists them.

**Two benchmark modes** (`evals/tools/benchmark.py`, `envctl.py benchmark`, or a job of kind `benchmark_agent` / `benchmark_direct`):
- `agent`: the real Individual Insurance agent answers, only the model changes; also measures tool accuracy (layer L3) and workflow compliance (L4).
- `direct`: the bare model gets the same question and the same reference information through the generation service
  (`eval-judge` `POST /generate`, the only service that may reach a provider, with the same allow-list and key rules as scoring);
  no agent, no tools. Prompt `direct-v1` is identical for every model and recorded. Only chat cases with one user message and something
  judgeable from the answer take part; the rest are listed as left out, with the reason.

Each model is one ordinary run (verified dataset, sealed, stored on its own) with the same cases, repetitions, judge and limits, tied
together by one benchmark id; models run one after another so timings do not interfere. A provider without a key is reported
`blocked_missing_credentials` (not skipped, not failed). Fallback behaviour is recorded: none; a failed call is an error or timeout of the
model that was asked.

**What is measured per model:** pass rate with Wilson interval, consistency, flaky cases, critical-failure rate, judge scores per metric
(correctness, task completion, faithfulness, relevance, hallucination, safety), tool accuracy, workflow compliance, safety violations,
latency mean/p50/p95, time to first token, throughput (output tokens per second), errors and timeouts, input/output/cached tokens, candidate
cost, judge cost (a separate figure), cost per successful execution. Unreported token counts and unpriced models stay unknown.

**Superiority needs evidence** (`shared/evaluation/benchmark.py`): a model is called better than another only if at least 10 cases were
compared, each ran at least 3 repetitions, the 95% bootstrap interval of the paired pass-rate difference excludes zero, the sign test is
below 0.05 and its critical-failure rate is not worse. Otherwise the report says "insufficient evidence" or "no reliable difference", and a
benchmark names a leader only if it beats every other model. A benchmark that includes a scripted model never ranks anything.
A benchmark whose runs did not record the requested mode, kind, group or model is **invalid**: it is not stored, its runs are.

```
python evals/environment/envctl.py benchmark --mode direct --dataset individual-single-turn --version 1.0.6 \
    --models openai/gpt-4o-mini,gemini/gemini-2.5-flash,anthropic/claude-haiku-4-5 --judge openai/gpt-4o --repeat 5 --setting temperature=0 --calibrate
python evals/environment/envctl.py benchmark --mode agent --dataset ... --models a,b   # the agent with a different model
docker compose exec tenant-service python eval_lake_cli.py models-seed | models | benchmarks | benchmark-ingest <file>
python evals/environment/envctl.py test-benchmark
docker compose exec -T tenant-service python test_eval_models.py
```

**Still blocked:** a benchmark of real GPT, Gemini and Claude models needs a key for each provider in `evals/environment/eval.env` and the
provider in `EVAL_ALLOWED_PROVIDERS`. Until then every benchmark here is scripted (synthetic) and says nothing about real models.
The benchmark comparison page is Phase 8; the budget and cost forecasting for benchmarks is Phase 7.


## Phase 7: cost lines

Every dollar of a run is recorded as an append-only **cost line** (`eval_cost_lines`) that says what it paid for, how much was used, how sure we are, and where the number came from.

| component | what it is |
|---|---|
| `candidate_llm` | the model under test, asked directly (direct benchmarks) |
| `agent_llm` / `subagent_llm` | the application's chat agent / one of its specialists or helpers (the ledger names the service) |
| `judge` | the DeepEval judge scoring an answer (cost as reported by the judge service) |
| `ocr` | the OCR engine reading a document |
| `embedding` | an embedding model (the application does not meter embeddings yet, so none appear) |
| `retry` | calls made by an attempt that failed with an infrastructure error and was run again |
| `fallback` | a call answered by a model other than the one under test |
| `unattributed` | ledger rows seen during an execution that carry another thread id (a late row, a conversation title): real spend, not that reply's own calls |
| `self_hosted` | reserved for GPU/CPU seconds (`unit_kind`) of a self-hosted model |

`cost_kind` is `estimated` (token counts from the ledger x a versioned price: nothing has been invoiced), `unknown` (used but cannot be priced: the amount is NULL, never 0) or `confirmed` (reserved for amounts a provider billed; M4 reconciliation). Lines are written by `ingest_run` (`shared/evaluation/cost_lines.py`, `cost_store.py`), keyed by a hash of (run, case, repetition, component, service, model, attempt) with a unique index, so ingesting a run twice, or one that crashed half way, never counts anything twice. The run's `known_cost_usd` is the sum of its lines. Runs ingested before cost lines existed are rebuilt with `eval_lake_cli.py cost-backfill` using the run's own price version; they lack what the original run did not record (service names, failed attempts).

`eval_lake_cli.py cost-attribution` (and `shared.evaluation.cost_lines.check_run`) checks each run: lines add up to the run's cost, every token the ledger showed is in a line, every execution that used a model has a line, nothing is recorded twice, no line belongs to an execution the run does not have.

What a failed execution spent is no longer lost: when an execution fails, the runner reads the ledger rows it caused before the next execution resets them (`UsageMeter.settle_abandoned`), and the usage of attempts that were retried travels with the final result as `retry_usage`.


### Provider billing reconciliation

A Super Admin types in what a provider billed for a period (inclusive dates, UTC; optionally the token totals the provider's page shows), for the API key or project that evaluations use. The platform adds up its own cost lines for that provider and period and compares (`shared/evaluation/reconcile.py`, `services/eval_reconcile.py`, `routers/eval_costs.py`):

| status | meaning |
|---|---|
| `matched` | within the tolerance (default 5% of the bill, never less than $0.05): the recorded amounts of that period are **confirmed** |
| `under_recorded` | billed more, every line priced: usage reached the provider without being attributed to an execution (or the key has other callers) |
| `over_recorded` | recorded more than billed: prices out of date, or a discount (cached input, batch) not applied |
| `incomplete` | billed more, and some lines could not be priced: they may explain the gap |

When token totals are given they say which side is off: tokens agree while dollars differ = the prices; the provider counted more tokens than were attributed = missing attribution. Two active statements of one provider may not overlap (a bill cannot be counted twice); a correction is a new statement naming the one it replaces. Statements and reconciliations are append-only; the live comparison is recomputed from the lines every time, and a reconciliation row records who looked and what they wrote. Money in any window is then **confirmed** (inside a period whose statement matches right now), **estimated** (priced from recorded tokens and a recorded price) or **unknown** (could not be priced; in no total): `GET /eval/costs/certainty`. Lines keep `cost_kind = estimated` forever; "confirmed" is derived, never written onto a line.

API: `GET/POST /eval/costs/statements`, `GET /eval/costs/statements/{id}`, `POST /eval/costs/statements/{id}/reconcile`, `GET /eval/costs/certainty`, `GET /eval/costs/lines` (the detailed usage records), `GET /eval/costs/attribution`. CLI: `eval_lake_cli.py cost-statements | cost-statement-add | cost-reconcile`.


### Cost analytics

`GET /eval/costs/...` (SuperAdmin; logic in `shared/evaluation/cost_analytics.py`, data in `services/eval_analytics.py`). Everything is computed from recorded numbers (cost lines, run results) and says which; where evidence is thin the answer says so instead of choosing a winner.

| endpoint | what it answers |
|---|---|
| `trends?from&to&bucket=day\|week\|month&group_by=component\|provider\|model` | money over time, empty days filled, a running total, the peak; unpriced lines counted apart; scripted models left out |
| `models[?dataset&version&mode]` | per dataset version and mode: each configuration's pass rate with its 95% interval, reliability, latency p50/p95, error rate, and what a **passed** test cost all-in (model + judge + retries + fallbacks + unattributed) / tests passed; the quality/cost frontier; model advice |
| `benchmarks` | what each benchmark cost in total and per model |
| `anomalies` | unusual runs / days / executions, each with the observed value, the baseline and the evidence |
| `recommendations` | what the comparison and the spending support, with evidence, caveats and a saving where one can be worked out |

Anomaly rules (robust statistics: median and scaled median absolute deviation, judged only against EARLIER data): `run_cost` (more than 2x the median cost per execution of at least 3 earlier runs of the same model, mode, dataset and version, and $0.05 more than usual), `daily_spike` (more than 3x the median of the previous active days in the last 30, at least 4 of them, and $0.25 more; days with no evaluation do not pull the usual down to zero), `token_outlier` (more than 4x the median tokens of at least 4 earlier executions of the same case on the same model, and 20,000 more), `waste` (retries, fallbacks and unattributed calls are 10% or more of a run), `unpriced`.

Model advice only considers configurations with at least 30 executions, a known cost per passed test and a real (not scripted) model; at most one piece of advice per configuration: **dominated** (its whole interval is below another's and it costs at least as much per passed test: drop it from future benchmarks) or **cheaper equivalent** (another costs at most 70% as much per passed test, is within 10 points, its interval reaches this one's pass rate, and it had no more critical failures: the runs cannot tell them apart). A cheaper judge is never recommended without calibration. Spending advice: waste (5% or more), the judge's share (40% or more), unpriced models, and the month's pace against the monthly limit (a straight line through sporadic spending, labelled as such). Nothing here changes a model, a judge or a budget.


### The Costs & Budgets page and the benchmarking integration

`/super-admin/evaluation/costs` (a tab of the AI Evaluation Center; `components/costs/*`, data module `lib/evalCosts.ts`). Views, kept in the address (`view`, `cur`, and each view's filters): **Overview** (this month and today against the budgets, what is running with its spend so far, how sure the month's money is, the 30-day chart by component, the provider-bill, attribution, anomaly and advice cards; it refreshes every 6 seconds while a job runs), **Cost vs quality** (per dataset version and mode: pass rate with its interval, reliability, latency, the cost of a passed test, the quality/cost frontier and the advice), **Budgets** (the daily and monthly limits, how to change them with a reason, the history), **Usage records** (every cost line, filterable, CSV download, the attribution check), **Reconciliation** (enter a provider bill, reconcile, replace with a correction, the confirmed / estimated / unknown split), **Findings & advice**, **Exchange rates**. Money is shown in USD, or in a second currency from recorded rates: series totals convert each day at that day's rate (`GET /eval/costs/overview|trends?currency=`), single figures use today's rate and say so; a day with no rate stays in dollars and is reported as unconverted. Rates are recorded with a source and never edited (`GET/POST /eval/costs/rates`); a rate more than 20% away from the previous one is recorded with a warning.

Benchmarking: the setup panel asks `/eval/jobs/estimate` for the estimate AND what the run would do to the day and month limits, shows both, and does not offer Start when an enforced limit would refuse it; the results page shows what the benchmark cost all-in (model, judge, retries, unattributed), per model and per passed test, and links to the cost comparison.

## Phase 8: analytics, the lake and skills on the map, saved views

The Studio (`/super-admin/evaluation`) reads everything from the platform's own records; Phase 8 adds three things to what it already read.

**Analytics** (`GET /eval/studio/analytics`, `services/eval_studio.py::analytics`, pure maths in `shared/evaluation/analytics.py`). Parameters: `days` (1 to 730, default 90), `dataset`, `model` (`no model` selects the checks that call no model), `include_synthetic` (scripted stand-ins are left out unless asked for). It returns, each with the count it rests on:

| key | what it says |
|---|---|
| `outcomes` | executions by status, overall and per model; the pass rate counts only executions that produced a verdict (passed or failed); critical failures |
| `coverage` | per dataset, how many of the newest published version's cases ran at least once in the window |
| `layers` | per model and layer (L1 inputs, L2 output quality, L3 agent trajectory, L4 workflow and state, L5 security and business rules, L6 performance and cost): how many executions the layer applied to, passed, failed, and the mean score. A layer that did not apply to an execution is left out of that layer; L6 without a limit is a measurement, not a verdict |
| `routing` | per specialist and per tool: executions that used it, how many of those L3 judged, and how many passed |
| `latency` | per model: mean, P50, P95, max (percentiles are linear-interpolated, over executions that passed or failed and recorded a latency) |
| `reliability` | per model, over cases run more than once: share with the same verdict every time, the flaky cases, the cases wrong every time; with fewer than three repeated cases there is no consistency figure rather than a made-up one |
| `drift` | review items opened per week for 12 weeks, by kind |

`GET /eval/studio/results` takes the same window and, to open the executions behind a figure, `failed_layer` (L1 to L6), `specialist`, `tool` and `days`. The page checks that the count in the list equals the figure it was opened from.

**New nodes.** `lake` (layer 1, Golden data): counts of `eval_storage_objects` by layer and state, published versions, health `bad` when any object is corrupt or missing, a `stores` link to each dataset. `skills` (layer 3): the skills the traces record (`trace_summary.skills`), a `loads` link from the agent; like specialists and tools it exists only as far as runs observed it. There is no node for field mappings: the product has no mapping records.

**Simulate.** The form can set the agent's skills (as configured, on, off; agent mode only), per-execution limits (latency, tokens, cost) and the quality gate with its minimum pass rate. They are sent as `skills`, `max_latency_ms`, `max_tokens`, `max_cost_usd`, `gate`, `gate_min_pass_rate`; the benchmark runner forwards them to each model's run, and each run records them in its config. An execution over a limit fails layer L6; it is not stopped midway.

**Saved views** (`lib/savedViews.ts`, `components/studio/SavedViews.tsx`). A name for a studio address (mode, filters, window, open item), kept in the browser's local storage, newest first, 20 at most, a name used twice replaces the older. They are per viewer and never leave the browser; every storage access is guarded, so a private window shows none and says why a save failed. Only addresses inside the studio are accepted when saving or reading. Every filter is also in the address, so a link to the current page is a deep link.

## Comparing and checking stored runs

`shared/evaluation/run_compare.py` (pure) compares two runs by the OUTCOME of each case across its repetitions: `passed` (every execution that produced a verdict passed), `failed` (at least one failed), `no_verdict` (blocked, skipped or an infrastructure error only). A is the baseline, B the later run: `newly_failing` passed in A and fails in B, `newly_passing` the reverse, `changed` is a verdict gained or lost, cases in only one run are listed and not compared. It gives each run's totals and the differences in pass rate, cost (only when both costs are complete), P50 and P95 latency, and notes when the runs differ in dataset, version, model or judge ("not like for like").

`shared/evaluation/run_tools.py` reads the database and the lake: `compare(a, b)` for two complete runs, `verify(run)` which re-reads every object stored for the run, compares the bytes with the checksum and size recorded when it was ingested, and checks that every result row is there. Both raise `RunToolError` with an HTTP status, which the router and the CLI turn into a response and a message.

| call | what it does |
|---|---|
| `GET /eval/runs/compare?a=&b=` | the comparison (422 for the same run twice, 404 for an unknown run, 409 for a run still being ingested) |
| `GET /eval/runs/{id}/report` | the run's text report as stored |
| `GET /eval/runs/{id}/artifacts/{name}` | one stored file; refused (409) if its bytes no longer match the recorded checksum |
| `eval_lake_cli.py run-verify <id>` | the verification above; exit status 1 when anything differs |
| `eval_lake_cli.py run-compare <a> <b>` | the comparison as text |

In the Studio: Investigate > Compare runs (list of stored runs, choose A and B), and a run's executions page opens with its summary.

### A conversation and the budget

Before a case starts, the runner checks that the run's budget covers an estimate for all its turns. Between turns it asks again (`Runner._turn_guard`): money already spent, plus the estimate for the turns this conversation has had, plus the next turn. If it does not fit the conversation stops there: `blocked`, reason `budget_exceeded`, nothing judged, the finished turns' usage kept. This matters when other cases running at the same time have spent the budget in the meantime. A scripted model costs nothing and is never stopped.

### The judge and unknown metric names

A case may ask for correctness, task_completion, faithfulness, relevance, hallucination, safety or custom. A name outside that list is not sent to the judge service (which would score it as a generic criterion under the wrong name); it is recorded as unscored with the reason.
