"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LiveRun from "@/components/benchmarking/LiveRun";
import SetupPanel from "@/components/benchmarking/SetupPanel";
import { JobsTab } from "@/components/evaluation/BenchmarkingWorkspace";
import { tx } from "@/lib/i18n/tx";
import { rerunJob, streamJob, type BenchmarkForm, type Job, type JobEvent } from "@/lib/evalBenchmarks";
import { getGraph, studioHref, type StudioGraph } from "@/lib/evalStudio";
import { useQueryState } from "@/lib/useQueryState";
import EcosystemMap, { type NodeOverlay } from "./EcosystemMap";

const TERMINAL = ["succeeded", "failed", "cancelled", "lost"];

/** What a job's event stream says so far, counted by provider: the nodes of the map light up from this. */
export function tally(events: JobEvent[]): { done: number; passed: number; failed: number; spent: number; byProvider: Record<string, { done: number; passed: number; failed: number }> } {
  const out = { done: 0, passed: 0, failed: 0, spent: 0, byProvider: {} as Record<string, { done: number; passed: number; failed: number }> };
  events.filter((e) => e.kind === "case").forEach((e) => {
    const d = e.data as Record<string, unknown>;
    const p = String(d.model ?? "").split("/")[0];
    const st = String(d.status);
    out.done += 1;
    out.passed += st === "passed" ? 1 : 0;
    out.failed += st === "failed" ? 1 : 0;
    out.spent += typeof d.cost_usd === "number" ? d.cost_usd : 0;
    if (p) { const b = (out.byProvider[p] ||= { done: 0, passed: 0, failed: 0 }); b.done += 1; b.passed += st === "passed" ? 1 : 0; b.failed += st === "failed" ? 1 : 0; }
  });
  return out;
}

/** The map overlays for a running job: the harness shows how far it is, each provider in use shows what its executions did, results the pass count. Nothing shows for a job that is not running. */
export function overlaysFor(job: Job | null, t: ReturnType<typeof tally>): Record<string, NodeOverlay> {
  if (!job || TERMINAL.includes(job.state)) return {};
  const planned = typeof job.progress?.planned === "number" ? (job.progress.planned as number) : null;
  const o: Record<string, NodeOverlay> = { harness: { text: `${t.done}${planned ? ` / ${planned}` : ""} ${tx("done")}`, tone: "run" }, results: { text: `${t.passed} ${tx("passed")}, ${t.failed} ${tx("failed")}`, tone: t.failed > t.passed ? "bad" : "run" } };
  Object.entries(t.byProvider).forEach(([p, b]) => { o[`provider:${p}`] = { text: `${b.done} ${tx("done")} · ${b.passed} ${tx("pass")}`, tone: "run" }; });
  const ds = (job.config as Record<string, unknown>).dataset;
  if (typeof ds === "string") o[`dataset:${ds}`] = { text: `${tx("being evaluated")}`, tone: "run" };
  o.agent = { text: `${tx("answering")}`, tone: "run" };
  o.costs = { text: `$${t.spent.toFixed(4)} ${tx("so far")}`, tone: "run" };
  return o;
}

export function ModeBanner({ models }: { models: string[] }) {
  if (models.length === 0) return <div className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900" data-testid="mode-banner" data-mode="none">{tx("Choose the models to compare. Scripted models are a free simulation; GPT, Gemini and Claude are real runs that spend money.")}</div>;
  const real = models.filter((m) => !m.startsWith("mock/"));
  return real.length === 0
    ? <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-2.5 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200" data-testid="mode-banner" data-mode="simulation"><b>{tx("Free simulation.")}</b> {tx("Scripted models answer on isolated fixtures: no provider is called and nothing is spent. It checks the machinery, not the quality of any real model.")}</div>
    : <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" data-testid="mode-banner" data-mode="real"><b>{tx("Real run.")}</b> {tx("This calls")} {real.join(", ")} {tx("with your evaluation key and spends money. The estimate and what it does to the budget are shown before anything starts; the run still happens on isolated fixtures, never on live customer data.")}</div>;
}

const seg = (on: boolean) => `rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${on ? "bg-white text-blue-700 shadow-sm dark:bg-slate-700 dark:text-sky-200" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"}`;

