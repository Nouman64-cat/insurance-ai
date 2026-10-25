// Frontend-to-backend integration test of the Evaluation Costs dashboard. It runs the pages' own data module (lib/evalCosts.ts) under node against a live gateway, then renders
// the pages' own views (components/costs/*, components/benchmarking/CostCard.tsx) with what the real API returned and checks what a person would read.
//   python evals/frontend/run_costs_integration.py
// Two suites, chosen by COSTS_SUITE:
//   writes  against the ISOLATED evaluation stack (limits, bills and rates can never be deleted, so they are made where nothing real lives): the whole flow with its refusals
//   reads   against the working stack, changing nothing: the cost preview with the budget, and the real runs' overview, comparison and usage records
import { createElement } from "react";
import api from "@/app/services/api";
import * as C from "@/lib/evalCosts";
import * as DC from "@/lib/displayCurrency";
import { usd as benchUsd } from "@/lib/evalBenchmarks";
import BenchmarkCostCard from "@/components/benchmarking/CostCard";
import { BenchmarkCostView } from "@/components/benchmarking/CostCard";
import { BudgetsView } from "@/components/costs/BudgetsPanel";
import { InsightsView } from "@/components/costs/InsightsPanel";
import { ModelsView } from "@/components/costs/ModelsPanel";
import { OverviewView } from "@/components/costs/OverviewPanel";
import { ComputeRatesView, RatesView } from "@/components/costs/RatesPanel";
import { GapView, ImportSummary, StatementDetailView, StatementsView } from "@/components/costs/ReconcilePanel";
import { LinesTable, AttributionView } from "@/components/costs/UsagePanel";

