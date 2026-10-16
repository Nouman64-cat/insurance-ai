"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { tx } from "@/lib/i18n/tx";

/**
 * "New arrival" tracking for list pages. A record is new until the user opens it: until then its row beats in light blue
 * and a banner at the top of the page says how many are waiting. What has been seen is remembered per page in this
 * browser, so a lead moved from Leads to Proposals is still flagged when the user gets there, and stays flagged
 * until they open it. The first visit only records what is already there, so nothing old is flagged.
 */
const key = (page: string) => `new_arrivals_seen:v7:${page}`;
const read = (page: string): Set<string> | null => {
  try { const raw = localStorage.getItem(key(page)); return raw ? new Set(JSON.parse(raw) as string[]) : null; } catch { return null; }
};
const write = (page: string, seen: Set<string>) => {
  try { localStorage.setItem(key(page), JSON.stringify(Array.from(seen).slice(-5000))); } catch { /* storage blocked: rows simply won't be flagged */ }
};

/** `freshIds`: records recent enough that they should still be flagged on a first visit (e.g. created in the last day),
 *  so a case that arrived just before the page was first opened is not mistaken for old. */
export function useNewArrivals(page: string, ids: string[], ready: boolean, freshIds?: Map<string, number>) {
  const [seen, setSeen] = useState<Set<string> | null>(null);

  // What this browser has opened. It only ever matters for records that are ALSO recent (see below).
  useEffect(() => { setSeen(read(page) ?? new Set()); }, [page]);

  // Only ONE record is ever "new": the single most recent arrival on this page, and only while it is recent (`freshIds`:
  // touched within the last few minutes) and has not been opened here. Opening it clears it, and nothing else takes its
  // place — an older record is never flagged because a newer one was opened. A newer arrival becomes the new one.
  const newIds = useMemo(() => {
    if (!ready || !seen || !freshIds) return new Set<string>();
    let latest: string | null = null; let at = -Infinity;
    for (const id of ids) { const ms = freshIds.get(id); if (ms !== undefined && ms > at) { at = ms; latest = id; } }
    return new Set(latest && !seen.has(latest) ? [latest] : []);
  }, [ready, seen, ids, freshIds]);

  const markSeen = useCallback((id: string) => {
    setSeen((prev) => { if (!prev || prev.has(id)) return prev; const next = new Set(prev); next.add(id); write(page, next); return next; });
  }, [page]);
  const markAllSeen = useCallback(() => {
    setSeen((prev) => { const next = new Set(prev ?? []); newIds.forEach((id) => next.add(id)); write(page, next); return next; });
  }, [page, newIds]);

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

/** Scrolls the first highlighted row into view (retrying briefly: the row may only render after a filter or page change). */
export const scrollToFirstNew = () => {
  let tries = 0;
  const go = () => {
    const el = document.querySelector<HTMLElement>(`.${NEW_ARRIVAL_CLASS}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    else if (++tries < 12) window.setTimeout(go, 120);
  };
  go();
};

/** id → time for the records touched within the last `minutes` (default 30) — pass as `freshIds`. */
export const recentIds = <T,>(items: T[], id: (t: T) => string, at: (t: T) => string | null | undefined, minutes = 30) => {
  const cutoff = Date.now() - minutes * 60_000;
  const out = new Map<string, number>();
  for (const t of items) { const v = at(t); const ms = v ? new Date(v).getTime() : NaN; if (!Number.isNaN(ms) && ms >= cutoff) out.set(id(t), ms); }
  return out;
};

/**
 * "Show" on the banner for paginated, filterable lists: if the new row is hidden by a filter or sits on another page,
 * clear the filters (`reset`), jump to its page, then scroll to it.
 */
export function useRevealNew<T>(opts: {
  filtered: T[]; keyOf: (t: T) => string; newIds: Set<string>; pageSize: number;
  setPage: (page: number) => void; reset: () => void;
}) {
  const { filtered, keyOf, newIds, pageSize, setPage, reset } = opts;
  const [pending, setPending] = useState(false);
  const jump = () => {
    const idx = filtered.findIndex((t) => newIds.has(keyOf(t)));
    if (idx < 0) return false;
    setPage(Math.floor(idx / pageSize) + 1);
    scrollToFirstNew();
    return true;
  };
  useEffect(() => {
    if (!pending) return;
    jump();
    setPending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, filtered]);
  return () => { if (!jump()) { reset(); setPending(true); } };
}

/** New arrivals first, everything else keeps its order. */
export const floatNew = <T,>(list: T[], keyOf: (t: T) => string, newIds: Set<string>): T[] => {
  if (newIds.size === 0) return list;
  return [...list.filter((t) => newIds.has(keyOf(t))), ...list.filter((t) => !newIds.has(keyOf(t)))];
};
