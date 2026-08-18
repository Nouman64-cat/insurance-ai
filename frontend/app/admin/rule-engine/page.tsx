"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import CatalogTab from "@/components/rule-engine/CatalogTab";
import SimulatorTab from "@/components/rule-engine/SimulatorTab";
import LogsTab from "@/components/rule-engine/LogsTab";

type Tab = "catalog" | "simulator" | "logs";

const TABS: { key: Tab; label: string }[] = [
  { key: "catalog", label: "Rule Catalog & Decision Guidelines" },
  // { key: "simulator", label: "Test & Simulate Rules" },
  // { key: "logs", label: "SECP Regulatory Audit Trail" },
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
    <div className="px-6 pt-5 pb-24 space-y-5 max-w-screen-2xl mx-auto w-full font-sans text-slate-800">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-blue-50 text-blue-600 border border-blue-100 rounded-lg">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Business Rule Engine</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              {/* Category → SubCategory → Channel eligibility, grouped decision rules, TSAR accumulation, and typed actuarial impacts — no code required. */}
            </p>
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex border-b border-slate-200 gap-6 text-xs font-medium">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`pb-3 flex items-center gap-2 transition border-b-2 ${
              activeTab === t.key ? "border-blue-600 text-blue-600 font-semibold" : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="p-8 text-center bg-white border border-slate-200 rounded-xl text-slate-500 text-sm font-medium">{error}</div>
      ) : !tenantId ? (
        <div className="p-8 text-center bg-white border border-slate-200 rounded-xl text-slate-400 text-sm animate-pulse font-medium">Loading...</div>
      ) : (
        <>
          {activeTab === "catalog" && <CatalogTab tenantId={tenantId} />}
          {activeTab === "simulator" && <SimulatorTab tenantId={tenantId} />}
          {activeTab === "logs" && <LogsTab tenantId={tenantId} />}
        </>
      )}
    </div>
  );
}