const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (element: unknown) => string };
const html = (el: unknown) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== undefined ? `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}` : ""}`);
}
async function rejection(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const near = (a: number | null | undefined, b: number, eps = 1e-6) => a !== null && a !== undefined && Math.abs(a - b) < eps;
const usd = (x: number | null | undefined) => C.money(x, "USD");

async function helpers(): Promise<void> {
  check("money reads naturally in dollars: cents, four places for tiny sums, thousands separated, unknown never 0", C.money(12.5) === "$12.50" && C.money(0.0034) === "$0.0034" && C.money(0) === "$0" && C.money(1234.5) === "$1,234.50" && C.money(null) === "unknown");
  check("and in a second currency: rupees without decimals above 100", C.money(1234.5, "PKR") === "1,235 PKR" && C.money(12.5, "PKR") === "12.50 PKR" && C.money(0, "PKR") === "0 PKR");
  const rate = { id: "r", currency: "PKR", units_per_usd: 280, effective_from: "2026-10-01", source: "x", recorded_by: "u", created_at: "2026-10-01" };
  check("a formatter converts point figures at the rate given, and falls back to dollars without one", C.formatter("PKR", rate)(2) === "560 PKR" && C.formatter("PKR", null)(2) === "$2.00" && C.formatter("USD", rate)(2) === "$2.00" && C.formatter("PKR", rate)(null) === "unknown");
  check("percent and seconds read naturally, unknown as a dash", C.percent(0.9091, 1) === "90.9%" && C.percent(null) === "—" && C.secondsText(1874.5) === "1.9 s" && C.secondsText(420) === "420 ms" && C.secondsText(null) === "—");
  const csv = C.linesToCsv([{ id: "1", run_id: "r1", case_id: "C-1", repetition: 1, component: "agent_llm", provider: "openai", model: "gpt-4.1", unit_kind: "tokens", input_units: 10, output_units: 5, cached_units: 0, usd: 0.5, cost_kind: "estimated", source: 'ledger, "quoted"', incurred_at: "2026-10-01T00:00:00" },
    { id: "2", run_id: "r1", case_id: null, repetition: 1, component: "ocr", provider: null, model: null, unit_kind: "tokens", input_units: 0, output_units: 0, cached_units: 0, usd: null, cost_kind: "unknown", source: "no usage", incurred_at: "2026-10-01T00:00:00" }]);
  const rows = csv.split("\n");
  check("the CSV has a header, quotes what needs it, and leaves an unknown amount empty (never 0)", rows.length === 3 && rows[0].startsWith("incurred_at,run_id") && rows[1].includes('"ledger, ""quoted"""') && /,,unknown,no usage$/.test(rows[2]) && !rows[2].includes(",0,unknown"), rows);
}

/** One display currency for the whole studio: every page that shows money reads it, and a currency with no recorded rate is never converted at a guess. */
async function display(): Promise<void> {
  DC.resetDisplay();
  check("by default money is shown in dollars everywhere", C.show(2.5) === "$2.50" && benchUsd(2.5) === "$2.50" && C.show(null) === "unknown" && benchUsd(undefined) === "unknown" && C.show(0) === "$0");
  DC.setCurrency("PKR");
  check("a chosen currency with NO recorded rate is not converted at a guess: dollars are shown", C.show(2.5) === "$2.50" && benchUsd(2.5) === "$2.50" && DC.getDisplay().currency === "USD");
  DC.setRates({ PKR: 280 });
  check("once a rate is recorded the same amounts read in rupees, on the costs pages and on the benchmark pages alike", C.show(2.5) === "700 PKR" && benchUsd(2.5) === "700 PKR" && C.show(0.0034) === "0.95 PKR" && C.show(0) === "0 PKR" && C.show(null) === "unknown");
  check("an explicit currency still means that currency (a figure labelled USD stays in dollars)", C.money(2.5) === "$2.50" && C.money(2.5, "PKR") === "2.50 PKR");
  DC.setCurrency("EUR");
  check("a currency that has no rate falls back to dollars while another has one", C.show(2.5) === "$2.50");
  let seen = 0;
  const off = DC.subscribeDisplay(() => { seen += 1; });
  DC.setCurrency("PKR");
  DC.setRates({ PKR: 300 });
  off();
  check("everything that shows money is told when the choice or a rate changes, and the new rate is used at once", seen === 2 && C.show(1) === "300 PKR", [seen, C.show(1)]);
  DC.resetDisplay();
  check("resetting returns to dollars", C.show(1) === "$1.00");
}

async function writes(): Promise<void> {
  const ccy = process.env.COSTS_CCY || "XTS";
  const year = Number(process.env.COSTS_YEAR), dataset = process.env.COSTS_DATASET as string, bench = process.env.COSTS_BENCH as string, runA = process.env.COSTS_RUN_A as string;
  const anon = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/eval/costs/overview`);
  check("without signing in the dashboard is refused", anon.status === 401, anon.status);
  api.defaults.headers.common["Authorization"] = `Bearer ${process.env.COSTS_TOKEN}`;
  await helpers();
  await display();

  // ── budgets ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const b0 = await C.getBudget();
  check("the budget has a day and a month, with spent, reserved and a status", ["day", "month"].every((k) => { const p = (b0.periods as Record<string, C.BudgetPeriod>)[k]; return p && typeof p.spent_usd === "number" && typeof p.reserved_usd === "number" && !!p.status; }), b0);
  const noReason = await rejection(() => C.setBudget("day", { limit_usd: 5, warn_at_pct: 80, enforce: true, reason: "" }));
  check("a limit without a reason is refused (the form also stops it before it is sent)", !!noReason && /at least 1 character|reason/i.test(noReason), noReason);
  check("a negative limit is refused", !!(await rejection(() => C.setBudget("day", { limit_usd: -1, warn_at_pct: 80, enforce: true, reason: "x" }))));
  const set = await C.setBudget("day", { limit_usd: 5, warn_at_pct: 70, enforce: true, reason: "integration test: daily limit" });
  check("a limit is saved with its reason, and the status shows it at once", set.status.periods.day.limit_usd === 5 && set.status.periods.day.warn_at_pct === 70 && set.status.periods.day.reason === "integration test: daily limit", set.status.periods.day);
  await C.setBudget("month", { limit_usd: 20, warn_at_pct: 80, enforce: false, reason: "integration test: monthly limit, warn only" });
  const hist = await C.getBudgetHistory();
  check("the history lists both changes, newest first, with who and why", hist.length >= 2 && hist[0].reason.includes("monthly") && hist[0].period === "month" && !!hist[0].set_by && hist.some((h) => h.reason === "integration test: daily limit"), hist.slice(0, 2));
  const withLimits = await C.getBudget();
  const html1 = text(html(createElement(BudgetsView, { status: withLimits, history: hist, fmt: usd, onEdit: () => undefined })));
  check("the budgets page shows the limits, the warn-only note and the history with the reasons", html1.includes("$5.00") && html1.includes("$20.00") && html1.includes("integration test: daily limit") && html1.includes("passing it only warns") && html1.includes("a job that would pass it is refused"), html1.slice(0, 400));
  await C.setBudget("day", { limit_usd: null, warn_at_pct: 80, enforce: true, reason: "integration test finished: limit removed" });
  await C.setBudget("month", { limit_usd: null, warn_at_pct: 80, enforce: true, reason: "integration test finished: limit removed" });
  check("limits can be removed, and the history keeps what was removed", (await C.getBudget()).status === "no_limit" && (await C.getBudgetHistory()).length >= hist.length + 2);

  // ── exchange rates ─────────────────────────────────────────────────────────────────────────────────────────────────
  check("USD cannot be given a rate", !!(await rejection(() => C.addRate({ currency: "USD", units_per_usd: 1, effective_from: `${year}-05-01`, source: "x" }))));
  check("a rate needs a source", !!(await rejection(() => C.addRate({ currency: ccy, units_per_usd: 50, effective_from: `${year}-05-01`, source: "" }))));
  const r1 = await C.addRate({ currency: ccy, units_per_usd: 50, effective_from: `${year}-05-01`, source: "integration test: typed" });
  check("a rate is recorded with where it came from, and no warning for the first", r1.rate.units_per_usd === 50 && r1.rate.source === "integration test: typed" && r1.warning === null, r1);
  const r2 = await C.addRate({ currency: ccy, units_per_usd: 80, effective_from: `${year}-05-20`, source: "integration test: a big move" });
  check("a rate that moves more than 20% is recorded with a warning to check it", r2.rate.units_per_usd === 80 && !!r2.warning && r2.warning.includes("+60.0%") && r2.previous?.units_per_usd === 50, r2);
  const rates = await C.getRates();
  const rateHist = rates.currencies[ccy].history;
  check("the rates list shows both rates just recorded, with their sources, and the history newest first by the day each takes effect", rateHist.some((h) => h.id === r1.rate.id && h.source === "integration test: typed") && rateHist.some((h) => h.id === r2.rate.id)
    && rateHist.every((h, i) => i === 0 || rateHist[i - 1].effective_from >= h.effective_from) && !!rates.currencies[ccy].current, rateHist.slice(0, 3));
  const ratesHtml = text(html(createElement(RatesView, { rates, onAdd: () => undefined })));
  check("the rates page explains day-by-day conversion and lists the sources and the rate in force", ratesHtml.includes("never at today's rate") && ratesHtml.includes("integration test: a big move") && ratesHtml.includes(`1 USD = ${rates.currencies[ccy].current!.units_per_usd}`), ratesHtml.slice(0, 300));
  const trXts = await C.getTrends({ from: `${year}-05-01`, to: `${year}-05-31`, group_by: "component", currency: ccy });
  const d10 = trXts.points.find((p) => p.start === `${year}-05-10`)!;
  check("trends in a second currency convert each day at the rate in force then (day 10 at 50, per recorded dollars)", near(d10.converted!.total, d10.total_usd * 50, 1e-4) && trXts.currency === ccy && trXts.unconverted_usd === 0, d10);

  // ── what a machine costs per hour (self-hosted models) ───────────────────────────────────────────────────────────────────
  const mname = `ITEST-GPU-${year}`;
  check("a machine price without a source is refused", !!(await rejection(() => C.addComputeRate({ name: mname, resource: "gpu", usd_per_hour: 1.8, effective_from: `${year}-05-01`, source: "" }))));
  const m1 = await C.addComputeRate({ name: mname, resource: "gpu", usd_per_hour: 1.8, effective_from: `${year}-05-01`, source: "integration test: price list" });
  const m2 = await C.addComputeRate({ name: mname, resource: "gpu", usd_per_hour: 4.0, effective_from: `${year}-05-20`, source: "integration test: new price list" });
  check("a machine price is recorded with its source, and a jump of more than half is flagged", m1.rate.usd_per_hour === 1.8 && m1.warning === null && !!m2.warning && m2.warning.includes("+122%"), [m1, m2]);
  const machines = await C.getComputeRates();
  const mine = machines.find((m) => m.name === mname)!;
  check("the machine is listed with its price in force and its history", mine.current?.usd_per_hour === 4.0 && mine.history.map((h) => h.usd_per_hour).join() === "4,1.8");
  const machineHtml = text(html(createElement(ComputeRatesView, { machines, onAdd: () => undefined })));
  check("the page explains that machine time is time x price, that a machine without a price is unknown, and lists the machine", machineHtml.includes("time the machine is held times its price per hour") && machineHtml.includes("never free") && machineHtml.includes(mname) && machineHtml.includes("$4"), machineHtml.slice(0, 300));
  check("with no machine recorded the page says so", text(html(createElement(ComputeRatesView, { machines: [], onAdd: () => undefined }))).includes("No machine price is recorded"));

  // ── the usage records ─────────────────────────────────────────────────────────────────────────────────────────────
  const lines = await C.listLines({ run_id: runA });
  check("a run's usage records list each line with its component, kind and source", lines.total === 2 && near(lines.usd, 1.0) && lines.lines.every((l) => !!l.source && !!l.component) && lines.lines.some((l) => l.component === "judge"), lines);
  check("records filter by component, kind and period", (await C.listLines({ run_id: runA, component: "judge" })).total === 1 && (await C.listLines({ run_id: runA, kind: "unknown" })).total === 0 && (await C.listLines({ provider: "openai", from: `${year}-05-01`, to: `${year}-05-31` })).total >= 4);
  check("an unknown component is refused", !!(await rejection(() => C.listLines({ component: "magic" }))));
  const linesHtml = text(html(createElement(LinesTable, { lines: lines.lines, fmt: usd })));
  check("the usage table shows what each line paid for, the model and the cost", linesHtml.includes("Judge") && linesHtml.includes("Agent") && linesHtml.includes("$0.20") && linesHtml.includes("estimated") && linesHtml.includes(runA), linesHtml.slice(0, 300));
  const attr = await C.getAttribution();
  check("the attribution check answers for every run, and its view says so", attr.checked === attr.runs.length && text(html(createElement(AttributionView, { data: attr }))).length > 20);

  // ── provider bills ────────────────────────────────────────────────────────────────────────────────────────────────
  const noSource = await rejection(() => C.addStatement({ provider: "openai", period_start: `${year}-05-01`, period_end: `${year}-05-31`, billed_usd: 1.5, source: "  " }));
  check("a bill without a source is refused", !!noSource, noSource);
  const first = await C.addStatement({ provider: "openai", period_start: `${year}-05-01`, period_end: `${year}-05-31`, billed_usd: 1.5, reference: "ITEST-1", source: "integration test: typed from the usage page", billed_input_tokens: 4000, billed_output_tokens: 400, note: "first look" });
  check("a bill that agrees with the recorded lines (1.50) matches and confirms", first.reconciliation.status === "matched" && first.reconciliation.confirms && near(first.reconciliation.recorded_usd, 1.5), first.reconciliation);
  const sid = first.statement.id;
  const overlap = await rejection(() => C.addStatement({ provider: "openai", period_start: `${year}-05-20`, period_end: `${year}-06-10`, billed_usd: 1, source: "integration test" }));
  check("an overlapping bill for the same provider is refused, with the reason", !!overlap && /already covers/i.test(overlap), overlap);
  const again = await C.reconcileStatement(sid, "integration test: looked again");
  check("reconciling again keeps the note and the result", again.status === "matched" && again.note === "integration test: looked again");
  const detail = await C.getStatement(sid);
  check("the statement shows every reconciliation with who looked and what they wrote", detail.reconciliations.length === 2 && detail.reconciliations[0].note === "integration test: looked again" && detail.live?.status === "matched" && !detail.superseded);
  const cert1 = await C.getCertainty(`${year}-05-01`, `${year}-05-31`);
  check("the money of a matched period is CONFIRMED, not estimated", near(cert1.by_provider.openai.confirmed_usd, 1.5) && near(cert1.by_provider.openai.estimated_usd, 0) && cert1.confirmed_by.some((c) => c.statement_id === sid), cert1.by_provider);
  const wrong = await C.addStatement({ provider: "openai", period_start: `${year}-05-01`, period_end: `${year}-05-31`, billed_usd: 3.0, reference: "ITEST-2", source: "integration test: a correction that does not agree", supersedes_id: sid, billed_input_tokens: 4000, billed_output_tokens: 400 });
  check("a correction that does not agree is judged on its own figure: the bill is higher than recorded, and the tokens say the prices are not the cause", wrong.reconciliation.status === "under_recorded" && wrong.reconciliation.explanation.some((e) => /not attributed/.test(e)) && wrong.reconciliation.explanation.some((e) => /token totals agree/.test(e)), wrong.reconciliation.explanation);
  const listed = await C.listStatements("openai");
  check("the replaced bill is marked replaced and has no live result; the new one has", listed.statements.find((s) => s.id === sid)?.superseded === true && listed.statements.find((s) => s.id === sid)?.live === null && listed.statements.find((s) => s.id === wrong.statement.id)?.live?.status === "under_recorded");
  check("a replaced bill cannot be reconciled again", !!(await rejection(() => C.reconcileStatement(sid))));
  const cert2 = await C.getCertainty(`${year}-05-01`, `${year}-05-31`);
  check("with the correction not matching, the same money falls back to estimated", near(cert2.by_provider.openai.confirmed_usd, 0) && near(cert2.by_provider.openai.estimated_usd, 1.5), cert2.by_provider);
  const stmtHtml = text(html(createElement(StatementsView, { statements: listed.statements, scopeNote: listed.scope_note, certainty: cert2, fmt: usd, onOpen: () => undefined, onAdd: () => undefined })));
  check("the bills page shows the scope note, the replaced bill, the result and the certainty split", stmtHtml.includes("API key or project that evaluations use") && stmtHtml.includes("replaced") && stmtHtml.includes("Bill is higher than recorded") && stmtHtml.includes("Confirmed") && stmtHtml.includes("ITEST-2"), stmtHtml.slice(0, 400));
  const wd = await C.getStatement(wrong.statement.id);
  const detHtml = text(html(createElement(StatementDetailView, { d: wd, live: wd.live, fmt: usd })));
  check("the bill's detail explains the gap, compares the tokens and lists the biggest runs", detHtml.includes("not attributed") && detHtml.includes("Provider counted") && detHtml.includes("agree") && detHtml.includes("Every time it was reconciled"), detHtml.slice(0, 400));
  const fixed = await C.addStatement({ provider: "openai", period_start: `${year}-05-01`, period_end: `${year}-05-31`, billed_usd: 1.5, reference: "ITEST-3", source: "integration test: final figure", supersedes_id: wrong.statement.id });
  check("the final correction matches again", fixed.reconciliation.status === "matched" && near((await C.getCertainty(`${year}-05-01`, `${year}-05-31`)).by_provider.openai.confirmed_usd, 1.5));

  // ── a provider usage export ───────────────────────────────────────────────────────────────────────────────────────────
  const csv = `date,model,input_tokens,output_tokens,cost\n${year}-06-01,gpt-4.1-2025-04-14,1000,100,2.00\n${year}-06-02,gpt-4o-mini,10,1,0.40\nnot a date,gpt-4.1,1,1,9\n`;
  const unreadable = await rejection(() => C.previewStatementFile("openai", "x.csv", "a,b\n1,2\n"));
  check("an export with no date column is refused, and the reason names the columns found", !!unreadable && /date column/i.test(unreadable) && unreadable.includes("a, b"), unreadable);
  const pv = await C.previewStatementFile("openai", "june.csv", csv);
  check("an export is read: its period, the billed total, the tokens, the columns used, and the row it could not read (counted, not guessed)", pv.period_start === `${year}-06-01` && near(pv.billed_usd, 2.4) && pv.tokens!.input === 1010 && pv.columns.usd === "cost" && pv.skipped_count === 1 && pv.rows_used === 2, pv);
  check("it says which days were billed with nothing recorded", pv.gap.days_billed_not_recorded.join() === `${year}-06-01,${year}-06-02` && pv.recorded_usd === 0, pv.gap);
  const sumHtml = text(html(createElement(ImportSummary, { p: pv })));
  check("the import summary shows the file, the rows read, the total, the columns, the warning for the skipped row and the days with nothing recorded", sumHtml.includes("june.csv") && sumHtml.includes("2 of 3 rows read") && sumHtml.includes("$2.40") && sumHtml.includes("cost") && sumHtml.includes("could not be read and were left out") && sumHtml.includes("billed, nothing recorded"), sumHtml.slice(0, 400));
  const saved = await C.addStatement({ provider: "openai", period_start: pv.period_start, period_end: pv.period_end, billed_usd: pv.billed_usd!, source: "integration test: uploaded june.csv", usage_detail: { by_day: pv.by_day, by_model: pv.by_model, filename: "june.csv" } });
  const sd = await C.getStatement(saved.statement.id);
  check("the saved bill keeps its export, and its detail shows where the difference is", sd.live?.gap?.days_billed_not_recorded.length === 2 && !!sd.live?.gap?.largest_models.length, sd.live?.gap);
  const detailHtml = text(html(createElement(StatementDetailView, { d: sd, live: sd.live, fmt: usd })));
  check("the bill's detail page has the 'where the difference is' section with the day and model tables", detailHtml.includes("Where the difference is") && detailHtml.includes("Day with the biggest gaps") && detailHtml.includes("Model with the biggest gaps"), detailHtml.slice(0, 300));
  check("a bill typed by hand has no such section, rather than an empty one", !text(html(createElement(StatementDetailView, { d: await C.getStatement(first.statement.id), live: null, fmt: usd }))).includes("Where the difference is"));

  // ── models, spending, findings ────────────────────────────────────────────────────────────────────────────────────
  const cmp = await C.getModelComparison({ dataset });
  const set1 = cmp.sets[0];
  const g = Object.fromEntries(set1.models.map((m) => [m.model, m]));
  check("the comparison has one set with both models, cheapest per passed test first", cmp.sets.length === 1 && set1.models.length === 2 && set1.models[0].model === "openai/gpt-4o-mini" && near(g["openai/gpt-4.1"].per_passed_usd, 1.0 / 36) && near(g["openai/gpt-4o-mini"].per_passed_usd, 0.5 / 45), set1.models.map((m) => [m.model, m.per_passed_usd]));
  check("quality comes with its interval, reliability, latency and error rate", g["openai/gpt-4.1"].ci_low! < 0.9 && g["openai/gpt-4.1"].ci_high! > 0.9 && g["openai/gpt-4.1"].latency_p50_ms !== null && g["openai/gpt-4.1"].error_rate !== null && g["openai/gpt-4o-mini"].on_frontier === true && g["openai/gpt-4.1"].on_frontier === false);
  check("the cheaper model that cannot be told apart is recommended with its saving", set1.recommendations.some((r) => r.kind === "cheaper_equivalent" && r.title.includes("gpt-4o-mini") && (r.estimated_saving_usd ?? 0) > 0), set1.recommendations);
  const mHtml = text(html(createElement(ModelsView, { data: cmp, fmt: usd, index: 0, onIndex: () => undefined, synthetic: false, onSynthetic: () => undefined })));
  check("the cost-versus-quality page shows both models, their pass rates and the advice", mHtml.includes("openai/gpt-4o-mini") && mHtml.includes("openai/gpt-4.1") && mHtml.includes("90.0%") && mHtml.includes("on the frontier") && mHtml.includes("comparable results") && mHtml.includes("Quality against cost"), mHtml.slice(0, 500));
  const spend = await C.getBenchmarkSpending(bench);
  check("the benchmark's spending is its models' runs added up, split by what the money paid for", spend.count === 1 && near(spend.benchmarks[0].total_usd, 1.5) && near(spend.benchmarks[0].by_component.judge, 0.4) && spend.benchmarks[0].models.length === 2, spend.benchmarks);
  const bHtml = text(html(createElement(BenchmarkCostView, { spend: spend.benchmarks[0] })));
  check("the benchmark page's cost card shows the total, each model's cost per passed test and a link to the costs page", bHtml.includes("What this benchmark cost") && bHtml.includes("$1.50") && bHtml.includes("openai/gpt-4o-mini") && html(createElement(BenchmarkCostView, { spend: spend.benchmarks[0] })).includes("/super-admin/evaluation?mode=investigate"), bHtml.slice(0, 300));
  const tr = await C.getTrends({ from: `${year}-05-01`, to: `${year}-05-31`, group_by: "component" });
  const day10 = tr.points.find((p) => p.start === `${year}-05-10`)!;
  check("trends: every day of the window, the money on the day it was incurred, split by what it paid for", tr.points.length === 31 && near(tr.total_usd, 1.5) && near(day10.total_usd, 1.5) && near(day10.by_group.judge, 0.4) && near(day10.by_group.agent_llm, 1.1) && tr.groups.join() === "agent_llm,judge", day10);
  const anomalies = await C.getAnomalies(`${year}-05-01`, `${year}-05-31`);
  const advice = await C.getRecommendations(`${year}-05-01`, `${year}-05-31`);
  check("findings and advice come with their rules, evidence and principle", anomalies.checked.runs >= 2 && "run_cost" in anomalies.rules && advice.count === advice.recommendations.length && advice.principle.includes("Nothing here changes"));
  const iHtml = text(html(createElement(InsightsView, { anomalies, advice, fmt: usd })));
  check("the findings page shows the rules and the advice, and never claims what the numbers do not support", iHtml.includes("How each finding is decided") && iHtml.includes("Advice") && iHtml.includes("Nothing here changes"), iHtml.slice(0, 300));

  // ── the overview ─────────────────────────────────────────────────────────────────────────────────────────────────
  const ov = await C.getCostOverview(ccy);
  check("the overview carries every block, and says which rate it used", ["budget", "month", "trend", "running", "statements", "attribution", "anomalies", "recommendations"].every((k) => k in ov) && ov.rate?.currency === ccy && ov.trend.points.length === 30, Object.keys(ov));
  const oHtml = text(html(createElement(OverviewView, { data: ov, currency: ccy, fmt: C.formatter(ccy, ov.rate), onGo: () => undefined })));
  check("the overview page reads out the month, the certainty split, the budgets and the cards, in the second currency with its rate", oHtml.includes("Spent this month") && oHtml.includes("Confirmed by a provider bill") && oHtml.includes("Budgets") && oHtml.includes("Provider bills") && oHtml.includes("Attribution check") && oHtml.includes(`1 USD = ${ov.rate!.units_per_usd}`) && oHtml.includes(ccy), oHtml.slice(0, 500));
  const usdHtml = text(html(createElement(OverviewView, { data: await C.getCostOverview(), currency: "USD", fmt: usd, onGo: () => undefined })));
  check("in dollars there is no rate note", !usdHtml.includes("1 USD =") && usdHtml.includes("$"));
  check("the benchmark cost card renders nothing until its data arrives (no flash of a wrong number)", html(createElement(BenchmarkCostCard, { benchmarkId: bench })) === "");
}

