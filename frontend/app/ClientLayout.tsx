"use client";

import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { useEffect, useState, useCallback, useRef } from "react";
import api from "@/app/services/api";

interface ToastMsg { id: number; text: string; ok: boolean }

function ToastBanner({ toasts, onDismiss }: { toasts: ToastMsg[]; onDismiss: (id: number) => void }) {
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className={`pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 rounded-xl shadow-lg text-sm font-semibold border cursor-pointer select-none transition-all
            ${t.ok
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-amber-50 border-amber-200 text-amber-800"}`}
        >
          {t.ok ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          )}
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLoginPage = pathname === "/login";
  const [authChecked, setAuthChecked] = useState(false);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastIdRef = useRef(0);

  const showToast = useCallback((text: string, ok: boolean) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, text, ok }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  }, []);

  useEffect(() => {
    const token = localStorage.getItem("jwt_token");
    const tenantId = localStorage.getItem("tenant_id");

    if (token && tenantId) {
      api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
      api.defaults.headers.common["X-Tenant-Id"] = tenantId;
    }

    if (!token && !isLoginPage) {
      router.push("/login");
    } else if (token && isLoginPage) {
      router.push("/");
    } else {
      setAuthChecked(true);
    }
  }, [pathname, isLoginPage, router]);

  // Poll background processing documents globally across navigation
  useEffect(() => {
    if (!authChecked || isLoginPage) return;

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
  }, [authChecked, isLoginPage, showToast]);

  if (!authChecked && !isLoginPage) {
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
    <body className={isLoginPage ? "bg-slate-950" : "dashboard-shell bg-slate-50"}>
      {isLoginPage ? (
        children
      ) : (
        <>
          {/* ── Sidebar ──────────────────────────────────────────────────────── */}
          <Sidebar />

          {/* ── Main column ─────────────────────────────────────────────────── */}
          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
            <TopBar />

            {/* ── Page content ──────────────────────────────────────────────── */}
            <main className="flex-1 overflow-auto">
              {children}
            </main>

            {/* ── Footer ────────────────────────────────────────────────────── */}
            <footer className="border-t border-slate-200 bg-white py-2.5 px-6">
              <p className="text-center text-[10px] text-slate-400">
                insurance-ai Underwriting Portal — Prototype v0.1.0 &nbsp;·&nbsp; Strictly Confidential &nbsp;·&nbsp; Adamjee Life Assurance Co. Ltd.
              </p>
            </footer>
          </div>
        </>
      )}
      <ToastBanner toasts={toasts} onDismiss={id => setToasts(prev => prev.filter(t => t.id !== id))} />
    </body>
  );
}
