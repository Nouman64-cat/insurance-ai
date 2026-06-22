"use client";

import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { useEffect, useState } from "react";
import api from "@/app/services/api";

export function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLoginPage = pathname === "/login";
  const [authChecked, setAuthChecked] = useState(false);

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
    </body>
  );
}
