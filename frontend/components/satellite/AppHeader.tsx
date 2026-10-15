"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useSatelliteUser } from "@/components/satellite/SsoGate";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { tx } from "@/lib/i18n/tx";
import { portalUrl } from "@/lib/appLinks";
import { signOut } from "@/lib/sso";

// The top bar every portal-sign-in app shares: the app's name and the tenant, the app's own actions, the language
// switch, the way back to the portal, who is signed in, and sign out. Sections, if any, sit on a second row.

export interface HeaderSection { href: string; label: string; active: boolean; count?: number }

/** The portal page a role starts on (the same as the portal's brand link). */
export function portalHome(role: string): string {
  if (role === "Admin") return portalUrl("/");
  if (role === "Agent" || role === "Broker") return portalUrl("/proposal");
  if (role === "ClaimsAdjuster" || role === "ClaimsManager") return portalUrl("/claims");
  return portalUrl("/cases");
}

export default function AppHeader({ title, home, icon, actions, sections, sectionsLabel, open = false }: {
  title: string;
  home: string;
  icon: ReactNode;
  actions?: ReactNode;
  sections?: HeaderSection[];
  sectionsLabel?: string;
  /** An app with no sign-in: no account, no sign-out, no way back to the portal. */
  open?: boolean;
}) {
  const { t } = useI18n();
  const user = useSatelliteUser();
  return (
    <header className="shrink-0 border-b border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-2.5">
        <Link href={home} className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white" aria-hidden="true">{icon}</span>
          <span className="flex flex-col leading-tight">
            <span className="text-[15px] font-bold tracking-tight text-slate-900">{title}</span>
            <span className="text-[11px] font-medium text-slate-500">{user.tenant_name ?? t("sidebar.brand")}</span>
          </span>
        </Link>
        <div className="ms-auto flex items-center gap-2 sm:gap-3">
          {actions}
          <LanguageSwitcher />
          {!open && (<>
          <a href={portalHome(user.role_name)} className="hidden whitespace-nowrap rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 md:inline-flex">
            {tx("← Back to the portal")}
          </a>
          <div className="hidden items-center gap-2 border-s border-slate-200 ps-3 sm:flex">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-[11px] font-bold text-slate-700" aria-hidden="true">
              {(user.full_name || user.email || "?").split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("")}
            </span>
            <div className="min-w-0 text-start">
              <p className="max-w-[10rem] truncate text-xs font-bold text-slate-900">{user.full_name || user.email}</p>
              <p className="text-[10px] text-slate-500">{user.role_name}</p>
            </div>
          </div>
          <button type="button" onClick={signOut} title={t("sidebar.logout")} aria-label={t("sidebar.logout")}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 rtl:-scale-x-100">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
          </>)}
        </div>
        {sections && sections.length > 0 && (
          <nav aria-label={sectionsLabel} className="order-last -mb-2.5 flex w-full gap-1 overflow-x-auto">
            {sections.map((s) => (
              <Link key={s.href} href={s.href} aria-current={s.active ? "page" : undefined}
                className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-xs font-semibold transition-colors ${
                  s.active ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800"}`}>
                {s.label}
                {!!s.count && <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-800">{s.count}</span>}
              </Link>
            ))}
          </nav>
        )}
      </div>
    </header>
  );
}
