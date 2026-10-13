"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { NavigationProgress } from "@/components/NavigationProgress";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { tx } from "@/lib/i18n/tx";
import { useRecordHighlighter } from "@/lib/useHighlightTarget";
import { AUTOMATION_URL, PORTAL_URL, portalUrl } from "@/lib/appLinks";
import { signOut } from "@/lib/sso";
import { useWorkbenchUser } from "./SsoGate";

// The workbench's frame: a top bar with the underwriting sections, who is signed in, the language switch and the way
// back to the portal. Pages embedded elsewhere (the Automation Chat's case panel opens them with ?_portal=1, or in
// any iframe) render on their own, without this bar: the window around them already has its navigation.

const SECTIONS = [
  { href: "/underwriting?tab=pre-underwriting", label: "Pre-Underwriting" },
  { href: "/underwriting?tab=risk-engine", label: "Risk Engine & OCR OPS" },
  { href: "/post-underwriting", label: "Post-Underwriting Verification" },
  { href: "/live-evaluation", label: "Live Evaluation" },
  { href: "/assessments", label: "Assessment History" },
] as const;

/** The section lit for a URL. A case belongs to Pre-Underwriting, where it is opened from. */
function activeSection(pathname: string, tab: string | null): string | null {
  if (pathname.startsWith("/case/") || pathname === "/pre-underwriting") return SECTIONS[0].href;
  if (pathname === "/underwriting") return tab === "risk-engine" ? SECTIONS[1].href : SECTIONS[0].href;
  return SECTIONS.find((s) => s.href === pathname)?.href ?? null;
}

/** The portal page each role starts on (the same as the portal's brand link). */
function portalHome(role: string): string {
  if (role === "Admin") return portalUrl("/");
  if (role === "Agent" || role === "Broker") return portalUrl("/proposal");
  if (role === "ClaimsAdjuster" || role === "ClaimsManager") return portalUrl("/claims");
  return portalUrl("/cases");
}

function useEmbedded(): boolean {
  const searchParams = useSearchParams();
  const [framed, setFramed] = useState(false);
  // Also true after a link inside the frame navigated away from the URL that carried ?_portal=1.
  useEffect(() => { setFramed(window.parent !== window); }, []);
  return searchParams?.get("_portal") === "1" || framed;
}

export default function WorkbenchShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const user = useWorkbenchUser();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const embedded = useEmbedded();
  const lit = activeSection(pathname, searchParams.get("tab"));

  // "Pop the record the agent just navigated to" (?case_id=…, ?highlight=…), as in the portal.
  useRecordHighlighter();

  if (embedded) {
    return (
      <>
        <NavigationProgress />
        <main className="h-screen overflow-auto bg-slate-50">{children}</main>
      </>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-50">
      <NavigationProgress />
      <header className="shrink-0 border-b border-slate-200 bg-white">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-2.5">
          <Link href="/underwriting" className="flex items-center gap-2.5">
            <span className="text-blue-600" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-[15px] font-bold tracking-tight text-slate-900">{tx("Underwriting Workbench")}</span>
              <span className="text-[11px] font-medium text-blue-500">{user.tenant_name ?? t("sidebar.brand")}</span>
            </span>
          </Link>

          {/* Its own row under the brand and account controls, so every section stays visible at any width. */}
          <nav aria-label={tx("Underwriting sections")} className="order-last -mb-1 flex w-full gap-1 overflow-x-auto pb-1">
            {SECTIONS.map((s) => {
              const active = lit === s.href;
              return (
                <Link
                  key={s.href}
                  href={s.href}
                  aria-current={active ? "page" : undefined}
                  className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                    active ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  }`}
                >
                  {t(`nav.${s.label}`)}
                </Link>
              );
            })}
          </nav>

          <div className="ms-auto flex items-center gap-3">
            <LanguageSwitcher />
            <a
              href={AUTOMATION_URL}
              target="_blank"
              rel="noopener"
              className="hidden whitespace-nowrap text-xs font-semibold text-slate-500 hover:text-slate-900 md:inline"
            >
              {tx("Automation")}
            </a>
            <a
              href={portalHome(user.role_name)}
              className="whitespace-nowrap rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              title={PORTAL_URL}
            >
              {tx("← Back to the portal")}
            </a>
            <div className="hidden min-w-0 text-end sm:block">
              <p className="max-w-[12rem] truncate text-xs font-bold text-slate-900">{user.full_name || user.email}</p>
              <p className="text-[10px] text-slate-500">{user.role_name}</p>
            </div>
            <button
              type="button"
              onClick={signOut}
              title={t("sidebar.logout")}
              aria-label={t("sidebar.logout")}
              className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 rtl:-scale-x-100">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <main className="relative flex-1 overflow-auto bg-slate-50">{children}</main>
    </div>
  );
}
