"use client";

import { useEffect, type ReactNode } from "react";
import { tx } from "@/lib/i18n/tx";
import type { BudgetPeriod, ReconStatus } from "@/lib/evalCosts";

// The small pieces every costs panel uses: the same blue-and-white look as the rest of the Super Admin pages.

export const inputCls = "w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 bg-white";
export const btnPrimary = "px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-all";
export const btnGhost = "px-3 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 disabled:opacity-40 transition-all";
export const card = "rounded-xl border border-slate-200 bg-white p-4 min-w-0";

export function Notice({ kind = "error", children }: { kind?: "error" | "warn" | "ok" | "info"; children: ReactNode }) {
  const tone = { error: "bg-red-50 border-red-200 text-red-600", warn: "bg-amber-50 border-amber-200 text-amber-700", ok: "bg-emerald-50 border-emerald-200 text-emerald-700", info: "bg-blue-50 border-blue-200 text-blue-700" }[kind];
  return <div className={`text-xs rounded-lg px-3 py-2 border whitespace-pre-wrap ${tone}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}

export function Stat({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: ReactNode; testId?: string }) {
  return (
    <div className={card}>
      <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{label}</div>
      <div className="mt-1 text-2xl font-bold text-slate-900" data-testid={testId}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold text-slate-500 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-slate-400 mt-1">{hint}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`bg-white rounded-xl shadow-xl w-full ${wide ? "max-w-3xl" : "max-w-lg"} max-h-[90vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
          <h2 className="text-sm font-bold text-slate-900">{title}</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none" aria-label={tx("Close")}>×</button>
        </div>
        <div className="p-5 space-y-3">{children}</div>
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-900/20" onClick={onClose} />
      <aside role="dialog" aria-label={title} className="fixed right-0 top-0 bottom-0 w-full max-w-xl bg-white border-l border-slate-200 shadow-xl z-50 overflow-y-auto p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-bold text-slate-900">{title}</h2>
          <button type="button" className={btnGhost} onClick={onClose}>{tx("Close")}</button>
        </div>
        {children}
      </aside>
    </>
  );
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "blue" | "green" | "amber" | "red" | "violet" }) {
  const t = { slate: "bg-slate-50 text-slate-600 border-slate-200", blue: "bg-blue-50 text-blue-700 border-blue-200", green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200", red: "bg-red-50 text-red-700 border-red-200", violet: "bg-violet-50 text-violet-700 border-violet-200" }[tone];
  return <span className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap ${t}`}>{children}</span>;
}

export const KIND_TONE = { confirmed: "green", estimated: "blue", unknown: "amber" } as const;
export const SEVERITY_TONE = { high: "red", medium: "amber", low: "slate", info: "blue" } as const;
export const RECON_TONE: Record<ReconStatus, "green" | "red" | "amber" | "violet"> = { matched: "green", under_recorded: "red", over_recorded: "violet", incomplete: "amber" };

/** The share of a limit that is used: spent (solid) and reserved by queued and running jobs (lighter), against the limit. No limit: it says so instead of drawing an empty bar. */
export function BudgetBar({ p, fmt }: { p: BudgetPeriod; fmt: (usd: number | null) => string }) {
  const label = p.period === "day" ? tx("Today") : tx("This month");
  if (p.limit_usd === null) {
    return (
      <div data-testid={`budget-${p.period}`}>
        <div className="flex justify-between text-xs"><span className="font-semibold text-slate-700">{label}</span><span className="text-slate-500">{fmt(p.spent_usd)} {tx("spent")}{p.reserved_usd > 0 ? ` + ${fmt(p.reserved_usd)} ${tx("reserved")}` : ""}</span></div>
        <p className="text-[11px] text-slate-400 mt-1">{tx("No limit is set.")}</p>
      </div>
    );
  }
  const total = Math.max(p.limit_usd, 1e-9);
  const spent = Math.min(100, (p.spent_usd / total) * 100), reserved = Math.min(100 - spent, (p.reserved_usd / total) * 100);
  const color = p.status === "exceeded" ? "bg-red-500" : p.status === "warning" ? "bg-amber-500" : "bg-blue-600";
  return (
    <div data-testid={`budget-${p.period}`}>
      <div className="flex justify-between text-xs">
        <span className="font-semibold text-slate-700">{label}</span>
        <span className="text-slate-500">{fmt(p.spent_usd)} {tx("spent")}{p.reserved_usd > 0 ? ` + ${fmt(p.reserved_usd)} ${tx("reserved")}` : ""} {tx("of")} <b className="text-slate-800">{fmt(p.limit_usd)}</b></span>
      </div>
      <div className="mt-1.5 h-2.5 rounded-full bg-slate-100 overflow-hidden flex" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(spent + reserved)}>
        <div className={color} style={{ width: `${spent}%` }} />
        <div className={`${color} opacity-40`} style={{ width: `${reserved}%` }} />
      </div>
      <p className="text-[11px] text-slate-500 mt-1">
        {p.status === "exceeded" ? <b className="text-red-600">{tx("Limit reached.")}</b> : p.status === "warning" ? <b className="text-amber-600">{tx("Close to the limit.")}</b> : null}{" "}
        {p.remaining_usd !== null ? `${fmt(Math.max(p.remaining_usd, 0))} ${tx("left")}` : ""} · {p.enforce ? tx("a job that would pass it is refused") : tx("passing it only warns")} · {tx("warns at")} {p.warn_at_pct}%
      </p>
    </div>
  );
}

export const when = (s?: string | null) => (s ? new Date(s).toLocaleString() : "—");
export const day = (s?: string | null) => (s ? new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");
export const shortId = (id?: string | null) => (id ? id.slice(0, 8) : "—");
