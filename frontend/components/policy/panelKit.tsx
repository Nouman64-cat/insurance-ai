"use client";

// Small presentational primitives shared by the Stage B step panels
// (Reinstatement, Renewals). Kept deliberately tiny — no data fetching here.

import { useState } from "react";
import { tx } from "@/lib/i18n/tx";

export const btnPrimary = "px-3.5 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 disabled:cursor-not-allowed";
export const btnGhost = "px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed";
export const btnDanger = "px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed";
export const inputCls = "w-full text-xs border border-slate-200 rounded-lg px-2.5 py-2 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300";

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function Chip({ cls, children }: Readonly<{ cls: string; children: React.ReactNode }>) {
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold border ${cls}`}>{children}</span>;
}

export function Stat({ label, value, hint, tone }: Readonly<{ label: string; value: string; hint?: string; tone?: "warn" | "bad" | "accent" }>) {
  const ring = tone === "bad" ? "border-red-200 bg-red-50/40" : tone === "warn" ? "border-amber-200 bg-amber-50/40"
    : tone === "accent" ? "border-blue-200 bg-gradient-to-br from-blue-50 to-white" : "border-slate-200 bg-white";
  return (
    <div className={`rounded-xl border p-4 ${ring}`}>
      <p className="text-[10px] uppercase tracking-widest font-bold text-slate-400 mb-1.5">{label}</p>
      <p className="text-lg font-black tracking-tight text-slate-800 tabular-nums">{value}</p>
      {hint && <p className="text-[11px] font-medium text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}

export function KV({ label, value }: Readonly<{ label: string; value: React.ReactNode }>) {
  return (
    <div>
      <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">{label}</p>
      <p className="text-sm mt-0.5 text-slate-700 font-medium">{value || "—"}</p>
    </div>
  );
}

export function CheckList({ checks }: Readonly<{ checks: { key: string; label: string; passed: boolean; detail: string; severity: string }[] }>) {
  return (
    <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
      {checks.map((c) => {
        const tone = c.passed ? "text-blue-600" : c.severity === "info" ? "text-slate-400" : c.severity === "review" ? "text-amber-600" : "text-red-600";
        return (
          <div key={c.key} className="flex items-start gap-3 px-3 py-2.5">
            <span className={`mt-0.5 ${tone}`}>
              {c.passed ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              )}
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-700">{tx(c.label)}</p>
              <p className="text-[11px] text-slate-500">{c.detail}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}


export interface AuditItem {
  id: string; event_type: string; actor: string | null; from_status: string | null;
  to_status: string | null; at: string; detail: Record<string, unknown>;
}

/** Collapsible per-case audit trail. `labels` maps event types to readable names;
 *  event types matching `bad` render with a red dot. */
export function AuditTimeline({
  items, labels, bad = /Failed|Rejected|Withdrawn|Declined|Cancelled|Exception/, good = /Reinstated|Completed|Renewed/,
}: Readonly<{ items: AuditItem[]; labels: Record<string, string>; bad?: RegExp; good?: RegExp }>) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50 text-left">
        <span className="text-sm font-bold text-slate-800">{tx("Audit trail")} <span className="ml-1 text-[10px] font-semibold text-slate-500 bg-slate-100 border border-slate-200 rounded-full px-2 py-0.5">{items.length}</span></span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`w-4 h-4 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <ol className="px-4 pb-4 pt-3 border-t border-slate-100 space-y-3">
          {items.map((e) => (
            <li key={e.id} className="flex gap-3">
              <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${bad.test(e.event_type) ? "bg-red-500" : good.test(e.event_type) ? "bg-blue-600" : "bg-slate-400"}`} />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-700">
                  {tx(labels[e.event_type] ?? e.event_type)}
                  {e.from_status && e.to_status && <span className="ml-2 text-[11px] font-medium text-slate-500">{e.from_status} → {e.to_status}</span>}
                </p>
                <p className="text-[11px] text-slate-400">{fmtDateTime(e.at)} · {e.actor ?? "system"}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ── Step tracker bits shared by the 7-step panels (Claims, Policy Exit) ──────

export type TrackerState = "complete" | "pending" | "action" | "exception" | "skipped" | "not_started";

export const TRACKER_TEXT: Record<TrackerState, string> = {
  complete: "text-blue-700", pending: "text-amber-600", action: "text-amber-700", exception: "text-red-600",
  skipped: "text-slate-400", not_started: "text-slate-400",
};

export function StageDot({ state, n }: Readonly<{ state: TrackerState; n: number }>) {
  if (state === "complete") {
    return (
      <span className="flex items-center justify-center w-7 h-7 rounded-full bg-blue-600 text-white flex-shrink-0">
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
      </span>
    );
  }
  const cls = state === "exception" ? "border-red-300 bg-red-50 text-red-600"
    : state === "action" || state === "pending" ? "border-2 border-amber-400 bg-white text-amber-700"
      : "border border-slate-200 bg-slate-50 text-slate-400";
  return <span className={`flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold flex-shrink-0 ${cls}`}>{n}</span>;
}
