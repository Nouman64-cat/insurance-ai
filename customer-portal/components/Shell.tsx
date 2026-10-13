"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { api, authPost, useApi } from "@/lib/api";
import { initials } from "@/lib/format";
import type { Me } from "@/lib/types";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Icon, ToastProvider, Skeleton } from "./ui";

const NAV = [
  { href: "/dashboard", key: "dashboard", icon: "dashboard" },
  { href: "/policies", key: "policies", icon: "policies" },
  { href: "/payments", key: "payments", icon: "payments" },
  { href: "/claims", key: "claims", icon: "claims" },
  { href: "/documents", key: "documents", icon: "documents" },
  { href: "/profile", key: "profile", icon: "profile" },
  { href: "/support", key: "support", icon: "support" },
] as const;

export const NOTICES_CHANGED = "cp:notices-changed";

function Brand({ collapsed }: { collapsed: boolean }) {
  const { t } = useI18n();
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5 overflow-hidden">
      <span className="text-blue-600 flex-shrink-0"><Icon name="shield" className="w-7 h-7" /></span>
      {!collapsed && (
        <div className="flex flex-col justify-center">
          <span className="text-slate-900 font-bold text-[16px] tracking-tight whitespace-nowrap leading-tight">{t("brand.name")}</span>
          <span className="text-blue-500 font-medium text-[11px] whitespace-nowrap leading-tight">{t("brand.tagline")}</span>
        </div>
      )}
    </Link>
  );
}

