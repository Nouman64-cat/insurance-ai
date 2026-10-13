"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { NavigationProgress } from "@/components/NavigationProgress";
import { useSatelliteUser } from "@/components/satellite/SsoGate";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { tx } from "@/lib/i18n/tx";
import { portalUrl } from "@/lib/appLinks";
import { signOut } from "@/lib/sso";
import { requestsApi, type Notification, type Summary } from "@/lib/requestsApi";
import { formatDate } from "./ui";

// The app's frame: sections, the "New request" button, notifications, language, the way back to the portal.
// Embedded (?_portal=1 or inside an iframe) it renders the page alone.

const SummaryContext = createContext<{ summary: Summary | null; refresh: () => void }>({ summary: null, refresh: () => {} });
export const useSummary = () => useContext(SummaryContext);

function portalHome(role: string): string {
  if (role === "Admin") return portalUrl("/");
  if (role === "Agent" || role === "Broker") return portalUrl("/proposal");
  if (role === "ClaimsAdjuster" || role === "ClaimsManager") return portalUrl("/claims");
  return portalUrl("/cases");
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
  const { t } = useI18n();
  const user = useSatelliteUser();
  const pathname = usePathname();
  const embedded = useEmbedded();
  const [summary, setSummary] = useState<Summary | null>(null);

  const refresh = useCallback(() => {
    requestsApi.summary().then(setSummary).catch(() => undefined);
  }, []);

  // Counts on every page change, and every 30 seconds while the tab is visible (notifications arrive in between).
  useEffect(() => { refresh(); }, [pathname, refresh]);
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const sections = [
    { href: "/requests", label: tx("My requests"), count: summary?.my_needs_information || 0, show: true },
    { href: "/requests/review", label: tx("Review queue"), count: (summary?.assigned_to_me ?? 0) + (summary?.queue_unclaimed ?? 0), show: !!summary?.can_review },
    { href: "/requests/admin", label: tx("Tenant queue"), count: summary?.tenant_overdue || 0, show: !!summary?.is_admin },
    { href: "/requests/routing", label: tx("Routing"), count: 0, show: !!summary?.is_admin },
  ].filter((s) => s.show);
  const active = (href: string) => href === "/requests" ? pathname === "/requests" : pathname.startsWith(href);

  const value = { summary, refresh };
  if (embedded) {
    return <SummaryContext.Provider value={value}><NavigationProgress /><main className="h-screen overflow-auto bg-slate-50">{children}</main></SummaryContext.Provider>;
  }

  return (
    <SummaryContext.Provider value={value}>
      <div className="flex h-screen flex-col overflow-hidden bg-slate-50">
        <NavigationProgress />
        <header className="shrink-0 border-b border-slate-200 bg-white">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-2.5">
            <Link href="/requests" className="flex items-center gap-2.5">
              <span className="text-blue-600" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
                  <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              </span>
              <span className="flex flex-col leading-tight">
                <span className="text-[15px] font-bold tracking-tight text-slate-900">{tx("Request Management")}</span>
                <span className="text-[11px] font-medium text-blue-500">{user.tenant_name ?? t("sidebar.brand")}</span>
              </span>
            </Link>
            <div className="ms-auto flex items-center gap-3">
              <Link href="/requests/new" className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">
                {tx("+ New request")}
              </Link>
              <Bell unread={summary?.unread_notifications ?? 0} onChanged={refresh} />
              <LanguageSwitcher />
              <a href={portalHome(user.role_name)} className="whitespace-nowrap rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                {tx("← Back to the portal")}
              </a>
              <div className="hidden min-w-0 text-end sm:block">
                <p className="max-w-[12rem] truncate text-xs font-bold text-slate-900">{user.full_name || user.email}</p>
                <p className="text-[10px] text-slate-500">{user.role_name}</p>
              </div>
              <button type="button" onClick={signOut} title={t("sidebar.logout")} aria-label={t("sidebar.logout")}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 rtl:-scale-x-100">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </div>
            <nav aria-label={tx("Request sections")} className="order-last -mb-1 flex w-full gap-1 overflow-x-auto pb-1">
              {sections.map((s) => (
                <Link key={s.href} href={s.href} aria-current={active(s.href) ? "page" : undefined}
                  className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold ${active(s.href) ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"}`}>
                  {s.label}
                  {s.count > 0 && <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-800">{s.count}</span>}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="relative flex-1 overflow-auto bg-slate-50">{children}</main>
      </div>
    </SummaryContext.Provider>
  );
}
