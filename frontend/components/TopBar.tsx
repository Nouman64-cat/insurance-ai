"use client";
import { useState, useEffect } from "react";
import { openAutomationChat } from "@/lib/sso";
import { useNotify } from "@/components/NotificationContext";
import GlobalSearch from "@/components/GlobalSearch";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useI18n } from "@/lib/i18n/I18nProvider";

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5h16v11H9l-5 4V5z" />
      <path d="M14 3h7v7M21 3l-8 8" opacity="0" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface TopBarProps {
  title?: string;
  subtitle?: string;
}

export function TopBar({ title, subtitle }: TopBarProps) {
  const { notify } = useNotify();
  const { t } = useI18n();
  // Admins can replay the welcome tour (components/tour/AdminTour.tsx) at any time.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => { setIsAdmin(localStorage.getItem("user_role") === "Admin"); }, []);
  const [tenantName, setTenantName] = useState("Adamjee Life");

  useEffect(() => {
    const savedName = localStorage.getItem("tenant_name");
    if (savedName) {
      setTenantName(savedName);
    }
    // Always refresh in background
    import("@/app/services/api").then(({ default: api }) => {
      api.get("/auth/me").then(res => {
        if (res.data.tenant_name) {
          setTenantName(res.data.tenant_name);
          localStorage.setItem("tenant_name", res.data.tenant_name);
        }
      }).catch(() => {});
    });
  }, []);

  return (
    <header className="sticky top-0 z-30 h-14 flex-shrink-0 flex items-center justify-between gap-4 px-6 bg-white/80 backdrop-blur-md border-b border-slate-200 shadow-sm">

      {/* Left: Page title */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight truncate leading-snug py-0.5">
              {title ?? t("topBar.defaultTitle")}
            </h1>
            <span className="hidden sm:inline-flex items-center text-[9px] font-bold uppercase tracking-[0.12em] text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full whitespace-nowrap">
              {tenantName}
            </span>
          </div>
          {subtitle && (
            <p className="text-xs text-slate-500 mt-0.5 truncate">{subtitle}</p>
          )}
        </div>
      </div>

      {/* Center: Search */}
      <GlobalSearch />

      {/* Right: Actions */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <LanguageSwitcher />

        {/* The Automation Chat is a separate app in its own container: this opens it in a new tab (it is a link out,
            not a mode of this page), or says it is not running. */}
        <button
          type="button"
          onClick={async () => {
            if (!(await openAutomationChat())) {
              notify(t("topBar.automationChatDown"), false);
            }
          }}
          title={t("topBar.automationChatTitle")}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
        >
          <ChatIcon />
          {t("topBar.automationChat")}
        </button>

        {isAdmin && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("start-admin-tour"))}
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-all"
          >
            {t("topBar.takeTour")}
          </button>
        )}

        <button
          type="button"
          onClick={() => window.location.reload()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all shadow-sm hover:shadow-md"
        >
          <RefreshIcon />
          <span className="hidden sm:inline">{t("topBar.refresh")}</span>
        </button>
      </div>
    </header>
  );
}
