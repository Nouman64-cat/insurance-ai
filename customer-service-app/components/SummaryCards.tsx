"use client";

import { tx } from "@/lib/i18n/tx";
import type { Summary, View } from "@/lib/api";

// The four things a person at the desk needs to know first. Each card is also a shortcut: it shows exactly those tickets.
const CARDS: { view: View; title: string; help: string; key: keyof Summary; tone: string; ring: string }[] = [
  { view: "overdue", title: "Late", help: "Past their target time. Do these first.", key: "overdue", tone: "text-red-700", ring: "ring-red-200 hover:ring-red-400" },
  { view: "unassigned", title: "Not taken yet", help: "Nobody is handling these. Open one and take it.", key: "unassigned", tone: "text-amber-700", ring: "ring-amber-200 hover:ring-amber-400" },
  { view: "mine", title: "Mine", help: "Tickets you are handling.", key: "mine", tone: "text-blue-700", ring: "ring-blue-200 hover:ring-blue-400" },
  { view: "waiting", title: "Waiting on customer", help: "We asked the customer; nothing to do until they reply.", key: "waiting", tone: "text-slate-700", ring: "ring-slate-200 hover:ring-slate-400" },
];

export default function SummaryCards({ summary, view, onPick }: { summary: Summary | null; view: View; onPick: (v: View) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" role="group" aria-label={tx("Where to start")}>
      {CARDS.map((c) => {
        const n = summary?.[c.key];
        const on = view === c.view;
        return (
          <button key={c.view} type="button" onClick={() => onPick(on ? "active" : c.view)} aria-pressed={on}
            className={`rounded-xl bg-white p-3 text-start ring-1 transition-shadow ${on ? "ring-2 !ring-blue-500 shadow-sm" : c.ring}`}>
            <span className="flex items-baseline justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{tx(c.title)}</span>
              <span className={`text-2xl font-bold tabular-nums ${n ? c.tone : "text-slate-300"}`}>{n ?? "–"}</span>
            </span>
            <span className="mt-1 block text-[11px] leading-snug text-slate-500">{tx(c.help)}</span>
          </button>
        );
      })}
    </div>
  );
}
