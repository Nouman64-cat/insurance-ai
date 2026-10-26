// The comparison table of a benchmark: every measured quantity of every model side by side, grouped by what it measures. Built only from the stored benchmark summary: a value the benchmark does not have is shown as
// not available (with the reason), never as a zero, and a cost the platform could not price is "unknown". The best value in a row is marked only when it is a fair comparison: at least two real models were measured,
// the values differ, and scripted stand-in models never take part in picking a best.
import { ms, pct, tokens, usd, type ModelResult } from "@/lib/evalBenchmarks";

export type Direction = "higher" | "lower" | "none";                        // which way is better; "none" is informational (more tokens is not better or worse)
export interface Cell { value: number | null; text: string; best: boolean; note?: string }
export interface Row { id: string; label: string; hint: string; direction: Direction; cells: Record<string, Cell>; same: boolean; key: boolean }
export interface Highlight { id: string; title: string; model: string; text: string }
export interface Group { id: "quality" | "reliability" | "speed" | "cost"; title: string; subtitle: string; rows: Row[] }

const NOT_RUN: Record<string, string> = { blocked_missing_credentials: "not run: no API key for this provider", no_results: "no execution produced a verdict", blocked: "blocked" };
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** The rows worth reading first: how right, how safe, how steady, how fast, what a correct answer costs. The rest are detail, one click away. */
export const KEY_ROWS = new Set(["accuracy", "critical", "consistency", "p50", "p95", "per_pass", "total"]);
interface Spec { id: string; label: string; hint: string; direction: Direction; value: (m: ModelResult) => number | null; text: (m: ModelResult, v: number | null) => string; note?: (m: ModelResult) => string | undefined }
const dash = (v: number | null, f: (x: number) => string, none = "—") => (v === null ? none : f(v));

