// Frontend-to-backend integration test of the LLM Benchmarking page. It runs the page's OWN API module (lib/evalBenchmarks.ts, the one
// every component imports) under node against the live gateway, the way the page calls it: build the form, validate it, preview the
// cost, start, follow the live stream, cancel, rerun, read the results, filter them, export them and open an execution's trace.
//
//   python evals/frontend/run_benchmarking_integration.py          (starts the job worker, mints a Super Admin token, compiles and runs this)
//
// It uses scripted models only, so it spends nothing. Environment: BM_TOKEN (a Super Admin JWT), NEXT_PUBLIC_API_URL (the gateway).
import api from "@/app/services/api";
import {
  buildRequest, cancelJob, exportPath, formProblems, getBenchmark, getBreakdown, getDataset, getHistory, getJob, getResult, listBenchmarks, listDatasets, listJobs, listModels,
  modelColor, ms, normalizeBenchmark, parseSse, pct, previewJob, rerunJob, runsOfJob, startJob, streamJob, usd, type BenchmarkForm, type JobEvent,
} from "@/lib/evalBenchmarks";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`);
}
async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
async function until<T>(fn: () => Promise<T | null | false>, seconds: number, every = 2000): Promise<T | null> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, every));
  }
  return null;
}

async function main(): Promise<number> {
  api.defaults.headers.common["Authorization"] = `Bearer ${process.env.BM_TOKEN}`;      // what the app shell does after sign-in

  // ── pure helpers the page relies on ──
  const sse = parseSse('id: 1\nevent: state\ndata: {"seq":1}\n\nid: 2\nevent: case\ndata: {"se');
  check("the stream reader keeps an unfinished frame for the next chunk", sse.events.length === 1 && sse.events[0].id === "1" && sse.rest.startsWith("id: 2"), sse);
  check("a keep-alive comment is ignored", parseSse(": keep-alive\n\n").events.length === 0);
  check("formatters show unknown as unknown, never as zero", usd(null) === "unknown" && usd(0) === "$0" && pct(null) === "—" && ms(null) === "—" && ms(1500) === "1.5 s");
  check("the same model keeps the same colour, two models of one provider differ", modelColor("openai/a", ["openai/a", "openai/b"]) !== modelColor("openai/b", ["openai/a", "openai/b"]) && modelColor("openai/a", ["openai/a"]) === modelColor("openai/a", ["openai/a", "openai/b"]));

  const bare = normalizeBenchmark({ benchmark_id: "old", summary: {} });
  check("a benchmark saved before validity and notes existed reads as valid with nothing to report", bare.summary.valid && bare.summary.problems.length === 0 && bare.summary.notes.length === 0 && bare.summary.comparisons.length === 0 && Object.keys(bare.summary.models).length === 0, bare.summary);
  check("a benchmark with no summary at all does not crash the page", normalizeBenchmark({ benchmark_id: "old", summary: null }).summary.valid);
  check("a benchmark that says it is invalid stays invalid", !normalizeBenchmark({ benchmark_id: "x", summary: { valid: false, problems: ["mode differs"] } }).summary.valid);

  // ── what the setup panel loads ──
  const datasets = await listDatasets();
  const single = datasets.find((d) => d.slug === "individual-single-turn");
  check("the datasets with a published version are listed", !!single && !!single.latest_version, datasets.map((d) => d.slug));
  if (!single) return 1;
  const detail = await getDataset(single.slug);
  const published = detail.versions.filter((v) => v.state === "published");
  check("a dataset shows its published versions and its workflow stages", published.length > 0 && detail.facets.category.includes("lead-onboarding"), detail.facets);
  const models = await listModels();
  const labels = models.map((m) => m.label);
  check("the registry offers GPT, Gemini, Claude and the scripted models", ["openai/gpt-4o-mini", "gemini/gemini-2.5-pro", "anthropic/claude-sonnet-4-5", "mock/mock-oracle"].every((l) => labels.includes(l)), labels);

  const form: BenchmarkForm = { dataset: single.slug, version: single.latest_version as string, mode: "agent", models: ["mock/mock-oracle", "mock/mock-lazy"], repetitions: 1,
    judge: "mock/mock-judge", metrics: [], stages: ["lead-onboarding"], temperature: "0", budget: "1", stopOnCritical: false, allowSameJudge: false };
  check("a complete form has no problems", formProblems(form).length === 0, formProblems(form));
  check("one model is a problem the page shows before asking the backend", formProblems({ ...form, models: ["mock/mock-oracle"] }).some((p) => /at least two/i.test(p)));
  check("metrics without a judge are a problem", formProblems({ ...form, judge: "", metrics: ["safety"] }).length > 0);
  check("the judge being a compared model is a problem unless allowed", formProblems({ ...form, judge: "mock/mock-oracle" }).length > 0 && formProblems({ ...form, judge: "mock/mock-oracle", allowSameJudge: true }).length === 0);
  const request = buildRequest(form);
  check("the request carries only what was chosen", request.kind === "benchmark_agent" && request.repeat === "1" && request.categories?.[0] === "lead-onboarding" && request.budget_usd === 1 && request.metrics === undefined && request.settings === undefined, request);
  check("a direct benchmark sends the temperature, an agent benchmark does not", buildRequest({ ...form, mode: "direct" }).settings?.[0] === "temperature=0");

  // ── Phase 8: skills, per-execution limits and the quality gate ──
  const plain = buildRequest(form);
  check("by default nothing about skills, limits or the gate is sent (the platform's own defaults apply)", plain.skills === undefined && plain.max_latency_ms === undefined && plain.max_tokens === undefined && plain.max_cost_usd === undefined && plain.gate === undefined, plain);
  const tuned = buildRequest({ ...form, skills: "off", maxLatencyMs: "8000", maxTokens: "4000", maxCostUsd: "0.05", gate: true, gateMinPassPct: "85" });
  check("skills, the three limits and the gate are sent when chosen, the pass rate as a fraction", tuned.skills === "off" && tuned.max_latency_ms === 8000 && tuned.max_tokens === 4000 && tuned.max_cost_usd === 0.05 && tuned.gate === true && tuned.gate_min_pass_rate === 0.85, tuned);
  check("skills belong to the agent: a direct benchmark never sends them", buildRequest({ ...form, mode: "direct", skills: "on" }).skills === undefined);
  check("the gate's pass rate is left out when the gate is off, and 'as configured' sends no skills", buildRequest({ ...form, gate: false, gateMinPassPct: "70", skills: "default" }).gate_min_pass_rate === undefined && buildRequest({ ...form, skills: "default" }).skills === undefined);
  check("a limit that is not a whole number, a negative cost and a pass rate over 100 are problems the page shows", formProblems({ ...form, maxLatencyMs: "1.5" }).length === 1 && formProblems({ ...form, maxTokens: "abc" }).length === 1 && formProblems({ ...form, maxCostUsd: "-1" }).length === 1
    && formProblems({ ...form, gate: true, gateMinPassPct: "120" }).length === 1 && formProblems({ ...form, maxLatencyMs: "", maxTokens: "", maxCostUsd: "", gate: false }).length === 0);
  const tunedPreview = await previewJob(buildRequest({ ...form, skills: "off", maxLatencyMs: "8000", maxTokens: "4000", maxCostUsd: "0.05", gate: true, gateMinPassPct: "85" }));
  check("the backend accepts the request the form builds, with the limits and the gate", tunedPreview.cost !== undefined && tunedPreview.executions !== null, tunedPreview);
  const badLimit = await rejects(() => previewJob({ ...buildRequest(form), max_latency_ms: 0 }));
  check("the backend refuses a limit of zero", badLimit !== null, badLimit);

  // ── the cost preview ──
  const preview = await previewJob(request);
  const cost = preview.cost;
  check("the preview counts the model runs", !!cost && cost.model_backed_cases > 0 && cost.models.length === 2 && cost.models[0].executions === cost.model_backed_cases, cost);
  check("scripted models are previewed at no cost", !!cost && cost.usd.total === 0 && cost.models.every((m) => m.synthetic));
  const real = await previewJob(buildRequest({ ...form, models: ["openai/gpt-4o-mini", "openai/gpt-4o"], judge: "openai/gpt-4.1", repetitions: 3, budget: "5" }));
  check("a real-model preview estimates tokens and dollars before anything runs", !!real.cost && real.cost.tokens.input > 0 && real.cost.usd.total > 0 && real.cost.models.every((m) => m.basis.length > 0), real.cost?.usd);
  check("a dearer model previews higher than a cheaper one", !!real.cost && (real.cost.models[1].usd ?? 0) > (real.cost.models[0].usd ?? 0));
  const tight = await previewJob(buildRequest({ ...form, models: ["openai/gpt-4o-mini", "openai/gpt-4o"], judge: "openai/gpt-4.1", repetitions: 3, budget: "0.01" }));
  check("a budget below the estimate is warned about", (tight.cost?.warnings ?? []).some((w) => /budget/.test(w)), tight.cost?.warnings);
  const fewer = await previewJob(buildRequest({ ...form, models: ["openai/gpt-4o-mini", "openai/gpt-4o"], judge: "openai/gpt-4.1", repetitions: 3, budget: "5", metrics: ["safety"] }));
  check("choosing fewer metrics lowers the judged calls", !!real.cost && !!fewer.cost && fewer.cost.judged_criteria_per_pass < real.cost.judged_criteria_per_pass, [fewer.cost?.judged_criteria_per_pass, real.cost?.judged_criteria_per_pass]);
  const refused = await rejects(() => previewJob({ ...request, models: ["mock/mock-oracle"] }));
  check("the backend refuses one model and says why", !!refused && /at least two/i.test(refused), refused);
  const refusedVersion = await rejects(() => previewJob({ ...request, version: "9.9.9" }));
  check("the backend refuses an unpublished version", !!refusedVersion && /published/i.test(refusedVersion), refusedVersion);

  // ── start, follow, cancel, rerun ──
  const jobA = await startJob(request);
  check("starting queues a job with its estimate stored", jobA.state === "queued" && jobA.estimate.cost !== undefined && jobA.config.kind === "benchmark_agent", jobA);
  const jobB = await startJob(request);
  const cancelledB = await cancelJob(jobB.id);
  const finalB = await until(async () => { const j = await getJob(jobB.id); return ["cancelled", "lost", "succeeded", "failed"].includes(j.state) ? j : null; }, 90);
  check("a job can be cancelled from the page and ends cancelled", !!finalB && finalB.state === "cancelled" && (cancelledB.cancel_requested || cancelledB.state === "cancelled"), finalB?.state);

  const events: JobEvent[] = [];
  let end: { state: string; run_id: string | null; error: string | null } | null = null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 420000);
  await streamJob(jobA.id, { onEvent: (e) => events.push(e), onEnd: (e) => { end = e; }, onError: (m) => console.log("       stream note:", m) }, ctl.signal);
  clearTimeout(timer);
  check("the live stream delivered events and ended with the job's state", events.length > 3 && end !== null && (end as { state: string }).state === "succeeded", { n: events.length, end });
  check("events arrive in order without gaps", events.every((e, i) => i === 0 || e.seq > events[i - 1].seq));
  const cases = events.filter((e) => e.kind === "case");
  check("each finished case reports its model, stage, latency and tokens", cases.length > 0 && cases.every((e) => typeof e.data.model === "string" && "latency_ms" in e.data && "stage" in e.data), cases[0]);
  check("the model's answer is streamed as it arrives", cases.some((e) => typeof e.data.reply === "string" && (e.data.reply as string).length > 0), cases.slice(0, 2));
  check("progress reports cost and the planned total", events.some((e) => e.kind === "progress" && typeof e.data.planned === "number" && typeof e.data.spent_usd === "number"));
  const jobs = await listJobs(50);
  check("the jobs list shows the new jobs", jobs.some((j) => j.id === jobA.id) && jobs.some((j) => j.id === jobB.id));

  const doneA = await getJob(jobA.id);
  check("the finished job knows its run", doneA.state === "succeeded" && !!doneA.run_id, doneA.state);
  const runs = await runsOfJob(jobA.id);
  const benchmarkId = runs.find((r) => r.group_id)?.group_id ?? null;
  check("the job's runs are found, one per model, sharing the benchmark id", runs.length === 2 && !!benchmarkId && runs.every((r) => r.group_id === benchmarkId && r.state === "complete"), runs);
  // a real (scripted) job started with skills off, the three limits and the gate: the runner takes every one and records them on each model's run
  const tunedJob = await startJob(buildRequest({ ...form, skills: "off", maxLatencyMs: "60000", maxTokens: "100000", maxCostUsd: "1", gate: true, gateMinPassPct: "50" }));
  const tunedDone = await until(async () => { const j = await getJob(tunedJob.id); return ["succeeded", "failed", "cancelled", "lost"].includes(j.state) ? j : null; }, 300);
  const tunedRuns = tunedDone ? await runsOfJob(tunedJob.id) : [];
  const tunedCfg = tunedRuns.length ? (await api.get<{ config: Record<string, any>; gate: { passed?: boolean; min_pass_rate?: number } | null }>(`/eval/runs/${tunedRuns[0].run_id}`)).data : null;
  check("a job started with skills off, limits and a gate runs to the end", tunedDone?.state === "succeeded" && tunedRuns.length === 2, tunedDone?.state);
  check("each model's run records skills off, the three limits and the gate with its minimum", !!tunedCfg && tunedCfg.config.skills_enabled === false && tunedCfg.config.limits?.max_latency_ms === 60000 && tunedCfg.config.limits?.max_tokens === 100000
    && tunedCfg.config.limits?.max_cost_usd === 1 && tunedCfg.config.gate?.min_pass_rate === 0.5, tunedCfg?.config);
  if (!benchmarkId) return 1;

  // ── results ──
  const list = await listBenchmarks();
  check("the benchmark is listed", list.some((b) => b.benchmark_id === benchmarkId));
  const bench = await getBenchmark(benchmarkId);
  check("the benchmark reports each model's accuracy, latency, tokens and cost", Object.keys(bench.summary.models).length === 2 && Object.values(bench.summary.models).every((m) => m.status === "measured" && m.pass_rate !== undefined && m.latency_ms !== undefined && m.cost !== undefined && m.tokens !== undefined), bench.summary.models);
  check("scripted models are flagged synthetic and the oracle beats the lazy model", bench.synthetic && (bench.summary.models["mock/mock-oracle"].pass_rate ?? 0) > (bench.summary.models["mock/mock-lazy"].pass_rate ?? 1));
  const all = await getBreakdown(benchmarkId);
  check("the breakdown has workflow stages, cases and both models", all.stages.length > 0 && all.cases.length > 0 && all.models.length === 2 && all.facets.stage.includes("lead-onboarding"), all.facets);
  const byModel = await getBreakdown(benchmarkId, { model: ["mock/mock-lazy"] });
  check("filtering by model keeps only that model", byModel.models.length === 1 && byModel.models[0] === "mock/mock-lazy" && byModel.filtered);
  const byStage = await getBreakdown(benchmarkId, { stage: ["lead-onboarding"] });
  check("filtering by workflow stage keeps only that stage", byStage.stages.length === 1 && byStage.cases.every((c) => c.stage === "lead-onboarding"));
  const failedOnly = await getBreakdown(benchmarkId, { status: ["failed"] });
  check("filtering by status keeps only those executions", failedOnly.cases.length > 0 && failedOnly.cases.every((c) => Object.values(c.models).every((m) => m.passed === 0 && m.other === 0)), failedOnly.cases.length);
  const oneCase = await getBreakdown(benchmarkId, { case: all.cases[0].case });
  check("filtering by test case finds it", oneCase.cases.length >= 1 && oneCase.cases.every((c) => c.case.includes(all.cases[0].case)));
  const history = await getHistory("mock/mock-oracle");
  check("the history includes this benchmark for the model", history.some((p) => p.benchmark_id === benchmarkId && p.pass_rate !== undefined), history.length);

  const oracleCell = all.cases.map((c) => c.models["mock/mock-oracle"]).find((c) => c && c.result_ids.length > 0);
  const trace = oracleCell ? await getResult(oracleCell.result_ids[0]) : null;
  check("an execution opens with its answer, checks and trace", !!trace && typeof trace.response_text === "string" && trace.response_text.length > 0 && trace.assertion_results.length > 0 && !!trace.trace, trace && Object.keys(trace));
  check("an execution shows what was expected versus what happened for each check", !!trace && trace.assertion_results.every((a) => "status" in a && "expected" in a && "actual" in a));
  const judged = trace && trace.judge_scores.length > 0 ? trace : null;
  check("judge scores come with their reasons", judged === null || judged.judge_scores.every((m) => m.status !== "scored" || (m.reason ?? "").length > 0));

  const csv = await api.get<string>(exportPath("benchmark", benchmarkId, "csv"), { responseType: "text" });
  const csvRows = csv.data.trim().split("\n");
  check("the benchmark exports as CSV with a row per execution", csvRows.length - 1 === runs.reduce((n, r) => n + r.executions, 0) && csvRows[0].includes("input_tokens") && csvRows[0].includes("latency_ms"), [csvRows.length, csvRows[0]]);
  const js = await api.get<{ results: unknown[]; benchmark: { benchmark_id: string } }>(exportPath("benchmark", benchmarkId, "json"));
  check("the benchmark exports as JSON with its identity", js.data.benchmark.benchmark_id === benchmarkId && js.data.results.length === csvRows.length - 1);
  const runCsv = await api.get<string>(exportPath("run", runs[0].run_id, "csv"), { responseType: "text" });
  check("a single run exports too", runCsv.data.trim().split("\n").length - 1 === runs[0].executions);

  // ── rerun ──
  const again = await rerunJob(jobA.id);
  check("a rerun queues a new job with the same request", again.id !== jobA.id && again.state === "queued" && JSON.stringify(again.config.models) === JSON.stringify(jobA.config.models), again);
  await cancelJob(again.id);
  const finalAgain = await until(async () => { const j = await getJob(again.id); return ["cancelled", "lost", "succeeded", "failed"].includes(j.state) ? j : null; }, 90);
  check("the rerun can be cancelled before it runs", !!finalAgain && finalAgain.state === "cancelled", finalAgain?.state);

  // ── permission: the same calls without a Super Admin token are refused ──
  const saved = api.defaults.headers.common["Authorization"];
  delete api.defaults.headers.common["Authorization"];
  const noAuth = await rejects(() => listBenchmarks());
  const noAuthPreview = await rejects(() => previewJob(request));
  api.defaults.headers.common["Authorization"] = saved;
  check("without sign-in the page's calls are refused", noAuth !== null && noAuthPreview !== null, [noAuth, noAuthPreview]);

  console.log(`\n${failures === 0 ? "PASS" : "FAILED"}: ${failures} failed`);
  return failures === 0 ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error("FAIL unexpected error:", e); process.exit(1); });
