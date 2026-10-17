"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import CatalogTab from "@/components/rule-engine/CatalogTab";
import SimulatorTab from "@/components/rule-engine/SimulatorTab";
import LogsTab from "@/components/rule-engine/LogsTab";
import { tx } from "@/lib/i18n/tx";

type Tab = "catalog" | "simulator" | "logs";

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "catalog", label: "Rules", hint: "Browse and edit decision rules" },
  { key: "simulator", label: "Try it out", hint: "See which rules match sample details before publishing" },
  { key: "logs", label: "Activity", hint: "Every time the app checked a rule set" },
];

export default function RuleEnginePage() {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("catalog");
  const [error, setError] = useState("");

  useEffect(() => {
    const tid = localStorage.getItem("tenant_id");
    if (tid) setTenantId(tid);
    else setError(tx("No active organization tenant found. Please log in."));
  }, []);

  return (
    <div className="min-h-full w-full bg-slate-50/60">
      <div className="mx-auto w-full max-w-screen-2xl px-4 pb-12 pt-6 font-sans text-slate-800 sm:px-6">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{tx("Decision rules")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              {tx("The rules that decide eligibility, risk and underwriting outcomes. Changes are made in a draft and only take effect when you publish.")}
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm" role="tablist">
            {TABS.map((tab) => {
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  role="tab"
                  aria-selected={isActive}
                  title={tx(tab.hint)}
                  onClick={() => setActiveTab(tab.key)}
                  className={`rounded-xl px-4 py-2 text-xs font-semibold transition ${
                    isActive ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  }`}
                >
                  {tx(tab.label)}
                </button>
              );
            })}
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm font-medium text-red-800">{error}</div>
        ) : !tenantId ? (
          <div className="p-12 text-center text-sm text-slate-400">{tx("Loading…")}</div>
        ) : (
          <div>
            {activeTab === "catalog" && <CatalogTab tenantId={tenantId} />}
            {activeTab === "simulator" && <SimulatorTab tenantId={tenantId} />}
            {activeTab === "logs" && <LogsTab tenantId={tenantId} />}
          </div>
        )}
      </div>
    </div>
  );
}
