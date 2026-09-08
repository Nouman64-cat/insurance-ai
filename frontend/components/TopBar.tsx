"use client";
import { useState, useEffect } from "react";
import { useCopilot } from "@/components/CopilotContext";
import GlobalSearch from "@/components/GlobalSearch";

function BellIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5" aria-hidden="true">
      <path fillRule="evenodd" d="M5.25 9a6.75 6.75 0 0113.5 0v.75c0 2.123.8 4.057 2.118 5.52a.75.75 0 01-.297 1.206c-1.544.57-3.16.99-4.831 1.243a3.75 3.75 0 11-7.48 0 24.585 24.585 0 01-4.831-1.244.75.75 0 01-.298-1.205A8.217 8.217 0 005.25 9.75V9zm4.502 8.9a2.25 2.25 0 104.496 0 25.057 25.057 0 01-4.496 0z" clipRule="evenodd" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface TopBarProps {
  title?: string;
  subtitle?: string;
}

export function TopBar({ title = "Executive Overview", subtitle }: TopBarProps) {
  const { isAutomationMode, setAutomationMode } = useCopilot();
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
              {title}
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
        
        {/* Theme Toggle */}
        <button
          onClick={() => {
            if (document.documentElement.classList.contains("dark")) {
              document.documentElement.classList.remove("dark");
              localStorage.setItem("theme", "light");
            } else {
              document.documentElement.classList.add("dark");
              localStorage.setItem("theme", "dark");
            }
          }}
          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          title="Toggle Dark Mode"
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
          </svg>
        </button>
        {/* Automation Mode Toggle */}
        <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-full border border-slate-200">
          <button
            onClick={() => setAutomationMode(false)}
            className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-full transition-all ${!isAutomationMode ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}
          >
            Manual
          </button>
          <button
            onClick={() => setAutomationMode(true)}
            className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-full transition-all ${isAutomationMode ? 'bg-blue-600 shadow-sm text-white' : 'text-slate-500 hover:text-slate-700'}`}
          >
            Automation
          </button>
        </div>

        <button
          type="button"
          onClick={() => window.location.reload()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all shadow-sm hover:shadow-md"
        >
          <RefreshIcon />
          <span className="hidden sm:inline">Refresh</span>
        </button>

        {/* Divider */}
        <span className="h-5 w-px bg-slate-200 mx-1" />

        {/* Notification bell */}
        <button
          type="button"
          className="relative p-1.5 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          aria-label="Notifications"
        >
          <BellIcon />
          <span className="absolute top-1 right-1 w-2 h-2 bg-blue-500 rounded-full border border-white" />
        </button>

        {/* Strictly confidential badge */}
        <span className="hidden lg:inline-flex items-center text-[9px] font-bold uppercase tracking-widest text-slate-400 bg-slate-100 border border-slate-200 px-2 py-1 rounded-md whitespace-nowrap">
          Strictly Confidential
        </span>
      </div>
    </header>
  );
}
