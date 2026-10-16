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
import { trackForRole } from "./SpecialistWorkspace";
import { useWorkbenchUser } from "./SsoGate";

// The workbench's frame: a top bar with the underwriting sections, who is signed in, the language switch and the way
// back to the portal. Pages embedded elsewhere (the Automation Chat's case panel opens them with ?_portal=1, or in
// any iframe) render on their own, without this bar: the window around them already has its navigation.

// Underwriting is one queue: each application's medical and financial reviews, compiled into the final decision.
// (The old post-underwriting, live-evaluation and assessment-history pages still resolve by URL; they are no
// longer sections of the workbench.)
const SECTIONS = [
  { href: "/underwriting?tab=pre-underwriting", label: "Underwriting" },
] as const;

/** The section lit for a URL. A case belongs to Pre-Underwriting, where it is opened from. */
function activeSection(pathname: string, tab: string | null): string | null {
  if (pathname.startsWith("/case/") || pathname === "/pre-underwriting") return SECTIONS[0].href;
  if (pathname === "/underwriting") return SECTIONS[0].href;
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

function SectionLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors ${
        active ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-900"
      }`}
    >
      {label}
    </Link>
  );
}

export default function WorkbenchShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const user = useWorkbenchUser();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const embedded = useEmbedded();
  const track = trackForRole(user.role_name);
  const sections = track ? [{ href: "/underwriting", label: track === "medical" ? "Medical Underwriting" : "Financial Underwriting" }] : SECTIONS;
  const lit = track ? "/underwriting" : activeSection(pathname, searchParams.get("tab"));

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
        <div className="flex h-14 items-center gap-6 px-5">
          <Link href="/underwriting" className="flex flex-shrink-0 items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-semibold text-slate-900">{tx("Underwriting")}</span>
              <span className="max-w-[11rem] truncate text-xs text-slate-500">{user.tenant_name ?? t("sidebar.brand")}</span>
            </span>
          </Link>

          {/* Sections sit in the bar on wide screens and drop to their own row (below) on narrow ones. */}
          <nav aria-label={tx("Underwriting sections")} className="hidden h-full items-stretch gap-1 lg:flex">
            {sections.map((s) => (
              <SectionLink key={s.href} href={s.href} label={track ? tx(s.label) : t(`nav.${s.label}`)} active={lit === s.href} />
            ))}
          </nav>

          <div className="ms-auto flex items-center gap-2">
            <LanguageSwitcher />
            <span className="mx-1 hidden h-6 w-px bg-slate-200 md:block" aria-hidden="true" />
            <a
              href={AUTOMATION_URL}
              target="_blank"
              rel="noopener"
              className="hidden items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 md:inline-flex"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
              </svg>
              {tx("Automation")}
            </a>
            <a
              href={track ? portalUrl("/profile") : portalHome(user.role_name)}
              title={PORTAL_URL}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
              {tx("Portal")}
            </a>
            <span className="mx-1 hidden h-6 w-px bg-slate-200 sm:block" aria-hidden="true" />
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600" aria-hidden="true">
                {(user.full_name || user.email || "?").split(/[\s@.]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
              </span>
              <div className="hidden min-w-0 leading-tight sm:block">
                <p className="max-w-[10rem] truncate text-sm font-medium text-slate-900">{user.full_name || user.email}</p>
                <p className="text-xs text-slate-500">{user.role_name}</p>
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
        </div>
        <nav aria-label={tx("Underwriting sections")} className="flex h-11 items-stretch gap-1 overflow-x-auto border-t border-slate-100 px-5 lg:hidden">
          {sections.map((s) => (
            <SectionLink key={s.href} href={s.href} label={track ? tx(s.label) : t(`nav.${s.label}`)} active={lit === s.href} />
          ))}
        </nav>
      </header>

      <main className="relative flex-1 overflow-auto bg-slate-50">{children}</main>
    </div>
  );
}
