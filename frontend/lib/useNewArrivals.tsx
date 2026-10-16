"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { tx } from "@/lib/i18n/tx";

/**
 * "New arrival" tracking for list pages. A record is new until the user opens it: until then its row beats in light blue
 * and a banner at the top of the page says how many are waiting. What has been seen is remembered per page in this
 * browser, so a lead moved from Leads to Proposals is still flagged when the user gets there, and stays flagged
 * until they open it. The first visit only records what is already there, so nothing old is flagged.
 */
const key = (page: string) => `new_arrivals_seen:v2:${page}`;
const read = (page: string): Set<string> | null => {
  try { const raw = localStorage.getItem(key(page)); return raw ? new Set(JSON.parse(raw) as string[]) : null; } catch { return null; }
};
const write = (page: string, seen: Set<string>) => {
  try { localStorage.setItem(key(page), JSON.stringify(Array.from(seen).slice(-5000))); } catch { /* storage blocked: rows simply won't be flagged */ }
};

/** `freshIds`: records recent enough that they should still be flagged on a first visit (e.g. created in the last day),
 *  so a case that arrived just before the page was first opened is not mistaken for old. */
export function useNewArrivals(page: string, ids: string[], ready: boolean, freshIds?: Set<string>) {
  const [seen, setSeen] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!ready) return;
    const stored = read(page);
    if (stored) {
      // A key can carry a version ("id|submitted"). A record already seen before versions existed counts as seen at its current version.
      const upgraded = ids.filter((k) => k.includes("|") && !stored.has(k) && stored.has(k.split("|")[0]));
      if (upgraded.length) { upgraded.forEach((k) => stored.add(k)); write(page, stored); }
      setSeen(new Set(stored));
      return;
    }
    const baseline = new Set(ids.filter((id) => !freshIds?.has(id)));   // first visit: what is already here counts as seen, except very recent arrivals
    write(page, baseline);
    setSeen(baseline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, ready]);

  const newIds = useMemo(() => new Set(seen ? ids.filter((id) => !seen.has(id)) : []), [seen, ids]);

  const markSeen = useCallback((id: string) => {
    setSeen((prev) => { if (!prev || prev.has(id)) return prev; const next = new Set(prev); next.add(id); write(page, next); return next; });
  }, [page]);
  const markAllSeen = useCallback(() => {
    setSeen((prev) => { const next = new Set(prev ?? []); ids.forEach((id) => next.add(id)); write(page, next); return next; });
  }, [page, ids]);

  return { newIds, markSeen, markAllSeen };
}

const Ctx = createContext<{ newIds: Set<string>; markSeen: (id: string) => void }>({ newIds: new Set(), markSeen: () => {} });
export function NewArrivalsProvider({ value, children }: { value: { newIds: Set<string>; markSeen: (id: string) => void }; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useNewArrivalsContext = () => useContext(Ctx);

/** Light-blue beating highlight for a row/card that has not been opened yet. */
export const NEW_ARRIVAL_CLASS = "new-arrival";

/** The pop-up at the top of the page: stays until the new records are opened (or dismissed). */
export function NewArrivalsBanner({ count, noun, onShow, onDismiss }: { count: number; noun: string; onShow: () => void; onDismiss: () => void }) {
  if (count === 0) return null;
  return (
    <div role="status" className="sticky top-2 z-30 flex items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50/95 px-4 py-2.5 shadow-md shadow-blue-500/10 backdrop-blur">
      <div className="flex items-center gap-3">
        <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-600" /></span>
        <p className="text-sm font-semibold text-blue-900">{count} {tx(count === 1 ? `new ${noun}` : `new ${noun}s`)} <span className="font-normal text-blue-800">{tx("waiting — highlighted below until you open them.")}</span></p>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={onShow} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">{tx("Show")}</button>
        <button onClick={onDismiss} aria-label={tx("Dismiss")} className="rounded-lg p-1.5 text-blue-700 hover:bg-blue-100"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>
      </div>
    </div>
  );
}

/** Scrolls the first highlighted row into view. */
export const scrollToFirstNew = () => document.querySelector<HTMLElement>(`.${NEW_ARRIVAL_CLASS}`)?.scrollIntoView({ behavior: "smooth", block: "center" });

/** The single most recent record (and only if it is within the last `hours`) — pass as `freshIds`, so a first visit flags
 *  just the latest arrival and not everything created recently. */
export const recentIds = <T,>(items: T[], id: (t: T) => string, at: (t: T) => string | null | undefined, hours = 24) => {
  const cutoff = Date.now() - hours * 3600_000;
  let best: { id: string; t: number } | null = null;
  for (const item of items) {
    const v = at(item); const t = v ? new Date(v).getTime() : NaN;
    if (!Number.isNaN(t) && t >= cutoff && (!best || t > best.t)) best = { id: id(item), t };
  }
  return new Set(best ? [best.id] : []);
};
