"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useCallback, useState } from "react";
import { authPost } from "@/lib/api";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Icon, ToastProvider } from "./ui";

// A walk-in sees exactly these five things. The restriction is enforced by the backend; this is only what is drawn.
const NAV = [
  { href: "/walk-in/apply", key: "apply", icon: "claims" },
  { href: "/walk-in/plans", key: "plans", icon: "policies" },
  { href: "/walk-in/status", key: "status", icon: "calendar" },
  { href: "/walk-in/profile", key: "profile", icon: "profile" },
] as const;

export function WalkInShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const logout = useCallback(async () => {
    setBusy(true);
    try { await authPost("walk-in/logout"); } catch { /* the server clears the cookies either way */ }
    router.replace("/walk-in/start");
    router.refresh();
  }, [router]);

  const links = (
    <nav className="flex-1 py-3 px-2 space-y-0.5" aria-label={t("nav.label")}>
      {NAV.map((n) => {
        const active = pathname === n.href || pathname.startsWith(n.href + "/");
        return (
          <Link key={n.href} href={n.href} onClick={() => setOpen(false)} aria-current={active ? "page" : undefined}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] transition-colors ${active ? "bg-blue-50 text-blue-700 font-bold ring-1 ring-blue-100/50" : "text-slate-600 font-medium hover:text-slate-900 hover:bg-slate-50"}`}>
            <span className={active ? "text-blue-600" : "text-slate-400"}><Icon name={n.icon} /></span>
            {t(`walkin.nav.${n.key}`)}
          </Link>
        );
      })}
      <button type="button" onClick={logout} disabled={busy}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] font-medium text-slate-500 hover:text-rose-700 hover:bg-rose-50 text-start">
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" /></svg>
        {t("walkin.nav.logout")}
      </button>
    </nav>
  );
  const brand = (
    <div className="flex items-center gap-2.5">
      <span className="text-blue-600"><Icon name="shield" className="w-7 h-7" /></span>
      <div className="flex flex-col"><span className="text-slate-900 font-bold text-[16px] tracking-tight leading-tight">{t("brand.name")}</span>
        <span className="text-blue-500 font-medium text-[11px] leading-tight">{t("walkin.tagline")}</span></div>
    </div>
  );
  return (
    <ToastProvider>
      <div className="flex h-screen overflow-hidden bg-slate-50">
        <aside className="hidden lg:flex w-64 flex-shrink-0 flex-col bg-white border-e border-slate-200">
          <div className="h-16 px-4 flex items-center border-b border-slate-100">{brand}</div>
          {links}
        </aside>
        {open && (
          <div className="lg:hidden fixed inset-0 z-50 flex">
            <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} aria-hidden="true" />
            <aside className="relative w-72 max-w-[85vw] bg-white h-full flex flex-col shadow-2xl" role="dialog" aria-modal="true">
              <div className="h-16 px-4 flex items-center border-b border-slate-100">{brand}</div>
              {links}
            </aside>
          </div>
        )}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="sticky top-0 z-30 h-14 flex items-center justify-between gap-3 px-4 sm:px-6 bg-white/80 backdrop-blur-md border-b border-slate-200">
            <button type="button" onClick={() => setOpen(true)} aria-label={t("nav.open")} className="lg:hidden p-2 -ms-2 rounded-lg text-slate-600 hover:bg-slate-100"><Icon name="menu" /></button>
            <span className="hidden sm:inline-flex items-center text-[9px] font-bold uppercase tracking-[0.12em] text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">{t("walkin.badge")}</span>
            <div className="ms-auto"><LanguageSwitcher /></div>
          </header>
          <main className="flex-1 overflow-y-auto" id="main">
            <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-6">{children}</div>
            <footer className="px-6 py-4 text-center text-[11px] text-slate-400">{t("footer.text")}</footer>
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
