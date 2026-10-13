"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { tx } from "@/lib/i18n/tx";

// Building blocks shared by the apps that sign in through the portal (Request Management, Customer Service, …), in
// the portal's design language: white cards on slate, blue primary actions, small uppercase labels, rounded pills.

export const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-slate-50";
export const labelClass = "mb-1 block text-xs font-semibold text-slate-600";
export const primaryButton =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
export const secondaryButton =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
export const dangerButton =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50";
export const ghostButton =
  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-slate-200 bg-white shadow-card ${className}`}>{children}</section>;
}

export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
      <div>
        <h2 className="text-sm font-bold text-slate-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export type Tone = "slate" | "blue" | "indigo" | "amber" | "emerald" | "red" | "sky" | "violet";

const TONES: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
  blue: "bg-blue-50 text-blue-700 ring-blue-200",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
};
const DOTS: Record<Tone, string> = {
  slate: "bg-slate-400", blue: "bg-blue-500", indigo: "bg-indigo-500", amber: "bg-amber-500",
  emerald: "bg-emerald-500", red: "bg-red-500", sky: "bg-sky-500", violet: "bg-violet-500",
};

/** A status pill. */
export function Badge({ tone, children, dot = true }: { tone: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${TONES[tone]}`}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${DOTS[tone]}`} />}
      {children}
    </span>
  );
}

export type PriorityCode = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export const PRIORITY_LABEL: Record<PriorityCode, string> = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" };
const PRIORITY_BARS: Record<PriorityCode, number> = { LOW: 1, NORMAL: 2, HIGH: 3, URGENT: 4 };
const PRIORITY_COLOR: Record<PriorityCode, string> = { LOW: "bg-slate-400", NORMAL: "bg-blue-500", HIGH: "bg-amber-500", URGENT: "bg-red-500" };

/** Priority as a label with a small signal-strength meter, readable at a glance in a list. */
export function Priority({ value }: { value: PriorityCode }) {
  const bars = PRIORITY_BARS[value] ?? 2;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-700" title={tx(PRIORITY_LABEL[value] ?? value)}>
      <span className="flex items-end gap-px" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={`w-[3px] rounded-sm ${i <= bars ? PRIORITY_COLOR[value] : "bg-slate-200"}`} style={{ height: 3 + i * 2 }} />
        ))}
      </span>
      <span className={value === "URGENT" ? "font-semibold text-red-700" : ""}>{tx(PRIORITY_LABEL[value] ?? value)}</span>
    </span>
  );
}

export function formatDate(value: string | null | undefined, withTime = false): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, withTime
    ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" });
}

/** "2h ago", "in 3 days": for timestamps where closeness matters more than the exact date. */
export function relativeTime(value: string | null | undefined): string {
  if (!value) return "—";
  const diff = new Date(value).getTime() - Date.now();
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const amount = minutes < 60 ? tx("{n} min", { n: Math.max(1, minutes) }) : hours < 36 ? tx("{n} h", { n: hours }) : tx("{n} days", { n: days });
  return diff >= 0 ? tx("in {when}", { when: amount }) : tx("{when} ago", { when: amount });
}

/** A due date as the person working the queue needs it: how much time is left, or how late it is. */
export function DueLabel({ due, open, overdue }: { due: string | null | undefined; open: boolean; overdue?: boolean }) {
  if (!due) return <span className="text-xs text-slate-400">—</span>;
  if (!open) return <span className="text-xs text-slate-400" title={formatDate(due, true)}>{formatDate(due)}</span>;
  const late = overdue ?? new Date(due).getTime() < Date.now();
  const soon = !late && new Date(due).getTime() - Date.now() < 24 * 3_600_000;
  return (
    <span className={`text-xs ${late ? "font-semibold text-red-700" : soon ? "font-semibold text-amber-700" : "text-slate-600"}`} title={formatDate(due, true)}>
      {late ? tx("Overdue · {when}", { when: relativeTime(due) }) : relativeTime(due)}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-14 text-sm text-slate-500" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" />
      {label ?? tx("Loading…")}
    </div>
  );
}

/** Placeholder rows while a list loads, so the layout doesn't jump. */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-slate-100" role="status" aria-label={tx("Loading…")}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex animate-pulse items-center gap-4 px-5 py-4">
          <div className="h-3 w-1/3 rounded bg-slate-200" />
          <div className="h-3 w-20 rounded bg-slate-100" />
          <div className="ms-auto h-3 w-16 rounded bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <span className="flex items-start gap-2">
        <svg viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true">
          <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
        </svg>
        {message}
      </span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 text-xs font-semibold text-red-700 underline">{tx("Try again")}</button>
      )}
    </div>
  );
}

export function Empty({ title, hint, action, icon }: { title: string; hint?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <span className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        {icon ?? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0-3-3m3 3 3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
          </svg>
        )}
      </span>
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {hint && <p className="max-w-md text-xs text-slate-500">{hint}</p>}
      {action}
    </div>
  );
}

export function useDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
      <span>{tx("{from}–{to} of {total}", { from, to, total })}</span>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className={`${secondaryButton} !px-3 !py-1 text-xs`}>{tx("Previous")}</button>
          <span>{tx("Page {page} of {total}", { page, total: pages })}</span>
          <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} className={`${secondaryButton} !px-3 !py-1 text-xs`}>{tx("Next")}</button>
        </div>
      )}
    </div>
  );
}

/** A row of filter pills (status tabs and the like). */
export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number }[]; label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
            value === o.value ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
          {o.label}
          {o.count !== undefined && o.count > 0 && (
            <span className={`rounded-full px-1.5 text-[10px] ${value === o.value ? "bg-white/20" : "bg-slate-200 text-slate-700"}`}>{o.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** A centred dialog. Escape and the backdrop close it; focus moves into it when it opens. */
export function Dialog({ open, title, subtitle, onClose, children, footer, wide = false }: {
  open: boolean; title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    panel.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[8vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title} className={`w-full ${wide ? "max-w-3xl" : "max-w-xl"} rounded-2xl bg-white shadow-2xl`}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-6 py-4">
          <div>
            <h2 className="text-base font-bold text-slate-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label={tx("Close")} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

/** A small labelled value, for detail panels. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 truncate text-sm text-slate-800">{children}</dd>
    </div>
  );
}

export function initials(name: string | null | undefined): string {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

export function Avatar({ name, internal = false }: { name: string | null | undefined; internal?: boolean }) {
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${internal ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-700"}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
