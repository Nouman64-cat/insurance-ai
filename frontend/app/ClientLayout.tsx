"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { endSso, publishSso, safeNext, startSso } from "@/lib/sso";
import AdminTour from "@/components/tour/AdminTour";
import { useEffect, useState } from "react";
import api from "@/app/services/api";
import { listQuotes } from "@/app/services/quotes";
import { PENDING_QUOTES_STORAGE_KEY, PENDING_QUOTES_EVENT, PendingQuoteWatch } from "@/lib/pendingQuotes";
import { NavigationProgress } from "@/components/NavigationProgress";
import { NotificationProvider, useNotify } from "@/components/NotificationContext";
import { ACRRequestsProvider } from "@/components/ACRRequestsProvider";
import { useRecordHighlighter } from "@/lib/useHighlightTarget";
import { useI18n } from "@/lib/i18n/I18nProvider";

// Give up watching an customer after this many polls (~2 min at 4s/poll) —
// they simply didn't qualify for any active plan, so no quote will ever land.
const MAX_QUOTE_POLL_ATTEMPTS = 30;

export function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Popup windows and the in-chat panel iframe (both opened with ?_portal=1
  // by CopilotInterface's navigate handlers) render the page's own content
  // only — the surrounding sidebar/topbar/footer would just be a redundant,
  // useless-to-click copy nested inside an already-chrome-full window.
  // Also true for any page loaded inside the Copilot's frame, even after a link
  // inside it navigated away from the URL that carried ?_portal=1 — otherwise
  // the whole app (sidebar, top bar) appeared nested inside the chat panel.
  const [isFramed, setIsFramed] = useState(false);
  useEffect(() => { setIsFramed(window.parent !== window); }, []);
  const isPortalEmbed = searchParams?.get("_portal") === "1" || isFramed;
  const isLoginPage = pathname === "/login";
  // Public, unauthenticated pages meant to be opened by someone outside the
  // portal (e.g. a customer with no account) — must skip both the auth
  // redirect below and the Sidebar/TopBar/Footer portal shell entirely.
  const isPublicStandalonePage =
    pathname?.startsWith("/e-application/") ||
    pathname?.startsWith("/underwriting-questionnaire/") ||
    pathname?.startsWith("/e-app/") ||
    pathname?.startsWith("/medical-exam/") ||
    pathname?.startsWith("/medical-lab/") ||
    pathname?.startsWith("/documents/") ||
    false;
  const bypassAuthShell = isLoginPage || isPublicStandalonePage;
  const [authChecked, setAuthChecked] = useState(false);
  const [tenantName, setTenantName] = useState("Adamjee Life");
  const { notify: showToast } = useNotify();
  const { t } = useI18n();

  // Global "pop the record the agent just navigated to" watcher — pages don't
  // need any wiring beyond rendering the data the row contains.
  useRecordHighlighter();

  useEffect(() => {
    if (isLoginPage && new URLSearchParams(window.location.search).get("signout") === "1") {
      // Signed out from another app (the Underwriting Workbench): end this app's session too, so the stored
      // token doesn't sign the user straight back in. Done before anything below can re-publish the shared
      // cookie. The ?next= stays, for whoever signs in next.
      localStorage.clear();
      try { sessionStorage.removeItem("sso_published"); } catch { /* storage unavailable */ }
      delete api.defaults.headers.common["Authorization"];
      delete api.defaults.headers.common["X-Tenant-Id"];
      endSso();
      const params = new URLSearchParams(window.location.search);
      params.delete("signout");
      const rest = params.toString();
      window.history.replaceState(null, "", `/login${rest ? `?${rest}` : ""}`);
      return;
    }

    const token = localStorage.getItem("jwt_token");
    const tenantId = localStorage.getItem("tenant_id");
    const tName = localStorage.getItem("tenant_name");
    
    if (tName) {
      setTenantName(tName);
    }

    // SuperAdmins have a token but no tenant_id, so the two headers are set independently.
    if (token) {
      api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
      // Sessions that began before single sign-on existed have no shared cookie yet: create it, once per tab.
      try {
        if (!sessionStorage.getItem("sso_published") || sessionStorage.getItem("sso_published") !== token) {
          startSso(token).then((ok) => { if (ok) sessionStorage.setItem("sso_published", token); });
        }
      } catch { /* storage unavailable */ }
    }
    if (token && tenantId) {
      api.defaults.headers.common["X-Tenant-Id"] = tenantId;
    }
    const isSuperAdmin = localStorage.getItem("user_role") === "SuperAdmin";

    if (isPublicStandalonePage) {
      setAuthChecked(true);
    } else if (!token && !isLoginPage) {
      router.push("/login");
    } else if (token && isLoginPage) {
      const params = new URLSearchParams(window.location.search);
      // Already signed in here: make sure the shared session exists too, and honour a ?next= back to another app.
      const back = safeNext(params.get("next"));
      publishSso(token).then((result) => {
        if (result === "invalid") {
          // The stored token has expired: sending the user back to `next` would only bounce them here again.
          // Forget it and show the sign-in form; `next` is kept for after they sign in.
          localStorage.removeItem("jwt_token");
          localStorage.removeItem("tenant_id");
          delete api.defaults.headers.common["Authorization"];
          delete api.defaults.headers.common["X-Tenant-Id"];
          return;
        }
        // Another app is only reachable with the shared cookie set; without it, stay in the portal.
        if (back && result === "ok") window.location.assign(back);
        else router.push(isSuperAdmin ? "/super-admin/tenants" : "/");
      });
    } else if (token && isSuperAdmin && pathname === "/") {
      router.push("/super-admin/tenants");
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
            showToast(t("shell.documentStatus", { name: item.name, status: artifact.status.toLowerCase() }), isAccepted);

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
  }, [authChecked, isLoginPage, isPublicStandalonePage, showToast, t]);

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
          showToast(t("shell.quoteGenerated", { name: watch.name }), true);
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
  }, [authChecked, isLoginPage, isPublicStandalonePage, showToast, t]);

  if (!authChecked && !bypassAuthShell) {
    return (
      <body className="bg-slate-950 min-h-screen flex items-center justify-center font-sans text-slate-200">
        <div className="flex flex-col items-center gap-3">
          <svg className="animate-spin h-8 w-8 text-blue-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-xs text-slate-400 font-medium">{t("shell.validating")}</span>
        </div>
      </body>
    );
  }

  return (
    <body className={bypassAuthShell ? (isLoginPage ? "bg-slate-950" : "bg-slate-50") : "dashboard-shell bg-slate-50"}>
      <NavigationProgress />
      {bypassAuthShell ? (
        children
      ) : (
        <ACRRequestsProvider>
          {/* ── Sidebar ──────────────────────────────────────────────────────── */}
          {!isPortalEmbed && <Sidebar />}
          {!isPortalEmbed && <AdminTour />}

          {/* ── Main column ─────────────────────────────────────────────────── */}
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            {!isPortalEmbed && <TopBar />}

            {/* ── Page content ──────────────────────────────────────────────── */}
            <main className="flex-1 overflow-hidden relative flex">
              {isPortalEmbed ? (
                <div className="flex-1 overflow-auto bg-slate-50 relative h-full">
                  {children}
                </div>
              ) : (
                <div className="flex-1 overflow-auto bg-slate-50 relative h-full">
                  {children}
                </div>
              )}
            </main>

            {/* ── Footer ────────────────────────────────────────────────────── */}
            {!isPortalEmbed && (
              <footer className="border-t border-slate-200 bg-white py-2.5 px-6 shrink-0">
                <p className="text-center text-[10px] text-slate-400">
                  {t("shell.footer", { tenant: tenantName })}
                </p>
              </footer>
            )}
          </div>

        </ACRRequestsProvider>
      )}
    </body>
  );
}