function NavList({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { t } = useI18n();
  const pathname = usePathname();
  return (
    <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5" aria-label={t("nav.label")}>
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link key={item.href} href={item.href} onClick={onNavigate} title={collapsed ? t(`nav.${item.key}`) : undefined} aria-current={active ? "page" : undefined}
            className={`flex items-center transition-all duration-150 text-[13px] ${collapsed ? "w-11 h-11 justify-center rounded-xl mx-auto p-0" : "gap-2.5 px-3 py-2.5 rounded-xl mx-2"} ${
              active ? "bg-blue-50 text-blue-700 font-bold shadow-sm ring-1 ring-blue-100/50" : "text-slate-600 font-medium hover:text-slate-900 hover:bg-slate-50"}`}>
            <span className={active ? "text-blue-600" : "text-slate-400"}><Icon name={item.icon} /></span>
            {!collapsed && <span className="flex-1 truncate">{t(`nav.${item.key}`)}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={`w-4 h-4 transition-transform duration-300 rtl:-scale-x-100 ${collapsed ? "rotate-180" : ""}`}><polyline points="15 18 9 12 15 6" /></svg>
  );
}

function AccountMenu({ me, onSignOut }: { me: Me | null; onSignOut: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label={t("account.menu")}
        className="flex items-center gap-2 rounded-xl px-1.5 py-1 hover:bg-slate-100 transition-colors">
        <span className="w-8 h-8 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center">{me ? initials(me.display_name) : "…"}</span>
        <span className="hidden md:block text-start leading-tight">
          <span className="block text-xs font-bold text-slate-800 max-w-[140px] truncate">{me?.display_name || <Skeleton className="h-3 w-20" />}</span>
          <span className="block text-[10px] text-slate-400 ltr-num">{me?.username}</span>
        </span>
      </button>
      {open && (
        <div role="menu" className="absolute end-0 mt-2 w-60 card p-1.5 z-50">
          <div className="px-3 py-2 border-b border-slate-100 mb-1">
            <p className="text-sm font-bold text-slate-800 truncate">{me?.display_name}</p>
            <p className="text-xs text-slate-400 ltr-num">{me?.username}</p>
          </div>
          <Link role="menuitem" href="/profile" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg text-slate-700 hover:bg-slate-50"><Icon name="profile" className="w-4 h-4" />{t("account.profile")}</Link>
          <Link role="menuitem" href="/profile#security" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg text-slate-700 hover:bg-slate-50"><Icon name="lock" className="w-4 h-4" />{t("account.changePassword")}</Link>
          <button role="menuitem" type="button" onClick={onSignOut} className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg text-rose-700 hover:bg-rose-50 text-start">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
            {t("account.signOut")}
          </button>
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const me = useApi<Me>("me");
  const notices = useApi<{ unread: number }>("notifications");
  const reloadNotices = notices.reload;
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => { setDrawer(false); }, [pathname]);
  useEffect(() => {
    window.addEventListener(NOTICES_CHANGED, reloadNotices);
    return () => window.removeEventListener(NOTICES_CHANGED, reloadNotices);
  }, [reloadNotices]);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try { await authPost("logout"); } catch { /* cookies are cleared by the server either way */ }
    router.replace("/login");
    router.refresh();
  }, [router]);

  const unread = notices.data?.unread ?? 0;
  const current = NAV.find((n) => pathname === n.href || pathname.startsWith(n.href + "/"));
  const title = pathname.startsWith("/notifications") ? t("nav.notifications") : current ? t(`nav.${current.key}`) : t("brand.name");

  return (
    <ToastProvider>
      <div className="flex h-screen overflow-hidden bg-slate-50">
        {/* desktop sidebar */}
        <aside className={`hidden lg:flex flex-shrink-0 flex-col bg-white border-e border-slate-200 transition-all duration-300 ease-in-out overflow-x-hidden ${collapsed ? "w-[72px]" : "w-64"} h-screen relative z-40`}>
          <div className={`flex items-center border-b border-slate-100 flex-shrink-0 ${collapsed ? "flex-col justify-center py-4 gap-4" : "justify-between h-16 px-4"}`}>
            <Brand collapsed={collapsed} />
            <button type="button" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors flex-shrink-0"><Chevron collapsed={collapsed} /></button>
          </div>
          <NavList collapsed={collapsed} />
          <div className={`border-t border-slate-100 p-3 ${collapsed ? "flex justify-center" : ""}`}>
            <button type="button" onClick={signOut} disabled={signingOut} title={t("account.signOut")}
              className={`flex items-center gap-2.5 text-[13px] font-medium text-slate-500 hover:text-rose-700 hover:bg-rose-50 rounded-xl transition-colors ${collapsed ? "w-11 h-11 justify-center" : "w-full px-3 py-2.5"}`}>
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
              {!collapsed && t("account.signOut")}
            </button>
          </div>
        </aside>

        {/* mobile drawer */}
        {drawer && (
          <div className="lg:hidden fixed inset-0 z-50 flex">
            <div className="absolute inset-0 bg-slate-900/50" onClick={() => setDrawer(false)} aria-hidden="true" />
            <aside className="relative w-72 max-w-[85vw] bg-white h-full flex flex-col shadow-2xl" role="dialog" aria-modal="true" aria-label={t("nav.label")}>
              <div className="flex items-center justify-between h-16 px-4 border-b border-slate-100"><Brand collapsed={false} />
                <button type="button" onClick={() => setDrawer(false)} aria-label={t("common.close")} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100"><svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" /></svg></button></div>
              <NavList collapsed={false} onNavigate={() => setDrawer(false)} />
              <div className="border-t border-slate-100 p-3"><button type="button" onClick={signOut} className="w-full flex items-center gap-2.5 px-3 py-2.5 text-[13px] font-medium text-rose-700 hover:bg-rose-50 rounded-xl">{t("account.signOut")}</button></div>
            </aside>
          </div>
        )}

        <div className="flex-1 flex flex-col min-w-0">
          <header className="sticky top-0 z-30 h-14 flex-shrink-0 flex items-center justify-between gap-3 px-4 sm:px-6 bg-white/80 backdrop-blur-md border-b border-slate-200 shadow-sm">
            <div className="flex items-center gap-2 min-w-0">
              <button type="button" onClick={() => setDrawer(true)} aria-label={t("nav.open")} className="lg:hidden p-2 -ms-2 rounded-lg text-slate-600 hover:bg-slate-100"><Icon name="menu" /></button>
              <h1 className="text-base font-bold text-slate-900 tracking-tight truncate">{title}</h1>
              <span className="hidden sm:inline-flex items-center text-[9px] font-bold uppercase tracking-[0.12em] text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full whitespace-nowrap">{t("topBar.customerPortal")}</span>
            </div>
            <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
              <LanguageSwitcher />
              <Link href="/notifications" aria-label={unread ? t("notifications.unreadAria", { count: unread }) : t("nav.notifications")} className="relative p-2 rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors">
                <Icon name="bell" />
                {unread > 0 && <span className="absolute top-1 end-1 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center">{unread > 9 ? "9+" : unread}</span>}
              </Link>
              <AccountMenu me={me.data} onSignOut={signOut} />
            </div>
          </header>
          <main className="flex-1 overflow-y-auto" id="main">
            <div className="max-w-screen-2xl mx-auto w-full px-4 sm:px-6 py-6">{children}</div>
            <footer className="px-6 py-4 text-center text-[11px] text-slate-400">{t("footer.text")}</footer>
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
