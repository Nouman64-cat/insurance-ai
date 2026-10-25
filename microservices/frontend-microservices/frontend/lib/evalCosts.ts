// Everything the Evaluation Costs dashboard (and the cost parts of the Benchmarking page) say to the backend, in one place. The pages import only this module for data, so the
// integration test can drive exactly the calls the pages make (see evals/frontend/run_costs_integration.py). No React in here.
import api from "@/app/services/api";
import { withReasons, type Estimate, type JobRequest } from "@/lib/evalBenchmarks";

// ── Types (what the backend returns; a null is "not known", never zero) ─────────────────────────────────────────────

export type BudgetState = "no_limit" | "ok" | "warning" | "exceeded";
export interface BudgetPeriod {
  period: "day" | "month"; limit_usd: number | null; spent_usd: number; reserved_usd: number; estimate_usd: number | null; projected_usd: number; warn_at_pct: number; enforce: boolean;
  remaining_usd: number | null; used_pct: number | null; status: BudgetState; allowed: boolean; message: string | null; since: string; set_by: string | null; set_at: string | null; reason: string | null;
}
export interface BudgetStatus { periods: { day: BudgetPeriod; month: BudgetPeriod }; allowed: boolean; status: BudgetState; refused_by: string[]; messages: string[] }
export interface BudgetChange { id: string; period: "day" | "month"; limit_usd: number | null; warn_at_pct: number; enforce: boolean; set_by: string; reason: string; at: string }

export interface ComponentTotals { usd: number; lines?: number }
export interface TrendPoint { start: string; total_usd: number; lines: number; unknown_lines: number; by_group: Record<string, number>; cumulative_usd: number;
  converted?: { total: number; by_group: Record<string, number>; cumulative: number; unconverted_usd: number } }
export interface Trends {
  bucket: string; group_by: string | null; groups: string[]; points: TrendPoint[]; total_usd: number; unknown_lines: number; active_buckets: number; average_per_active_bucket_usd: number | null;
  peak: { start: string; total_usd: number } | null; window: { from: string; to: string }; converted_total?: number; unconverted_usd?: number; currency?: string; rate_now?: Rate | null;
}

export interface Rate { id: string; currency: string; units_per_usd: number; effective_from: string; source: string; recorded_by: string; created_at: string }
export interface Rates { base: "USD"; currencies: Record<string, { current: Rate | null; history: Rate[] }> }

export interface Certainty { confirmed_usd: number; estimated_usd: number; total_usd: number; unknown_lines: number }
export interface RunningJob { job_id: string; state: string; kind: string | null; dataset: string | null; version: string | null; models: (string | null)[]; estimated_usd: number | null; spent_usd: number | null;
  executions: number | null; planned: number | null; started_at: string | null; created_at: string }
export interface StatementSummary { id: string; provider: string; period_start: string; period_end: string; billed_usd: number; status: ReconStatus | null; difference_usd: number | null }
export interface Recommendation { id: string; kind: string; title: string; severity: string; detail?: string; confidence?: string; estimated_saving_usd?: number | null; saving_basis?: string | null;
  evidence?: Record<string, unknown>; caveats?: string[] }
export interface CostOverview {
  as_of: string; currency: string | null; rate: Rate | null; budget: BudgetStatus;
  month: { from: string; to: string; total_usd: number; converted_total: number | null; unconverted_usd: number | null; unknown_lines: number; by_component: Record<string, number>; by_provider: Record<string, number>;
    certainty: Certainty; confirmed_by: { statement_id: string; provider: string; period_start: string; period_end: string; billed_usd: number }[];
    projection: { month_to_date_usd: number; days_elapsed: number; days_in_month: number; projected_usd: number; limit_usd: number | null; over_limit: boolean | null } | null };
  today_usd: number; trend: { points: TrendPoint[]; groups: string[]; total_usd: number; converted_total?: number | null }; running: RunningJob[];
  statements: { count: number; needs_attention: number; latest: StatementSummary[] }; attribution: { checked: number; with_problems: number };
  anomalies: { count: number; high: number; counts: Record<string, number> }; recommendations: { count: number; estimated_saving_usd: number; top: { id: string; kind: string; title: string; severity: string }[] };
}

