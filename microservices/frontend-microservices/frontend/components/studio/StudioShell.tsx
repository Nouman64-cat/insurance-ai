"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import CostsWorkspace from "@/components/costs/CostsWorkspace";
import DatasetsWorkspace from "@/components/evaluation/DatasetsWorkspace";
import DriftWorkspace from "@/components/evaluation/DriftWorkspace";
import { tx } from "@/lib/i18n/tx";
import { HEALTH_COLOR, MODES, STUDIO_ROOT, TOOLS, getGraph, studioHref, type ModeId, type StudioGraph, type ToolId } from "@/lib/evalStudio";
import { useQueryState } from "@/lib/useQueryState";
import CommandPalette from "./CommandPalette";
import ExploreView from "./ExploreView";
import InvestigateView from "./InvestigateView";
import SimulateView from "./SimulateView";

/** The overall state of the ecosystem as one pill in the header: the worst thing on the map and how many nodes are affected. */
export function StatePill({ graph }: { graph: StudioGraph | null }) {
  if (!graph) return <span className="h-6 w-24 animate-pulse rounded-full bg-slate-100 dark:bg-slate-800" aria-hidden />;
  const bad = graph.health.bad ?? 0, warn = graph.health.warn ?? 0;
  const s = bad ? "bad" : warn ? "warn" : (graph.health.ok ?? 0) > 0 ? "ok" : "unknown";
  return (
    <Link href={studioHref({ extra: { hf: bad ? "bad" : warn ? "warn" : "" } })} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200" data-testid="state-pill" data-state={s}
      title={tx("Open the map filtered to what needs attention")}>
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: HEALTH_COLOR[s].dot }} />
      {bad ? `${bad} ${tx("failing")}${warn ? `, ${warn} ${tx("to watch")}` : ""}` : warn ? `${warn} ${tx("to watch")}` : s === "ok" ? tx("all healthy") : tx("not enough evidence")}
    </Link>
  );
}

const navLink = (on: boolean) => `flex-none whitespace-nowrap border-b-2 px-3 pb-2 pt-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${on ? "border-blue-600 text-blue-700 dark:border-sky-400 dark:text-sky-200" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"}`;

function Studio() {
  const [modeParam] = useQueryState("mode", "explore");
  const [toolParam] = useQueryState("tool");
  const mode = (MODES.some((m) => m.id === modeParam) ? modeParam : "explore") as ModeId;
  const tool = TOOLS.find((t) => t.id === toolParam)?.id as ToolId | undefined;
  const [graph, setGraph] = useState<StudioGraph | null>(null);
  const [palette, setPalette] = useState(false);
  const load = useCallback(() => getGraph().then(setGraph).catch(() => undefined), []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="mx-auto w-full max-w-screen-2xl min-w-0 px-4 py-3 sm:px-6" data-testid="studio">
      <a href="#studio-main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-blue-600 focus:px-3 focus:py-2 focus:text-xs focus:font-semibold focus:text-white">{tx("Skip to the content")}</a>
      <header className="sticky top-0 z-30 -mx-4 mb-4 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90 sm:-mx-6" data-testid="studio-header">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pb-1 pt-2.5 sm:px-6">
          <Link href={STUDIO_ROOT} className="flex items-center gap-2 text-sm font-bold tracking-tight text-slate-900 dark:text-slate-50">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-cyan-400 text-[11px] text-white" aria-hidden>◉</span>{tx("Evaluation Studio")}
          </Link>
          <StatePill graph={graph} />
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => setPalette(true)} className="flex w-44 items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-400 hover:border-sky-400 dark:border-slate-700 dark:bg-slate-900 sm:w-64" data-testid="search-button" aria-label={tx("Search the studio")}>
              <span>{tx("Search or jump to…")}</span><kbd className="rounded border border-slate-200 px-1 text-[10px] dark:border-slate-600">Ctrl K</kbd>
            </button>
            <Link href={studioHref({ mode: "simulate" })} className="hidden rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 sm:inline-block" data-testid="quick-run">{tx("New evaluation")}</Link>
          </div>
        </div>

        {/* the three ways to look at the ecosystem; the sections it manages (datasets, drift, costs, form templates) are in the sidebar */}
        <nav className="flex items-end gap-1 overflow-x-auto px-4 sm:px-6" aria-label={tx("Studio sections")} data-testid="studio-nav">
          {MODES.map((m) => {
            const on = !tool && mode === m.id;
            return <Link key={m.id} href={studioHref({ mode: m.id })} aria-current={on ? "page" : undefined} title={tx(m.hint)} data-mode={m.id} className={navLink(on)}>{tx(m.label)}</Link>;
          })}
        </nav>
      </header>

      <main id="studio-main" className="studio-rise" data-testid="studio-main">
        {tool === "datasets" && <DatasetsWorkspace />}
        {tool === "drift" && <DriftWorkspace />}
        {tool === "costs" && <CostsWorkspace />}
        {!tool && mode === "explore" && <ExploreView />}
        {!tool && mode === "simulate" && <SimulateView />}
        {!tool && mode === "investigate" && <InvestigateView />}
      </main>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}

export default function StudioShell() {
  return <Suspense fallback={null}><Studio /></Suspense>;
}
