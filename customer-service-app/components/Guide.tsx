"use client";

import { useEffect, useState } from "react";
import { tx } from "@/lib/i18n/tx";
import type { Status } from "@/lib/api";
import { STATUS_HELP, STATUS_LABEL, STATUS_TONE } from "@/lib/labels";
import { Badge } from "@/components/satellite/ui";

// The desk explains itself: what a ticket is, the three things you do with one, and what each status means.
const KEY = "cs_guide_dismissed";

export function useGuide() {
  const [shown, setShown] = useState(false);
  useEffect(() => { try { setShown(localStorage.getItem(KEY) !== "1"); } catch { setShown(true); } }, []);
  const set = (v: boolean) => { setShown(v); try { if (v) localStorage.removeItem(KEY); else localStorage.setItem(KEY, "1"); } catch { /* storage unavailable */ } };
  return { shown, show: () => set(true), hide: () => set(false) };
}

const STAFF_STEPS = [
  { n: 1, title: "A request comes in", text: "Customers and colleagues log enquiries, complaints and servicing requests as tickets. They appear in the list below, the most urgent first." },
  { n: 2, title: "Take it and work on it", text: "Open a ticket and press “Take this ticket” so everyone knows it is yours, then “Start working”. Reply to the customer in the message box." },
  { n: 3, title: "Solve it and close it", text: "When the customer's problem is sorted, press “Mark solved” and write what was done. Close it once they are happy." },
];
const USER_STEPS = [
  { n: 1, title: "Tell us what you need", text: "Press “New ticket”, say what it is about and describe it. You get a reference straight away." },
  { n: 2, title: "We work on it", text: "Service staff pick it up. You can follow every step and read their replies by opening the ticket." },
  { n: 3, title: "Reply if we ask", text: "If we need something from you, the ticket says so. Open it and reply. When it is solved you will see the outcome." },
];

export function StatusLegend({ compact = false }: { compact?: boolean }) {
  return (
    <ul className={compact ? "grid gap-1.5" : "grid gap-2 sm:grid-cols-2"}>
      {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
        <li key={s} className="flex items-start gap-2">
          <span className="shrink-0 pt-px"><Badge tone={STATUS_TONE[s]}>{tx(STATUS_LABEL[s])}</Badge></span>
          <span className="text-xs text-slate-600">{tx(STATUS_HELP[s])}</span>
        </li>
      ))}
    </ul>
  );
}

export function GuideBanner({ staff, onHide }: { staff: boolean; onHide: () => void }) {
  const steps = staff ? STAFF_STEPS : USER_STEPS;
  return (
    <div className="relative rounded-xl border border-blue-200 bg-gradient-to-br from-blue-50 to-white p-4">
      <button type="button" onClick={onHide} className="absolute end-3 top-3 rounded-md px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100">{tx("Got it, hide this")}</button>
      <p className="text-sm font-bold text-slate-900">{staff ? tx("How the service desk works") : tx("How this works")}</p>
      <p className="mt-0.5 text-xs text-slate-600">
        {staff ? tx("A ticket is one customer request. Every ticket moves from New to Closed. Here is what to do.") : tx("A ticket is one request you have made to the service team.")}
      </p>
      <ol className="mt-3 grid gap-3 sm:grid-cols-3">
        {steps.map((s) => (
          <li key={s.n} className="flex gap-3 rounded-lg bg-white/80 p-3 ring-1 ring-blue-100">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">{s.n}</span>
            <span>
              <span className="block text-xs font-bold text-slate-900">{tx(s.title)}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-slate-600">{tx(s.text)}</span>
            </span>
          </li>
        ))}
      </ol>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-semibold text-blue-700">{tx("What do the status labels mean?")}</summary>
        <div className="mt-2"><StatusLegend /></div>
      </details>
    </div>
  );
}