export interface ModelGroup {
  label: string; model: string; synthetic: boolean; run_ids: string[]; runs: number; repetitions: number[]; judge_model: string | null; status: string | null; ran: number; passes: number;
  pass_rate: number | null; ci_low: number | null; ci_high: number | null; consistency: number | null; flaky_cases: number; critical_failures: number; latency_p50_ms: number | null; latency_p95_ms: number | null;
  error_rate: number | null; infrastructure_errors: number; total_usd: number; judge_usd: number; candidate_usd: number; by_component: Record<string, ComponentTotals & { unknown_lines: number }>; unknown_lines: number;
  per_passed_usd: number | null; candidate_per_passed_usd: number | null; per_execution_usd: number | null; on_frontier: boolean | null; dominated_by: string[]; enough_evidence: boolean; cost_rank?: number;
}
export interface ModelSet { dataset: string; version: string; mode: "agent" | "direct"; models: ModelGroup[]; frontier: string[]; warnings: string[]; recommendations: Recommendation[] }
export interface ModelComparison { sets: ModelSet[]; include_synthetic: boolean; how_to_read: string }
export interface BenchmarkSpend { benchmark_id: string; mode: string; dataset: string; version: string; created_at: string; repetitions: number; total_usd: number; unknown_lines: number; by_component: Record<string, number>;
  models: { label: string; run_id: string; total_usd: number; judge_usd: number; by_component: Record<string, number>; passed: number; ran: number; per_passed_usd: number | null }[] }
export interface Anomaly { kind: string; severity: "high" | "medium" | "low"; subject: Record<string, unknown>; observed: number | null; baseline: number | null; ratio: number | null; excess_usd: number | null; at: string; message: string; evidence: Record<string, unknown> }
export interface Anomalies { window: { from: string; to: string }; anomalies: Anomaly[]; counts: Record<string, number>; checked: { runs: number; days: number; executions: number }; rules: Record<string, string> }
export interface Recommendations { window: { from: string; to: string }; recommendations: Recommendation[]; count: number; principle: string }

export interface CostLine { id: string; run_id: string | null; case_id: string | null; repetition: number; component: string; provider: string | null; model: string | null; unit_kind: string;
  input_units: number; output_units: number; cached_units: number; usd: number | null; cost_kind: "confirmed" | "estimated" | "unknown"; source: string; incurred_at: string }
export interface LineFilter { run_id?: string; component?: string; provider?: string; kind?: string; case_id?: string; from?: string; to?: string; limit?: number; offset?: number }
export interface Lines { total: number; usd: number; unknown_lines: number; lines: CostLine[] }
export interface Attribution { runs: { run_id: string; kind: string; model: string | null; synthetic: boolean; lines: number; known_usd: number; recorded_usd: number; by_component: Record<string, unknown>; problems: string[] }[]; checked: number; with_problems: number }

export type ReconStatus = "matched" | "under_recorded" | "over_recorded" | "incomplete";
export interface Reconciliation { status: ReconStatus; billed_usd: number; recorded_usd: number; difference_usd: number; difference_pct: number; allowed_usd: number; tolerance_pct: number; tolerance_usd: number;
  unknown_lines: number; line_count: number; explanation: string[]; confirms: boolean; note?: string | null; at?: string; id?: string;
  tokens: null | Record<string, { billed: number; recorded: number; difference: number; difference_pct: number; matches: boolean } | boolean>;
  recorded: { usd: number; lines: number; unknown_lines: number; tokens: Record<string, number>; by_component: Record<string, { usd: number; lines: number }>; top_runs: { run_id: string; usd: number }[] } }