/** What the person is doing now, as three steps of one task: set a run up, watch it, look back at earlier ones. A run that starts moves the view to Watch by itself. */
export default function SimulateView() {
  const [dataset] = useQueryState("dataset");
  const [provider] = useQueryState("models");
  const [sim, setSim] = useQueryState("sim", "new");
  const [, setForm] = useState<BenchmarkForm | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [graph, setGraph] = useState<StudioGraph | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [, setBench] = useQueryState("bench");
  const [, setMode] = useQueryState("mode");
  const [, setSub] = useQueryState("sub");
  const seen = useRef<Set<number>>(new Set());
  const running = !!job && !TERMINAL.includes(job.state);
  const view = sim === "watch" && job ? "watch" : sim === "runs" ? "runs" : "new";

  const loadGraph = useCallback(() => getGraph().then(setGraph).catch(() => undefined), []);
  useEffect(() => { loadGraph(); }, [loadGraph]);
  useEffect(() => { if (!running) return; const t = setInterval(loadGraph, 6000); return () => clearInterval(t); }, [running, loadGraph]);

  // the run's own event stream (server-sent events) drives the nodes
  useEffect(() => {
    if (!job) return;
    const ctl = new AbortController();
    seen.current = new Set();
    setEvents([]);
    streamJob(job.id, { onEvent: (e) => { if (seen.current.has(e.seq)) return; seen.current.add(e.seq); setEvents((l) => [...l.slice(-999), e]); }, onEnd: () => undefined, onError: () => undefined }, ctl.signal).catch(() => undefined);
    return () => ctl.abort();
  }, [job?.id]);                       // eslint-disable-line react-hooks/exhaustive-deps

  const t = useMemo(() => tally(events), [events]);
  const overlays = useMemo(() => overlaysFor(job, t), [job, t]);
  const focus = useMemo(() => graph ? { ...graph, nodes: graph.nodes.filter((n) => ["dataset", "harness", "agent", "provider", "deepeval", "results", "costs"].includes(n.kind)), edges: graph.edges } : null, [graph]);
  const openResults = (benchmarkId: string) => { setBench(benchmarkId); setSub("benchmarks"); setMode("investigate"); };
  const started = (j: Job) => { setJob(j); setSim("watch"); };
  async function rerun(j: Job) { try { started(await rerunJob(j.id)); } catch { setSim("runs"); } }

  const map = (
    <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
      <h2 className="text-xs font-bold text-slate-900 dark:text-slate-50">{running ? tx("Running now") : tx("What a run touches")}</h2>
      <p className="mb-2 text-[11px] text-slate-500">{running ? tx("The nodes update from the run's own event stream.") : tx("These nodes light up as a run works through the dataset.")}</p>
      {focus ? <EcosystemMap graph={focus} selected={selected} onSelect={setSelected} overlays={overlays} compact /> : <p className="py-8 text-center text-xs text-slate-400">{tx("Loading…")}</p>}
    </section>
  );

  return (
    <div className="space-y-4" data-testid="simulate-view">
      <div className="flex flex-wrap items-center gap-3">
        <nav className="flex gap-1 rounded-full border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-900" aria-label={tx("Simulate")} data-testid="sim-steps">
          <button type="button" onClick={() => setSim("new")} aria-current={view === "new" ? "step" : undefined} className={seg(view === "new")} data-sim="new">{tx("New run")}</button>
          <button type="button" onClick={() => setSim("watch")} disabled={!job} aria-current={view === "watch" ? "step" : undefined} className={`${seg(view === "watch")} disabled:cursor-not-allowed disabled:opacity-40`} data-sim="watch" title={job ? undefined : tx("Start a run to watch it")}>
            {running && <span className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500 align-middle" aria-hidden />}{tx("Watch")}
          </button>
          <button type="button" onClick={() => setSim("runs")} aria-current={view === "runs" ? "step" : undefined} className={seg(view === "runs")} data-sim="runs">{tx("Recent runs")}</button>
        </nav>
        <p className="text-[11px] text-slate-500">
          {view === "new" ? tx("Scripted models are a free simulation on isolated fixtures. GPT, Gemini and Claude are real runs that spend money; the estimate comes first.") : view === "watch" ? tx("Cancel stops after the case in flight; a stopped run keeps what it has.") : tx("Open a run to watch it, see its results, or run it again.")}
        </p>
      </div>

      {view === "new" && <SetupPanel onStarted={started} initialDataset={dataset || undefined} initialProvider={provider || undefined} onForm={setForm} aside={<details className="rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"><summary className="cursor-pointer px-4 py-3 text-xs font-bold text-slate-900 dark:text-slate-50">{tx("What a run touches")}</summary><div className="px-3 pb-3">{map}</div></details>} />}

      {view === "watch" && job && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="min-w-0 order-2 xl:order-1"><LiveRun job={job} onJob={setJob} onOpenResults={openResults} /></div>
          <div className="min-w-0 order-1 xl:sticky xl:top-24 xl:order-2 xl:self-start">{map}</div>
        </div>
      )}

      {view === "runs" && <JobsTab onOpen={(j) => { setJob(j); setSim("watch"); }} onResults={openResults} onRerun={rerun} />}
    </div>
  );
}
