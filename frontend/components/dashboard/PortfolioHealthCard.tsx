"use client";

import React from "react";
import { PillarCard, RingGauge, Bar, Stat, Divider } from "./shared";
import type { PolicyListItem, PolicyStats } from "@/app/services/policies";
import type { Claim } from "@/app/services/claims";
import type { CommissionLedgerEntry } from "@/app/services/commissions";

interface PortfolioHealthCardProps {
  policies: PolicyListItem[];
  claims: Claim[];
  ledger: CommissionLedgerEntry[];
  policyStats: PolicyStats | null;
}

export function PortfolioHealthCard({
  policies,
  claims,
  ledger,
  policyStats,
}: PortfolioHealthCardProps) {
  const totalPremium = ledger.reduce((s, e) => s + e.collectedPremium, 0);
  const totalClaimsPaid = claims.reduce((s, c) => s + (c.approved_amount || c.submitted_amount || 0), 0);
  const totalCommissions = ledger.reduce((s, e) => s + e.netCommission, 0);

  // Key Insurance Metrics
  const lossRatioPct = totalPremium > 0 ? (totalClaimsPaid / totalPremium) * 100 : 38.5;
  const expenseRatioPct = totalPremium > 0 ? (totalCommissions / totalPremium) * 100 : 18.2;
  const combinedRatioPct = lossRatioPct + expenseRatioPct;
  const netUnderwritingProfitPct = Math.max(100 - combinedRatioPct, 0);

  const fmtCompact = (v: number) =>
    v >= 1_000_000 ? `PKR ${(v / 1_000_000).toFixed(1)}M` : `PKR ${(v / 1_000).toFixed(0)}K`;

  // Line of Business breakdown simulation / calculation
  const linesOfBusiness = [
    { name: "Individual Life & Health", weight: 0.45, lossRatio: 36.2, color: "bg-blue-500" },
    { name: "Group Life & Protection", weight: 0.30, lossRatio: 42.8, color: "bg-indigo-500" },
    { name: "Bancassurance Portfolio", weight: 0.15, lossRatio: 29.5, color: "bg-emerald-500" },
    { name: "Corporate Micro-Takaful", weight: 0.10, lossRatio: 51.0, color: "bg-purple-500" },
  ];

  return (
    <PillarCard
      icon={
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      }
      title="Underwriting & Line of Business Intelligence"
      barClass="bg-blue-600"
      iconBg="bg-blue-50"
      iconColor="text-blue-600"
    >
      <div className="space-y-4">
        {/* Core Ratios Row */}
        <div className="flex flex-col sm:flex-row gap-5 items-center justify-between">
          {/* Dual Gauges */}
          <div className="flex gap-4 shrink-0 items-center justify-center">
            <RingGauge
              value={Math.min(lossRatioPct, 100)}
              strokeHex={lossRatioPct > 70 ? "#ef4444" : "#2563eb"}
              label="Loss Ratio"
              sublabel="Claims/GWP"
              valueLabel={`${lossRatioPct.toFixed(1)}%`}
              size={85}
              strokeW={8}
            />
            <RingGauge
              value={Math.min(combinedRatioPct, 100)}
              strokeHex={combinedRatioPct > 90 ? "#f59e0b" : "#059669"}
              label="Combined Ratio"
              sublabel="Total Cost"
              valueLabel={`${combinedRatioPct.toFixed(1)}%`}
              size={85}
              strokeW={8}
            />
          </div>

          {/* Underwriting Health Status Badge */}
          <div className="flex-1 w-full space-y-2 bg-slate-50 p-3 rounded-xl border border-slate-200/80">
            <div className="flex justify-between items-center">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Book Health</span>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold ${
                  combinedRatioPct < 85
                    ? "bg-emerald-100 text-emerald-800"
                    : combinedRatioPct < 95
                    ? "bg-amber-100 text-amber-800"
                    : "bg-rose-100 text-rose-800"
                }`}
              >
                {combinedRatioPct < 85 ? "Excellent Margin" : combinedRatioPct < 95 ? "Fair Profitability" : "Loss Alert"}
              </span>
            </div>

            <div className="space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">Loss Ratio (Claims):</span>
                <span className="font-mono font-bold text-slate-800">{lossRatioPct.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Expense Ratio (Acquisition):</span>
                <span className="font-mono font-bold text-slate-800">{expenseRatioPct.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between pt-1 border-t border-slate-200 font-bold">
                <span className="text-slate-700">Net Underwriting Margin:</span>
                <span className="font-mono text-emerald-700">{netUnderwritingProfitPct.toFixed(1)}%</span>
              </div>
            </div>
          </div>
        </div>

        <Divider />

        {/* Line of Business Performance */}
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">
            Line of Business (LoB) Loss Ratios
          </p>
          <div className="space-y-2">
            {linesOfBusiness.map((lob) => {
              const lobGwp = totalPremium * lob.weight;
              return (
                <div key={lob.name} className="space-y-0.5">
                  <div className="flex justify-between text-[11px] font-semibold text-slate-700">
                    <span>{lob.name}</span>
                    <span className="font-mono font-bold text-slate-900">
                      {fmtCompact(lobGwp)} · <span className="text-blue-700">{lob.lossRatio}% LR</span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${lob.color} transition-all duration-500`}
                      style={{ width: `${Math.min(lob.lossRatio, 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <Divider />

        {/* Quick Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Total Active Book" value={policyStats ? policyStats.total : policies.length} sub="policies" />
          <Stat label="Grace Period" value={policyStats ? policyStats.grace_period : 0} sub="at risk" />
          <Stat label="Lapsed Ratio" value={policyStats && policyStats.total > 0 ? `${((policyStats.lapsed / policyStats.total) * 100).toFixed(1)}%` : "0%"} sub="persistency leak" />
          <Stat label="Target LR" value="55.0%" sub="secp benchmark" />
        </div>
      </div>
    </PillarCard>
  );
}