export interface Statement { id: string; provider: string; period_start: string; period_end: string; billed_usd: number; reference: string | null; source: string; billed_tokens: { input: number | null; output: number | null; cached: number | null };
  tolerance_pct: number; tolerance_usd: number; supersedes_id: string | null; entered_by: string; created_at: string; superseded: boolean; live: Reconciliation | null;
  last_reconciliation: { id: string; status: ReconStatus; at: string; by: string; note: string | null; recorded_usd: number; difference_usd: number } | null }
export interface StatementDetail extends Omit<Statement, "last_reconciliation"> { scope_note: string;
  reconciliations: { id: string; status: ReconStatus; billed_usd: number; recorded_usd: number; difference_usd: number; difference_pct: number; unknown_lines: number; note: string | null; detail: Record<string, unknown>; by: string; at: string }[] }
export interface StatementIn { provider: string; period_start: string; period_end: string; billed_usd: number; reference?: string; source: string; billed_input_tokens?: number; billed_output_tokens?: number;
  billed_cached_tokens?: number; tolerance_pct?: number; tolerance_usd?: number; supersedes_id?: string; note?: string }
export interface CertaintyWindow { from: string; to: string; totals: Certainty; by_provider: Record<string, { total_usd: number; lines: number; unknown_lines: number; confirmed_usd: number; estimated_usd: number }>;
  confirmed_by: { statement_id: string; provider: string; period_start: string; period_end: string; billed_usd: number }[]; meaning: Record<string, string> }

export const COMPONENT_LABEL: Record<string, string> = {
  candidate_llm: "Model under test", agent_llm: "Agent", subagent_llm: "Specialists", judge: "Judge", ocr: "OCR", embedding: "Embeddings", retry: "Retries", fallback: "Fallback model",
  unattributed: "Unattributed calls", self_hosted: "Self-hosted",
};
export const COMPONENT_COLOR: Record<string, string> = {
  agent_llm: "#2563eb", candidate_llm: "#1d4ed8", subagent_llm: "#38bdf8", judge: "#7c3aed", ocr: "#0ea5e9", embedding: "#14b8a6", retry: "#f59e0b", fallback: "#f97316", unattributed: "#ef4444", self_hosted: "#64748b",
};
export const RECON_LABEL: Record<ReconStatus, string> = { matched: "Matches the bill", under_recorded: "Bill is higher than recorded", over_recorded: "Recorded is higher than the bill", incomplete: "Incomplete (unpriced usage)" };

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const q = (p: Record<string, string | number | boolean | undefined | null>) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== ""));
export const getCostOverview = async (currency?: string) => (await api.get<CostOverview>("/eval/costs/overview", { params: q({ currency }) })).data;
export const getBudget = async () => (await api.get<BudgetStatus>("/eval/budget")).data;
export const getBudgetHistory = async () => (await api.get<{ changes: BudgetChange[] }>("/eval/budget/history")).data.changes;
export const getTrends = async (p: { from?: string; to?: string; bucket?: "day" | "week" | "month"; group_by?: "component" | "provider" | "model"; currency?: string; include_synthetic?: boolean } = {}) =>
  (await api.get<Trends>("/eval/costs/trends", { params: q(p) })).data;
export const getModelComparison = async (p: { dataset?: string; version?: string; mode?: string; include_synthetic?: boolean } = {}) => (await api.get<ModelComparison>("/eval/costs/models", { params: q(p) })).data;
export const getBenchmarkSpending = async (benchmarkId?: string) => (await api.get<{ benchmarks: BenchmarkSpend[]; total_usd: number; count: number }>("/eval/costs/benchmarks", { params: q({ benchmark_id: benchmarkId }) })).data;
export const getAnomalies = async (from?: string, to?: string) => (await api.get<Anomalies>("/eval/costs/anomalies", { params: q({ from, to }) })).data;
export const getRecommendations = async (from?: string, to?: string) => (await api.get<Recommendations>("/eval/costs/recommendations", { params: q({ from, to }) })).data;
export const listLines = async (f: LineFilter = {}) => (await api.get<Lines>("/eval/costs/lines", { params: q({ ...f }) })).data;
export const getAttribution = async (runId?: string) => (await api.get<Attribution>("/eval/costs/attribution", { params: q({ run_id: runId }) })).data;
export const getCertainty = async (from?: string, to?: string) => (await api.get<CertaintyWindow>("/eval/costs/certainty", { params: q({ from, to }) })).data;
export const listStatements = async (provider?: string) => (await api.get<{ statements: Statement[]; scope_note: string }>("/eval/costs/statements", { params: q({ provider }) })).data;
export const getStatement = async (id: string) => (await api.get<StatementDetail>(`/eval/costs/statements/${id}`)).data;
export const getRates = async () => (await api.get<Rates>("/eval/costs/rates")).data;

