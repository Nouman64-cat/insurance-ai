"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { tx } from "@/lib/i18n/tx";
import { getDataset, listJobs, listModels, pct, type DatasetDetail, type Job, type ModelEntry } from "@/lib/evalBenchmarks";
import { getCostOverview, show, type CostOverview } from "@/lib/evalCosts";
import { getRegistry, listItems, type DriftItem, type WatchedItem } from "@/lib/evalDrift";
import { HEALTH_COLOR, KIND_HELP, KIND_ICON, getObserved, studioHref, type Observed, type StudioGraph, type StudioNode } from "@/lib/evalStudio";

const link = "inline-flex items-center rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:border-sky-400";
const h = "text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5";

function Loading() { return <p className="text-xs text-slate-400">{tx("Loading…")}</p>; }
function Err({ text }: { text: string }) { return <p className="text-xs text-red-600">{text}</p>; }
function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setData(null); setError(null); load().then(setData).catch((e) => setError(e instanceof Error ? e.message : "Could not load.")); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, deps);
  return { data, error };
}
const Row = ({ k, v }: { k: ReactNode; v: ReactNode }) => <div className="flex justify-between gap-3 text-xs py-1 border-b border-slate-100 dark:border-slate-800"><span className="text-slate-500">{k}</span><span className="font-semibold text-slate-800 dark:text-slate-100 text-right">{v}</span></div>;

