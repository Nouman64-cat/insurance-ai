"use client";

import { useCallback, useEffect, useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import LiveRun from "@/components/benchmarking/LiveRun";
import Results from "@/components/benchmarking/Results";
import SetupPanel from "@/components/benchmarking/SetupPanel";
import { tx } from "@/lib/i18n/tx";
import { useQueryState } from "@/lib/useQueryState";
import { cancelJob, listJobs, rerunJob, runsOfJob, usd, type Job } from "@/lib/evalBenchmarks";

type Tab = "new" | "live" | "results" | "jobs";
const TERMINAL = ["succeeded", "failed", "cancelled", "lost"];
const btnGhost = "px-2.5 py-1 text-[11px] font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 disabled:opacity-40 transition-all";

export function JobsTab({ onOpen, onResults, onRerun }: { onOpen: (j: Job) => void; onResults: (benchmarkId: string) => void; onRerun: (j: Job) => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => listJobs(40).then(setJobs).catch((e) => setError(e instanceof Error ? e.message : "Could not list jobs.")), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function openResults(j: Job) {
    try {
      const group = (await runsOfJob(j.id)).find((r) => r.group_id)?.group_id;
      if (group) onResults(group);
      else setError("This job has no stored benchmark yet.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not find the results.");
    }
  }

  return (
    <div className="space-y-3">
      {error && <div className="text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600">{error}</div>}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-xs" data-testid="jobs-table">
          <thead><tr className="text-left text-slate-400 border-b border-slate-100"><th className="px-3 py-2 font-semibold">{tx("Requested")}</th><th className="font-semibold">{tx("State")}</th><th className="font-semibold">{tx("What")}</th><th className="font-semibold">{tx("Estimate")}</th><th /></tr></thead>
          <tbody>
            {jobs.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-slate-400">{tx("No jobs yet.")}</td></tr>}
            {jobs.map((j) => (
              <tr key={j.id} className="border-t border-slate-100 align-top">
                <td className="px-3 py-2 whitespace-nowrap text-slate-500">{new Date(j.created_at).toLocaleString()}</td>
                <td className="py-2"><span className="font-semibold text-slate-700">{j.state}</span></td>
                <td className="py-2 text-slate-600">{String(j.config.kind).replace("benchmark_", "")} · {String(j.config.dataset)} {String(j.config.version)}<span className="block text-[10px] text-slate-400">{((j.config.models as string[] | undefined) ?? [String(j.config.model ?? "")]).join(" vs ")} ×{String(j.config.repeat)}</span></td>
                <td className="py-2 text-slate-600">{j.estimate.cost?.usd ? usd(j.estimate.cost.usd.total) : "—"}</td>
                <td className="py-2 pr-3 text-right whitespace-nowrap space-x-1">
                  <button type="button" className={btnGhost} onClick={() => onOpen(j)}>{TERMINAL.includes(j.state) ? tx("View") : tx("Monitor")}</button>
                  {TERMINAL.includes(j.state) && j.run_id !== undefined && <button type="button" className={btnGhost} onClick={() => openResults(j)}>{tx("Results")}</button>}
                  {TERMINAL.includes(j.state) ? <button type="button" className={btnGhost} onClick={() => onRerun(j)}>{tx("Rerun")}</button>
                    : <button type="button" className={`${btnGhost} text-red-600`} onClick={() => setCancelling(j)}>{tx("Cancel")}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cancelling && (
        <ConfirmDialog title={tx("Cancel this job?")} confirmLabel={tx("Cancel the job")} cancelLabel={tx("Keep it")} busy={busy} onCancel={() => setCancelling(null)}
          onConfirm={async () => { setBusy(true); try { await cancelJob(cancelling.id); setCancelling(null); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Could not cancel."); setCancelling(null); } finally { setBusy(false); } }}>
          <p className="text-sm text-slate-600">{tx("A queued job is dropped; a running one finishes the case in flight, then stops and keeps what it has.")}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export default function BenchmarkingWorkspace() {
  const [tabParam, setTab] = useQueryState("view", "new");
  const [job, setJob] = useState<Job | null>(null);
  const tab = (["new", "results", "jobs"].includes(tabParam) || (tabParam === "live" && job) ? tabParam : "new") as Tab;
  const [benchmarkParam, setBenchmark] = useQueryState("benchmark");
  const benchmarkId = benchmarkParam || null;
  const setBenchmarkId = (id: string | null) => setBenchmark(id ?? "");

  const openJob = (j: Job) => { setJob(j); setTab("live"); };
  const openResults = (id: string) => { setBenchmarkId(id); setTab("results"); };
  async function rerun(j: Job) {
    try { openJob(await rerunJob(j.id)); } catch { setTab("jobs"); }
  }

  const tabs: { id: Tab; label: string; hidden?: boolean }[] = [
    { id: "new", label: tx("New benchmark") }, { id: "live", label: tx("Live run"), hidden: !job }, { id: "results", label: tx("Results & comparison") }, { id: "jobs", label: tx("Jobs") },
  ];

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-2xl mx-auto w-full min-w-0 overflow-x-hidden font-sans">
      <div>
        <h2 className="text-xl font-bold text-slate-900 tracking-tight">{tx("Model Benchmarking")}</h2>
        <p className="text-sm text-slate-500 mt-0.5 max-w-3xl">
          {tx("Compare GPT, Gemini and Claude on the published evaluation datasets: pick the models, see the cost before you spend it, watch the run, then compare accuracy, reliability, speed and cost side by side.")}
        </p>
      </div>
      <div className="flex gap-1 border-b border-slate-200" role="tablist">
        {tabs.filter((t) => !t.hidden).map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px ${tab === t.id ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}>{t.label}</button>
        ))}
      </div>
      {tab === "new" && <SetupPanel onStarted={openJob} />}
      {tab === "live" && job && <LiveRun job={job} onJob={setJob} onOpenResults={openResults} />}
      {tab === "results" && <Results initialId={benchmarkId} onOpened={setBenchmarkId} />}
      {tab === "jobs" && <JobsTab onOpen={openJob} onResults={openResults} onRerun={rerun} />}
    </div>
  );
}
