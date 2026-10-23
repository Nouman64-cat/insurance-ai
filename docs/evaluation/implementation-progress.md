# Evaluation platform: implementation progress (Steps 6 to 9)

**Source of truth.** Percentages are computed by `python docs/evaluation/progress.py` from the checkboxes below, never estimated.
A criterion is ticked `[x]` only when it is implemented AND verified (a test or a run I can name in the Evidence column / log).
`[ ]` remaining, `[~]` in progress, `[!]` blocked (needs something outside the repo; the reason is written next to it).
Each step is 25% of the whole; inside a step every criterion weighs the same. Tags: `impl` implementation, `integ` integration with the
real stack/services, `test` automated tests, `fe` frontend (a criterion is `fe` only if it is something a user sees on a page).
Steps 1 to 5 are done (see the end of this file). **Resume rule:** after an interruption, read this file, run
`python evals/tools/selftest.py` and `git status`, confirm the last ticked task still holds, then continue at "Next".

## Step 6: Results storage and reporting

### 6.1 Data model
- [x] (impl) SQLModel tables `eval_runs`, `eval_case_results`, `eval_assertion_results` (run identity, dataset version + snapshot sha, suite, model, repetitions, budget, status; per-execution status/reason/latency/cost/usage; per-assertion outcome)
- [x] (integ) the tables exist in the platform database after tenant-service starts (migration applied, idempotent)
- [x] (impl) a finished run is immutable in the database (triggers, same pattern as published dataset versions)
- [x] (test) integration test: update and delete of a finished run's rows are refused by the database

### 6.2 Ingestion (the isolated worker never gets the platform database; the platform side ingests its run folder)
- [x] (impl) `ingest_run(folder)` validates the folder (summary, results, artifacts), uploads artifacts/report/summary to MinIO under `artifacts/<run>/`, writes the rows, verifies every checksum
- [x] (impl) idempotent: ingesting the same run twice changes nothing; a tampered folder is refused
- [x] (integ) a real run from the isolated stack is ingested into the platform database and MinIO; row counts equal the results file
- [x] (test) unit tests of folder validation and tamper detection; integration test of idempotence

### 6.3 Cost and usage records
- [x] (impl) per execution: tokens, model(s), cost, and an explicit known/unknown cost flag (never 0 for "not measured"); run totals computed from rows
- [x] (test) test that unknown cost stays unknown through ingestion and totals

### 6.4 Command line
- [~] (impl) `eval_lake_cli.py` commands: `run-ingest`, `runs`, `run <id>`, `run-verify <id>` (re-checks stored artifacts against checksums), `run-compare <a> <b>`
- [ ] (integ) the commands work against the real database and MinIO

### 6.5 API (SuperAdmin only)
- [ ] (impl) `/eval/runs` list and filters, `/eval/runs/{id}` detail, `/results`, `/artifacts/{name}`, `/report`, `/compare?a=&b=`
- [ ] (impl) gateway proxy routes for them
- [ ] (test) authorization tests: anonymous 401, non-SuperAdmin 403, SuperAdmin 200
- [ ] (integ) read paths exercised against real ingested data

### 6.6 Reports and comparison
- [ ] (impl) run report (same content as the console report) and run-to-run comparison (newly failing, newly passing, status changes, cost and latency deltas)
- [ ] (test) comparison unit tests on constructed runs

### 6.7 Wiring
- [x] (integ) `envctl.py run` ingests the finished run automatically (copy out of the isolated worker, ingest on the platform side)
- [x] (integ) a run survives a database reset of the evaluation environment and is still readable from the platform

### 6.8 Frontend
- [ ] (fe) "Evaluation Runs" page: run list, run detail (counts, failures, blocked, cost, per-case table), compare two runs
- [ ] (fe) sidebar entry and translations
- [ ] (test) the page type-checks and builds (or, if the toolchain cannot run here, is verified another way that is named in the log)

## Step 7: Chat runner and agent evaluation

### 7.1 Isolated chat stack
- [ ] (impl) chat-agent runs in the isolated evaluation stack: own database, internal network only, no production credentials
- [ ] (integ) it is healthy, answers `/health`, creates its checkpoint tables in the evaluation database, and the baseline snapshot is retaken
- [ ] (test) integration test: from the chat-agent container production and the internet are unreachable (except the provider destination)

