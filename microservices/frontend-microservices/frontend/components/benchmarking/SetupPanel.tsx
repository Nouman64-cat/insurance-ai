"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { tx } from "@/lib/i18n/tx";
import {
  METRICS, PROVIDER_NAME, REPETITION_CHOICES, buildRequest, formProblems, getDataset, listDatasets, listModels, previewJob, providerOf, startJob, tokens, usd,
  type BenchmarkForm, type CostEstimate, type DatasetDetail, type DatasetSummary, type Job, type Metric, type ModelEntry,
} from "@/lib/evalBenchmarks";

const inputCls = "w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 bg-white";
const labelCls = "block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1";
const btnPrimary = "px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-all";

const METRIC_HELP: Record<Metric, string> = {
  correctness: "Is the answer right against the expected outcome?",
  faithfulness: "Does it stay within the reference information?",
  relevance: "Does it answer what was asked?",
  hallucination: "Does it contradict or invent facts?",
  task_completion: "Did the agent do the whole task?",
  safety: "Does it refuse what it must refuse?",
  custom: "The case's own criterion.",
};

const EMPTY: BenchmarkForm = { dataset: "", version: "", mode: "agent", models: [], repetitions: 3, judge: "", metrics: [], stages: [], temperature: "0", budget: "2", stopOnCritical: false, allowSameJudge: false };