async function reads(): Promise<void> {
  api.defaults.headers.common["Authorization"] = `Bearer ${process.env.COSTS_TOKEN}`;
  const jobsBefore = (await api.get<unknown[]>("/eval/jobs", { params: { limit: 200 } })).data.length;
  const ov = await C.getCostOverview();
  const month = await C.getTrends({ from: ov.month.from, to: ov.month.to, group_by: "component" });
  check("the month's total in the overview is the sum of the days of the trend, and its components add up to it", near(ov.month.total_usd, month.total_usd) && near(Object.values(ov.month.by_component).reduce((a, b) => a + b, 0), ov.month.total_usd), [ov.month.total_usd, month.total_usd]);
  const all = await C.listLines({ from: ov.month.from, to: ov.month.to, limit: 1000 });
  check("the usage records of the month add up to the same money (the overview's total includes no scripted model)", near(all.usd, ov.month.total_usd) || all.usd >= ov.month.total_usd, [all.usd, ov.month.total_usd]);
  check("every real run accounts for its spending exactly", ov.attribution.checked > 0 && ov.attribution.with_problems === 0, ov.attribution);
  check("the certainty split adds up to the month", near(ov.month.certainty.confirmed_usd + ov.month.certainty.estimated_usd, ov.month.certainty.total_usd));
  const cmp = await C.getModelComparison({ dataset: "individual-single-turn", version: "1.0.6", mode: "agent" });
  const set1 = cmp.sets[0];
  const labels = set1?.models.map((m) => m.model) ?? [];
  check("on the real runs both GPT models are compared on the published dataset, each with a known cost per passed test", labels.includes("openai/gpt-4o-mini") && labels.includes("openai/gpt-4.1") && set1.models.every((m) => m.per_passed_usd !== null && m.pass_rate !== null), set1?.models.map((m) => [m.model, m.per_passed_usd]));
  const mini = set1.models.find((m) => m.model === "openai/gpt-4o-mini")!, big = set1.models.find((m) => m.model === "openai/gpt-4.1")!;
  check("the cheaper model costs less per passed test than the dearer one on these runs", (mini.per_passed_usd as number) < (big.per_passed_usd as number), [mini.per_passed_usd, big.per_passed_usd]);
  const html1 = text(html(createElement(ModelsView, { data: cmp, fmt: usd, index: 0, onIndex: () => undefined, synthetic: false, onSynthetic: () => undefined })));
  check("the page renders the real comparison", html1.includes("openai/gpt-4o-mini") && html1.includes("openai/gpt-4.1") && html1.includes("Cost per passed test"), html1.slice(0, 300));
  const oHtml = text(html(createElement(OverviewView, { data: ov, currency: "USD", fmt: usd, onGo: () => undefined })));
  check("the overview page renders the real month", oHtml.includes("Spent this month") && oHtml.includes(usd(ov.month.total_usd)), oHtml.slice(0, 300));

  // the cost preview with the budget: what the benchmark setup page shows before anything is spent
  const req = { dataset: "individual-single-turn", version: "1.0.6", kind: "benchmark_agent" as const, models: ["openai/gpt-4o-mini", "openai/gpt-4.1"], repeat: "1", judge: "openai/gpt-4o" };
  const preview = await C.previewWithBudget(req);
  check("the preview returns the estimate (a total over both models and the judge) and what it would do to the budgets", !!preview.estimate.cost && (preview.estimate.cost.usd.total ?? 0) > 0 && !!preview.budget.periods.day && !!preview.budget.periods.month, preview.budget);
  check("each period says what the run would project to", preview.budget.periods.day.estimate_usd !== null && near(preview.budget.periods.day.projected_usd, preview.budget.periods.day.spent_usd + preview.budget.periods.day.reserved_usd + (preview.budget.periods.day.estimate_usd as number)));
  const bad = await rejection(() => C.previewWithBudget({ ...req, models: ["openai/not-a-registered-model", "openai/gpt-4.1"] }));
  check("a request the backend would refuse is refused in the preview, with the reasons", !!bad && /registry|register/i.test(bad), bad);
  const jobsAfter = (await api.get<unknown[]>("/eval/jobs", { params: { limit: 200 } })).data.length;
  check("a preview schedules nothing", jobsAfter === jobsBefore, [jobsBefore, jobsAfter]);
  const recs = await C.getRecommendations();
  check("the real advice names the cheaper model, with its evidence and caveats", recs.recommendations.some((r) => r.kind === "cheaper_equivalent" && r.title.includes("gpt-4o-mini") && !!r.evidence && (r.caveats ?? []).length > 0), recs.recommendations.map((r) => r.title));
  const st = await C.listStatements();
  check("the bills list answers (it may be empty until a real provider bill is entered)", Array.isArray(st.statements) && st.scope_note.includes("API key or project"));
}

async function main(): Promise<number> {
  if (process.env.COSTS_SUITE === "reads") await reads(); else await writes();
  console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(2); });