function RulesBody({ node }: { node: StudioNode }) {
  const { data, error } = useLoad(() => getRegistry(), [node.id]);
  if (error) return <Err text={error} />;
  if (!data) return <Loading />;
  const items = data.filter((i: WatchedItem) => i.type === node.stats.type).sort((a, b) => Number(b.versions > 1) - Number(a.versions > 1) || b.dependent_cases - a.dependent_cases);
  return (
    <div data-testid="panel-rules">
      <p className={h}>{items.length} {tx("watched items")}</p>
      <ul className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
        {items.map((i) => (
          <li key={i.key} className="rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-2">
            <div className="flex items-start justify-between gap-2"><span className="text-xs font-semibold text-slate-800 dark:text-slate-100 break-words">{i.title}</span>
              <Link href={studioHref({ lens: "impact", impact: i.key })} className="text-[11px] font-semibold text-sky-600 whitespace-nowrap">{tx("see impact")} →</Link></div>
            <p className="text-[10px] text-slate-400 mt-0.5">v{i.version} · {i.versions > 1 ? `${tx("changed")} ${i.versions - 1}×` : tx("never changed")} · {i.dependent_cases} {tx("case(s) depend on it")}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DatasetBody({ node }: { node: StudioNode }) {
  const slug = node.stats.slug as string;
  const { data, error } = useLoad<DatasetDetail>(() => getDataset(slug), [slug]);
  const { data: items } = useLoad(() => listItems({ state: "active" }).then((r) => r.items.filter((i) => i.dataset === slug)), [slug]);
  return (
    <div data-testid="panel-dataset">
      <Row k={tx("Latest published version")} v={node.stats.latest_version ?? "—"} />
      <Row k={tx("Cases")} v={node.stats.cases} />
      <Row k={tx("Resting on an unconfirmed rule")} v={node.stats.unconfirmed} />
      <Row k={tx("Cases a real model has been run on")} v={`${node.stats.covered_cases} / ${node.stats.cases}`} />
      <Row k={tx("Runs recorded")} v={`${node.stats.runs} (${node.stats.real_runs} ${tx("with a real model")})`} />
      <Row k={tx("Last real pass rate")} v={node.stats.last_pass_rate === null || node.stats.last_pass_rate === undefined ? "—" : pct(node.stats.last_pass_rate, 1)} />
      {error && <Err text={error} />}
      {data && <><p className={`${h} mt-3`}>{tx("Versions")}</p><ul className="space-y-1">{data.versions.slice(0, 6).map((v) => <li key={v.version} className="text-xs text-slate-600 dark:text-slate-300 flex justify-between"><span>{v.version} · {v.state}</span><span>{v.case_count} {tx("cases")}{v.provisional ? ` · ${tx("provisional")}` : ""}</span></li>)}</ul></>}
      {items && items.length > 0 && <><p className={`${h} mt-3`}>{tx("Open review items")} ({items.length})</p><ul className="space-y-1">{items.slice(0, 5).map((i: DriftItem) => <li key={i.id} className="text-[11px] text-slate-600 dark:text-slate-300">{i.severity} · {i.summary.slice(0, 80)}</li>)}</ul></>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Link className={link} href={studioHref({ tool: "datasets", dataset: slug })}>{tx("Open the dataset manager")}</Link>
        <Link className={link} href={studioHref({ mode: "simulate", dataset: slug })}>{tx("Evaluate it")}</Link>
        <Link className={link} href={studioHref({ mode: "investigate", extra: { dsf: slug } })}>{tx("Its results")}</Link>
      </div>
    </div>
  );
}

function HarnessBody({ node }: { node: StudioNode }) {
  const { data, error } = useLoad<Job[]>(() => listJobs(8), [node.id, node.stats.jobs_7d]);
  const running = (node.stats.running ?? []) as Record<string, any>[];
  return (
    <div data-testid="panel-harness">
      <Row k={tx("Jobs in the last 7 days")} v={node.stats.jobs_7d} /><Row k={tx("Failed or lost in the last day")} v={node.stats.failed_1d} /><Row k={tx("Runs recorded")} v={`${node.stats.runs_total} (${node.stats.scripted_runs} ${tx("scripted")})`} />
      {running.length > 0 && <><p className={`${h} mt-3`}>{tx("Running now")}</p>{running.map((j) => <p key={j.job_id} className="text-xs text-slate-700 dark:text-slate-200">{j.dataset} {j.version} · {(j.models ?? []).filter(Boolean).join(" vs ")} · {j.executions ?? 0}/{j.planned ?? "?"}</p>)}</>}
      {error && <Err text={error} />}
      {data && <><p className={`${h} mt-3`}>{tx("Recent jobs")}</p><ul className="space-y-1">{data.slice(0, 6).map((j) => <li key={j.id} className="text-[11px] text-slate-600 dark:text-slate-300 flex justify-between"><span>{String(j.config.dataset)} {String(j.config.version)}</span><span>{j.state}</span></li>)}</ul></>}
      <div className="mt-3"><Link className={link} href={studioHref({ mode: "simulate" })}>{tx("Start or watch an evaluation")}</Link></div>
    </div>
  );
}

function DriftBody({ node }: { node: StudioNode }) {
  const { data, error } = useLoad(() => listItems({ state: "active" }), [node.id, node.stats.open]);
  return (
    <div data-testid="panel-drift">
      <Row k={tx("Waiting for a decision")} v={node.stats.open} /><Row k={tx("By severity")} v={Object.entries(node.stats.by_severity ?? {}).map(([k, v]) => `${v} ${k}`).join(", ") || "—"} /><Row k={tx("Last scan")} v={node.stats.last_scan_at ? new Date(node.stats.last_scan_at).toLocaleString() : tx("never")} />
      {error && <Err text={error} />}
      {data && <ul className="mt-3 space-y-1.5 max-h-60 overflow-y-auto pr-1">{data.items.slice(0, 8).map((i) => <li key={i.id} className="text-[11px] text-slate-600 dark:text-slate-300 rounded-lg border border-slate-200 dark:border-slate-700 px-2 py-1.5"><b className="text-slate-800 dark:text-slate-100">{i.severity}</b> · {i.kind.replace("_", " ")} — {i.summary.slice(0, 110)}</li>)}</ul>}
      <div className="mt-3 flex flex-wrap gap-2"><Link className={link} href={studioHref({ tool: "drift" })}>{tx("Open the review queue")}</Link><Link className={link} href={studioHref({ lens: "impact" })}>{tx("See what a change affects")}</Link></div>
    </div>
  );
}

function AgentBody({ node }: { node: StudioNode }) {
  const { data, error } = useLoad<Observed>(() => getObserved(), [node.id]);
  if (error) return <Err text={error} />;
  if (!data) return <Loading />;
  const rows = node.kind === "tools" ? data.tools : node.kind === "skills" ? data.skills : node.kind === "specialists" ? data.specialists : [];
  return (
    <div data-testid="panel-agent">
      {node.kind === "agent" && <><Row k={tx("Executions observed")} v={`${data.agent.executions} (${data.agent.scripted_executions} ${tx("scripted")})`} /><Row k={tx("Real-model executions that ran")} v={data.agent.ran} /><Row k={tx("Passed")} v={`${data.agent.passed}${data.agent.pass_rate === null ? "" : ` (${pct(data.agent.pass_rate, 1)})`}`} />
        <Row k={tx("Failed")} v={data.agent.failed} /><Row k={tx("Blocked or infrastructure errors")} v={`${data.agent.blocked} / ${data.agent.infrastructure_errors}`} /></>}
      {rows.length > 0 && (
        <table className="w-full text-[11px] mt-1"><thead><tr className="text-left text-slate-400"><th className="py-1 font-semibold">{node.kind === "tools" ? tx("Tool") : node.kind === "skills" ? tx("Skill") : tx("Specialist")}</th><th className="font-semibold text-right">{tx("Seen")}</th><th className="font-semibold text-right">{tx("Real pass rate")}</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.name} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1 text-slate-800 dark:text-slate-100 font-semibold">{r.name}{r.specialists.length ? <span className="block font-normal text-[10px] text-slate-400">{r.specialists.join(", ")}</span> : null}{r.tools.length ? <span className="block font-normal text-[10px] text-slate-400">{r.tools.slice(0, 6).join(", ")}</span> : null}</td>
            <td className="text-right">{r.executions}</td><td className="text-right">{r.pass_rate === null ? <span className="text-slate-400">—</span> : pct(r.pass_rate, 0)} <span className="text-slate-400">({r.ran})</span></td></tr>)}</tbody></table>
      )}
      <p className="mt-3 text-[10px] text-slate-400">{data.note}</p>
    </div>
  );
}

function ProviderBody({ node }: { node: StudioNode }) {
  const { data, error } = useLoad<ModelEntry[]>(() => listModels().then((l) => l.filter((m) => m.provider === node.stats.provider)), [node.id]);
  return (
    <div data-testid="panel-provider">
      <Row k={tx("Real runs")} v={node.stats.real_runs} /><Row k={tx("Executions that ran")} v={`${node.stats.ran}${node.stats.pass_rate === null ? "" : ` · ${pct(node.stats.pass_rate, 1)} ${tx("passed")}`}`} /><Row k={tx("Spent this month")} v={show(node.stats.spend_month_usd)} />
      {node.stats.blocked_for_key > 0 && <Row k={tx("Blocked for a missing key")} v={node.stats.blocked_for_key} />}
      {error && <Err text={error} />}
      {data && <ul className="mt-3 space-y-1.5">{data.map((m) => <li key={m.id} className="text-xs flex justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5"><span className="font-semibold text-slate-800 dark:text-slate-100">{m.model_id}<span className="block text-[10px] font-normal text-slate-400">{m.status}{m.synthetic ? ` · ${tx("scripted")}` : ""}</span></span>
        <span className="text-right text-[11px] text-slate-500">{m.current_price ? `${show(m.current_price.input_per_m)} / ${show(m.current_price.output_per_m)} ${tx("per M")}` : tx("no price")}{m.latest_benchmark?.pass_rate != null ? <span className="block">{pct(m.latest_benchmark.pass_rate, 0)} {tx("last benchmark")}</span> : null}</span></li>)}</ul>}
      {node.stats.provider !== "mock" && <div className="mt-3"><Link className={link} href={studioHref({ mode: "simulate", models: node.stats.provider })}>{tx("Benchmark these models")}</Link></div>}
    </div>
  );
}

function DeepEvalBody({ node }: { node: StudioNode }) {
  const metrics = Object.entries((node.stats.metrics ?? {}) as Record<string, { n: number; mean: number; met: number }>);
  return (
    <div data-testid="panel-deepeval">
      <Row k={tx("Judges used")} v={(node.stats.judges ?? []).join(", ") || "—"} /><Row k={tx("Judge calls that failed")} v={node.stats.judge_errors} />
      {metrics.length > 0 ? <table className="w-full text-[11px] mt-2"><thead><tr className="text-left text-slate-400"><th className="py-1 font-semibold">{tx("Metric")}</th><th className="font-semibold text-right">{tx("Scored")}</th><th className="font-semibold text-right">{tx("Mean")}</th><th className="font-semibold text-right">{tx("Threshold met")}</th></tr></thead>
        <tbody>{metrics.map(([m, v]) => <tr key={m} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1 capitalize">{m.replace("_", " ")}</td><td className="text-right">{v.n}</td><td className="text-right">{v.mean.toFixed(2)}</td><td className="text-right">{pct(v.met, 0)}</td></tr>)}</tbody></table> : <p className="text-xs text-slate-400 mt-2">{tx("No judged score has been recorded yet.")}</p>}
    </div>
  );
}

function LakeBody({ node }: { node: StudioNode }) {
  const layers = (node.stats.objects_by_layer ?? {}) as Record<string, number>;
  const states = (node.stats.objects_by_state ?? {}) as Record<string, number>;
  return (
    <div data-testid="panel-lake">
      {Object.entries(layers).map(([k, v]) => <Row key={k} k={`${k} ${tx("objects")}`} v={v} />)}
      <Row k={tx("Published versions")} v={node.stats.published_versions} />
      {Object.entries(states).map(([k, v]) => <Row key={k} k={`${tx("State")}: ${k}`} v={v} />)}
      <Row k={tx("Corrupt or missing")} v={node.stats.corrupt_or_missing} />
      <div className="mt-3"><Link className={link} href={studioHref({ tool: "datasets" })}>{tx("Open the dataset manager")}</Link></div>
    </div>
  );
}

function ResultsBody({ node }: { node: StudioNode }) {
  const by = (node.stats.by_status ?? {}) as Record<string, number>;
  return (
    <div data-testid="panel-results">
      {["passed", "failed", "blocked", "skipped", "infrastructure_error"].map((s) => <Row key={s} k={s.replace("_", " ")} v={by[s] ?? 0} />)}
      <Row k={tx("Critical failures")} v={node.stats.critical_failures} />
      <div className="mt-3 flex flex-wrap gap-2"><Link className={link} href={studioHref({ mode: "investigate" })}>{tx("Investigate results")}</Link><Link className={link} href={studioHref({ mode: "investigate", extra: { st: "failed" } })}>{tx("Only the failures")}</Link></div>
    </div>
  );
}

function CostsBody({ node }: { node: StudioNode }) {
  const { data, error } = useLoad<CostOverview>(() => getCostOverview(), [node.id]);
  return (
    <div data-testid="panel-costs">
      <Row k={tx("Spent this month")} v={show(node.stats.month_usd)} />
      {(["day", "month"] as const).map((k) => { const b = node.stats.budget?.[k]; return b ? <Row key={k} k={k === "day" ? tx("Today's limit") : tx("Monthly limit")} v={b.limit_usd === null ? tx("none set") : `${show(b.spent_usd + b.reserved_usd)} / ${show(b.limit_usd)}`} /> : null; })}
      {node.stats.unknown_lines > 0 && <Row k={tx("Lines that could not be priced")} v={node.stats.unknown_lines} />}
      {error && <Err text={error} />}
      {data && <><Row k={tx("Confirmed by a provider bill")} v={show(data.month.certainty.confirmed_usd)} /><Row k={tx("Estimated from tokens")} v={show(data.month.certainty.estimated_usd)} /><Row k={tx("Provider bills needing a look")} v={data.statements.needs_attention} /></>}
      <div className="mt-3 flex flex-wrap gap-2"><Link className={link} href={studioHref({ tool: "costs" })}>{tx("Open costs & budgets")}</Link><Link className={link} href={studioHref({ mode: "investigate", sub: "compare" })}>{tx("Compare cost with quality")}</Link></div>
    </div>
  );
}

/** What a node is, how healthy it is and why, its own live numbers, and what it is connected to (click one to move there). */
export default function NodePanel({ node, graph, onSelect, onClose }: { node: StudioNode; graph: StudioGraph; onSelect: (id: string) => void; onClose: () => void }) {
  const c = HEALTH_COLOR[node.health.state];
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  const connected = graph.edges.filter((e) => e.from === node.id || e.to === node.id).map((e) => ({ other: byId[e.from === node.id ? e.to : e.from], dir: e.from === node.id ? "→" : "←", label: e.label, weight: e.weight })).filter((x) => x.other);
  return (
    <aside className="studio-rise rounded-xl border border-slate-200 dark:border-slate-700 bg-white/90 dark:bg-slate-900/90 backdrop-blur p-4 space-y-3" aria-label={`${node.label} ${tx("details")}`} data-testid="node-panel">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{KIND_ICON[node.kind] ?? "•"} {tx(node.kind)}</p>
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-50 leading-tight">{node.label}</h2>
        </div>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-lg leading-none" aria-label={tx("Close details")}>×</button>
      </div>
      {KIND_HELP[node.kind] && <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600 dark:bg-slate-800/60 dark:text-slate-300" data-testid="node-help"><b className="text-slate-800 dark:text-slate-100">{tx("What this is")}: </b>{tx(KIND_HELP[node.kind])}</p>}
      <p className={`text-xs ${c.text}`}><span className="inline-block h-2 w-2 rounded-full mr-1.5 align-middle" style={{ background: c.dot }} /><b>{tx(c.label)}</b> — {node.health.reason}</p>
      <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
        {node.kind === "rules" && <RulesBody node={node} />}
        {node.kind === "dataset" && <DatasetBody node={node} />}
        {node.kind === "harness" && <HarnessBody node={node} />}
        {node.kind === "drift" && <DriftBody node={node} />}
        {(node.kind === "agent" || node.kind === "specialists" || node.kind === "skills" || node.kind === "tools") && <AgentBody node={node} />}
        {node.kind === "provider" && <ProviderBody node={node} />}
        {node.kind === "deepeval" && <DeepEvalBody node={node} />}
        {node.kind === "lake" && <LakeBody node={node} />}
        {node.kind === "results" && <ResultsBody node={node} />}
        {node.kind === "costs" && <CostsBody node={node} />}
      </div>
      {connected.length > 0 && (
        <div className="border-t border-slate-100 dark:border-slate-800 pt-3">
          <p className={h}>{tx("Connected to")}</p>
          <ul className="space-y-1">{connected.map((x, i) => <li key={i}><button type="button" onClick={() => onSelect(x.other.id)} className="w-full text-left text-[11px] text-slate-600 dark:text-slate-300 hover:text-sky-600 flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: HEALTH_COLOR[x.other.health.state].dot }} />{x.dir} {x.other.label}<span className="text-slate-400"> · {x.label}</span></button></li>)}</ul>
        </div>
      )}
    </aside>
  );
}
