"use client";

import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { useEffect, useState } from "react";
import api from "@/app/services/api";
import { listQuotes } from "@/app/services/quotes";
import { PENDING_QUOTES_STORAGE_KEY, PENDING_QUOTES_EVENT, PendingQuoteWatch } from "@/lib/pendingQuotes";
import { useCopilot } from "@/components/CopilotContext";
import { CopilotInterface } from "@/components/CopilotInterface";
import { NotificationProvider, useNotify } from "@/components/NotificationContext";
import { useRecordHighlighter } from "@/lib/useHighlightTarget";

// Give up watching an customer after this many polls (~2 min at 4s/poll) —
// they simply didn't qualify for any active plan, so no quote will ever land.
const MAX_QUOTE_POLL_ATTEMPTS = 30;

export function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLoginPage = pathname === "/login";
  // Public, unauthenticated pages meant to be opened by someone outside the
  // portal (e.g. a customer with no account) — must skip both the auth
  // redirect below and the Sidebar/TopBar/Footer portal shell entirely.
  const isPublicStandalonePage =
    pathname?.startsWith("/e-application/") ||
    pathname?.startsWith("/e-app/") ||
    pathname?.startsWith("/medical-exam/") ||
    false;
  const bypassAuthShell = isLoginPage || isPublicStandalonePage;
  const [authChecked, setAuthChecked] = useState(false);
  const [tenantName, setTenantName] = useState("Adamjee Life");
  const { isAutomationMode } = useCopilot();
  const { notify: showToast } = useNotify();

  // Global "pop the record the agent just navigated to" watcher — pages don't
  // need any wiring beyond rendering the data the row contains.
  useRecordHighlighter();

  const [copilotWidth, setCopilotWidth] = useState(40); // percentage
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const widthPct = ((window.innerWidth - e.clientX) / window.innerWidth) * 100;
      if (widthPct >= 15 && widthPct <= 85) {
        setCopilotWidth(widthPct);
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 0) return;
      const clientX = e.touches[0].clientX;
      const widthPct = ((window.innerWidth - clientX) / window.innerWidth) * 100;
      if (widthPct >= 15 && widthPct <= 85) {
        setCopilotWidth(widthPct);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("touchmove", handleTouchMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("touchend", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("touchend", handleMouseUp);
    };
  }, [isResizing]);

  useEffect(() => {
    const token = localStorage.getItem("jwt_token");
    const tenantId = localStorage.getItem("tenant_id");
    const tName = localStorage.getItem("tenant_name");
    
    if (tName) {
      setTenantName(tName);
    }

    if (token && tenantId) {
      api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
      api.defaults.headers.common["X-Tenant-Id"] = tenantId;
    }

    if (isPublicStandalonePage) {
      setAuthChecked(true);
    } else if (!token && !isLoginPage) {
      router.push("/login");
    } else if (token && isLoginPage) {
      router.push("/");
    } else {
      setAuthChecked(true);
    }
  }, [pathname, isLoginPage, isPublicStandalonePage, router]);

  // Poll background processing documents globally across navigation
  useEffect(() => {
    if (!authChecked || isLoginPage || isPublicStandalonePage) return;

    let active = true;
    let timerId: NodeJS.Timeout | null = null;

    const poll = async () => {
      if (!active) return;
      const tenantId = localStorage.getItem("tenant_id");
      const token = localStorage.getItem("jwt_token");
      if (!tenantId || !token) {
        timerId = setTimeout(poll, 4000);
        return;
      }

      let processing: Array<{ id: string; name: string }> = [];
      try {
        processing = JSON.parse(localStorage.getItem("insurance_ai_processing_docs") || "[]");
      } catch {
        processing = [];
      }

      if (processing.length === 0) {
        timerId = setTimeout(poll, 4000);
        return;
      }

      const updatedList = [...processing];
      let changed = false;

      for (const item of processing) {
        try {
          const res = await api.get(`/tenants/${tenantId}/artifacts/${item.id}`);
          const artifact = res.data;

          if (artifact.status !== "Processing") {
            const isAccepted = artifact.status === "Accepted";
            showToast(`${item.name} has been ${artifact.status.toLowerCase()}!`, isAccepted);

            const idx = updatedList.findIndex(x => x.id === item.id);
            if (idx > -1) {
              updatedList.splice(idx, 1);
              changed = true;
            }
          }
        } catch (err: any) {
          if (err.response?.status === 404 || err.response?.status === 401 || err.response?.status === 403) {
            const idx = updatedList.findIndex(x => x.id === item.id);
            if (idx > -1) {
              updatedList.splice(idx, 1);
              changed = true;
            }
          }
        }
      }

      if (changed && active) {
        localStorage.setItem("insurance_ai_processing_docs", JSON.stringify(updatedList));
      }

      timerId = setTimeout(poll, 4000);
    };

    const handleNewDoc = () => {
      if (timerId) clearTimeout(timerId);
      poll();
    };

    window.addEventListener("insurance_ai_new_processing", handleNewDoc);
    poll();

    return () => {
      active = false;
      if (timerId) clearTimeout(timerId);
      window.removeEventListener("insurance_ai_new_processing", handleNewDoc);
    };
  }, [authChecked, isLoginPage, isPublicStandalonePage, showToast]);

  // Poll for background-generated quotations (Kafka quote worker) globally
  // across navigation, so the toast fires no matter which page the user is on.
  useEffect(() => {
    if (!authChecked || isLoginPage || isPublicStandalonePage) return;

    let active = true;
    let timerId: NodeJS.Timeout | null = null;

    const readPending = (): (PendingQuoteWatch & { attempts?: number })[] => {
      try {
        return JSON.parse(localStorage.getItem(PENDING_QUOTES_STORAGE_KEY) || "[]");
      } catch {
        return [];
      }
    };

    const poll = async () => {
      if (!active) return;
      const pending = readPending();
      const tenantId = localStorage.getItem("tenant_id");

      if (pending.length === 0 || !tenantId) {
        timerId = setTimeout(poll, 4000);
        return;
      }

      let quotedCustomerIds = new Set<string>();
      try {
        const quotes = await listQuotes();
        quotedCustomerIds = new Set(quotes.map((q) => q.customer_id));
      } catch {
        timerId = setTimeout(poll, 4000);
        return;
      }

      const remaining: (PendingQuoteWatch & { attempts?: number })[] = [];
      for (const watch of pending) {
        if (quotedCustomerIds.has(watch.id)) {
          showToast(`Quotation generated for ${watch.name}!`, true);
          continue;
        }
        const attempts = (watch.attempts ?? 0) + 1;
        if (attempts < MAX_QUOTE_POLL_ATTEMPTS) {
          remaining.push({ ...watch, attempts });
        }
      }

      if (active) {
        localStorage.setItem(PENDING_QUOTES_STORAGE_KEY, JSON.stringify(remaining));
      }

      timerId = setTimeout(poll, 4000);
    };

    const handleNewPending = () => {
      if (timerId) clearTimeout(timerId);
      poll();
    };

    window.addEventListener(PENDING_QUOTES_EVENT, handleNewPending);
    poll();

    return () => {
      active = false;
      if (timerId) clearTimeout(timerId);
      window.removeEventListener(PENDING_QUOTES_EVENT, handleNewPending);
    };
  }, [authChecked, isLoginPage, isPublicStandalonePage, showToast]);

  if (!authChecked && !bypassAuthShell) {
    return (
      <body className="bg-slate-950 min-h-screen flex items-center justify-center font-sans text-slate-200">
        <div className="flex flex-col items-center gap-3">
          <svg className="animate-spin h-8 w-8 text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-xs text-slate-400 font-medium">Validating credentials...</span>
        </div>
      </body>
    );
  }

  return (
    <body className={bypassAuthShell ? (isLoginPage ? "bg-slate-950" : "bg-slate-50") : "dashboard-shell bg-slate-50"}>
      {bypassAuthShell ? (
        children
      ) : (
        <>
          {/* ── Sidebar ──────────────────────────────────────────────────────── */}
          {!isAutomationMode && <Sidebar />}

          {/* ── Main column ─────────────────────────────────────────────────── */}
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            {!isAutomationMode && <TopBar />}

            {/* ── Page content ──────────────────────────────────────────────── */}
            <main className="flex-1 overflow-hidden relative flex">
              {isAutomationMode ? (
                <div className="flex-1 h-full relative z-30 overflow-hidden bg-slate-50">
                  <CopilotInterface />
                </div>
              ) : (
                <div className="flex-1 overflow-auto bg-slate-50 relative h-full">
                  {children}
                </div>
              )}
            </main>

            {/* ── Footer ────────────────────────────────────────────────────── */}
            {!isAutomationMode && (
              <footer className="border-t border-slate-200 bg-white py-2.5 px-6 shrink-0">
                <p className="text-center text-[10px] text-slate-400">
                  insurance-ai Underwriting Portal — Prototype v0.1.0 &nbsp;·&nbsp; Strictly Confidential &nbsp;·&nbsp; {tenantName}
                </p>
              </footer>
            )}
          </div>

        </>
      )}
    </body>
  );
}
