"use client";

import React from "react";
import type { QuickAction } from "@/lib/agent/types";
import type { Journey, JourneyNode, JourneyState } from "@/lib/agent/journey";

/**
 * Full-page map of the journey the automation chat is following — opened from
 * the chat header's map toggle. Three columns read left to right:
 *
 *   Onboarding  ──►  Underwriting requirements (7, fan-out / fan-in)  ──►  Decision & cover
 *
 * Every node is one of three kinds: completed, active (in progress, waiting,
 * the next step, or needing attention) or inactive (not reached yet). Edges
 * take the colour of what they connect, and an edge leading into an active node
 * animates — that's the "you are here" trail.
 */

type Kind = "completed" | "active" | "inactive";

const kindOf = (s: JourneyState): Kind => (s === "done" ? "completed" : s === "todo" ? "inactive" : "active");

const ACTIVE_LABEL: Partial<Record<JourneyState, string>> = {
  current: "In progress",
  next: "Next step",
  available: "Available",
  waiting: "Waiting",
  failed: "Needs attention",
};

const NODE_W = 220;
const NODE_H = 66;
const V_GAP = 18;
const COL_GAP = 120;
const HEAD_H = 34; // column heading band above the nodes

interface Placed {
  node: JourneyNode;
  x: number;
  y: number;
}

function layout(journey: Journey) {
  const cols = [journey.before, journey.gates, journey.after];
  const colHeight = (n: number) => (n > 0 ? n * NODE_H + (n - 1) * V_GAP : 0);
  const bodyH = Math.max(...cols.map((c) => colHeight(c.length)), NODE_H);
  const placed: Placed[][] = cols.map((col, ci) => {
    const top = HEAD_H + (bodyH - colHeight(col.length)) / 2;
    return col.map((node, i) => ({ node, x: ci * (NODE_W + COL_GAP), y: top + i * (NODE_H + V_GAP) }));
  });
  return { placed, width: 3 * NODE_W + 2 * COL_GAP, height: HEAD_H + bodyH };
}

function edgeKind(from: JourneyNode, to: JourneyNode): Kind {
  if (from.state !== "done") return "inactive";
  return to.state === "done" ? "completed" : to.state === "todo" ? "inactive" : "active";
}

const EDGE_CLASS: Record<Kind, string> = {
  completed: "text-emerald-400 dark:text-emerald-500",
  active: "text-indigo-500 dark:text-indigo-400",
  inactive: "text-zinc-300 dark:text-zinc-700",
};

function Edge({ d, kind }: { d: string; kind: Kind }) {
  return (
    <g className={EDGE_CLASS[kind]}>
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={kind === "active" ? 2 : 1.5}
        strokeDasharray={kind === "completed" ? undefined : "6 5"}
        className={kind === "active" ? "journey-edge-flow" : undefined}
        markerEnd={`url(#journey-arrow-${kind})`}
      />
    </g>
  );
}

function NodeIcon({ node }: { node: JourneyNode }) {
  const kind = kindOf(node.state);
  if (kind === "completed") {
    return (
      <span className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center shrink-0">
        <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><polyline points="20 6 9 17 4 12" /></svg>
      </span>
    );
  }
  if (kind === "inactive") {
    return <span className="w-6 h-6 rounded-full border-2 border-dashed border-zinc-300 dark:border-zinc-600 shrink-0" />;
  }
  if (node.state === "available") {
    return (
      <span className="w-6 h-6 rounded-full border-2 border-indigo-400 flex items-center justify-center shrink-0">
        <span className="w-2 h-2 rounded-full bg-indigo-400" />
      </span>
    );
  }
  const tone = node.state === "failed" ? "bg-rose-500" : node.state === "waiting" ? "bg-amber-500" : "bg-indigo-500";
  return (
    <span className="relative w-6 h-6 flex items-center justify-center shrink-0">
      <span className={`absolute inset-0 rounded-full opacity-40 animate-ping ${tone}`} />
      <span className={`relative w-3.5 h-3.5 rounded-full ${tone}`} />
    </span>
  );
}

