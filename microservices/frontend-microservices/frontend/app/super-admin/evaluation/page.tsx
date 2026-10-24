"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CENTER_ROOT, TEMPLATES_ROUTE } from "@/lib/evaluationCenter";
import { getOverview, type DriftOverview } from "@/lib/evalDrift";
import { listBenchmarks, listDatasets, listJobs, type BenchmarkListItem, type DatasetSummary, type Job } from "@/lib/evalBenchmarks";
import { listTemplates, type TemplateSummary } from "@/lib/templates";
import { tx } from "@/lib/i18n/tx";

const card = "rounded-xl border border-slate-200 bg-white p-4";
const link = "px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-slate-300";
const when = (s?: string | null) => (s ? new Date(s).toLocaleString() : "—");

/** Each block loads on its own, so one slow or failing service never blanks the page. A failure says so instead of showing zeros. */
function useLoaded<T>(load: () => Promise<T>): { data: T | null; failed: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { load().then(setData).catch(() => setFailed(true)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  return { data, failed };
}

function Block({ title, href, action, failed, children }: { title: string; href: string; action: string; failed: boolean; children: React.ReactNode }) {
  return (
    <section className={card}>
      <div className="flex items-start justify-between gap-2 mb-2"><h2 className="text-sm font-bold text-slate-800">{title}</h2><Link href={href} className="text-xs font-semibold text-blue-600 hover:underline whitespace-nowrap">{action} →</Link></div>
      {failed ? <p className="text-xs text-red-600">{tx("Could not be loaded.")}</p> : children}
    </section>
  );
}

export default function OverviewPage() {
  const datasets = useLoaded<DatasetSummary[]>(listDatasets);
  const drift = useLoaded<DriftOverview>(getOverview);
  const benchmarks = useLoaded<BenchmarkListItem[]>(() => listBenchmarks(5));
  const jobs = useLoaded<Job[]>(() => listJobs(20));
  const templates = useLoaded<TemplateSummary[]>(listTemplates);
  const running = (jobs.data ?? []).filter((j) => !["succeeded", "failed", "cancelled", "lost"].includes(j.state));
  const failedRecently = (jobs.data ?? []).filter((j) => j.state === "failed").length;

  return (
    <div className="space-y-4" data-testid="overview">
      <div className="flex flex-wrap gap-2">
        <Link className={link} href={`${CENTER_ROOT}/benchmarking`} data-testid="act-benchmark">{tx("New benchmark")}</Link>
        <Link className={link} href={`${CENTER_ROOT}/drift?state=active`}>{tx("Review open findings")}</Link>
        <Link className={link} href={`${CENTER_ROOT}/datasets`}>{tx("Open datasets")}</Link>
        <Link className={link} href={TEMPLATES_ROUTE}>{tx("Edit form templates")}</Link>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Block title={tx("Datasets")} href={`${CENTER_ROOT}/datasets`} action={tx("Manage")} failed={datasets.failed}>
          {!datasets.data ? <p className="text-xs text-slate-400">{tx("Loading…")}</p> : datasets.data.length === 0 ? <p className="text-xs text-slate-400">{tx("No datasets yet.")}</p> : (
            <ul className="text-xs divide-y divide-slate-100">{datasets.data.map((d) => (
              <li key={d.slug} className="py-1.5 flex justify-between gap-2"><Link className="text-slate-700 hover:text-blue-600" href={`${CENTER_ROOT}/datasets?dataset=${encodeURIComponent(d.slug)}`}>{d.name}</Link><span className="text-slate-400">{d.latest_version ? `v${d.latest_version}` : tx("unpublished")}</span></li>))}</ul>
          )}
        </Block>
        <Block title={tx("Drift & change review")} href={`${CENTER_ROOT}/drift`} action={tx("Review")} failed={drift.failed}>
          {!drift.data ? <p className="text-xs text-slate-400">{tx("Loading…")}</p> : (
            <div className="text-xs space-y-1">
              <div className="text-2xl font-bold text-slate-800" data-testid="open-count">{drift.data.open}</div>
              <div className="text-slate-500">{tx("findings need a decision")}</div>
              <div className="flex gap-3 pt-1">{(["critical", "high", "medium", "low"] as const).map((s) => <Link key={s} href={`${CENTER_ROOT}/drift?state=active&severity=${s}`} className="text-slate-600 hover:text-blue-600">{s} <b>{drift.data!.open_by_severity[s] ?? 0}</b></Link>)}</div>
              <div className="text-slate-400 pt-1">{drift.data.last_scan ? `${tx("Last scan")}: ${when(drift.data.last_scan.at)}` : tx("No scan yet.")}</div>
            </div>
          )}
        </Block>
        <Block title={tx("Form templates")} href={TEMPLATES_ROUTE} action={tx("Manage")} failed={templates.failed}>
          {!templates.data ? <p className="text-xs text-slate-400">{tx("Loading…")}</p> : (
            <ul className="text-xs divide-y divide-slate-100">{templates.data.map((t) => (
              <li key={t.key} className="py-1.5 flex justify-between gap-2"><Link className="text-slate-700 hover:text-blue-600" href={`${TEMPLATES_ROUTE}?key=${encodeURIComponent(t.key)}`}>{t.title}</Link><span className="text-slate-400">v{t.published_version ?? "–"}{t.has_draft ? ` · ${tx("draft")}` : ""}</span></li>))}</ul>
          )}
        </Block>
        <Block title={tx("Running now")} href={`${CENTER_ROOT}/benchmarking?view=jobs`} action={tx("Jobs")} failed={jobs.failed}>
          {!jobs.data ? <p className="text-xs text-slate-400">{tx("Loading…")}</p> : running.length === 0 ? <p className="text-xs text-slate-400">{tx("Nothing is running.")}{failedRecently > 0 ? ` ${failedRecently} ${tx("recent job(s) failed.")}` : ""}</p> : (
            <ul className="text-xs divide-y divide-slate-100">{running.map((j) => <li key={j.id} className="py-1.5 flex justify-between"><span className="text-slate-700">{String(j.config.dataset)} {String(j.config.version)}</span><span className="text-slate-400">{j.state}</span></li>)}</ul>
          )}
        </Block>
        <Block title={tx("Latest benchmarks")} href={`${CENTER_ROOT}/benchmarking?view=results`} action={tx("Compare")} failed={benchmarks.failed}>
          {!benchmarks.data ? <p className="text-xs text-slate-400">{tx("Loading…")}</p> : benchmarks.data.length === 0 ? <p className="text-xs text-slate-400">{tx("No benchmarks yet.")}</p> : (
            <ul className="text-xs divide-y divide-slate-100">{benchmarks.data.map((b) => (
              <li key={b.benchmark_id} className="py-1.5"><Link className="text-slate-700 hover:text-blue-600" href={`${CENTER_ROOT}/benchmarking?view=results&benchmark=${encodeURIComponent(b.benchmark_id)}`}>{b.models.map((m) => m.label).join(" vs ")}</Link>
                <span className="block text-[10px] text-slate-400">{b.dataset} {b.dataset_version} · {b.repetitions}× · {when(b.created_at)}{b.synthetic ? ` · ${tx("synthetic")}` : ""}</span></li>))}</ul>
          )}
        </Block>
      </div>
    </div>
  );
}
