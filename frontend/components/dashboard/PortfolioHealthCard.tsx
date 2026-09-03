"use client";

import React from "react";
import { PillarCard, RingGauge, Stat, Divider } from "./shared";
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
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      }
      title="Underwriting & Line of Business Intelligence"
      barClass="bg-blue-600"
      iconBg="bg-blue-50"
      iconColor="text-blue-600"
    >
      <div className="space-y-2">
        {/* Core Ratios Row */}
        <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
          {/* Dual Gauges */}
          <div className="flex gap-3 shrink-0 items-center justify-center">
            <RingGauge
              value={Math.min(lossRatioPct, 100)}
              strokeHex={lossRatioPct > 70 ? "#ef4444" : "#2563eb"}
              label="Loss Ratio"
              sublabel="Claims/GWP"
              valueLabel={`${lossRatioPct.toFixed(1)}%`}
              size={56}
              strokeW={5.5}
            />
            <RingGauge
              value={Math.min(combinedRatioPct, 100)}
              strokeHex={combinedRatioPct > 90 ? "#f59e0b" : "#059669"}
              label="Combined Ratio"
              sublabel="Total Cost"
              valueLabel={`${combinedRatioPct.toFixed(1)}%`}
              size={56}
              strokeW={5.5}
            />
          </div>

          {/* Underwriting Health Status Badge */}
          <div className="flex-1 w-full space-y-1 bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-200/80">
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Book Health</span>
              <span
                className={`px-2 py-0.5 rounded-full text-[9px] font-extrabold ${
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

            <div className="space-y-0.5 text-[11px]">
              <div className="flex justify-between">
                <span className="text-slate-500">Loss Ratio (Claims):</span>
                <span className="font-mono font-bold text-slate-800">{lossRatioPct.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Expense Ratio (Acquisition):</span>
                <span className="font-mono font-bold text-slate-800">{expenseRatioPct.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between pt-0.5 border-t border-slate-200 font-bold">
                <span className="text-slate-700">Net Underwriting Margin:</span>
                <span className="font-mono text-emerald-700">{netUnderwritingProfitPct.toFixed(1)}%</span>
              </div>
            </div>
          </div>
        </div>

        <Divider className="my-1" />

        {/* Line of Business Performance — Compact Vertical Bar Chart */}
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
              Line of Business (LoB) Loss Ratios
            </p>
            {/* SECP benchmark legend */}
            <span className="flex items-center gap-1 text-[8px] font-semibold text-slate-400">
              <span className="inline-block w-3 border-t border-dashed border-slate-400" />
              55% SECP target
            </span>
          </div>

          <div className="bg-slate-50/80 rounded-lg border border-slate-200/60 px-2.5 py-1.5">
            {/* Chart area — compact height */}
            <div className="relative">
              {/* Dashed benchmark line */}
              <div
                className="absolute left-0 right-0 border-t border-dashed border-slate-300 z-10 pointer-events-none"
                style={{ bottom: `${55}%` }}
              />

              <div className="grid grid-cols-4 gap-3 h-[50px] items-end relative z-0">
                {linesOfBusiness.map((lob) => {
                  const barH = Math.min(Math.max(lob.lossRatio, 4), 100);
                  const isAboveBenchmark = lob.lossRatio > 55;
                  return (
                    <div key={lob.name} className="flex flex-col items-center h-full justify-end group">
                      {/* Value label */}
                      <span
                        className={`text-[9px] font-extrabold font-mono mb-0.5 leading-none whitespace-nowrap transition-colors ${
                          isAboveBenchmark ? "text-rose-600" : "text-emerald-600"
                        }`}
                      >
                        {lob.lossRatio}%
                      </span>
                      {/* Bar track */}
                      <div className="w-7 bg-slate-200/70 rounded-t flex-1 flex flex-col justify-end overflow-hidden">
                        <div
                          className={`w-full rounded-t-sm ${lob.color} transition-all duration-500`}
                          style={{ height: `${barH}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Labels row */}
            <div className="grid grid-cols-4 gap-3 mt-1.5 pt-1 border-t border-slate-200/80">
              {linesOfBusiness.map((lob) => {
                const lobGwp = totalPremium * lob.weight;
                return (
                  <div key={lob.name} className="flex flex-col items-center gap-0.5">
                    <span className="text-[8px] font-bold text-slate-600 text-center leading-tight truncate w-full">
                      {lob.name.split(" ").slice(0, 2).join(" ")}
                    </span>
                    <span className="text-[8px] font-mono text-slate-400 text-center">
                      {fmtCompact(lobGwp)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <Divider className="my-1" />

        {/* Quick Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Total Active Book" value={policyStats ? policyStats.total : policies.length} sub="policies" />
          <Stat label="Grace Period" value={policyStats ? policyStats.grace_period : 0} sub="at risk" />
          <Stat label="Lapsed Ratio" value={policyStats && policyStats.total > 0 ? `${((policyStats.lapsed / policyStats.total) * 100).toFixed(1)}%` : "0%"} sub="persistency leak" />
          <Stat label="Target LR" value="55.0%" sub="secp benchmark" />
        </div>
      </div>
    </PillarCard>
  );
}
