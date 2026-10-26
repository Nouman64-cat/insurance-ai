"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import SetupSteps from "./SetupSteps";
import { COPY, ORDER, canAdvance, nextOf, prevOf, setupSteps, type StepId } from "@/lib/setupSteps";
import { tx } from "@/lib/i18n/tx";
import { show, previewWithBudget, type BudgetStatus } from "@/lib/evalCosts";
import {
  METRICS, PROVIDER_NAME, REPETITION_CHOICES, buildRequest, formProblems, getDataset, listDatasets, listModels, providerOf, startJob, tokens, usd,
  type BenchmarkForm, type CostEstimate, type DatasetDetail, type DatasetSummary, type Job, type Metric, type ModelEntry,
} from "@/lib/evalBenchmarks";

// The run builder. One decision per section, in the order a person thinks about it: WHO is compared, on WHAT, HOW, and (optionally) how it is judged and limited.
// Every choice is summarised in the header of its section, so a finished section can be closed and still be read. A sticky summary on the right (a bar at the bottom on
// small screens) always shows what will run, what it will cost, what it does to the budgets, what is still missing, and the one button that starts it.

const inputCls = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 dark:border-slate-700 dark:bg-slate-900 dark:focus:ring-blue-900";
const labelCls = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500";
const chip = (on: boolean) => `rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${on ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-sky-200" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"}`;
const seg = (on: boolean) => `flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${on ? "bg-white text-blue-700 shadow-sm dark:bg-slate-700 dark:text-sky-200" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"}`;
const ghost = "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-blue-400 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300";

const METRIC_HELP: Record<Metric, string> = {
  correctness: "Is the answer right against the expected outcome?",
  faithfulness: "Does it stay within the reference information?",
  relevance: "Does it answer what was asked?",
  hallucination: "Does it contradict or invent facts?",
  task_completion: "Did the agent do the whole task?",
  safety: "Does it refuse what it must refuse?",
  custom: "The case's own criterion.",
};

export const EMPTY: BenchmarkForm = { dataset: "", version: "", mode: "agent", models: [], repetitions: 3, judge: "", metrics: [], stages: [], temperature: "0", budget: "2", stopOnCritical: false, allowSameJudge: false, skills: "default", maxLatencyMs: "", maxTokens: "", maxCostUsd: "", gate: false, gateMinPassPct: "90" };

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className={`flex items-start gap-2 text-[11px] ${ok ? "text-slate-500" : "font-semibold text-slate-800 dark:text-slate-100"}`}>
      <span className={`mt-px inline-flex h-4 w-4 flex-none items-center justify-center rounded-full border text-[10px] ${ok ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-300 text-transparent"}`} aria-hidden>✓</span>
      <span><span className="sr-only">{ok ? tx("done: ") : tx("still needed: ")}</span>{children}</span>
    </li>
  );
}

