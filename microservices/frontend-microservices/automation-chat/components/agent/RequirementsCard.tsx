"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChecklistItem, QuickAction, RequirementsChecklist } from "@/lib/agent/types";
import { RequirementStep, type StepResult } from "@/components/agent/RequirementSteps";

// The underwriting requirements as a live card: a progress ring and bar, the seven steps as a timeline, and the step
// to do next opened up with its own controls. Each step is carried out right here (see RequirementSteps) and the card
// re-reads the case when it completes, so the next one unlocks in place; only the footer's buttons (run underwriting,
// open the workspace...) go to the chat through `onAction`.

interface Props {
  checklist: RequirementsChecklist;
  onAction: (action: QuickAction) => void;
  /** Re-read the case and update this card where it stands. */
  onRefresh: () => Promise<void>;
}

const STATE_STYLE = {
  done: { chip: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500 text-white", seg: "bg-emerald-500" },
  next: { chip: "bg-blue-50 text-blue-700 border-blue-200", dot: "bg-blue-600 text-white", seg: "bg-blue-500" },
  todo: { chip: "bg-slate-50 text-slate-500 border-slate-200", dot: "bg-slate-100 text-slate-400 border border-slate-200", seg: "bg-slate-200" },
  issue: { chip: "bg-rose-50 text-rose-700 border-rose-200", dot: "bg-rose-500 text-white", seg: "bg-rose-400" },
} as const;

function Ring({ done, total }: { done: number; total: number }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const complete = done === total;
  return (
    <div className="relative h-14 w-14 shrink-0" role="img" aria-label={`${done} of ${total} requirements ready`}>
      <svg viewBox="0 0 56 56" className="h-14 w-14 -rotate-90">
        <circle cx="28" cy="28" r={r} fill="none" strokeWidth="5" className="stroke-slate-100" />
        <circle
          cx="28" cy="28" r={r} fill="none" strokeWidth="5" strokeLinecap="round"
          className={complete ? "stroke-emerald-500" : "stroke-blue-600"}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - done / total)}
          style={{ transition: "stroke-dashoffset 700ms cubic-bezier(0.2,0.7,0.2,1)" }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[13px] font-bold tabular-nums text-slate-800">
        {done}<span className="text-slate-400">/{total}</span>
      </span>
    </div>
  );
}