### 7.2 Model provider for the stack
- [x] (impl) a scripted OpenAI-compatible mock model service (clearly labelled synthetic: results from it are never model-quality results)
- [x] (integ) the chat-agent reaches the mock through the provider configuration; a ledger row is written per call with the mock's model name
- [ ] (impl) a real-provider path through the SuperAdmin LLM configuration of the evaluation platform (key from `eval.env` only)

### 7.3 Per-run model override
- [ ] (impl) the runner sets provider/model for a run through the real SuperAdmin configuration API, waits out the 60 s config cache, and verifies from the ledger that the intended model answered
- [x] (test) test that a wrong model in the ledger makes the case an infrastructure error, not a verdict

### 7.4 Trace
- [x] (impl) a guarded read-only trace endpoint in the chat-agent (enabled only in the evaluation stack): ordered messages, tool calls with arguments and results, proposed vs executed tools, specialist/skills, pending interrupt
- [x] (test) the endpoint is absent (404) unless the evaluation flag is set, and refuses other users' threads

### 7.5 Conversation driver
- [x] (impl) `chat.stream` executor: one thread per case, user turns in order, SSE parsing, confirmation handling per `metadata.confirmations`, per-turn observations (`trace.turn.N.*`, `response.text`)
- [x] (impl) `$customer.<ref>.id`, `$plan.<CODE>.id`, `{{date:today-4d}}` substitution in messages and expected values
- [x] (test) unit tests: SSE parsing, placeholder substitution, observation building

### 7.6 State observation
- [x] (impl) `state.*` derived from before/after database snapshots (new customers/users/cases/tenants/organizations/claims, lead fields, pending plan, policy and claim status, IPP)
- [x] (test) tests that every `state.*` target used by the 38 chat-shaped cases is produced by the observer

