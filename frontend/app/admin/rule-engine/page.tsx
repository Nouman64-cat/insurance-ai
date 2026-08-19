"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import CatalogTab from "@/components/rule-engine/CatalogTab";
import SimulatorTab from "@/components/rule-engine/SimulatorTab";
import LogsTab from "@/components/rule-engine/LogsTab";

type Tab = "catalog" | "simulator" | "logs";

const TABS: { key: Tab; label: string; icon: string; enabled: boolean; tooltip?: string }[] = [
  {
    key: "catalog",
    label: "Rule Catalog",
    icon: "M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10",
    enabled: true,
  },
  {
    key: "simulator",
    label: "Simulate",
    icon: "M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    enabled: true,
    tooltip: "Dry-run rules against sample data before deploying.",
  },
  {
    key: "logs",
    label: "Audit Trail",
    icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01",
    enabled: true,
    tooltip: "SECP compliance audit log of all rule evaluations.",
  },
];

export default function RuleEnginePage() {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("catalog");
  const [error, setError] = useState("");

  useEffect(() => {
    const tid = localStorage.getItem("tenant_id");
    if (tid) {
      setTenantId(tid);
    } else {
      setError("No active organization tenant found. Please log in.");
    }
  }, []);

  return (
    <div className="px-6 pt-5 pb-10 max-w-screen-2xl mx-auto w-full font-sans text-slate-800">
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-slate-100 text-slate-700 rounded-xl border border-slate-200 shadow-sm">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
              />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-black text-slate-900 tracking-tight">Business Rule Engine</h1>
              <span className="text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                v2.0
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Automated underwriting, pricing, and compliance rule management.
            </p>
          </div>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center gap-1 p-1 bg-slate-100/80 rounded-xl border border-slate-200" role="tablist">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  isActive
                    ? "bg-white text-blue-700 shadow-sm border border-slate-200/80"
                    : "text-slate-600 hover:text-slate-900 hover:bg-slate-200/50"
                }`}
                title={tab.tooltip}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tab.icon} />
                </svg>
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Main Tab Content ───────────────────────────────────────────── */}
      {error ? (
        <div className="p-6 bg-red-50 border border-red-200 rounded-2xl text-red-800 text-xs font-semibold">
          {error}
        </div>
      ) : !tenantId ? (
        <div className="p-12 text-center text-xs text-slate-400 font-medium">Loading workspace tenant...</div>
      ) : (
        <div>
          {activeTab === "catalog" && <CatalogTab tenantId={tenantId} />}
          {activeTab === "simulator" && <SimulatorTab tenantId={tenantId} />}
          {activeTab === "logs" && <LogsTab tenantId={tenantId} />}
        </div>
      )}
    </div>
  );
}