// ── Acting (a refusal comes back as an Error whose message lists the reasons) ───────────────────────────────────────

async function refusing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw withReasons(err);
  }
}
export const setBudget = (period: "day" | "month", body: { limit_usd: number | null; warn_at_pct: number; enforce: boolean; reason: string }) =>
  refusing(async () => (await api.put<{ limit: BudgetChange; status: BudgetStatus }>(`/eval/budget/${period}`, body)).data);
export const addStatement = (body: StatementIn) => refusing(async () => (await api.post<{ statement: Statement; reconciliation: Reconciliation; scope_note: string }>("/eval/costs/statements", body)).data);
export const reconcileStatement = (id: string, note?: string) => refusing(async () => (await api.post<Reconciliation>(`/eval/costs/statements/${id}/reconcile`, { note: note || undefined })).data);
export const addRate = (body: { currency: string; units_per_usd: number; effective_from: string; source: string }) =>
  refusing(async () => (await api.post<{ rate: Rate; previous: Rate | null; warning: string | null }>("/eval/costs/rates", body)).data);

/** What a benchmark request would run and cost, and what it would do to the daily and monthly budgets. Nothing is queued. */
export const previewWithBudget = (req: JobRequest) =>
  refusing(async () => (await api.post<{ valid: boolean; estimate: Estimate; budget: BudgetStatus }>("/eval/jobs/estimate", req)).data);

// ── Showing money ───────────────────────────────────────────────────────────────────────────────────────────────────

/** How an amount reads, in dollars or in the second currency. Tiny sums keep four decimals (an evaluation turn costs a fraction of a cent); a null is "unknown", never 0. */
export function money(amount: number | null | undefined, currency = "USD"): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "unknown";
  if (currency === "USD") return amount === 0 ? "$0" : Math.abs(amount) < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (amount === 0) return `0 ${currency}`;
  return Math.abs(amount) >= 100 ? `${Math.round(amount).toLocaleString("en-US")} ${currency}` : `${amount.toFixed(2)} ${currency}`;
}
/** A formatter for point amounts in the chosen currency, using the rate in force today (series totals come converted day by day from the backend). */
export function formatter(currency: string, rate: Rate | null | undefined): (usd: number | null | undefined) => string {
  if (currency === "USD" || !rate) return (usd) => money(usd, "USD");
  return (usd) => (usd === null || usd === undefined ? "unknown" : money(usd * rate.units_per_usd, currency));
}
export const percent = (x: number | null | undefined, digits = 0) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(digits)}%`);
export const secondsText = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

/** The detailed usage records as a CSV a spreadsheet opens: one row per cost line, the unknown ones with an empty amount (never 0). */
export function linesToCsv(lines: CostLine[]): string {
  const head = ["incurred_at", "run_id", "case_id", "repetition", "component", "provider", "model", "input_units", "output_units", "cached_units", "usd", "cost_kind", "source"];
  const esc = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [head.join(","), ...lines.map((l) => [l.incurred_at, l.run_id, l.case_id, l.repetition, l.component, l.provider, l.model, l.input_units, l.output_units, l.cached_units, l.usd, l.cost_kind, l.source].map(esc).join(","))].join("\n");
}
export function csvDownload(name: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
