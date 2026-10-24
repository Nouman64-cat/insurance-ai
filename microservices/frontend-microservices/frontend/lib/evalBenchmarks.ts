// Everything the LLM Benchmarking page says to the backend, in one place. The page imports only this module for data, so the
// integration test can drive exactly the calls the page makes (see evals/frontend: it runs this file against the live gateway).
//
// No React in here, and no direct use of window except in the two functions that need the browser (download, stream).
import api from "@/app/services/api";

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type BenchmarkMode = "agent" | "direct";
export const METRICS = ["correctness", "faithfulness", "relevance", "hallucination", "task_completion", "safety", "custom"] as const;
export type Metric = (typeof METRICS)[number];
export const REPETITION_CHOICES = [1, 3, 5, 10, 20, 30] as const;

export interface VersionInfo { version: string; state: string; case_count: number; unconfirmed_cases?: number; provisional?: boolean }
export interface DatasetSummary { slug: string; name: string; workflow: string; turn_mode: string; status: string; latest_version: string | null }
export interface DatasetDetail extends DatasetSummary { versions: VersionInfo[]; facets: { category: string[]; scenario_type: string[] } }

export interface Price { input_per_m: number; cached_per_m: number; output_per_m: number; source: string }
export interface ModelEntry {
  id: string; label: string; provider: string; model_id: string; display_name: string | null; status: string; synthetic: boolean; roles: string[];
  current_price: Price | null;
  latest_benchmark: { benchmark_id: string; pass_rate: number | null; status: string } | null;
}

export interface JobRequest {
  dataset: string; version: string; kind: "benchmark_agent" | "benchmark_direct"; models: string[]; repeat: string; judge?: string; metrics?: Metric[];
  categories?: string[]; case_ids?: string[]; settings?: string[]; budget_usd?: number; concurrency?: number; stop_on_critical?: boolean; retries?: number;
  allow_same_judge?: boolean; suite?: "technical" | "business";
}

export interface ModelCost {
  model: string; synthetic: boolean; executions: number; input_tokens: number; output_tokens: number; usd: number | null; usd_known: boolean; basis: string; samples: number;
}
export interface CostEstimate {
  mode: BenchmarkMode; model_backed_cases: number; repetitions: number; repetitions_assumed: boolean; judged_criteria_per_pass: number; models: ModelCost[];
  judge: { model: string | null; calls: number; input_tokens: number; output_tokens: number; usd: number | null; usd_known: boolean; basis: string };
  tokens: { input: number; output: number; judge_input: number; judge_output: number };
  usd: { models: number; judge: number; total: number; complete: boolean; unpriced: string[] };
  upper_bound: boolean; note: string; warnings: string[]; error?: string;
}
export interface Estimate { cases_in_version: number; cases_selected: number; executions: number | null; real_model: boolean; synthetic: boolean; cost?: CostEstimate }

export interface Job {
  id: string; state: string; config: JobRequest & Record<string, unknown>; estimate: Estimate; progress: Record<string, unknown>; cancel_requested: boolean;
  run_id: string | null; error: string | null; created_at: string; started_at: string | null; finished_at: string | null;
}
export interface JobEvent { seq: number; at: string; kind: string; message: string | null; data: Record<string, unknown> }

export interface Stat { n: number; mean: number | null; p50: number | null; p95: number | null; min: number | null; max: number | null; stdev: number | null }
export interface ModelResult {
  label: string; status: string; synthetic: boolean; note?: string; executions: number; ran: number; pass_rate?: number | null; ci_low?: number | null; ci_high?: number | null;
  consistency?: number | null; flaky_cases?: string[]; consistently_wrong_cases?: string[]; critical_failures?: number; critical_failure_rate?: number | null;
  quality?: Record<string, { n: number; mean: number | null; met: number }>; latency_ms?: Stat; ttft_ms?: Stat; throughput_tokens_per_s?: number | null;
  tokens?: { input: number; output: number; cached: number }; cost?: { candidate_usd: number; judge_usd: number; total_usd: number; per_passed_usd: number | null; executions_with_unknown_cost: number };
  error_rate?: number | null; safety_violations?: { executions: number; rate: number };
}
export interface BenchmarkListItem {
  benchmark_id: string; mode: BenchmarkMode; dataset: string; dataset_version: string; models: { label: string; status?: string }[]; repetitions: number;
  judge_model: string | null; synthetic: boolean; complete: boolean; created_at: string;
}
export interface BenchmarkDetail extends BenchmarkListItem {
  summary: {
    valid: boolean; problems: string[]; models: Record<string, ModelResult>; order: string[]; leader: string | null; notes: string[]; synthetic: boolean;
    comparisons: { a: string; b: string; verdict: string; note?: string }[]; judge: { model: string | null; calibration?: { status: string; agreement: number | null } | null };
    fairness: { check: string; ok: boolean; detail?: string }[];
  };
  runs: { run_id: string; model: string; state: string; pass_rate: number | null; known_cost_usd: number }[];
}