function StateIcon({ item, index }: { item: ChecklistItem; index: number }) {
  const style = STATE_STYLE[item.state].dot;
  return (
    <span className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${style}`}>
      {item.state === "done" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><polyline points="20 6 9 17 4 12" /></svg>
      ) : item.state === "issue" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="h-3.5 w-3.5"><path d="M18 6L6 18M6 6l12 12" /></svg>
      ) : (
        index + 1
      )}
      {item.state === "next" && <span className="absolute inset-0 -z-10 animate-ping rounded-full bg-blue-400/40" aria-hidden="true" />}
    </span>
  );
}

function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function RequirementsCard({ checklist, onAction, onRefresh }: Props) {
  const { items, done, total, allDone } = checklist;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [results, setResults] = useState<Partial<Record<ChecklistItem["id"], StepResult>>>({});
  const [, tick] = useState(0);

  // Steps hold on to `changed` for as long as they are open, so it must not change under them.
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const changed = useCallback(() => refreshRef.current(), []);
  // Anything that happens to this case elsewhere (the customer submits, an agent files a report...) updates the card.
  useEffect(() => {
    let timer: number | undefined;
    const onEvt = (e: Event) => {
      if ((e as CustomEvent).detail?.case_id !== checklist.caseId) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void changed(); }, 400);
    };
    window.addEventListener("uw-case-event", onEvt);
    return () => { window.removeEventListener("uw-case-event", onEvt); window.clearTimeout(timer); };
  }, [checklist.caseId, changed]);
  const report = useCallback((id: ChecklistItem["id"], r: StepResult | null) => {
    setResults((prev) => {
      const next = { ...prev };
      if (r) next[id] = r; else delete next[id];
      return next;
    });
  }, []);

  // "updated 2 min ago" keeps itself honest
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 15000);
    return () => window.clearInterval(id);
  }, []);

  const nextItem = useMemo(() => items.find((i) => i.state === "next" || i.state === "issue"), [items]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const refresh = async () => {
    setRefreshing(true);
    try { await onRefresh(); } finally { window.setTimeout(() => setRefreshing(false), 400); }
  };

  const run = (key: string, action: QuickAction) => {
    setBusyKey(key);
    onAction(action);
    window.setTimeout(() => setBusyKey((k) => (k === key ? null : k)), 1500);
  };

  const actionButton = (key: string, action: QuickAction, primary: boolean) => (
    <button
      key={key}
      type="button"
      onClick={() => run(key, action)}
      disabled={busyKey === key}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-all active:scale-[0.97] disabled:opacity-60 ${
        primary
          ? "bg-blue-600 text-white shadow-sm hover:bg-blue-700"
          : "border border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
      }`}
    >
      {busyKey === key && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
      {action.label}
      {primary && busyKey !== key && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      )}
    </button>
  );

  return (
    <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header: progress at a glance */}
      <div className="flex items-center gap-4 border-b border-slate-100 bg-gradient-to-br from-slate-50 to-white px-5 py-4">
        <Ring done={done} total={total} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Underwriting requirements</p>
          <h3 className="truncate text-base font-bold tracking-tight text-slate-900">Case {checklist.caseNo}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {allDone ? "Everything is in. Ready for AI underwriting." : nextItem ? `Up next: ${nextItem.name}` : `${total - done} left`}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          title="Re-read this case"
          aria-label="Refresh requirements"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:border-blue-200 hover:text-blue-700"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}>
            <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>

      {/* Segmented progress */}
      <div className="flex gap-1 px-5 pt-4" aria-hidden="true">
        {items.map((it) => (
          <span key={it.id} className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
            <span className={`block h-full rounded-full transition-all duration-700 ${STATE_STYLE[it.state].seg} ${it.state === "todo" ? "w-0" : "w-full"}`} />
          </span>
        ))}
      </div>

      {/* The seven steps */}
      <ol className="relative px-5 py-4">
        <span className="absolute bottom-8 left-[2.125rem] top-8 w-px bg-slate-200" aria-hidden="true" />
        {items.map((it, i) => {
          const isOpen = it.state === "next" || it.state === "issue" || open.has(it.id);
          const expandable = it.state === "done" || it.state === "todo";
          const style = STATE_STYLE[it.state];
          return (
            <li key={it.id} className="relative">
              <div
                className={`group flex gap-3 rounded-xl px-2 py-2.5 transition-colors ${
                  it.state === "next" ? "bg-blue-50/70 ring-1 ring-blue-100" : it.state === "issue" ? "bg-rose-50/60 ring-1 ring-rose-100" : expandable ? "cursor-pointer hover:bg-slate-50" : ""
                }`}
                onClick={expandable ? () => toggle(it.id) : undefined}
                role={expandable ? "button" : undefined}
                aria-expanded={expandable ? isOpen : undefined}
                tabIndex={expandable ? 0 : undefined}
                onKeyDown={expandable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(it.id); } } : undefined}
              >
                <StateIcon item={it} index={i} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`text-[14px] font-semibold leading-tight ${it.state === "todo" ? "text-slate-500" : "text-slate-900"}`}>{it.name}</span>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${style.chip}`}>{it.status}</span>
                    {it.state === "next" && <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600">Up next</span>}
                    {expandable && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                        className={`ml-auto h-3.5 w-3.5 text-slate-300 transition-transform group-hover:text-slate-500 ${isOpen ? "rotate-180" : ""}`}><polyline points="6 9 12 15 18 9" /></svg>
                    )}
                  </div>
                  <div className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}>
                    <div className="overflow-hidden">
                      <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">{it.detail}</p>
                      {it.state === "todo" && (
                        <p className="mt-1 text-[12px] text-slate-400">Unlocks once the steps before it are done.</p>
                      )}
                      {it.warning && (
                        <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12px] font-medium text-amber-800">⚠ {it.warning}</p>
                      )}
                      {results[it.id] && (
                        <div className={`mt-2 rounded-lg px-2.5 py-1.5 text-[12px] ${results[it.id]!.tone === "ok" ? "bg-emerald-50 text-emerald-800" : results[it.id]!.tone === "warn" ? "bg-amber-50 text-amber-800" : "bg-rose-50 text-rose-800"}`}>
                          <p className="font-semibold">{results[it.id]!.title}</p>
                          {results[it.id]!.lines?.map((l, k) => <p key={k} className="opacity-90">{l}</p>)}
                        </div>
                      )}
                      {(it.state === "next" || it.state === "issue") && (
                        <div onClick={(e) => e.stopPropagation()}>
                          <RequirementStep checklist={checklist} item={it} changed={changed} report={report} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {/* Footer */}
      {(allDone || checklist.note || (checklist.footerActions && checklist.footerActions.length > 0)) && (
        <div className={`border-t px-5 py-4 ${allDone ? "border-emerald-100 bg-emerald-50/60" : "border-slate-100 bg-slate-50/60"}`}>
          {allDone && (
            <p className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-emerald-800">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><polyline points="20 6 9 17 4 12" /></svg>
              All {total} requirements are complete.
            </p>
          )}
          {checklist.note && <p className="mb-3 text-[13px] leading-relaxed text-slate-700">{checklist.note}</p>}
          {checklist.footerActions && checklist.footerActions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {checklist.footerActions.map((a, k) => actionButton(`foot-${k}`, a, allDone && k === 0))}
            </div>
          )}
        </div>
      )}
      <p className="border-t border-slate-100 px-5 py-2 text-[11px] text-slate-400">Updated {ago(checklist.asOf)}</p>
    </div>
  );
}