function specs(models: Record<string, ModelResult>, labels: string[]): Record<Group["id"], Spec[]> {
  const quality = Array.from(new Set(labels.flatMap((l) => Object.keys(models[l]?.quality ?? {})))).sort();
  return {
    quality: [
      { id: "accuracy", label: "Accuracy", hint: "Share of the executions that produced a verdict that passed. The range is the 95% interval: wide means little evidence.", direction: "higher", value: (m) => num(m.pass_rate),
        text: (m, v) => (v === null ? "—" : `${pct(v, 1)}${num(m.ci_low) !== null && num(m.ci_high) !== null ? ` (${pct(m.ci_low, 0)}–${pct(m.ci_high, 0)})` : ""}`) },
      { id: "ran", label: "Executions that ran", hint: "Executions that produced a verdict (passed or failed), out of all that were planned. Blocked, skipped and errored ones are not counted as results.", direction: "none", value: (m) => num(m.ran),
        text: (m, v) => (v === null ? "—" : `${v} / ${m.executions}`) },
      { id: "critical", label: "Critical failures", hint: "Executions that broke a rule the case marks as critical. One of these fails the case whatever else was right.", direction: "lower", value: (m) => num(m.critical_failures), text: (_m, v) => dash(v, String) },
      { id: "critical_rate", label: "Critical failure rate", hint: "Critical failures as a share of the executions that ran.", direction: "lower", value: (m) => num(m.critical_failure_rate), text: (_m, v) => dash(v, (x) => pct(x, 1)) },
      { id: "safety", label: "Safety violations", hint: "Executions flagged for a safety violation by the judge or a safety check.", direction: "lower", value: (m) => num(m.safety_violations?.executions), text: (_m, v) => dash(v, String) },
      ...quality.map((k): Spec => ({ id: `q_${k}`, label: `Judged: ${k.replace(/_/g, " ")}`, hint: "Mean score from the judge model, 0 to 1, over the executions it scored.", direction: "higher",
        value: (m) => num(m.quality?.[k]?.mean), text: (m, v) => (v === null ? "not scored" : `${v.toFixed(2)} (${m.quality?.[k]?.n ?? 0} scored)`) })),
    ],
    reliability: [
      { id: "consistency", label: "Consistency", hint: "How often the same case got the same verdict on every repeat. It needs a case to be run at least twice.", direction: "higher", value: (m) => num(m.consistency),
        text: (_m, v) => dash(v, (x) => pct(x, 0), "needs 2+ repeats") },
      { id: "flaky", label: "Flaky cases", hint: "Cases that passed on some repeats and failed on others.", direction: "lower", value: (m) => (m.flaky_cases ? m.flaky_cases.length : null), text: (_m, v) => dash(v, String) },
      { id: "wrong", label: "Always wrong", hint: "Cases the model failed on every repeat.", direction: "lower", value: (m) => (m.consistently_wrong_cases ? m.consistently_wrong_cases.length : null), text: (_m, v) => dash(v, String) },
      { id: "errors", label: "Errors and timeouts", hint: "Share of executions that ended in an infrastructure error or a timeout instead of a verdict.", direction: "lower", value: (m) => num(m.error_rate), text: (_m, v) => dash(v, (x) => pct(x, 1)) },
    ],
    speed: [
      { id: "p50", label: "Latency, median (P50)", hint: "Half of the executions answered faster than this.", direction: "lower", value: (m) => num(m.latency_ms?.p50), text: (_m, v) => ms(v) },
      { id: "p95", label: "Latency, slow end (P95)", hint: "One execution in twenty was slower than this.", direction: "lower", value: (m) => num(m.latency_ms?.p95), text: (_m, v) => ms(v) },
      { id: "mean", label: "Latency, average", hint: "The mean time to answer.", direction: "lower", value: (m) => num(m.latency_ms?.mean), text: (_m, v) => ms(v) },
      { id: "ttft", label: "Time to first token, median", hint: "How long until the first words arrived (streamed answers only).", direction: "lower", value: (m) => num(m.ttft_ms?.p50), text: (_m, v) => ms(v) },
      { id: "tps", label: "Throughput", hint: "Output tokens per second while the model was answering.", direction: "higher", value: (m) => num(m.throughput_tokens_per_s), text: (_m, v) => dash(v, (x) => `${x.toFixed(1)} tok/s`) },
    ],
    cost: [
      { id: "inference", label: "Inference cost", hint: "What the model's own calls cost in this benchmark (tokens times the price in force).", direction: "lower", value: (m) => num(m.cost?.candidate_usd), text: (_m, v) => usd(v) },
      { id: "per_pass", label: "Cost per passed case", hint: "Inference cost divided by the executions that passed: what one correct answer cost. Unknown when any cost could not be priced.", direction: "lower", value: (m) => num(m.cost?.per_passed_usd),
        text: (_m, v) => usd(v), note: (m) => ((m.cost?.executions_with_unknown_cost ?? 0) > 0 ? `${m.cost!.executions_with_unknown_cost} execution(s) could not be priced` : undefined) },
      { id: "judge", label: "Judge cost", hint: "What judging this model's answers cost. It belongs to the evaluation, not to the model, so it is not compared.", direction: "none", value: (m) => num(m.cost?.judge_usd), text: (_m, v) => usd(v) },
      { id: "total", label: "Total cost", hint: "Inference plus judge.", direction: "none", value: (m) => num(m.cost?.total_usd), text: (_m, v) => usd(v) },
      { id: "unknown", label: "Executions with unknown cost", hint: "Executions whose cost could not be established (no usage was recorded). They are counted, never treated as free.", direction: "lower", value: (m) => num(m.cost?.executions_with_unknown_cost), text: (_m, v) => dash(v, String) },
      { id: "tok_in", label: "Tokens in", hint: "Input tokens sent to the model, over the whole benchmark.", direction: "none", value: (m) => num(m.tokens?.input), text: (_m, v) => tokens(v) },
      { id: "tok_out", label: "Tokens out", hint: "Output tokens the model produced.", direction: "none", value: (m) => num(m.tokens?.output), text: (_m, v) => tokens(v) },
      { id: "tok_cached", label: "Cached input tokens", hint: "Input tokens served from the provider's cache, which are cheaper.", direction: "none", value: (m) => num(m.tokens?.cached), text: (_m, v) => tokens(v) },
    ],
  };
}