export interface BreakdownCell { passed: number; failed: number; other: number; critical: number; ran: number; pass_rate: number | null; ci_low: number | null; ci_high: number | null }
export interface CaseCell { runs: number; passed: number; failed: number; other: number; critical: number; pass_rate: number | null; p50_ms: number | null; p95_ms: number | null; cost_usd: number; cost_known: boolean; result_ids: string[] }
export interface Breakdown {
  benchmark_id: string; mode: BenchmarkMode; models: string[]; stages: { stage: string; models: Record<string, BreakdownCell> }[];
  cases: { case: string; stage: string; models: Record<string, CaseCell> }[]; facets: { model: string[]; stage: string[]; status: string[] }; filtered: boolean;
}
export interface HistoryPoint {
  benchmark_id: string; at: string; model: string; mode: BenchmarkMode; synthetic: boolean; status: string; pass_rate?: number; ci_low?: number; ci_high?: number;
  p50_ms?: number; p95_ms?: number; total_usd?: number; cost_per_passed_usd?: number | null; critical_failures?: number; input_tokens?: number; output_tokens?: number;
}

export interface ResultDetail {
  result_id: string; case: string; stage: string | null; repetition: number; status: string; reason: string | null; critical_failed: boolean; latency_ms: number | null;
  input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; cost_known: boolean; judge_cost_usd: number | null; model: string | null;
  assertion_results: { id: string; kind: string; target: string | null; severity: string; status: string; message: string | null; expected: unknown; actual: unknown }[];
  judge_scores: { metric: string; criterion: string | null; score: number | null; threshold: number | null; passed: boolean | null; status: string; reason: string | null; judge_model: string | null }[];
  response_text: string | null; trace: Record<string, unknown> | null; verdict: Record<string, unknown>; layers: Record<string, string | undefined>;
}

// ── Reading and validating ───────────────────────────────────────────────────────────────────────────────────────────

export const listDatasets = async () => (await api.get<DatasetSummary[]>("/eval/datasets")).data;
export const getDataset = async (slug: string) => (await api.get<DatasetDetail>(`/eval/datasets/${slug}`)).data;
export const listModels = async () => (await api.get<ModelEntry[]>("/eval/models")).data;
export const listJobs = async (limit = 30) => (await api.get<Job[]>("/eval/jobs", { params: { limit } })).data;
export const getJob = async (id: string) => (await api.get<Job & { run?: Record<string, unknown> | null }>(`/eval/jobs/${id}`)).data;
export const listBenchmarks = async (limit = 50) => (await api.get<BenchmarkListItem[]>("/eval/benchmarks", { params: { limit } })).data;
/** A stored benchmark as the page can safely read it. Older benchmarks were saved before some summary fields existed (validity, problems,
 *  notes, comparisons, order), and an empty or partial summary must read as "nothing to report", never crash the page. A benchmark that
 *  does not say it is invalid is not shown as invalid. */
export type RawBenchmark = Omit<Partial<BenchmarkDetail>, "summary"> & { summary?: Partial<BenchmarkDetail["summary"]> | null };
export function normalizeBenchmark(raw: RawBenchmark): BenchmarkDetail {
  const s: Partial<BenchmarkDetail["summary"]> = raw.summary ?? {};
  return {
    ...(raw as Omit<BenchmarkDetail, "summary">),
    models: Array.isArray(raw.models) ? raw.models : [],
    runs: Array.isArray(raw.runs) ? raw.runs : [],
    summary: {
      valid: s.valid !== false, problems: Array.isArray(s.problems) ? s.problems : [], models: s.models ?? {}, order: Array.isArray(s.order) ? s.order : [],
      leader: s.leader ?? null, notes: Array.isArray(s.notes) ? s.notes : [], synthetic: s.synthetic ?? raw.synthetic ?? false,
      comparisons: Array.isArray(s.comparisons) ? s.comparisons : [], judge: s.judge ?? { model: raw.judge_model ?? null, calibration: null },
      fairness: Array.isArray(s.fairness) ? s.fairness : [],
    },
  };
}
export const getBenchmark = async (id: string) => normalizeBenchmark((await api.get<BenchmarkDetail>(`/eval/benchmarks/${id}`)).data);
export const getHistory = async (model?: string) => (await api.get<{ points: HistoryPoint[] }>("/eval/benchmarks/history", { params: model ? { model } : {} })).data.points;
export interface RunRow { run_id: string; kind: string; group_id: string | null; job_id: string | null; model: string | null; state: string; executions: number; passed: number; failed: number; pass_rate: number | null; known_cost_usd: number }
/** The runs a job produced. For a benchmark they share one group_id, which is the benchmark's id. */
export const runsOfJob = async (jobId: string) => (await api.get<{ total: number; runs: RunRow[] }>("/eval/runs", { params: { job_id: jobId } })).data.runs;
export const getResult = async (id: string) => (await api.get<ResultDetail>(`/eval/results/${id}`)).data;