export default function SetupPanel({ onStarted, initialDataset, initialProvider, initialForm, onForm, aside }: {
  onStarted: (job: Job) => void; initialDataset?: string; initialProvider?: string; initialForm?: Partial<BenchmarkForm> | null; onForm?: (form: BenchmarkForm) => void; aside?: ReactNode;
}) {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [detail, setDetail] = useState<DatasetDetail | null>(null);
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [form, setForm] = useState<BenchmarkForm>(EMPTY);
  const [custom, setCustom] = useState("");
  const [preview, setPreview] = useState<{ cost?: CostEstimate; executions: number | null; budget?: BudgetStatus } | null>(null);
  const [refused, setRefused] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<StepId>("models");                                  // the step that is open; every step can be opened from the pipeline at the top
  const [visited, setVisited] = useState<Set<StepId>>(new Set<StepId>(["models"]));
  const panelRef = useRef<HTMLElement | null>(null);
  const seq = useRef(0);
  const applied = useRef(false);
  const restore = useRef<Partial<BenchmarkForm> | null>(initialForm ?? null);          // a form brought back from the address or the saved draft, applied once the dataset has loaded

  useEffect(() => {
    (async () => {
      try {
        const [ds, ms] = await Promise.all([listDatasets(), listModels()]);
        const usable = ds.filter((d) => d.latest_version);
        setDatasets(usable);
        setModels(ms);
        const wanted = usable.find((d) => d.slug === initialDataset) ?? usable.find((d) => d.slug.includes("single")) ?? usable[0];
        if (wanted) {
          const back = restore.current;
          // the saved choices are applied as they were; the dataset-dependent ones (version, stages) are checked against the dataset in the next effect
          setForm((f) => ({ ...f, ...(back ?? {}), dataset: wanted.slug }));
          if (back?.repetitions && !(REPETITION_CHOICES as readonly number[]).includes(back.repetitions)) setCustom(String(back.repetitions));
        }
      } catch (e) {
        setModels([]);
        setError(e instanceof Error ? e.message : "Could not load datasets and models.");
      }
    })();
  }, [initialDataset]);

  useEffect(() => {
    if (!form.dataset) return;
    getDataset(form.dataset)
      .then((d) => {
        setDetail(d);
        const published = d.versions.filter((v) => v.state === "published");
        const back = restore.current;
        restore.current = null;
        const fallback = published.find((v) => v.version === d.latest_version)?.version ?? published[published.length - 1]?.version ?? "";
        // a saved version is kept only if it is still published, and saved stages only if the dataset still has them
        const version = back?.version && published.some((v) => v.version === back.version) ? back.version : fallback;
        setForm((f) => ({ ...f, version, stages: back?.stages && version === back.version ? back.stages : [] }));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the dataset."));
  }, [form.dataset]);

  useEffect(() => { onForm?.(form); }, [form]);                       // eslint-disable-line react-hooks/exhaustive-deps

  const candidates = useMemo(() => (models ?? []).filter((m) => m.status === "active" && m.roles.includes("candidate")), [models]);
  const judges = useMemo(() => (models ?? []).filter((m) => m.status === "active" && m.roles.includes("judge")), [models]);
  const real = useMemo(() => candidates.filter((m) => !m.synthetic), [candidates]);
  const scripted = useMemo(() => candidates.filter((m) => m.synthetic), [candidates]);
  const byProvider = useMemo(() => {
    const out: Record<string, ModelEntry[]> = {};
    real.forEach((m) => (out[m.provider] ||= []).push(m));
    return out;
  }, [real]);

  // a link that names a provider (the map's node) starts with that provider's models chosen, once
  useEffect(() => {
    if (applied.current || !initialProvider || !models) return;
    applied.current = true;
    const mine = candidates.filter((m) => m.provider === initialProvider).map((m) => m.label);
    if (mine.length > 0) setForm((f) => ({ ...f, models: mine.slice(0, 4) }));
  }, [models, candidates, initialProvider]);

  const problems = formProblems(form);
  const request = useMemo(() => (problems.length === 0 ? buildRequest(form) : null), [form, problems.length]);

  // The preview follows the form: every change asks the backend again (the same checks as a real start), after a short pause.
  useEffect(() => {
    setPreview(null);
    setRefused([]);
    if (!request) return;
    const mine = ++seq.current;
    setPreviewing(true);
    const timer = setTimeout(async () => {
      try {
        const e = await previewWithBudget(request);
        if (mine === seq.current) setPreview({ cost: e.estimate.cost, executions: e.estimate.executions, budget: e.budget });
      } catch (err) {
        if (mine === seq.current) setRefused([err instanceof Error ? err.message : "The request was refused."]);
      } finally {
        if (mine === seq.current) setPreviewing(false);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [request]);

  const set = <K extends keyof BenchmarkForm>(k: K, v: BenchmarkForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = <K extends "models" | "metrics" | "stages">(k: K, v: string) =>
    setForm((f) => ({ ...f, [k]: (f[k] as string[]).includes(v) ? (f[k] as string[]).filter((x) => x !== v) : [...(f[k] as string[]), v] }) as BenchmarkForm);

  // presets: a starting point from what the registry really has, never a made-up model
  const cheapest = useMemo(() => real.filter((m) => m.current_price).sort((a, b) => (a.current_price!.output_per_m + a.current_price!.input_per_m) - (b.current_price!.output_per_m + b.current_price!.input_per_m)).slice(0, 2), [real]);
  const realJudge = judges.find((j) => !j.synthetic && !cheapest.some((c) => c.label === j.label));
  const freeJudge = judges.find((j) => j.synthetic);
  const presets = [
    { id: "free", badge: "FREE · about a minute", label: "Free dry run", hint: "Two scripted models on isolated fixtures. Checks that everything is wired up and spends nothing. The results say nothing about real models.", ok: scripted.length >= 2,
      apply: () => { setCustom(""); setForm((f) => ({ ...f, models: scripted.slice(0, 2).map((m) => m.label), judge: freeJudge?.label ?? "", metrics: [], repetitions: 1, mode: "agent", budget: "1", stages: [] })); } },
    { id: "real", badge: "SPENDS MONEY · recommended", label: "Compare two real models", hint: "The two lowest-priced real models in the registry, three repetitions, judged by another model. Check the cost estimate before you start.", ok: cheapest.length >= 2,
      apply: () => { setCustom(""); setForm((f) => ({ ...f, models: cheapest.map((m) => m.label), judge: realJudge?.label ?? "", metrics: [], repetitions: 3, mode: "agent", budget: "2", stages: [] })); } },
  ];
  const applyPreset = (p: (typeof presets)[number]) => { p.apply(); setVisited(new Set<StepId>(ORDER)); setStep("review"); };
  const clear = () => { setCustom(""); setForm((f) => ({ ...EMPTY, dataset: f.dataset, version: f.version })); };

  const cost = preview?.cost;
  const usesMoney = form.models.some((m) => !m.startsWith("mock/"));
  const budgetRefuses = preview?.budget ? !preview.budget.allowed : false;
  const accepted = !!request && !!cost && !cost.error && !previewing && refused.length === 0;
  const canStart = accepted && !starting && !budgetRefuses;
  const modelsOk = form.models.length >= 2, scopeOk = !!form.dataset && !!form.version;
  const otherProblems = problems.filter((p) => !/two models|published dataset/i.test(p));
  const judgeSummary = form.judge ? `${form.judge}${form.metrics.length ? ` · ${form.metrics.length} ${tx("metrics")}` : ""}` : tx("no judge: rule checks only");
  const cases = cost ? cost.model_backed_cases : null;
  const executions = cost && cases !== null ? cases * cost.repetitions * Math.max(form.models.length, 1) : null;

  const why = !modelsOk ? tx("Choose at least two models to compare.") : !scopeOk ? tx("Choose a published dataset version.") : otherProblems[0] ? tx(otherProblems[0]) : previewing ? tx("Checking the request with the backend…")
    : refused[0] ? refused[0] : cost?.error ? cost.error : budgetRefuses ? tx("A spending limit would refuse this run.") : starting ? tx("Starting…") : null;

  const steps = setupSteps(form, { current: step, visited, problems, ready: canStart });
  const goTo = (id: StepId) => {
    setStep(id);
    setVisited((v) => new Set(v).add(id));
    setTimeout(() => panelRef.current?.scrollIntoView({ block: "nearest", behavior: typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }), 30);
  };

  async function start() {
    if (!request) return;
    setStarting(true);
    setError(null);
    try {
      const job = await startJob(request);
      setConfirm(false);
      onStarted(job);
    } catch (e) {
      setConfirm(false);
      setError(e instanceof Error ? e.message : "Could not start the benchmark.");
    } finally {
      setStarting(false);
    }
  }
  const press = () => (usesMoney ? setConfirm(true) : start());
  const startLabel = starting ? tx("Starting…") : usesMoney ? `${tx("Start real run")}${cost && !cost.error ? ` · ${tx("up to")} ${usd(cost.usd.total)}` : ""}` : tx("Start free simulation");

  const summary = (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900" aria-live="polite" data-testid="run-summary">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-slate-900 dark:text-slate-50">{tx("This run")}</h2>
        {form.models.length > 0 && (
          <span data-testid="run-mode" data-mode={usesMoney ? "real" : "simulation"} className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${usesMoney ? "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200" : "border-sky-300 bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200"}`}>
            {usesMoney ? tx("REAL · spends money") : tx("FREE SIMULATION")}
          </span>
        )}
      </div>

      {form.models.length === 0 ? <p className="text-xs text-slate-400">{tx("Pick the models to compare. Everything that follows adapts to them.")}</p> : (
        <div className="flex flex-wrap gap-1.5">{form.models.map((m) => <span key={m} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">{m.split("/")[1]}<button type="button" onClick={() => toggle("models", m)} className="text-slate-400 hover:text-red-500" aria-label={`${tx("Remove")} ${m}`}>×</button></span>)}</div>
      )}

      <p className="text-[11px] leading-relaxed text-slate-500">
        {form.dataset ? <>{form.dataset} <b>{form.version}</b> · {form.stages.length === 0 ? tx("all stages") : `${form.stages.length} ${tx("stages")}`} · {form.mode === "agent" ? tx("through the real agent") : tx("bare model")} · {form.repetitions}× </> : null}
        {executions !== null && <>→ <b className="text-slate-800 dark:text-slate-100">{cases}</b> {tx("cases")} × {cost!.repetitions} × {form.models.length} {tx("models")} = <b className="text-slate-800 dark:text-slate-100">{executions}</b> {tx("executions")}{cost!.judged_criteria_per_pass > 0 && form.judge ? `, ${cost!.judged_criteria_per_pass * cost!.repetitions * form.models.length} ${tx("judge calls")}` : ""}</>}
      </p>

      <div className="rounded-lg bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{tx("Estimated cost")}</span>
          <span className="text-xl font-bold text-blue-700 dark:text-sky-300" data-testid="estimate-total">{cost && !cost.error ? `${usd(cost.usd.total)}${cost.usd.complete ? "" : "+"}` : previewing ? "…" : "—"}</span>
        </div>
        {cost && !cost.error && <p className="mt-0.5 text-[10px] text-slate-400">{tx(cost.note)}</p>}
        {!cost && !previewing && <p className={`mt-0.5 text-[10px] ${problems[0] ? "font-semibold text-amber-700 dark:text-amber-300" : "text-slate-400"}`} data-testid="estimate-waiting">{problems[0] ? `${tx("No estimate yet:")} ${tx(problems[0])}` : tx("Appears when the request is complete.")}</p>}
        {cost && !cost.error && (
          <details className="mt-2 text-[11px]">
            <summary className="cursor-pointer font-semibold text-slate-600 dark:text-slate-300">{tx("Where it comes from")}</summary>
            <table className="mt-1.5 w-full">
              <tbody>
                {cost.models.map((m) => <tr key={m.model} className="border-t border-slate-200 dark:border-slate-700" title={m.basis}><td className="py-1 text-slate-700 dark:text-slate-200">{m.model}<span className="block text-[10px] text-slate-400">{m.basis}</span></td><td className="text-right text-slate-500">{tokens(m.input_tokens)} / {tokens(m.output_tokens)}</td><td className="text-right font-semibold">{usd(m.usd)}</td></tr>)}
                <tr className="border-t border-slate-200 dark:border-slate-700" title={cost.judge.basis}><td className="py-1 text-slate-700 dark:text-slate-200">{tx("Judge")}: {cost.judge.model ?? tx("none")}<span className="block text-[10px] text-slate-400">{cost.judge.basis}</span></td><td className="text-right text-slate-500">{tokens(cost.judge.input_tokens)} / {tokens(cost.judge.output_tokens)}</td><td className="text-right font-semibold">{usd(cost.judge.usd)}</td></tr>
              </tbody>
            </table>
          </details>
        )}
        {cost?.warnings.map((w) => <p key={w} className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">{w}</p>)}
      </div>

      {preview?.budget && (
        <div className="space-y-1.5" data-testid="budget-impact">
          {(["day", "month"] as const).map((k) => { const p = preview.budget!.periods[k]; return p.limit_usd === null ? null : (
            <div key={k} className={`rounded-lg border px-2.5 py-2 text-[11px] ${p.status === "exceeded" ? "border-red-200 bg-red-50 text-red-700" : p.status === "warning" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300"}`}>
              <b>{k === "day" ? tx("Today's limit") : tx("This month's limit")}</b> {show(p.limit_usd)}: {show(p.spent_usd)} {tx("spent")}{p.reserved_usd > 0 ? ` + ${show(p.reserved_usd)} ${tx("reserved")}` : ""} → {show(p.projected_usd)}{p.used_pct === null ? "" : ` (${Math.round(p.used_pct)}%)`}
              {p.status === "exceeded" ? ` · ${p.enforce ? tx("this run would be refused") : tx("passing it only warns")}` : p.status === "warning" ? ` · ${tx("close to the limit")}` : ""}
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200/70"><div className={`h-full ${p.status === "exceeded" ? "bg-red-500" : p.status === "warning" ? "bg-amber-500" : "bg-blue-500"}`} style={{ width: `${Math.min(100, p.used_pct ?? 0)}%` }} /></div>
            </div>); })}
          {preview.budget.periods.day.limit_usd === null && preview.budget.periods.month.limit_usd === null && <p className="text-[10px] text-slate-400">{tx("No spending limit is set.")} <Link className="underline" href="/super-admin/evaluation?tool=costs&view=budgets">{tx("Set one")}</Link></p>}
          {budgetRefuses && <p className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700">{preview.budget.messages.join(" ")} <Link className="underline" href="/super-admin/evaluation?tool=costs&view=budgets">{tx("Change the limits")}</Link></p>}
        </div>
      )}

      <ul className="space-y-1.5 border-t border-slate-100 pt-3 dark:border-slate-800" aria-label={tx("Ready to start?")} data-testid="checklist">
        <Check ok={modelsOk}>{tx("Two or more models chosen")}</Check>
        <Check ok={scopeOk}>{tx("A published dataset version chosen")}</Check>
        <Check ok={otherProblems.length === 0 && modelsOk && scopeOk}>{tx("Settings are valid")}</Check>
        <Check ok={accepted}>{tx("The backend accepted the request")}</Check>
        <Check ok={!!preview?.budget && !budgetRefuses}>{tx("Within the spending limits")}</Check>
      </ul>

      <button type="button" onClick={press} disabled={!canStart} data-testid="start-run"
        className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 dark:disabled:bg-slate-800">
        {startLabel}
      </button>
      {!canStart && why && <p className="text-center text-[11px] text-slate-500" data-testid="why-disabled">{why}</p>}
      {refused.length > 0 && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700" role="alert">{refused.map((r) => <p key={r}>{r}</p>)}</div>}
    </div>
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
      <div className="min-w-0 space-y-4 pb-24 lg:pb-0">
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600" role="alert">{error}</div>}

        <SetupSteps steps={steps} onGo={goTo} />

        {step === "models" && (
          <section aria-label={tx("Start from a template")} className="space-y-2" data-testid="presets">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-extrabold text-slate-900 dark:text-slate-50">{tx("Start from a template")} <span className="font-normal text-slate-400">{tx("or build your own below")}</span></h2>
              {(form.models.length > 0 || form.stages.length > 0 || form.judge) && <button type="button" onClick={clear} className="text-[11px] font-semibold text-slate-500 underline hover:text-slate-800">{tx("Start over")}</button>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {presets.map((p) => (
                <button key={p.id} type="button" disabled={!p.ok || !models} onClick={() => applyPreset(p)} data-preset={p.id} title={p.ok ? undefined : tx("Not enough models in the registry for this")}
                  className="rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ${p.id === "free" ? "bg-sky-50 text-sky-700" : "bg-amber-50 text-amber-800"}`}>{tx(p.badge)}</span>
                  <b className="mt-1.5 block text-sm font-extrabold text-slate-900 dark:text-slate-50">{tx(p.label)}</b>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{tx(p.hint)}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <section ref={panelRef} className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900" data-testid={`sec-${step === "questions" ? "scope" : step}`} data-step-panel={step} aria-label={tx(COPY[step].label)}>
          <header className="border-b border-slate-100 px-5 py-4 dark:border-slate-800">
            <p className="text-[11px] font-bold uppercase tracking-wide text-blue-700 dark:text-sky-300">{tx("Step")} {ORDER.indexOf(step) + 1} {tx("of")} {ORDER.length}{COPY[step].optional ? ` · ${tx("optional")}` : ""}</p>
            <h2 className="mt-0.5 text-lg font-extrabold text-slate-900 dark:text-slate-50">{tx(COPY[step].question)}</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">{tx(COPY[step].help)}</p>
          </header>

          <div className="space-y-5 px-5 py-5">
            {step === "models" && (
              <>
                {!models ? (
                  <div className="grid gap-2 sm:grid-cols-2" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />)}</div>
                ) : candidates.length === 0 ? <p className="text-xs text-slate-500">{tx("No model is registered as a candidate. Register one under Model registry first.")}</p> : (
                  <>
                    {Object.entries(byProvider).map(([provider, list]) => (
                      <div key={provider}>
                        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold text-slate-500"><span>{PROVIDER_NAME[provider] ?? provider}</span><span className="rounded bg-amber-50 px-1.5 py-px text-[9px] font-bold text-amber-700">{tx("spends money")}</span></div>
                        <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={PROVIDER_NAME[provider] ?? provider}>
                          {list.map((m) => <ModelCard key={m.label} m={m} on={form.models.includes(m.label)} onToggle={() => toggle("models", m.label)} />)}
                        </div>
                      </div>
                    ))}
                    {scripted.length > 0 && (
                      <div>
                        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold text-slate-500"><span>{tx("Scripted stand-ins")}</span><span className="rounded bg-sky-50 px-1.5 py-px text-[9px] font-bold text-sky-700">{tx("free")}</span></div>
                        <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label={tx("Scripted stand-ins")}>
                          {scripted.map((m) => <ModelCard key={m.label} m={m} on={form.models.includes(m.label)} onToggle={() => toggle("models", m.label)} />)}
                        </div>
                      </div>
                    )}
                    {form.models.some((m) => m.startsWith("mock/")) && form.models.some((m) => !m.startsWith("mock/")) && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">{tx("A scripted model next to a real one is not a quality comparison: scripted models are hard-coded stand-ins, so their results say nothing about a real model.")}</p>}
                  </>
                )}
              </>
            )}

            {step === "questions" && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelCls} htmlFor="bm-dataset">{tx("Test set")}</label>
                    <select id="bm-dataset" className={inputCls} value={form.dataset} onChange={(e) => set("dataset", e.target.value)}>
                      {datasets.length === 0 && <option value="">{tx("loading…")}</option>}
                      {datasets.map((d) => <option key={d.slug} value={d.slug}>{d.name} ({d.turn_mode.replace("_", " ")})</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls} htmlFor="bm-version">{tx("Published version")}</label>
                    <select id="bm-version" className={inputCls} value={form.version} onChange={(e) => set("version", e.target.value)}>
                      {(detail?.versions ?? []).filter((v) => v.state === "published").map((v) => <option key={v.version} value={v.version}>{v.version} · {v.case_count} {tx("cases")}{v.provisional ? ` · ${tx("provisional")}` : ""}</option>)}
                    </select>
                    <p className="mt-1 text-[10px] text-slate-400">{tx("Only a published version is frozen, so only it can be run.")}</p>
                  </div>
                </div>
                <details className="rounded-lg border border-slate-200 dark:border-slate-700" open={form.stages.length > 0}>
                  <summary className="cursor-pointer select-none px-3 py-2.5 text-xs font-bold text-slate-700 dark:text-slate-200">{tx("Run only some stages")} <span className="font-normal text-slate-400">({form.stages.length === 0 ? tx("all stages are run") : `${form.stages.length} ${tx("chosen")}`})</span></summary>
                  <div className="space-y-2 border-t border-slate-100 px-3 py-3 dark:border-slate-800">
                    <div className="flex flex-wrap gap-1.5">
                      {(detail?.facets.category ?? []).map((c) => <button key={c} type="button" aria-pressed={form.stages.includes(c)} onClick={() => toggle("stages", c)} className={chip(form.stages.includes(c))}>{c}</button>)}
                    </div>
                    <p className="text-[10px] text-slate-400">{tx("Leave all unselected to run every stage. A single stage is a cheap way to try a setup.")} {form.stages.length > 0 && <button type="button" onClick={() => set("stages", [])} className="font-semibold text-blue-600 hover:underline">{tx("Use all stages")}</button>}</p>
                  </div>
                </details>
              </>
            )}

            {step === "method" && (
              <>
                <div>
                  <span className={labelCls}>{tx("How are the models asked?")}</span>
                  <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label={tx("Benchmark mode")}>
                    {([["agent", "Through the real agent", "The Individual Insurance agent answers with its tools and skills, using each model. This is what the product does. Recommended."], ["direct", "As a bare model", "The model is asked the same question with the same reference information, with no agent and no tools. Cheaper, and tests the model alone."]] as const).map(([m, title, text]) => (
                      <button key={m} type="button" role="radio" aria-checked={form.mode === m} onClick={() => set("mode", m)} className={`rounded-xl border p-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${form.mode === m ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40" : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900"}`}>
                        <span className="flex items-center gap-2"><span className={`inline-flex h-4 w-4 items-center justify-center rounded-full border text-[9px] ${form.mode === m ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 text-transparent"}`} aria-hidden>●</span><b className="text-sm font-extrabold text-slate-900 dark:text-slate-50">{tx(title)}</b></span>
                        <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">{tx(text)}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <span className={labelCls}>{tx("How many times is each question asked?")}</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {REPETITION_CHOICES.map((n) => <button key={n} type="button" aria-pressed={form.repetitions === n && custom === ""} onClick={() => { setCustom(""); set("repetitions", n); }} className={chip(form.repetitions === n && custom === "")}>{n}{n === 3 ? ` · ${tx("recommended")}` : ""}</button>)}
                    <input aria-label={tx("custom repetitions, 1 to 100")} className={`${inputCls} !w-28`} placeholder={tx("custom")} inputMode="numeric" value={custom}
                      onChange={(e) => { setCustom(e.target.value); const n = Number(e.target.value); if (e.target.value !== "" && Number.isInteger(n)) set("repetitions", n); }} />
                  </div>
                  <p className="mt-1.5 text-[11px] text-slate-500">{tx("More repetitions separate a model that is reliably right from one that was lucky. Cost grows in proportion: one repetition is the cheapest way to try a setup.")}</p>
                </div>
                {form.mode === "agent" && (
                  <details className="rounded-lg border border-slate-200 dark:border-slate-700">
                    <summary className="cursor-pointer select-none px-3 py-2.5 text-xs font-bold text-slate-700 dark:text-slate-200">{tx("Advanced: agent skills")} <span className="font-normal text-slate-400">({(form.skills ?? "default") === "default" ? tx("as configured") : tx(form.skills === "on" ? "on" : "off")})</span></summary>
                    <div className="border-t border-slate-100 px-3 py-3 dark:border-slate-800" data-testid="skills-choice">
                      <div className="inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700" role="radiogroup" aria-label={tx("Agent skills")}>
                        {([["default", "As configured"], ["on", "On"], ["off", "Off"]] as const).map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={(form.skills ?? "default") === v} onClick={() => set("skills", v)} className={seg((form.skills ?? "default") === v)}>{tx(l)}</button>)}
                      </div>
                      <p className="mt-1.5 text-[10px] text-slate-400">{tx("Skills are the agent's progressive instructions. Run once with them on and once off to see what they add.")}</p>
                    </div>
                  </details>
                )}
              </>
            )}

            {step === "judge" && (
              <>
                <div>
                  <label className={labelCls} htmlFor="bm-judge">{tx("Judge model")}</label>
                  <select id="bm-judge" className={inputCls} value={form.judge} onChange={(e) => set("judge", e.target.value)}>
                    <option value="">{tx("No judge (rule checks only)")}</option>
                    {judges.map((j) => <option key={j.label} value={j.label}>{j.label}{j.synthetic ? ` (${tx("scripted")})` : ""}</option>)}
                  </select>
                  {form.judge && form.models.includes(form.judge) && !form.allowSameJudge && <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800" role="alert">{tx("This judge is also one of the models being compared. Choose another judge: a model tends to favour its own answers.")}</p>}
                  {!form.judge && <p className="mt-1.5 text-[11px] text-slate-500">{tx("Without a judge the results rest on rule-based checks only: which tools were called, what changed in the data, and exact text.")}</p>}
                </div>
                <details className="rounded-lg border border-slate-200 dark:border-slate-700">
                  <summary className="cursor-pointer select-none px-3 py-2.5 text-xs font-bold text-slate-700 dark:text-slate-200">{tx("Advanced: what to score")} <span className="font-normal text-slate-400">({form.metrics.length === 0 ? tx("all the cases ask for") : `${form.metrics.length} ${tx("chosen")}`})</span></summary>
                  <div className="space-y-3 border-t border-slate-100 px-3 py-3 dark:border-slate-800">
                    <div className="flex flex-wrap gap-1.5">
                      {METRICS.map((m) => <button key={m} type="button" disabled={!form.judge} title={tx(METRIC_HELP[m])} aria-pressed={form.metrics.includes(m)} onClick={() => toggle("metrics", m)} className={`${chip(form.metrics.includes(m))} disabled:opacity-40`}>{m.replace("_", " ")}</button>)}
                    </div>
                    {!form.judge && <p className="text-[10px] text-slate-400">{tx("Choose a judge to pick which quality metrics are scored.")}</p>}
                    <label className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-300"><input type="checkbox" className="mt-0.5" checked={form.allowSameJudge} onChange={(e) => set("allowSameJudge", e.target.checked)} />{tx("Allow the judge to be one of the compared models (weaker evidence)")}</label>
                  </div>
                </details>
              </>
            )}

            {step === "review" && (
              <>
                <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700" data-testid="review-list">
                  {([["models", "Models", steps[0].summary], ["questions", "Questions", `${steps[1].summary}${cases !== null ? ` · ${cases} ${tx("cases")}` : ""}`], ["method", "Method", steps[2].summary], ["judge", "Judge", `${steps[3].summary}${form.metrics.length ? ` · ${form.metrics.length} ${tx("metrics")}` : ""}`]] as const).map(([id, label, value]) => (
                    <div key={id} className="flex items-center gap-3 px-3 py-2.5">
                      <dt className="w-24 shrink-0 text-[11px] font-bold uppercase tracking-wide text-slate-400">{tx(label)}</dt>
                      <dd className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-800 dark:text-slate-100" title={value}>{value}</dd>
                      <button type="button" onClick={() => goTo(id)} className="shrink-0 text-[11px] font-semibold text-blue-700 hover:underline dark:text-sky-300">{tx("Change")}</button>
                    </div>
                  ))}
                </dl>
                <div className="max-w-xs">
                  <label className={labelCls} htmlFor="bm-budget">{tx("Spending limit for this run (USD)")}</label>
                  <input id="bm-budget" className={inputCls} inputMode="decimal" value={form.budget} onChange={(e) => set("budget", e.target.value)} />
                  <p className="mt-1 text-[10px] text-slate-400">{tx("The run stops when this is reached; what is left is reported as blocked, not failed.")}</p>
                </div>
                <details className="rounded-lg border border-slate-200 dark:border-slate-700">
                  <summary className="cursor-pointer select-none px-3 py-2.5 text-xs font-bold text-slate-700 dark:text-slate-200">{tx("Advanced: limits and quality gate")} <span className="font-normal text-slate-400">({form.maxLatencyMs || form.maxTokens || form.maxCostUsd || form.gate || form.stopOnCritical ? `${tx("set")}${form.gate ? ` · ${tx("gate")} ${form.gateMinPassPct || "90"}%` : ""}` : tx("none")})</span></summary>
                  <div className="space-y-4 border-t border-slate-100 px-3 py-3 dark:border-slate-800">
                    {form.mode === "direct" && <div className="max-w-[10rem]"><label className={labelCls} htmlFor="bm-temp">{tx("Temperature")}</label><input id="bm-temp" className={inputCls} inputMode="decimal" value={form.temperature} onChange={(e) => set("temperature", e.target.value)} /></div>}
                    <div data-testid="limits-gate" className="grid gap-3 sm:grid-cols-3">
                      <div><label className={labelCls} htmlFor="bm-maxlat">{tx("Slowest allowed (ms)")}</label><input id="bm-maxlat" className={inputCls} inputMode="numeric" placeholder={tx("no limit")} value={form.maxLatencyMs ?? ""} onChange={(e) => set("maxLatencyMs", e.target.value)} /></div>
                      <div><label className={labelCls} htmlFor="bm-maxtok">{tx("Most tokens per execution")}</label><input id="bm-maxtok" className={inputCls} inputMode="numeric" placeholder={tx("no limit")} value={form.maxTokens ?? ""} onChange={(e) => set("maxTokens", e.target.value)} /></div>
                      <div><label className={labelCls} htmlFor="bm-maxcost">{tx("Most cost per execution (USD)")}</label><input id="bm-maxcost" className={inputCls} inputMode="decimal" placeholder={tx("no limit")} value={form.maxCostUsd ?? ""} onChange={(e) => set("maxCostUsd", e.target.value)} /></div>
                      <p className="text-[10px] text-slate-400 sm:col-span-3">{tx("An execution over a limit fails the performance layer (L6); it is not stopped midway.")}</p>
                      <div className="sm:col-span-3">
                        <label className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-300"><input type="checkbox" className="mt-0.5" checked={!!form.gate} onChange={(e) => set("gate", e.target.checked)} />{tx("Apply a quality gate: each model must reach a minimum pass rate (critical cases are held to a stricter standard)")}</label>
                        {form.gate && <div className="mt-2 max-w-[10rem]"><label className={labelCls} htmlFor="bm-gate">{tx("Minimum pass rate (%)")}</label><input id="bm-gate" className={inputCls} inputMode="decimal" value={form.gateMinPassPct ?? ""} onChange={(e) => set("gateMinPassPct", e.target.value)} /></div>}
                      </div>
                    </div>
                    <label className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-300"><input type="checkbox" className="mt-0.5" checked={form.stopOnCritical} onChange={(e) => set("stopOnCritical", e.target.checked)} />{tx("Stop a model's run at its first critical failure")}</label>
                  </div>
                </details>
                <div className="rounded-lg bg-slate-50 px-4 py-3 dark:bg-slate-800/50">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="mr-auto min-w-0 text-xs text-slate-600 dark:text-slate-300"><b className="block text-sm font-extrabold text-slate-900 dark:text-slate-50">{canStart ? (usesMoney ? tx("Ready: this run spends real money") : tx("Ready: a free simulation")) : tx("Not ready yet")}</b>{!canStart && why ? <span data-testid="review-why">{why}</span> : usesMoney && cost && !cost.error ? <span>{tx("Estimated at most")} {usd(cost.usd.total)}</span> : null}</div>
                    <button type="button" onClick={press} disabled={!canStart} data-testid="start-run-review" className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">{startLabel}</button>
                  </div>
                </div>
              </>
            )}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-3 dark:border-slate-800">
            {step !== "models" ? <button type="button" onClick={() => goTo(prevOf(step))} className={ghost} data-testid="step-back">← {tx("Back")}</button> : <span />}
            {step !== "review" && (
              <div className="flex items-center gap-3">
                {!canAdvance(step, form) && <span className="text-[11px] text-slate-500" data-testid="step-blocked">{step === "models" ? tx("Pick at least two models to continue.") : tx("Choose a published test set to continue.")}</span>}
                <button type="button" onClick={() => goTo(nextOf(step))} disabled={!canAdvance(step, form)} data-testid="step-next" className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-bold text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">{tx("Next")}: {tx(COPY[nextOf(step)].label)} →</button>
              </div>
            )}
          </footer>
        </section>

        {aside}
      </div>

      <aside className="min-w-0 space-y-3 lg:sticky lg:top-24 lg:self-start" aria-label={tx("Run summary")}>
        {summary}
      </aside>

      {/* small screens: the same facts and the same button, pinned to the bottom edge */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-2.5 shadow-[0_-4px_16px_rgba(15,23,42,0.08)] backdrop-blur dark:border-slate-700 dark:bg-slate-950/95 lg:hidden" data-testid="mobile-bar">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <div className="min-w-0 flex-1 text-[11px] text-slate-500"><b className="block truncate text-slate-800 dark:text-slate-100">{form.models.length} {tx("models")} · {cost && !cost.error ? usd(cost.usd.total) : "—"}</b><span className="block truncate">{!canStart && why ? why : usesMoney ? tx("real run") : tx("free simulation")}</span></div>
          <button type="button" onClick={press} disabled={!canStart} className="flex-none rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white disabled:bg-slate-200 disabled:text-slate-500">{usesMoney ? tx("Start real run") : tx("Start")}</button>
        </div>
      </div>

      {confirm && cost && (
        <ConfirmDialog title={tx("Start a real run on paid models?")} confirmLabel={`${tx("Start and spend up to ")}${usd(Math.min(cost.usd.total, Number(form.budget) || cost.usd.total))}`} busy={starting} onConfirm={start} onCancel={() => setConfirm(false)}>
          <p className="text-sm text-slate-600">
            {tx("This calls")} {form.models.filter((m) => !m.startsWith("mock/")).map((m) => `${providerOf(m)}/${m.split("/")[1]}`).join(", ")} {tx("with your evaluation key. The estimate is")} <b>{usd(cost.usd.total)}</b> {tx("at most; this run's own budget limit is")} <b>{form.budget.trim() === "" ? tx("not set") : `$${form.budget}`}</b>. {tx("It runs on isolated fixtures, never on live customer data.")}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ModelCard({ m, on, onToggle }: { m: ModelEntry; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} onClick={onToggle}
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${on ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40" : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900"}`}>
      <span className={`mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded border text-[10px] ${on ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 text-transparent"}`} aria-hidden>✓</span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold text-slate-800 dark:text-slate-100">{m.display_name ?? m.model_id}</span>
        <span className="block text-[10px] text-slate-500">{m.synthetic ? tx("scripted · free") : m.current_price ? `$${m.current_price.input_per_m} in · $${m.current_price.output_per_m} out ${tx("per million tokens")}` : tx("no price registered")}</span>
        {m.latest_benchmark && m.latest_benchmark.pass_rate !== null && !m.synthetic && <span className="block text-[10px] text-slate-400">{tx("last benchmark")}: {Math.round(m.latest_benchmark.pass_rate * 100)}% {tx("passed")}</span>}
      </span>
    </button>
  );
}
