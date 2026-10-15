"use client";

import { tx } from "@/lib/i18n/tx";
import type { Summary, View } from "@/lib/api";

// The four numbers a person at the desk needs first. Each card is also a shortcut to exactly those tickets.
const CARDS: { view: View; title: string; key: keyof Summary; tone: string; icon: string; iconBg: string }[] = [
  { view: "active", title: "Open", key: "active", tone: "text-slate-900", iconBg: "bg-blue-50 text-blue-600", icon: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 0 9 6 9-6" },
  { view: "overdue", title: "Overdue", key: "overdue", tone: "text-red-700", iconBg: "bg-red-50 text-red-600", icon: "M12 8v5l3 2m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" },
  { view: "unassigned", title: "Unassigned", key: "unassigned", tone: "text-amber-700", iconBg: "bg-amber-50 text-amber-600", icon: "M15 19a4 4 0 0 0-8 0m4-6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm9 6v-1a4 4 0 0 0-3-3.87" },
  { view: "waiting", title: "Waiting on customer", key: "waiting", tone: "text-slate-900", iconBg: "bg-slate-100 text-slate-600", icon: "M12 6v6l4 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" },
];

export default function SummaryCards({ summary, view, onPick }: { summary: Summary | null; view: View; onPick: (v: View) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="group" aria-label={tx("Queue summary")}>
      {CARDS.map((c) => {
        const n = summary?.[c.key];
        const on = view === c.view;
        return (
          <button key={c.view} type="button" onClick={() => onPick(on && c.view !== "active" ? "active" : c.view)} aria-pressed={on}
            className={`flex items-center gap-3 rounded-xl border bg-white p-3.5 text-start shadow-card transition-all hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${on ? "border-blue-500 ring-1 ring-blue-500" : "border-slate-200"}`}>
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${c.iconBg}`} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d={c.icon} /></svg>
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium text-slate-500">{tx(c.title)}</span>
              <span className={`block text-2xl font-bold leading-tight tabular-nums ${n ? c.tone : "text-slate-300"}`}>{n ?? "–"}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