export interface BreakdownFilter { model?: string[]; stage?: string[]; status?: string[]; case?: string }
export const getBreakdown = async (id: string, f: BreakdownFilter = {}) =>
  (await api.get<Breakdown>(`/eval/benchmarks/${id}/breakdown`, { params: { model: f.model?.join(",") || undefined, stage: f.stage?.join(",") || undefined, status: f.status?.join(",") || undefined, case: f.case || undefined } })).data;

// ── Acting ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The shared client keeps only the headline of a refusal ("This run cannot be requested."). The reasons are in the response, and the person
 *  asking needs them: this puts them back into the message. */
export function withReasons(err: unknown): Error {
  const e = err as { message?: string; response?: { data?: { detail?: { message?: string; problems?: unknown } } } };
  const problems = e?.response?.data?.detail?.problems;
  const list = Array.isArray(problems) ? problems.filter((p): p is string => typeof p === "string") : [];
  const base = e?.message ?? "The request was refused.";
  return Object.assign(new Error(list.length > 0 ? `${base} ${list.join(" ")}` : base), { response: (err as { response?: unknown })?.response });
}
async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw withReasons(err);
  }
}

/** What the request would run and cost. Nothing is queued. A refusal comes back as an Error whose message lists the reasons. */
export const previewJob = (req: JobRequest) => refusing(async () => (await api.post<{ valid: boolean; estimate: Estimate }>("/eval/jobs/estimate", req)).data.estimate);
export const startJob = (req: JobRequest) => refusing(async () => (await api.post<Job>("/eval/jobs", req)).data);
export const cancelJob = async (id: string) => (await api.post<Job>(`/eval/jobs/${id}/cancel`)).data;
export const rerunJob = (id: string) => refusing(async () => (await api.post<Job>(`/eval/jobs/${id}/rerun`)).data);

/** The request the page sends for a form. Only what the user chose is included, so the backend's own defaults apply to the rest. */
export interface BenchmarkForm {
  dataset: string; version: string; mode: BenchmarkMode; models: string[]; repetitions: number; judge: string; metrics: Metric[]; stages: string[];
  temperature: string; budget: string; stopOnCritical: boolean; allowSameJudge: boolean;
}
export function buildRequest(f: BenchmarkForm): JobRequest {
  const req: JobRequest = { dataset: f.dataset, version: f.version, kind: f.mode === "direct" ? "benchmark_direct" : "benchmark_agent", models: f.models, repeat: String(f.repetitions) };
  if (f.judge) req.judge = f.judge;
  if (f.judge && f.metrics.length > 0) req.metrics = f.metrics;
  if (f.stages.length > 0) req.categories = f.stages;
  if (f.mode === "direct" && f.temperature.trim() !== "") req.settings = [`temperature=${f.temperature.trim()}`];
  if (f.budget.trim() !== "" && Number(f.budget) >= 0) req.budget_usd = Number(f.budget);
  if (f.stopOnCritical) req.stop_on_critical = true;
  if (f.allowSameJudge) req.allow_same_judge = true;
  return req;
}

/** Why the form cannot be sent yet (empty when it can). The backend repeats every one of these checks; this only saves a round trip. */
export function formProblems(f: BenchmarkForm): string[] {
  const out: string[] = [];
  if (!f.dataset || !f.version) out.push("Choose a published dataset version.");
  if (f.models.length < 2) out.push("Choose at least two models to compare.");
  if (!Number.isInteger(f.repetitions) || f.repetitions < 1 || f.repetitions > 100) out.push("Repetitions must be a whole number from 1 to 100.");
  if (f.metrics.length > 0 && !f.judge) out.push("Choose a judge to score metrics.");
  if (f.judge && f.models.includes(f.judge) && !f.allowSameJudge) out.push("The judge is also one of the models compared. Choose another judge, or allow it on purpose.");
  if (f.budget.trim() !== "" && !(Number(f.budget) >= 0)) out.push("The budget must be a number of dollars.");
  if (f.mode === "direct" && f.temperature.trim() !== "" && Number.isNaN(Number(f.temperature))) out.push("Temperature must be a number.");
  return out;
}