### 7.7 Coverage of the chat cases
- [ ] (integ) every chat case (27 single-turn in 1.0.x sources + the multi-turn dataset) reaches passed, failed, blocked or infrastructure_error: none is skipped
- [ ] (integ) with the mock provider the runner completes a scripted conversation per category end to end (mechanics verified, labelled synthetic)
- [x] (impl) `IND-SEC-006` (another user's thread) executes against the real ownership check
- [ ] (!) with a real provider key every chat case executes against a real model (BLOCKED: needs a dedicated evaluation key in `eval.env`)

### 7.8 Cost and budget for chat
- [ ] (impl) per-case token/cost attribution from the ledger by execution correlation; budget enforced across turns
- [ ] (test) budget stops a conversation mid-way as `blocked: budget_exceeded` without hiding the spent cost

### 7.9 Frontend
- [ ] (fe) run detail shows a chat case's transcript, tool calls and arguments, and which assertion failed where

## Step 8: Repeated evaluations and reliability

### 8.1 Repetition policy
- [ ] (impl) default repetitions by case class (deterministic operations 1, chat 3, benchmark 5) with explicit override; the policy and counts are recorded with the run
- [ ] (test) tests of the policy table

### 8.2 Per-case aggregation
- [x] (impl) per case: n, passes, pass rate, Wilson 95% interval, and class (stable_pass, stable_fail, flaky, insufficient)
- [ ] (test) tests against hand-computed values

### 8.3 Run reliability metrics
- [x] (impl) consistency, flaky count, score/latency/cost variance across repetitions
- [ ] (test) tests on constructed runs

### 8.4 Quality gates
- [x] (impl) configurable gates by severity (critical must reach 100% of repetitions), a gate verdict in the report and the exit status
- [ ] (test) gate tests (pass, fail on one critical flake, not enough repetitions)

### 8.5 Clean state and stopping
- [x] (integ) every repetition of a chat case starts from a reset database and a new thread (verified by integration test)
- [x] (impl) `--stop-on-critical` and budget-aware repetition (no repetition starts that cannot be paid for)
- [ ] (test) tests for both

### 8.6 Storage, API and CLI
- [ ] (impl) aggregates stored/served with the run; CLI `run-reliability <id>`
- [x] (integ) verified on a stored multi-repetition run

### 8.7 Frontend
- [ ] (fe) reliability view on the run page (pass rate with interval, flaky list, gate verdict)

## Step 9: DeepEval and multi-LLM benchmarking

### 9.1 Judge service
- [x] (impl) a separate `eval-judge` service with DeepEval installed, reachable only from the runner, egress only for the provider
- [x] (integ) the service starts and scores a request end to end (against the mock provider)
- [ ] (!) scores with a real judge model (BLOCKED: needs the evaluation key)

### 9.2 Metrics
- [x] (impl) the case `semantic_criteria` (correctness, faithfulness, relevance, hallucination, task_completion, safety, custom) mapped to DeepEval metrics with each criterion's threshold
- [ ] (test) mapping tests for every metric name the dataset uses

### 9.3 Judge governance
- [x] (impl) the judge model is pinned and separate from the model under test; its cost is attributed and counted against the budget
- [x] (test) tests: a run refuses a judge equal to the model under test unless forced, and records the judge identity

### 9.4 Storage
- [ ] (impl) `eval_metric_scores` (metric, score, threshold, passed, reason, judge model, cost) ingested with the run
- [ ] (integ) stored and returned by the API for a real run

### 9.5 Verdict combination
- [x] (impl) case verdict from the case's own `evaluation` block: layers, pass threshold, critical assertions override a high score
- [ ] (test) tests of the combination rules

### 9.6 Judge calibration
- [x] (impl) a calibration set of known good and bad answers with the judge's expected direction
- [x] (integ) calibration executes and is reported with the run

### 9.7 Multi-LLM benchmark
- [ ] (impl) model registry (provider, model, price source) and a benchmark runner: for each model set the override, run the chat cases N times, store results with the model identity
- [ ] (integ) the benchmark runs end to end over two mock models with different behaviour and the results differ as designed
- [ ] (!) real benchmark over GPT, Gemini and Claude (BLOCKED: needs a dedicated key for each provider)

### 9.8 Benchmark report
- [ ] (impl) comparison per model: pass rate with interval, critical failures, flaky cases, latency, tokens, cost, cost per passed case
- [ ] (test) report tests on constructed results

### 9.9 Provider credential handling
- [ ] (impl) a model whose provider has no key is `blocked_missing_credentials` in the benchmark, never skipped silently or failed
- [ ] (test) test for it

### 9.10 Frontend
- [ ] (fe) benchmark comparison page (models side by side, per-category table, cost)

## Log (newest first; every tick must be backed by a line here)

- 2026-10-23 **Phase 4 (chat harness, DeepEval, repetitions, judge calibration) ticks.** Backed by runs on 2026-10-23, all with SCRIPTED models (mock/mock-oracle, -lazy, -reckless; judges mock-judge, mock-judge-strict), so they show the harness works, not model quality:
  `envctl.py test-chat` 14/14 (conversation driven and judged in six layers; lazy agent fails; reckless agent stopped by the role gate or failed critically; skills on/off and prompt variants change the system prompt the model receives; another user's thread refused 403 and the trace route 403 for the intruder; infrastructure error retried, verdict not; fresh thread and database per repetition; no key blocks without calling; judge service scores every metric), `test-runner` 12/12, `test-runs` 5/5,
  offline `selftest.py` incl. 30 chat evaluation tests and 16 usage tests; production chat-agent `/chat/eval/trace/x` answers 404 with and without credentials; `eval_lake_cli.py run-reliability 20261023T131222-e58a8f` prints the stored interval, gate and calibration;
  judge calibration (`envctl.py calibrate`): both mock judges NOT TRUSTED at 54% (7 of 13), as designed. Ingested multi-turn runs 20261023T025121-17f2f1 / 025424-42006c: 30 executions each, 0 skipped, 0 infrastructure errors (21 passed; failures are scripted-oracle limits on IND-PLAN-004/005, IND-LEAD-006, IND-CLM-006, IND-CUST-005).
  NOT ticked and why: 7.1 (container-level egress test not run), 7.3 impl (a per-request header is used, not the SuperAdmin config API), 7.7 "none skipped" for single-turn chat cases and the real-key items (BLOCKED: no key), 7.8 (no mid-conversation budget stop; budget is checked before each execution and judge call), 7.9/8.7/9.10 (UI), 9.4 storage / 9.7 to 9.9 (benchmark, Phase 5), 8.1, 8.2/8.3/8.4 tests are in `test_stats.py` but I did not re-run them separately, 6.5/6.6 (runs API, comparison).
  Known: baseline selftest drift for IND-SEC-009/011 (claims.py text changed) and IND-AGT-003 fails for real (add_user without a confirmation step).

- 2026-10-22 **Audit fix.** The router-wide tenant check on the claims router had changed Finance's 403 message on the payment register, so the approved case IND-SEC-005 failed 5/5
  (a consistent, wrong answer: reported failed, not passed). Fixed in code (`_verify_claims_tenant` in `routers/claims.py` keeps Finance's original message), the golden case is unchanged.
  After the fix: environment integration 19/19, runner integration 12/12, run-storage integration 5/5, anonymous production reads still 401; published single-turn 1.0.6 run
  `20261022T200932-6084d9`: 24 passed, 0 failed, 3 blocked (OCR key), 17 skipped (chat runner missing); multi-turn 1.0.3 run `20261022T201007-cc5e41`: 10 skipped. Both are stored (platform DB + MinIO).
  The Dataset Manager page type-checks in the frontend container (`tsc --noEmit`: 11 errors, all in unrelated files, none in `super-admin/` or the sidebar).

- 2026-10-22 **Independent audit (steps 6 to 9).** Verified by running them, not by reading code:
  - Step 6 ticks above are backed by: `python evals/tools/selftest.py` (7 run-storage unit tests), `envctl.py test-runs` (5 integration tests: rows = results file, every artifact in the
    object store with its checksum, second ingestion changes nothing, tampered / unlisted-file / reused-run-id folders refused, the database refuses UPDATE/DELETE/INSERT on a finished run,
    unknown cost stays unknown, cost follows the ACTIVE price version, no cost record is invented without usage); a live ingestion of two real runs into the platform database and MinIO
    (44 + 10 results, 71 assertions, 30 objects, 0 checksum mismatches, 0 duplicates, immutability triggers refused all six change attempts); `envctl.py fresh` then `eval_lake_cli.py runs`
    still lists both runs; schema comparison SQLModel vs live database: 15 eval tables, 0 differences, triggers present.
  - `eval_lake_cli.py` has `run-ingest`, `runs`, `run <id> [--report]`; `run-verify` and `run-compare` do NOT exist, so 6.4 stays `[~]`.
  - NOT implemented (no code, no route, no page): the runs API and its gateway proxy (6.5), run comparison/report (6.6), every Super Admin evaluation page (`/super-admin/evaluation*` answer 404;
    only the Dataset Manager and Token Economy pages exist), the chat runner (`chat.stream` is not a registered operation; 27 chat cases + 10 multi-turn are reported `skipped`), chat-agent in the
    isolated stack, any mock provider, repetition statistics (Wilson, consistency, gates), DeepEval (not installed anywhere), the judge service, the benchmark runner, jobs/SSE monitor.
  - Existing behaviour that was exercised: `--repeat 5` over the published 1.0.6 suite (220 executions, IND-SEC-005 failed 5/5, no flaky case, 0 infrastructure errors) and `--repeat 10` over
    8 stack cases (80/80 passed); a case that is not in the published version is refused by name.

- 2026-10-22 **COLLISION found, work paused on Steps 6 to 9 until the owner decides.** While I was building 6.1 and 6.2, another author changed the same
  files in this working tree: `shared/evaluation/runs.py` was replaced by a different ingestion (`seal_folder`, `verify_folder`, `ingest_run(lake, folder)`,
  `IngestReport`, versioned `PriceTable`), `pricing.py`/`run_report.py`/`ddl.py`/`models/evaluation.py` were extended (EvalRun gained kind/group/config/
  provider/model/judge/pricing columns; new `EvalMetricScore`, `EvalJob`, `eval_pricing_versions`, `eval_cost_records`). That is a broader design than mine.
  I did NOT overwrite it. I yielded: the worker now seals its run folder with their `seal_folder` (verified: their `verify_folder` accepts it), my duplicate
  `run_folder.py` and its tests were removed (copies kept in the session scratchpad), and the lake CLI was repaired (it failed to start after their rewrite).
  Their code has no tests that I have run, so nothing of theirs is ticked below. My earlier verified results (run storage 7/7, immutability triggers) belonged to my
  replaced implementation and no longer count.
- 2026-10-22 tracker created. Nothing in Steps 6 to 9 is ticked yet.

## Steps 1 to 5 (done before this tracker)
Step 1 rule/calculation operations, Step 2 data-writing operations, Step 3 OCR operation, Step 4 isolated environment and fixtures,
Step 5 full runner (published Gold 1.0.6: 44 cases, 23 passed, 1 failed (IND-SEC-005, wording, decision pending), 3 blocked (OCR key), 17 skipped (chat)).
