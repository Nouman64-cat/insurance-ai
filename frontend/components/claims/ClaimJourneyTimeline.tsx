"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClaimStatusHistoryItem } from "@/app/services/claims";
import { tx } from "@/lib/i18n/tx";

const STEP_PX = 320;

const splitStamp = (iso: string) => {
  const [date = "", time = ""] = iso.replace("T", " ").slice(0, 16).split(" ");
  return { date, time };
};

/**
 * Every status change on a claim (who moved it, and when) as a horizontal timeline, oldest on the left and newest on the right.
 * It opens scrolled to the latest event, scrolls by touch, mouse wheel, keyboard (it is focusable) or the arrow buttons,
 * and fades the edges when there is more to see.
 */
export function ClaimJourneyTimeline({ events }: { events: ClaimStatusHistoryItem[] }) {
  const ordered = useMemo(() => [...events].reverse(), [events]); // the API sends newest first
  const scroller = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdge({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth; // open on the latest event
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ordered.length, measure]);

  const nudge = (dir: -1 | 1) => scroller.current?.scrollBy({ left: dir * STEP_PX, behavior: "smooth" });

  if (ordered.length === 0) {
    return <p className="py-2 text-sm text-slate-500">{tx("No audit events recorded yet.")}</p>;
  }

  const arrow = "flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-2xs transition-colors hover:border-blue-300 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-slate-200 disabled:hover:text-slate-600";

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          <span className="font-semibold text-slate-800">{tx("History")}</span>
          <span className="mx-1.5 text-slate-300" aria-hidden="true">·</span>
          {ordered.length > 1 ? tx("{0} status changes, oldest to newest", { 0: ordered.length }) : tx("1 status change")}
        </p>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => nudge(-1)} disabled={!edge.left} aria-label={tx("Earlier events")} className={arrow}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button type="button" onClick={() => nudge(1)} disabled={!edge.right} aria-label={tx("Later events")} className={arrow}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      <div className="relative">
        <div
          ref={scroller}
          onScroll={measure}
          role="region"
          aria-label={tx("Claim journey events")}
          tabIndex={0}
          className="snap-x snap-mandatory overflow-x-auto scroll-smooth rounded-lg pb-3 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500/30"
        >
          <ol className="flex w-max min-w-full gap-4">
            {ordered.map((h, i) => {
              const isLatest = i === ordered.length - 1;
              const { date, time } = splitStamp(h.created_at);
              return (
                <li key={h.id || i} className="flex w-72 shrink-0 snap-start flex-col">
                  <time dateTime={h.created_at} className="block text-xs font-medium text-slate-500">
                    {date} <span className="text-slate-400">·</span> {time}
                  </time>

                  <div className="relative my-2.5 flex h-4 items-center">
                    {i < ordered.length - 1 && (
                      <span aria-hidden="true" className="absolute left-1.5 top-1/2 h-0.5 w-[calc(100%+1rem)] -translate-y-1/2 bg-blue-100" />
                    )}
                    <span
                      aria-hidden="true"
                      className={`relative z-10 h-3.5 w-3.5 rounded-full ring-4 ring-slate-50 ${isLatest ? "bg-blue-600" : "border-2 border-blue-300 bg-white"}`}
                    />
                  </div>

                  <div
                    className={`rounded-xl border p-3.5 ${isLatest ? "border-blue-300 bg-blue-50/70" : "border-slate-200 bg-white"}`}
                  >
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      {h.from_status && (
                        <>
                          <span className="rounded-md border border-slate-200 bg-white px-2 py-0.5 font-semibold text-slate-600">{h.from_status}</span>
                          <svg className="h-3 w-3 shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                          </svg>
                        </>
                      )}
                      <span className={`rounded-md border px-2 py-0.5 font-semibold ${isLatest ? "border-blue-600 bg-blue-600 text-white" : "border-blue-200 bg-blue-50 text-blue-700"}`}>
                        {h.to_status}
                      </span>
                      {isLatest && (
                        <span className="ml-auto rounded-full border border-blue-200 bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-700">
                          {tx("Latest")}
                        </span>
                      )}
                    </div>
                    <p className="mt-2.5 text-xs text-slate-500">
                      {tx("By")} <span className="font-semibold text-slate-700">{h.actor_name || tx("System")}</span>
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
        {edge.left && <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-slate-50 to-transparent" />}
        {edge.right && <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-slate-50 to-transparent" />}
      </div>
    </div>
  );
}