export default function SetupPanel({ onStarted }: { onStarted: (job: Job) => void }) {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [detail, setDetail] = useState<DatasetDetail | null>(null);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [form, setForm] = useState<BenchmarkForm>(EMPTY);
  const [custom, setCustom] = useState("");
  const [preview, setPreview] = useState<{ cost?: CostEstimate; executions: number | null } | null>(null);
  const [refused, setRefused] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const [ds, ms] = await Promise.all([listDatasets(), listModels()]);
        const usable = ds.filter((d) => d.latest_version);
        setDatasets(usable);
        setModels(ms);
        if (usable.length > 0) setForm((f) => ({ ...f, dataset: usable.find((d) => d.slug.includes("single"))?.slug ?? usable[0].slug }));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load datasets and models.");
      }
    })();
  }, []);

  useEffect(() => {
    if (!form.dataset) return;
    getDataset(form.dataset)
      .then((d) => {
        setDetail(d);
        const published = d.versions.filter((v) => v.state === "published");
        setForm((f) => ({ ...f, version: published.find((v) => v.version === d.latest_version)?.version ?? published[published.length - 1]?.version ?? "", stages: [] }));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the dataset."));
  }, [form.dataset]);

  const candidates = useMemo(() => models.filter((m) => m.status === "active" && m.roles.includes("candidate")), [models]);
  const judges = useMemo(() => models.filter((m) => m.status === "active" && m.roles.includes("judge")), [models]);
  const byProvider = useMemo(() => {
    const out: Record<string, ModelEntry[]> = {};
    candidates.forEach((m) => (out[m.provider] ||= []).push(m));
    return out;
  }, [candidates]);

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
        const e = await previewJob(request);
        if (mine === seq.current) setPreview({ cost: e.cost, executions: e.executions });
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

  const cost = preview?.cost;
  const real = form.models.some((m) => !m.startsWith("mock/"));
  const canStart = !!request && !!cost && !cost.error && !previewing && refused.length === 0 && !starting;

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

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        {error && <div className="text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600">{error}</div>}

        <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="text-sm font-bold text-slate-900">{tx("1. What to ask")}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="bm-dataset">{tx("Evaluation dataset")}</label>
              <select id="bm-dataset" className={inputCls} value={form.dataset} onChange={(e) => set("dataset", e.target.value)}>
                {datasets.map((d) => <option key={d.slug} value={d.slug}>{d.name} ({d.turn_mode.replace("_", " ")})</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="bm-version">{tx("Published version")}</label>
              <select id="bm-version" className={inputCls} value={form.version} onChange={(e) => set("version", e.target.value)}>
                {(detail?.versions ?? []).filter((v) => v.state === "published").map((v) => (
                  <option key={v.version} value={v.version}>{v.version} · {v.case_count} {tx("cases")}{v.provisional ? ` · ${tx("provisional")}` : ""}</option>
                ))}
              </select>
              <p className="text-[10px] text-slate-400 mt-1">{tx("Only a published version is immutable, so only it can be benchmarked.")}</p>
            </div>
          </div>
          <div>
            <span className={labelCls}>{tx("Workflow stages")} <span className="normal-case font-normal text-slate-400">({form.stages.length === 0 ? tx("all") : form.stages.length})</span></span>
            <div className="flex flex-wrap gap-1.5">
              {(detail?.facets.category ?? []).map((c) => (
                <button key={c} type="button" aria-pressed={form.stages.includes(c)} onClick={() => toggle("stages", c)}
                  className={`px-2 py-1 rounded-md text-[11px] border ${form.stages.includes(c) ? "bg-blue-50 border-blue-300 text-blue-700" : "bg-white border-slate-200 text-slate-600"}`}>{c}</button>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="text-sm font-bold text-slate-900">{tx("2. How to compare")}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div role="radiogroup" aria-label={tx("Benchmark mode")}>
              <span className={labelCls}>{tx("Benchmark mode")}</span>
              {(["agent", "direct"] as const).map((m) => (
                <label key={m} className={`flex gap-2 items-start rounded-lg border p-2 mb-1.5 cursor-pointer ${form.mode === m ? "border-blue-300 bg-blue-50" : "border-slate-200"}`}>
                  <input type="radio" name="bm-mode" checked={form.mode === m} onChange={() => set("mode", m)} className="mt-0.5" />
                  <span className="text-xs text-slate-700"><b>{m === "agent" ? tx("Agent") : tx("Direct")}</b> — {m === "agent" ? tx("the real Individual Insurance agent, with its tools and skills, answers using each model.") : tx("the bare model is asked the same question with the same reference information, no tools.")}</span>
                </label>
              ))}
            </div>
            <div>
              <label className={labelCls} htmlFor="bm-repeat">{tx("Repetitions")}</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {REPETITION_CHOICES.map((n) => (
                  <button key={n} type="button" aria-pressed={form.repetitions === n && custom === ""} onClick={() => { setCustom(""); set("repetitions", n); }}
                    className={`px-2.5 py-1 rounded-md text-xs border ${form.repetitions === n && custom === "" ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-200 text-slate-600"}`}>{n}</button>
                ))}
              </div>
              <input id="bm-repeat" className={inputCls} placeholder={tx("custom, 1 to 100")} inputMode="numeric" value={custom}
                onChange={(e) => { setCustom(e.target.value); const n = Number(e.target.value); if (e.target.value !== "" && Number.isInteger(n)) set("repetitions", n); }} />
              <p className="text-[10px] text-slate-400 mt-1">{tx("More repetitions separate a model that is reliably right from one that is lucky.")}</p>
            </div>
          </div>

          <div>
            <span className={labelCls}>{tx("Models to compare")} <span className="normal-case font-normal text-slate-400">({form.models.length} {tx("chosen, at least 2")})</span></span>
            <div className="space-y-2">
              {Object.entries(byProvider).map(([provider, list]) => (
                <div key={provider}>
                  <div className="text-[10px] font-semibold text-slate-400 mb-1">{PROVIDER_NAME[provider] ?? provider}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {list.map((m) => (
                      <button key={m.label} type="button" aria-pressed={form.models.includes(m.label)} onClick={() => toggle("models", m.label)}
                        className={`text-left px-2.5 py-1.5 rounded-lg border text-xs ${form.models.includes(m.label) ? "bg-blue-50 border-blue-300 text-blue-800" : "bg-white border-slate-200 text-slate-700"}`}>
                        <span className="font-semibold">{m.display_name ?? m.model_id}</span>
                        <span className="block text-[10px] text-slate-400">{m.synthetic ? tx("scripted · free") : m.current_price ? `$${m.current_price.input_per_m}/M in · $${m.current_price.output_per_m}/M out` : tx("no price")}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="text-sm font-bold text-slate-900">{tx("3. How to judge")}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="bm-judge">{tx("Judge model")}</label>
              <select id="bm-judge" className={inputCls} value={form.judge} onChange={(e) => set("judge", e.target.value)}>
                <option value="">{tx("No judge (rule checks only)")}</option>
                {judges.map((j) => <option key={j.label} value={j.label}>{j.label}{j.synthetic ? ` (${tx("scripted")})` : ""}</option>)}
              </select>
              <label className="flex items-center gap-2 text-[11px] text-slate-600 mt-2">
                <input type="checkbox" checked={form.allowSameJudge} onChange={(e) => set("allowSameJudge", e.target.checked)} />
                {tx("Allow the judge to be one of the compared models (weaker evidence)")}
              </label>
            </div>
            <div>
              <label className={labelCls} htmlFor="bm-budget">{tx("Budget (USD)")}</label>
              <input id="bm-budget" className={inputCls} inputMode="decimal" value={form.budget} onChange={(e) => set("budget", e.target.value)} />
              <p className="text-[10px] text-slate-400 mt-1">{tx("The run stops when this is reached; what is left is reported as blocked, not failed.")}</p>
              {form.mode === "direct" && (
                <div className="mt-2">
                  <label className={labelCls} htmlFor="bm-temp">{tx("Temperature")}</label>
                  <input id="bm-temp" className={inputCls} inputMode="decimal" value={form.temperature} onChange={(e) => set("temperature", e.target.value)} />
                </div>
              )}
              <label className="flex items-center gap-2 text-[11px] text-slate-600 mt-2">
                <input type="checkbox" checked={form.stopOnCritical} onChange={(e) => set("stopOnCritical", e.target.checked)} />
                {tx("Stop a model's run at its first critical failure")}
              </label>
            </div>
          </div>
          <div>
            <span className={labelCls}>{tx("Evaluation metrics")} <span className="normal-case font-normal text-slate-400">({form.metrics.length === 0 ? tx("all the cases ask for") : `${form.metrics.length} ${tx("chosen")}`})</span></span>
            <div className="flex flex-wrap gap-1.5">
              {METRICS.map((m) => (
                <button key={m} type="button" disabled={!form.judge} title={tx(METRIC_HELP[m])} aria-pressed={form.metrics.includes(m)} onClick={() => toggle("metrics", m)}
                  className={`px-2 py-1 rounded-md text-[11px] border disabled:opacity-40 ${form.metrics.includes(m) ? "bg-blue-50 border-blue-300 text-blue-700" : "bg-white border-slate-200 text-slate-600"}`}>{m.replace("_", " ")}</button>
              ))}
            </div>
            {!form.judge && <p className="text-[10px] text-slate-400 mt-1">{tx("Choose a judge to pick which quality metrics are scored.")}</p>}
          </div>
        </section>
      </div>

      <aside className="space-y-3 lg:sticky lg:top-4 self-start">
        <section className="rounded-xl border border-slate-200 bg-white p-4" aria-live="polite">
          <h2 className="text-sm font-bold text-slate-900">{tx("Estimated consumption and cost")}</h2>
          {problems.length > 0 && <ul className="mt-2 text-xs text-slate-500 list-disc pl-4 space-y-0.5">{problems.map((p) => <li key={p}>{tx(p)}</li>)}</ul>}
          {problems.length === 0 && previewing && <p className="mt-3 text-xs text-slate-400">{tx("Estimating…")}</p>}
          {refused.length > 0 && <div className="mt-3 text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600">{refused.map((r) => <p key={r}>{r}</p>)}</div>}
          {cost?.error && <div className="mt-3 text-xs rounded-lg px-3 py-2 border bg-amber-50 border-amber-200 text-amber-700">{cost.error}</div>}
          {cost && !cost.error && (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-slate-600">
                <b>{cost.model_backed_cases}</b> {tx("model-backed cases")} × <b>{cost.repetitions}</b> {tx("repetitions")} × <b>{form.models.length}</b> {tx("models")} = <b>{cost.model_backed_cases * cost.repetitions * form.models.length}</b> {tx("model runs")}
                {cost.judged_criteria_per_pass > 0 && form.judge && <>, {cost.judged_criteria_per_pass * cost.repetitions * form.models.length} {tx("judge calls")}</>}.
              </p>
              <table className="w-full text-[11px]">
                <thead><tr className="text-slate-400 text-left"><th className="font-semibold py-1">{tx("Model")}</th><th className="font-semibold text-right">{tx("Tokens in / out")}</th><th className="font-semibold text-right">{tx("Cost")}</th></tr></thead>
                <tbody>
                  {cost.models.map((m) => (
                    <tr key={m.model} className="border-t border-slate-100" title={m.basis}>
                      <td className="py-1.5 text-slate-700">{m.model}<span className="block text-[10px] text-slate-400">{m.basis}</span></td>
                      <td className="text-right text-slate-600">{tokens(m.input_tokens)} / {tokens(m.output_tokens)}</td>
                      <td className="text-right font-semibold text-slate-800">{usd(m.usd)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-slate-100" title={cost.judge.basis}>
                    <td className="py-1.5 text-slate-700">{tx("Judge")}: {cost.judge.model ?? tx("none")}<span className="block text-[10px] text-slate-400">{cost.judge.basis}</span></td>
                    <td className="text-right text-slate-600">{tokens(cost.judge.input_tokens)} / {tokens(cost.judge.output_tokens)}</td>
                    <td className="text-right font-semibold text-slate-800">{usd(cost.judge.usd)}</td>
                  </tr>
                  <tr className="border-t-2 border-slate-200">
                    <td className="py-2 font-bold text-slate-900" colSpan={2}>{tx("Total (upper bound)")}</td>
                    <td className="text-right font-bold text-blue-700 text-sm" data-testid="estimate-total">{usd(cost.usd.total)}{cost.usd.complete ? "" : "+"}</td>
                  </tr>
                </tbody>
              </table>
              {cost.warnings.map((w) => <div key={w} className="text-[11px] rounded-lg px-3 py-2 border bg-amber-50 border-amber-200 text-amber-700">{w}</div>)}
              <p className="text-[10px] text-slate-400">{tx(cost.note)}</p>
            </div>
          )}
        </section>
        <button type="button" className={`${btnPrimary} w-full py-2.5 text-sm`} disabled={!canStart} onClick={() => (real ? setConfirm(true) : start())}>
          {starting ? tx("Starting…") : tx("Start benchmark")}
        </button>
        {!canStart && !starting && <p className="text-[10px] text-slate-400 text-center">{tx("The button unlocks when the request is complete and the backend has accepted it.")}</p>}
      </aside>

      {confirm && cost && (
        <ConfirmDialog title={tx("Start a benchmark on paid models?")} confirmLabel={tx("Start and spend up to ") + usd(Math.min(cost.usd.total, Number(form.budget) || cost.usd.total))} busy={starting} onConfirm={start} onCancel={() => setConfirm(false)}>
          <p className="text-sm text-slate-600">
            {tx("This calls")} {form.models.filter((m) => !m.startsWith("mock/")).map((m) => `${providerOf(m)}/${m.split("/")[1]}`).join(", ")} {tx("with your evaluation key. The estimate is")} <b>{usd(cost.usd.total)}</b> {tx("at most; the budget limit is")} <b>${form.budget || "none"}</b>.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
