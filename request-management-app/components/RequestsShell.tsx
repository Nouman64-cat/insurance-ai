"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { NavigationProgress } from "@/components/NavigationProgress";
import AppHeader from "@/components/satellite/AppHeader";
import { tx } from "@/lib/i18n/tx";
import { requestsApi, type Notification, type Summary } from "@/lib/requestsApi";
import { connectRequestEvents, type LiveEvent } from "@/lib/requestEvents";
import { formatDate } from "./ui";

// The app's frame: sections, the "New request" button, notifications, language, the way back to the portal.
// Embedded (?_portal=1 or inside an iframe) it renders the page alone.

const SummaryContext = createContext<{ summary: Summary | null; refresh: () => void }>({ summary: null, refresh: () => {} });
export const useSummary = () => useContext(SummaryContext);

// Live status changes (Server-Sent Events). Pages subscribe with useRequestEvents and reload what they show.
type Listener = (e: LiveEvent) => void;
const LiveContext = createContext<{ subscribe: (l: Listener) => () => void; live: boolean }>({ subscribe: () => () => {}, live: false });

/** Call `handler` for every live change this user may see (and for "resync" after missed changes). */
export function useRequestEvents(handler: Listener) {
  const { subscribe } = useContext(LiveContext);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => subscribe((e) => latest.current(e)), [subscribe]);
}

function LiveDot({ live }: { live: boolean }) {
  return (
    <span className="hidden items-center gap-1.5 text-[11px] font-medium text-slate-500 sm:inline-flex"
      title={live ? tx("Statuses update live") : tx("Reconnecting… statuses refresh when the connection is back")}>
      <span className={`h-2 w-2 rounded-full ${live ? "bg-emerald-500" : "bg-slate-300"}`} />
      {live ? tx("Live") : tx("Offline")}
    </span>
  );
}

function Bell({ unread, onChanged }: { unread: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[] | null>(null);
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setFailed(false);
    requestsApi.notifications().then((r) => setItems(r.items)).catch(() => setFailed(true));
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const openOne = async (n: Notification) => {
    setOpen(false);
    if (!n.read_at) await requestsApi.readNotification(n.id).catch(() => undefined);
    onChanged();
    if (n.request_id) router.push(`/requests/${n.request_id}`);
  };

  return (
    <div className="relative" ref={box}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label={tx("Notifications")}
        className="relative rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -end-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-red-600 px-1 text-[10px] font-bold leading-[1.1rem] text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute end-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <span className="text-xs font-bold text-slate-800">{tx("Notifications")}</span>
            {unread > 0 && (
              <button type="button" className="text-[11px] font-semibold text-blue-600"
                onClick={async () => { await requestsApi.readAll().catch(() => undefined); setItems((xs) => xs?.map((x) => ({ ...x, read_at: x.read_at ?? "now" })) ?? null); onChanged(); }}>
                {tx("Mark all read")}
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {failed ? <p className="px-4 py-6 text-center text-xs text-red-600">{tx("Couldn't load notifications.")}</p>
              : items === null ? <p className="px-4 py-6 text-center text-xs text-slate-500">{tx("Loading…")}</p>
                : items.length === 0 ? <p className="px-4 py-6 text-center text-xs text-slate-500">{tx("No notifications yet.")}</p>
                  : items.map((n) => (
                    <button key={n.id} type="button" onClick={() => openOne(n)}
                      className={`block w-full border-b border-slate-50 px-4 py-2.5 text-start hover:bg-slate-50 ${n.read_at ? "" : "bg-blue-50/40"}`}>
                      <p className="text-xs font-semibold text-slate-800">{tx(n.title)}</p>
                      <p className="mt-0.5 text-[11px] text-slate-600">{n.body}</p>
                      <p className="mt-0.5 text-[10px] text-slate-400">{formatDate(n.created_at, true)}</p>
                    </button>
                  ))}
          </div>
        </div>
      )}
    </div>
  );
}

function useEmbedded(): boolean {
  const searchParams = useSearchParams();
  const [framed, setFramed] = useState(false);
  useEffect(() => { setFramed(window.parent !== window); }, []);
  return searchParams?.get("_portal") === "1" || framed;
}

export default function RequestsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const embedded = useEmbedded();
  const [summary, setSummary] = useState<Summary | null>(null);

  const [live, setLive] = useState(false);
  const listeners = useRef(new Set<Listener>());

  const refresh = useCallback(() => {
    requestsApi.summary().then(setSummary).catch(() => undefined);
  }, []);

  const subscribe = useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => { listeners.current.delete(l); };
  }, []);

  // One stream per tab. Every change refreshes the counts (coalesced: a burst of changes is one reload).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = connectRequestEvents({
      onLive: setLive,
      onEvent: (e) => {
        listeners.current.forEach((l) => l(e));
        clearTimeout(timer);
        timer = setTimeout(refresh, 300);
      },
    });
    return () => { clearTimeout(timer); close(); };
  }, [refresh]);

  // Counts on every page change. Notifications and overdue counts aren't status changes, so they're still polled:
  // every minute while live, every 30 seconds while the stream is down.
  useEffect(() => { refresh(); }, [pathname, refresh]);
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, live ? 60_000 : 30_000);
    return () => clearInterval(id);
  }, [refresh, live]);

  const sections = [
    { href: "/requests", label: tx("My requests"), count: summary?.my_needs_information || 0, show: true },
    { href: "/requests/review", label: tx("Review queue"), count: (summary?.assigned_to_me ?? 0) + (summary?.queue_unclaimed ?? 0), show: !!summary?.can_review },
    { href: "/requests/admin", label: tx("Tenant queue"), count: summary?.tenant_overdue || 0, show: !!summary?.is_admin },
    { href: "/requests/routing", label: tx("Routing"), count: 0, show: !!summary?.is_admin },
  ].filter((s) => s.show);
  const active = (href: string) => href === "/requests" ? pathname === "/requests" : pathname.startsWith(href);

  const value = { summary, refresh };
  const liveValue = { subscribe, live };
  if (embedded) {
    return (
      <LiveContext.Provider value={liveValue}>
        <SummaryContext.Provider value={value}><NavigationProgress /><main className="h-screen overflow-auto bg-slate-50">{children}</main></SummaryContext.Provider>
      </LiveContext.Provider>
    );
  }

  return (
    <LiveContext.Provider value={liveValue}>
    <SummaryContext.Provider value={value}>
      <div className="flex h-screen flex-col overflow-hidden bg-slate-50">
        <NavigationProgress />
        <AppHeader
          title={tx("Request Management")}
          home="/requests"
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
              <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
          }
          actions={
            <>
              <LiveDot live={live} />
              <Link href="/requests/new" className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700">
                {tx("+ New request")}
              </Link>
              <Bell unread={summary?.unread_notifications ?? 0} onChanged={refresh} />
            </>
          }
          sections={sections.map((s) => ({ href: s.href, label: s.label, count: s.count, active: active(s.href) }))}
          sectionsLabel={tx("Request sections")}
        />
        <main className="relative flex-1 overflow-auto bg-slate-50">{children}</main>
      </div>
    </SummaryContext.Provider>
    </LiveContext.Provider>
  );
}