function MapNode({ p, onAction, disabled, running }: { p: Placed; onAction: (a: QuickAction, nodeId: string) => void; disabled: boolean; running: boolean }) {
  const { node } = p;
  const kind = kindOf(node.state);
  const clickable = kind === "active" && !!node.action && !disabled && !running;
  const tone =
    kind === "completed"
      ? "border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-950/40"
      : kind === "inactive"
        ? "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 opacity-60"
        : node.state === "failed"
          ? "border-rose-300 bg-white dark:border-rose-500/50 dark:bg-zinc-900 shadow-[0_0_0_4px_rgba(244,63,94,0.10)]"
          : node.state === "waiting"
            ? "border-amber-300 bg-white dark:border-amber-500/50 dark:bg-zinc-900 shadow-[0_0_0_4px_rgba(245,158,11,0.10)]"
            : node.state === "available"
              ? "border-indigo-200 bg-white dark:border-indigo-500/30 dark:bg-zinc-900"
              : "border-indigo-400 bg-white dark:border-indigo-400/60 dark:bg-zinc-900 shadow-[0_0_0_4px_rgba(99,102,241,0.14)]";
  const badge = running ? "Working" : ACTIVE_LABEL[node.state];
  const content = (
    <>
      {running ? (
        <span className="relative w-6 h-6 shrink-0">
          <span className="absolute inset-0 rounded-full border-2 border-indigo-200 dark:border-indigo-500/30" />
          <span className="absolute inset-0 rounded-full border-2 border-transparent border-t-indigo-500 animate-spin" />
        </span>
      ) : (
        <NodeIcon node={node} />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-semibold leading-tight text-zinc-900 dark:text-zinc-100 truncate">{node.label}</span>
        <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
          {running ? "Copilot is on it…" : clickable ? `${node.action!.label} →` : node.sub || (kind === "inactive" ? "Not reached yet" : "")}
        </span>
      </span>
      {badge && (
        <span
          className={`absolute -top-2 right-2 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${
            running
              ? "bg-indigo-600 text-white animate-pulse"
              : node.state === "failed"
              ? "bg-rose-500 text-white"
              : node.state === "waiting"
                ? "bg-amber-500 text-white"
                : node.state === "available"
                  ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300"
                  : "bg-indigo-500 text-white"
          }`}
        >
          {badge}
        </span>
      )}
    </>
  );
  const style: React.CSSProperties = { left: p.x, top: p.y, width: NODE_W, height: NODE_H };
  const cls = `absolute flex items-center gap-2.5 rounded-2xl border px-3 text-left transition-all ${tone}`;
  return clickable ? (
    <button
      type="button"
      style={style}
      className={`${cls} hover:-translate-y-0.5 hover:shadow-lg cursor-pointer`}
      onClick={() => onAction(node.action!, node.id)}
      title={`${node.action!.label}${node.sub ? ` — ${node.sub}` : ""}`}
    >
      {content}
    </button>
  ) : (
    <div style={style} className={`${cls} ${running ? "border-indigo-400 shadow-[0_0_0_4px_rgba(99,102,241,0.18)]" : ""}`} title={node.sub}>
      {content}
    </div>
  );
}

export function JourneyMap({
  journey,
  onAction,
  disabled = false,
  loading = false,
  live = false,
  runningNodeId = null,
  activity = null,
}: {
  journey: Journey | null;
  onAction: (a: QuickAction, nodeId?: string) => void;
  disabled?: boolean;
  loading?: boolean;
  live?: boolean;
  runningNodeId?: string | null;
  // Status card for a step in progress — pinned to the bottom of the map.
  activity?: React.ReactNode;
}) {
  if (!journey) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
        <div className="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center mb-4">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-7 h-7 text-indigo-500"><circle cx="5" cy="6" r="2.5" /><circle cx="19" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M7.5 6h9M6.3 8.2l4.4 7.6M17.7 8.2l-4.4 7.6" /></svg>
        </div>
        <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">No journey yet</p>
        <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400 max-w-sm">
          Onboard a customer or open an underwriting case in this chat — the map of where you are and what comes next will appear here.
        </p>
      </div>
    );
  }

  const { placed, width, height } = layout(journey);
  const [before, gates, after] = placed;
  const all = [...before, ...gates, ...after];
  const completed = all.filter((p) => p.node.state === "done").length;
  const nextSteps = all.filter((p) => kindOf(p.node.state) === "active" && p.node.action);

  // Edges: chain down each linear column, fan out from the last onboarding node
  // to every requirement, fan in from every requirement to the first decision node.
  const edges: { d: string; kind: Kind; key: string }[] = [];
  const chain = (col: Placed[]) => {
    for (let i = 0; i < col.length - 1; i++) {
      const a = col[i], b = col[i + 1];
      const cx = a.x + NODE_W / 2;
      edges.push({ key: `${a.node.id}-${b.node.id}`, kind: edgeKind(a.node, b.node), d: `M${cx},${a.y + NODE_H} L${cx},${b.y - 3}` });
    }
  };
  const curve = (a: Placed, b: Placed) => {
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x - 3, y2 = b.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;
    return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
  };
  chain(before);
  chain(after);
  const hub = before[before.length - 1];
  const sink = after[0];
  if (gates.length) {
    for (const g of gates) {
      if (hub) edges.push({ key: `${hub.node.id}-${g.node.id}`, kind: edgeKind(hub.node, g.node), d: curve(hub, g) });
      if (sink) edges.push({ key: `${g.node.id}-${sink.node.id}`, kind: edgeKind(g.node, sink.node), d: curve(g, sink) });
    }
  } else if (hub && sink) {
    edges.push({ key: `${hub.node.id}-${sink.node.id}`, kind: edgeKind(hub.node, sink.node), d: curve(hub, sink) });
  }

  const headings = ["Onboarding", "Underwriting requirements", "Decision & cover"];

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto custom-scrollbar">
      <style>{`
        @keyframes journey-dash { to { stroke-dashoffset: -22; } }
        .journey-edge-flow { animation: journey-dash 0.9s linear infinite; }
        @media (prefers-reduced-motion: reduce) { .journey-edge-flow { animation: none; } }
      `}</style>

      {/* Summary */}
      <div className="shrink-0 px-4 sm:px-8 pt-6 pb-4 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-widest text-indigo-500">Journey map</div>
          <h2 className="text-lg font-bold text-zinc-900 dark:text-white truncate">{journey.title}</h2>
          {journey.subtitle && <p className="text-[12.5px] text-zinc-500 dark:text-zinc-400">{journey.subtitle}</p>}
        </div>
        <div className="flex items-center gap-4">
          <div className="w-40">
            <div className="flex justify-between text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 mb-1">
              <span>Progress</span>
              <span className="tabular-nums">{completed}/{all.length}</span>
            </div>
            <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500 transition-all duration-700" style={{ width: `${(completed / all.length) * 100}%` }} />
            </div>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full ${
              live ? "text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-500/15" : "text-zinc-500 bg-zinc-100 dark:text-zinc-400 dark:bg-zinc-800"
            }`}
            title={live ? "Listening for live case events" : "Live updates disconnected"}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${live ? "bg-emerald-500 animate-pulse" : "bg-zinc-400"}`} />
            {loading ? "Syncing" : live ? "Live" : "Offline"}
          </span>
        </div>
      </div>

      {/* Legend */}
      <div className="shrink-0 px-4 sm:px-8 pb-2 flex flex-wrap gap-x-5 gap-y-1.5 text-[11.5px] text-zinc-600 dark:text-zinc-400">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-emerald-500" /> Completed</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-indigo-500" /> Active · next step</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full border-2 border-indigo-400" /> Active · available</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-amber-500" /> Active · waiting</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-rose-500" /> Needs attention</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full border-2 border-dashed border-zinc-400" /> Inactive</span>
      </div>

      {/* Map canvas — scrolls sideways on narrow screens */}
      <div className="shrink-0 px-4 sm:px-8 py-4 overflow-x-auto custom-scrollbar">
        <div className="relative mx-auto" style={{ width, height }}>
          {headings.map((h, i) => (
            <div
              key={h}
              className="absolute top-0 text-[10px] font-extrabold uppercase tracking-widest text-zinc-400 text-center"
              style={{ left: i * (NODE_W + COL_GAP), width: NODE_W }}
            >
              {h}
            </div>
          ))}
          <svg className="absolute inset-0 overflow-visible" width={width} height={height} aria-hidden>
            <defs>
              {(["completed", "active", "inactive"] as Kind[]).map((k) => (
                <marker key={k} id={`journey-arrow-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M1 1 L9 5 L1 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={EDGE_CLASS[k]} />
                </marker>
              ))}
            </defs>
            {edges.map((e) => <Edge key={e.key} d={e.d} kind={e.kind} />)}
          </svg>
          {all.map((p) => <MapNode key={p.node.id} p={p} onAction={onAction} disabled={disabled} running={p.node.id === runningNodeId} />)}
        </div>
      </div>

      {/* What can be done now */}
      {nextSteps.length > 0 && !activity && (
        <div className="shrink-0 px-4 sm:px-8 pb-8">
          <div className="max-w-3xl mx-auto rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/70 p-4">
            <div className="text-[10px] font-extrabold uppercase tracking-widest text-zinc-400 mb-2">What you can do now</div>
            <div className="flex flex-wrap gap-2">
              {nextSteps.map((p) => (
                <button
                  key={`ns-${p.node.id}`}
                  type="button"
                  disabled={disabled}
                  onClick={() => onAction(p.node.action!, p.node.id)}
                  className={`text-[12px] font-semibold px-3 py-1.5 rounded-xl border transition-colors disabled:opacity-50 ${
                    p.node.state === "next"
                      ? "border-indigo-300 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 dark:border-indigo-500/40 dark:text-indigo-300 dark:bg-indigo-500/10"
                      : "border-zinc-200 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  }`}
                >
                  {p.node.action!.label}
                </button>
              ))}
            </div>
            {disabled && !activity && <p className="mt-2 text-[11.5px] text-zinc-500">The copilot is busy — steps unlock when it finishes.</p>}
          </div>
        </div>
      )}

      {activity && <div className="sticky bottom-0 mt-auto px-4 sm:px-8 pb-4 pt-2 z-20">{activity}</div>}
    </div>
  );
}
