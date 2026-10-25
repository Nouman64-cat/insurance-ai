"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { HEALTH_COLOR, HEALTH_ORDER, KIND_HELP, LAYER_HELP, getGraph, headline, sameGraph, type Health, type StudioGraph } from "@/lib/evalStudio";
import { useQueryState } from "@/lib/useQueryState";
import EcosystemMap from "./EcosystemMap";
import ImpactExplorer from "./ImpactExplorer";
import NodePanel from "./NodePanel";

const seg2 = (on: boolean) => `rounded-full px-3.5 py-1 text-xs font-semibold transition-colors ${on ? "bg-white text-blue-700 shadow-sm dark:bg-slate-700 dark:text-sky-200" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"}`;

/** The health of the whole ecosystem at a glance: how many nodes are in each state. Clicking a state shows only those nodes. */
export function HealthStrip({ graph, only, onToggle }: { graph: StudioGraph; only: Set<Health>; onToggle: (h: Health) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={tx("Filter the map by health")} data-testid="health-strip">
      {HEALTH_ORDER.map((h) => {
        const n = graph.health[h] ?? 0;
        return (
          <button key={h} type="button" disabled={n === 0} aria-pressed={only.has(h)} onClick={() => onToggle(h)} data-health={h}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold disabled:opacity-40 ${only.has(h) ? "border-sky-500 bg-sky-50 dark:bg-sky-950/40" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`}>
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: HEALTH_COLOR[h].dot }} />{n} {tx(HEALTH_COLOR[h].label)}
          </button>
        );
      })}
    </div>
  );
}

/** The one sentence that says how the ecosystem stands, with a button to the part that needs the most attention. */
export function Headline({ graph, onLook }: { graph: StudioGraph; onLook: (id: string) => void }) {
  const h = headline(graph);
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-2.5 ${h.state === "bad" ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30" : h.state === "warn" ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30" : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"}`} data-testid="headline" data-state={h.state}>
      <span className="inline-block h-2.5 w-2.5 flex-none rounded-full" style={{ background: HEALTH_COLOR[h.state].dot }} aria-hidden />
      <p className="min-w-0 flex-1 text-xs text-slate-800 dark:text-slate-100">{tx(h.text)}</p>
      {h.nodeId && <button type="button" onClick={() => onLook(h.nodeId!)} className="flex-none rounded-lg bg-white px-3 py-1 text-[11px] font-semibold text-blue-700 shadow-sm ring-1 ring-slate-200 hover:ring-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:bg-slate-800 dark:text-sky-200 dark:ring-slate-600">{tx("Show me")}</button>}
    </div>
  );
}

/** What the map is and how to read it, for someone seeing it the first time: closes for good once understood, and comes back from the "How to read this" button. */
export function Primer({ graph, onClose }: { graph: StudioGraph; onClose: () => void }) {
  const layers = graph.layers;
  return (
    <section className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 dark:border-blue-900 dark:bg-blue-950/20" aria-label={tx("How to read this map")} data-testid="primer">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-50">{tx("What you are looking at")}</h2>
          <p className="mt-0.5 max-w-3xl text-xs text-slate-600 dark:text-slate-300">{tx("Every part of the system that decides whether the Insurance AI can be trusted, on one map: what it is built on, the approved tests, the test harness, the agent being tested, the models that answer, and the results and cost. Everything here is read live from the platform's records, nothing is typed in.")}</p>
        </div>
        <button type="button" onClick={onClose} className="flex-none rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300" data-testid="primer-close">{tx("Got it")}</button>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div>
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{tx("Read it left to right")}</h3>
          <ol className="mt-1.5 space-y-1 text-[11px] text-slate-600 dark:text-slate-300">
            {layers.map((l, i) => <li key={l}><b className="text-slate-800 dark:text-slate-100">{i + 1}. {tx(l)}</b>: {tx(LAYER_HELP[l] ?? "")}</li>)}
          </ol>
        </div>
        <div>
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{tx("What the marks mean")}</h3>
          <ul className="mt-1.5 space-y-1.5 text-[11px] text-slate-600 dark:text-slate-300">
            {HEALTH_ORDER.map((h) => <li key={h} className="flex items-center gap-2"><span className="inline-block h-2.5 w-2.5 flex-none rounded-full" style={{ background: HEALTH_COLOR[h].dot }} aria-hidden /><b className="text-slate-800 dark:text-slate-100">{tx(HEALTH_COLOR[h].label)}</b>{h === "unknown" ? `: ${tx("no run yet, so nothing is claimed")}` : h === "ok" ? `: ${tx("what has been measured is fine")}` : h === "warn" ? `: ${tx("worth a look")}` : `: ${tx("something is wrong")}`}</li>)}
            <li className="flex items-center gap-2"><svg width="26" height="8" aria-hidden className="flex-none"><path d="M1 4h24" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" /></svg>{tx("a link: one part feeds or uses the other; thicker carries more")}</li>
            <li className="flex items-center gap-2"><svg width="26" height="8" aria-hidden className="flex-none"><path d="M1 4h24" stroke="#0ea5e9" strokeWidth="2" strokeDasharray="5 4" strokeLinecap="round" /></svg>{tx("moving dashes: an evaluation is running through it right now")}</li>
          </ul>
        </div>
        <div>
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{tx("Try it")}</h3>
          <ul className="mt-1.5 space-y-1 text-[11px] text-slate-600 dark:text-slate-300">
            <li><b className="text-slate-800 dark:text-slate-100">{tx("Hover")}</b> {tx("a part to light up everything it is connected to.")}</li>
            <li><b className="text-slate-800 dark:text-slate-100">{tx("Click")}</b> {tx("a part to see why it has that colour, its numbers, and what you can do about it.")}</li>
            <li><b className="text-slate-800 dark:text-slate-100">{tx("Filter")}</b> {tx("with the buttons above to show only what is failing.")}</li>
            <li><b className="text-slate-800 dark:text-slate-100">{tx("Keyboard")}</b>: {tx("Tab to the map, arrow keys move between parts, Enter opens, Esc closes.")}</li>
            <li><b className="text-slate-800 dark:text-slate-100">{tx("Change impact")}</b> {tx("(top of the page) follows one changed rule or template to the tests and results it affects.")}</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

/** Whether the window is at least this wide (the details sit beside the map on a wide screen and under it on a narrow one). */
function useWide(query = "(min-width: 1024px)"): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return wide;
}

const STORE = "studioExplorePrimer";
const seen = () => { try { return window.localStorage.getItem(STORE) === "seen"; } catch { return false; } };         // a per-viewer convenience only; without storage the primer simply shows each time
const markSeen = () => { try { window.localStorage.setItem(STORE, "seen"); } catch { /* private window: shown again next time */ } };

const ZOOMS = [{ id: "fit", label: "Fit", value: 0 }, { id: "100", label: "100%", value: 1 }, { id: "125", label: "125%", value: 1.25 }, { id: "150", label: "150%", value: 1.5 }] as const;

export default function ExploreView() {
  const [lens, setLens] = useQueryState("lens", "map");
  const [node, setNode] = useQueryState("node");
  const [hf, setHf] = useQueryState("hf");
  const [zoomId, setZoomId] = useQueryState("zoom", "fit", { replace: true });
  const [help, setHelp] = useState(false);
  useEffect(() => { setHelp(!seen()); }, []);
  const closeHelp = () => { markSeen(); setHelp(false); };
  const [graph, setGraph] = useState<StudioGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => getGraph().then((g) => { setGraph((prev) => (sameGraph(prev, g) ? prev : g)); setError(null); }).catch((e) => setError(e instanceof Error ? e.message : "Could not load the ecosystem.")), []);
  useEffect(() => { load(); }, [load]);
  const running = (graph?.running.length ?? 0) > 0;
  useEffect(() => { const t = setInterval(load, running ? 5000 : 30000); return () => clearInterval(t); }, [load, running]);
  const only = useMemo(() => new Set((hf ? hf.split(",") : []).filter((x) => HEALTH_ORDER.includes(x as Health)) as Health[]), [hf]);
  const toggle = (h: Health) => { const n = new Set(only); n.has(h) ? n.delete(h) : n.add(h); setHf(Array.from(n).join(",")); };
  const selected = graph?.nodes.find((n) => n.id === node) ?? null;
  const zoom = ZOOMS.find((z) => z.id === zoomId) ?? ZOOMS[0];
  const wide = useWide();
  const needs = graph ? graph.nodes.filter((n) => n.health.state === "bad" || n.health.state === "warn").sort((a, b) => HEALTH_ORDER.indexOf(a.health.state) - HEALTH_ORDER.indexOf(b.health.state)) : [];
  return (
    <div className="space-y-3" data-testid="explore-view">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-50">{lens === "impact" ? tx("Change impact") : tx("Evaluation ecosystem")}</h2>
          <p className="max-w-2xl text-xs text-slate-500">{lens === "impact" ? tx("Follow one changed rule, plan, workflow or form template to the tests, reviews and results it affects.") : tx("A live map of what the Insurance AI is tested with and how each part is doing. Click any part to see why.")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-full border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-900" role="group" aria-label={tx("View")}>
            <button type="button" aria-pressed={lens !== "impact"} onClick={() => setLens("map")} className={seg2(lens !== "impact")}>{tx("Ecosystem map")}</button>
            <button type="button" aria-pressed={lens === "impact"} onClick={() => setLens("impact")} className={seg2(lens === "impact")} data-testid="lens-impact">{tx("Change impact")}</button>
          </div>
          {lens !== "impact" && <button type="button" onClick={() => (help ? closeHelp() : setHelp(true))} aria-expanded={help} aria-controls="explore-primer" data-testid="help-toggle"
            className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-blue-400 hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"><span aria-hidden>? </span>{tx("How to read this")}</button>}
        </div>
      </div>
      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{error}</p>}

      {lens === "impact" ? <ImpactExplorer /> : !graph ? (
        <div aria-busy="true" aria-label={tx("Loading the ecosystem")} className="space-y-3" data-testid="map-loading">
          <div className="h-11 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]"><div className="h-[26rem] animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" /><div className="hidden h-[26rem] animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800 lg:block" /></div>
        </div>
      ) : (
        <>
          {help && <div id="explore-primer"><Primer graph={graph} onClose={closeHelp} /></div>}
          <Headline graph={graph} onLook={(id) => setNode(id)} />
          <div className="flex flex-wrap items-center gap-2">
            <HealthStrip graph={graph} only={only} onToggle={toggle} />
            <div className="ml-auto flex items-center gap-2">
              <div className="flex gap-0.5 rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900" role="group" aria-label={tx("Zoom")} data-testid="zoom">
                {ZOOMS.map((z) => <button key={z.id} type="button" aria-pressed={zoom.id === z.id} onClick={() => setZoomId(z.id)} className={`rounded-md px-2 py-1 text-[11px] font-semibold ${zoom.id === z.id ? "bg-blue-600 text-white" : "text-slate-500 hover:text-slate-800"}`}>{z.id === "fit" ? tx("Fit") : z.label}</button>)}
              </div>
              <button type="button" onClick={load} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">{tx("Refresh")}</button>
            </div>
          </div>
          {/* the map takes the whole width; a part's details slide in beside it only when one is selected, and the parts that need attention sit under the map instead of beside it */}
          <div className="grid items-start transition-[grid-template-columns,column-gap] duration-300 ease-out motion-reduce:transition-none" data-testid="map-stage" data-open={selected ? "true" : "false"}
            style={wide ? { gridTemplateColumns: selected ? "minmax(0,1fr) minmax(0,22rem)" : "minmax(0,1fr) minmax(0,0rem)", columnGap: selected ? "1rem" : "0rem" } : { gridTemplateColumns: "minmax(0,1fr)", rowGap: "0.75rem" }}>
            <div className="min-w-0">
              <EcosystemMap graph={graph} selected={node || null} onSelect={(id) => setNode(id ?? "")} only={only} zoom={zoom.value} />
            </div>
            <div className="min-w-0 overflow-hidden lg:sticky lg:top-24" aria-hidden={!selected}>
              {selected && <NodePanel key={selected.id} node={selected} graph={graph} onSelect={(id) => setNode(id)} onClose={() => setNode("")} />}
            </div>
          </div>
          <p className="text-[10px] text-slate-400">{graph.note} · {tx("updated")} {new Date(graph.as_of).toLocaleTimeString()} · {tx("refreshes by itself")}</p>

          <section aria-label={tx("Parts that need attention")} data-testid="map-hint">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{needs.length > 0 ? tx("Start with these") : tx("Needs attention")}</h3>
              <p className="text-[11px] text-slate-500">{tx("Click a card, or any part of the map, to see inside it.")}</p>
            </div>
            {needs.length === 0 ? <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-emerald-700 dark:border-slate-700 dark:bg-slate-900">{tx("Nothing needs attention right now.")}</p> : (
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {needs.map((n) => (
                  <li key={n.id}><button type="button" onClick={() => setNode(n.id)} aria-pressed={node === n.id}
                    className={`h-full w-full rounded-xl border bg-white px-3 py-2.5 text-left transition-colors hover:border-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 dark:bg-slate-900 ${node === n.id ? "border-blue-500" : "border-slate-200 dark:border-slate-700"}`}>
                    <span className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-100"><span className="inline-block h-2 w-2 flex-none rounded-full" style={{ background: HEALTH_COLOR[n.health.state].dot }} />{n.label}</span>
                    <span className="mt-0.5 block pl-4 text-[11px] text-slate-500">{n.health.reason}</span></button></li>))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