const GROUPS: { id: Group["id"]; title: string; subtitle: string }[] = [
  { id: "quality", title: "Quality", subtitle: "Is it right, and is it safe?" },
  { id: "reliability", title: "Reliability", subtitle: "Does it behave the same way every time?" },
  { id: "speed", title: "Speed", subtitle: "How long do people wait?" },
  { id: "cost", title: "Cost and tokens", subtitle: "What did it cost, and per correct answer?" },
];

/** The table for the models shown (`labels`, in display order). `fair` models (measured, real, not hidden) decide which value is best in each row. */
export function buildTable(models: Record<string, ModelResult>, labels: string[]): Group[] {
  const sp = specs(models, labels);
  const fair = labels.filter((l) => models[l]?.status === "measured" && !models[l]?.synthetic);
  return GROUPS.map((g) => {
    const rows: Row[] = sp[g.id].map((s) => {
      const cells: Record<string, Cell> = {};
      for (const l of labels) {
        const m = models[l];
        if (!m) { cells[l] = { value: null, text: "—", best: false }; continue; }
        if (m.status !== "measured") { cells[l] = { value: null, text: "not run", best: false, note: `${NOT_RUN[m.status] ?? m.status}${m.note ? `: ${m.note}` : ""}` }; continue; }
        const v = s.value(m);
        cells[l] = { value: v, text: s.text(m, v), best: false, note: s.note?.(m) };
      }
      const vals = fair.map((l) => cells[l].value).filter((v): v is number => v !== null);
      const same = vals.length > 0 && vals.every((v) => v === vals[0]);
      if (s.direction !== "none" && vals.length >= 2 && !same) {
        const target = s.direction === "higher" ? Math.max(...vals) : Math.min(...vals);
        for (const l of fair) if (cells[l].value === target) cells[l].best = true;
      }
      return { id: s.id, label: s.label, hint: s.hint, direction: s.direction, cells, same: same || vals.length < 2, key: KEY_ROWS.has(s.id) };
    });
    return { ...g, rows };
  });
}

/** Rows where the models differ, plus every row of a group when `all` is set. Used by the "only what differs" switch. */
export function onlyDifferences(groups: Group[]): Group[] {
  return groups.map((g) => ({ ...g, rows: g.rows.filter((r) => !r.same) })).filter((g) => g.rows.length > 0);
}

/** The table as CSV (what is shown, one line per metric), for a spreadsheet. */
export function tableToCsv(groups: Group[], labels: string[]): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [["Group", "Metric", ...labels].map(q).join(",")];
  for (const g of groups) for (const r of g.rows) lines.push([g.title, r.label, ...labels.map((l) => `${r.cells[l]?.text ?? "—"}${r.cells[l]?.best ? " (best)" : ""}`)].map(q).join(","));
  return lines.join("\n");
}

/** The three things most people come for, as sentences: who is the most accurate, the fastest, and the cheapest per correct answer. Only among real, measured models, only when they differ, and a tie names no one. */
export function highlights(groups: Group[]): Highlight[] {
  const out: Highlight[] = [];
  for (const [id, title] of [["accuracy", "Most accurate"], ["p50", "Fastest (median)"], ["per_pass", "Cheapest per correct answer"]] as const) {
    const row = groups.flatMap((g) => g.rows).find((r) => r.id === id);
    const best = row ? Object.entries(row.cells).filter(([, c]) => c.best) : [];
    if (best.length === 1) out.push({ id, title, model: best[0][0], text: best[0][1].text.replace(/ \(.*$/, "") });
  }
  return out;
}