// ── Exports ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const exportPath = (kind: "run" | "benchmark", id: string, format: "csv" | "json") =>
  kind === "run" ? `/eval/runs/${id}/export?format=${format}` : `/eval/benchmarks/${id}/export?format=${format}`;

/** Fetch an export with the user's credentials and hand it to the browser as a file. */
export async function downloadExport(kind: "run" | "benchmark", id: string, format: "csv" | "json"): Promise<void> {
  const res = await api.get<Blob>(exportPath(kind, id, format), { responseType: "blob" });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${kind}-${id}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Live events (Server-Sent Events over fetch, so the Authorization header can be sent) ────────────────────────────────

/** Split an SSE text buffer into complete frames; the unfinished tail is returned to be completed by the next chunk. */
export function parseSse(buffer: string): { events: { id?: string; event: string; data: string }[]; rest: string } {
  const frames = buffer.split("\n\n");
  const rest = frames.pop() ?? "";
  const events: { id?: string; event: string; data: string }[] = [];
  for (const frame of frames) {
    let id: string | undefined;
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0 || event !== "message") events.push({ id, event, data: data.join("\n") });
  }
  return { events, rest };
}

export interface StreamHandlers { onEvent: (e: JobEvent) => void; onEnd: (end: { state: string; run_id: string | null; error: string | null }) => void; onError?: (message: string) => void }

/** Follow a job until it ends or `signal` aborts. Reconnects from the last event it saw if the connection drops. Resolves when finished. */
export async function streamJob(jobId: string, h: StreamHandlers, signal: AbortSignal, baseUrl?: string | null): Promise<void> {
  let last = 0;
  const base = (baseUrl ?? api.defaults.baseURL ?? process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
  // The same credentials every other call on the page uses: the app shell sets them on the shared client after sign-in.
  const common = (api.defaults.headers.common ?? {}) as Record<string, unknown>;
  const auth = typeof common["Authorization"] === "string" ? (common["Authorization"] as string) : `Bearer ${typeof window !== "undefined" ? window.localStorage.getItem("jwt_token") ?? "" : ""}`;
  const headers: Record<string, string> = { Authorization: auth, Accept: "text/event-stream" };
  if (typeof common["X-Tenant-Id"] === "string") headers["X-Tenant-Id"] = common["X-Tenant-Id"] as string;
  let failures = 0;
  while (!signal.aborted) {
    try {
      const res = await fetch(`${base}/eval/jobs/${jobId}/stream?after=${last}`, { headers, signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      failures = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const ev of parsed.events) {
          if (ev.event === "end") {
            h.onEnd(JSON.parse(ev.data));
            return;
          }
          const body = JSON.parse(ev.data) as JobEvent;
          last = Math.max(last, body.seq);
          h.onEvent(body);
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      failures += 1;
      h.onError?.(err instanceof Error ? err.message : String(err));
      if (failures >= 5) return;
    }
    await new Promise((r) => setTimeout(r, Math.min(1000 * failures + 500, 5000)));
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const pct = (x: number | null | undefined, digits = 0) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(digits)}%`);
export const ms = (x: number | null | undefined) => (x === null || x === undefined ? "—" : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
export const usd = (x: number | null | undefined) => (x === null || x === undefined ? "unknown" : x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
export const tokens = (x: number | null | undefined) => (x === null || x === undefined ? "—" : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : String(Math.round(x)));
export const providerOf = (label: string) => label.split("/")[0];
export const PROVIDER_NAME: Record<string, string> = { openai: "GPT (OpenAI)", gemini: "Gemini (Google)", anthropic: "Claude (Anthropic)", mock: "Scripted (synthetic)" };
export const PROVIDER_COLOR: Record<string, string> = { openai: "#2563eb", gemini: "#0ea5e9", anthropic: "#7c3aed", mock: "#94a3b8" };
/** A stable colour per model: the provider's hue, shifted a little for the second and third model of the same provider. */
export function modelColor(label: string, all: string[]): string {
  const base = PROVIDER_COLOR[providerOf(label)] ?? "#475569";
  const same = all.filter((m) => providerOf(m) === providerOf(label));
  const i = same.indexOf(label);
  return i <= 0 ? base : shade(base, i * 0.28);
}
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * Math.min(amount, 0.7));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => mix(c).toString(16).padStart(2, "0")).join("")}`;
}
