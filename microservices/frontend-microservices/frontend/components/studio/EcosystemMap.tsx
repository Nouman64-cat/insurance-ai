"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import { HEALTH_COLOR, KIND_ICON, LAYER_HELP, NODE_H, NODE_W, activeLinks, arrowTarget, edgePath, layoutGraph, neighbourhood, type Health, type StudioGraph, type StudioNode } from "@/lib/evalStudio";

export interface NodeOverlay { text: string; tone?: "run" | "ok" | "bad" }

/** The ecosystem as an interactive map: columns are the layers (business, golden data, harness, system under test, models, outcomes), each node carries its health, links carry how much
 *  passes along them, and the links of a running evaluation flow. Hover or focus a node to light up what it is connected to; select it to open its details beside the map.
 *  On a narrow screen the same nodes are a list, grouped by layer. */
export default function EcosystemMap({ graph, selected, onSelect, only, overlays, compact = false, zoom = 0 }: {
  graph: StudioGraph; selected: string | null; onSelect: (id: string | null) => void; only?: Set<Health>; overlays?: Record<string, NodeOverlay>; compact?: boolean; zoom?: number;
}) {
  const [hover, setHoverNow] = useState<string | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  // moving from a node to the link beside it or to the next node must not flash the whole map back to normal: leaving is delayed a moment, entering is immediate
  const setHover = (id: string | null) => { if (leave.current) clearTimeout(leave.current); if (id) setHoverNow(id); else leave.current = setTimeout(() => setHoverNow(null), 90); };
  useEffect(() => () => { if (leave.current) clearTimeout(leave.current); }, []);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const visible = useMemo(() => ({ ...graph, nodes: graph.nodes.filter((n) => !only || only.size === 0 || only.has(n.health.state) || n.id === selected) }), [graph, only, selected]);
  const layout = useMemo(() => layoutGraph(visible), [visible]);
  const ids = new Set(layout.nodes.map((n) => n.id));
  const edges = useMemo(() => graph.edges.map((e, i) => ({ e, i })).filter(({ e }) => ids.has(e.from) && ids.has(e.to)), [graph.edges, layout]);        // eslint-disable-line react-hooks/exhaustive-deps
  const focus = hover ?? selected;
  const near = focus ? neighbourhood(graph, focus) : null;
  const active = useMemo(() => activeLinks(graph), [graph]);
  const maxW = Math.max(1, ...graph.edges.map((e) => e.weight));
  const strokeOf = (w: number) => 1.2 + (Math.log(1 + w) / Math.log(1 + maxW)) * 3.2;
  const layerNames = graph.layers;
  const cols = Array.from(new Set(layout.nodes.map((n) => n.layer))).sort((a, b) => a - b);

  return (
    <div data-testid="ecosystem-map">
      <div className="hidden md:block studio-canvas rounded-xl border border-slate-200 dark:border-slate-700 overflow-x-auto">
        <svg ref={svgRef} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label={tx("The evaluation ecosystem")} className="block mx-auto"
          preserveAspectRatio="xMidYMid meet"
          style={zoom > 0 ? { width: Math.round(layout.width * zoom), maxWidth: "none", height: "auto" } : { width: "100%", minWidth: compact ? 520 : 940, height: "auto", maxHeight: compact ? 360 : 640 }}>
          <rect x={0} y={0} width={layout.width} height={layout.height} fill="transparent" onClick={() => selected && onSelect(null)} data-testid="map-background" />
          {cols.map((layer, col) => {
            const x = 28 + col * (NODE_W + 62);
            const name = layerNames[layer] ?? "";
            return (
              <g key={layer} data-layer={name}>
                <rect x={x - 12} y={10} width={NODE_W + 24} height={layout.height - 20} rx={16} className="studio-band" />
                <text x={x + NODE_W / 2} y={30} textAnchor="middle" fontSize="11" fontWeight="700" letterSpacing="1.2" className="studio-node-text">{name.toUpperCase()}<title>{LAYER_HELP[name] ?? name}</title></text>
                {!compact && <text x={x + NODE_W / 2} y={44} textAnchor="middle" fontSize="9.5" className="studio-node-sub">{(LAYER_HELP[name] ?? "").slice(0, 34)}</text>}
              </g>
            );
          })}
          <g>
            {edges.map(({ e, i }) => {
              const a = layout.byId[e.from], b = layout.byId[e.to];
              const lit = near?.edges.has(i);
              const dim = near && !lit;
              return (
                <path key={i} d={edgePath(a, b)} strokeWidth={strokeOf(e.weight)} strokeLinecap="round" data-edge={`${e.from}>${e.to}`}
                  className={`studio-edge ${active.has(i) ? "is-active" : lit ? "is-lit" : ""} ${dim ? "studio-dim" : ""}`}>
                  <title>{`${e.label}${e.weight ? ` (${e.weight.toLocaleString()})` : ""}`}</title>
                </path>
              );
            })}
          </g>
          {layout.nodes.map((n) => {
            const c = HEALTH_COLOR[n.health.state];
            const dim = near && !near.nodes.has(n.id);
            const o = overlays?.[n.id];
            return (
              <g key={n.id} className={`studio-node ${selected === n.id ? "is-selected" : ""} ${dim ? "studio-dim" : ""}`} transform={`translate(${n.x} ${n.y})`} tabIndex={0} role="button" aria-pressed={selected === n.id} data-node={n.id} data-health={n.health.state}
                aria-label={`${n.label}: ${tx(c.label)}. ${n.health.reason}`} onClick={() => onSelect(selected === n.id ? null : n.id)} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(n.id)} onBlur={() => setHover(null)} onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onSelect(selected === n.id ? null : n.id); }
                  else if (ev.key === "Escape" && selected) { ev.preventDefault(); onSelect(null); }
                  else if (ev.key === "ArrowLeft" || ev.key === "ArrowRight" || ev.key === "ArrowUp" || ev.key === "ArrowDown") {
                    const to = arrowTarget(layout.nodes, n.id, ev.key);
                    if (to) { ev.preventDefault(); (svgRef.current?.querySelector(`[data-node="${to}"]`) as SVGGElement | null)?.focus(); }
                  }
                }}>
                {(n.active || o?.tone === "run") && <rect className="studio-ring" x={-3} y={-3} width={NODE_W + 6} height={NODE_H + 6} rx={16} stroke="#0ea5e9" />}
                <rect className="studio-node-rect" width={NODE_W} height={NODE_H} rx={14} />
                <circle cx={16} cy={18} r={5.5} fill={c.dot}><title>{`${tx(c.label)}: ${n.health.reason}`}</title></circle>
                <text x={28} y={22} fontSize="12.5" fontWeight="700" className="studio-node-text">{(KIND_ICON[n.kind] ?? "•") + " " + (n.label.length > 17 ? `${n.label.slice(0, 16)}…` : n.label)}</text>
                <text x={14} y={42} fontSize="10.5" className="studio-node-sub">{(o?.text ?? n.health.reason).slice(0, 26)}{(o?.text ?? n.health.reason).length > 26 ? "…" : ""}</text>
                {(o?.text || n.badge) && <g transform={`translate(${NODE_W - 8} ${NODE_H - 14})`}><text textAnchor="end" fontSize="10" fontWeight="700" fill={o?.tone === "bad" ? "#dc2626" : "#2563eb"}>{(o?.text ?? n.badge)?.slice(0, 18)}</text></g>}
                <title>{`${n.label} — ${n.health.reason}`}</title>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="md:hidden space-y-3" data-testid="map-list">
        {cols.map((layer) => (
          <section key={layer}>
            <h3 className="text-[10px] font-bold tracking-widest text-slate-400 mb-1">{(layerNames[layer] ?? "").toUpperCase()}</h3>
            <ul className="space-y-1.5">
              {layout.nodes.filter((n) => n.layer === layer).map((n: StudioNode) => (
                <li key={n.id}>
                  <button type="button" onClick={() => onSelect(selected === n.id ? null : n.id)} aria-pressed={selected === n.id}
                    className={`w-full text-left rounded-xl border px-3 py-2 bg-white dark:bg-slate-900 ${selected === n.id ? "border-blue-500" : "border-slate-200 dark:border-slate-700"}`}>
                    <span className="inline-block h-2.5 w-2.5 rounded-full mr-2 align-middle" style={{ background: HEALTH_COLOR[n.health.state].dot }} />
                    <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{n.label}</span>
                    <span className="block text-[11px] text-slate-500 mt-0.5">{overlays?.[n.id]?.text ?? n.health.reason}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
