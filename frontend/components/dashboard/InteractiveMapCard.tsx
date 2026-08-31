"use client";

import React, { useState } from "react";
import { PillarCard } from "./shared";
import type { PolicyListItem } from "@/app/services/policies";
import type { Claim } from "@/app/services/claims";
import type { CommissionLedgerEntry } from "@/app/services/commissions";

interface InteractiveMapCardProps {
  policies: PolicyListItem[];
  claims: Claim[];
  ledger: CommissionLedgerEntry[];
  selectedRegion: string;
  onSelectRegion: (region: string) => void;
}

type MapMetricMode = "gwp" | "claims" | "lossRatio" | "policies";

interface RegionStats {
  id: string;
  name: string;
  shortName: string;
  gwp: number;
  claimsPaid: number;
  claimsCount: number;
  policyCount: number;
  lossRatio: number;
}

// Map SVG Paths for Pakistan Provinces (Normalized ViewBox 0 0 500 500)
const PROVINCE_PATHS: { id: string; name: string; d: string; labelX: number; labelY: number }[] = [
  {
    id: "Punjab",
    name: "Punjab",
    d: "M 270,160 L 320,170 L 370,190 L 380,240 L 350,290 L 300,320 L 260,300 L 240,260 L 240,210 L 270,160 Z",
    labelX: 310,
    labelY: 235,
  },
  {
    id: "Sindh",
    name: "Sindh",
    d: "M 230,305 L 290,325 L 310,380 L 290,440 L 220,440 L 190,410 L 200,350 L 230,305 Z",
    labelX: 250,
    labelY: 380,
  },
  {
    id: "Balochistan",
    name: "Balochistan",
    d: "M 80,250 L 225,255 L 220,300 L 190,345 L 180,405 L 80,390 L 50,330 L 60,280 Z",
    labelX: 130,
    labelY: 320,
  },
  {
    id: "Khyber Pakhtunkhwa",
    name: "Khyber Pakhtunkhwa",
    d: "M 200,100 L 250,90 L 265,155 L 235,205 L 210,245 L 160,240 L 180,170 Z",
    labelX: 215,
    labelY: 165,
  },
  {
    id: "Islamabad Capital Territory",
    name: "Islamabad",
    d: "M 268,142 L 285,145 L 282,158 L 265,155 Z",
    labelX: 275,
    labelY: 132,
  },
];

export function InteractiveMapCard({
  policies,
  claims,
  ledger,
  selectedRegion,
  onSelectRegion,
}: InteractiveMapCardProps) {
  const [metricMode, setMetricMode] = useState<MapMetricMode>("gwp");
  const [hoveredRegion, setHoveredRegion] = useState<string | null>(null);

  // Compute per-region statistics
  const regionNames = ["Punjab", "Sindh", "Balochistan", "Khyber Pakhtunkhwa", "Islamabad Capital Territory"];
  
  const regionStatsMap: Record<string, RegionStats> = {};

  regionNames.forEach((rName) => {
    const regPolicies = policies.filter((p) => p.region === rName);
    const regClaims = claims.filter((c) => c.region === rName);
    const regLedger = ledger.filter((l) => l.branch?.includes(rName) || l.payeeName?.includes(rName));

    const gwp = regLedger.reduce((sum, e) => sum + e.collectedPremium, 0) || regPolicies.length * 145000;
    const claimsPaid = regClaims.reduce((sum, c) => sum + (c.approved_amount || c.submitted_amount || 0), 0);
    const lossRatio = gwp > 0 ? (claimsPaid / gwp) * 100 : 0;

    regionStatsMap[rName] = {
      id: rName,
      name: rName,
      shortName: rName === "Islamabad Capital Territory" ? "ICT" : rName === "Khyber Pakhtunkhwa" ? "KP" : rName,
      gwp,
      claimsPaid,
      claimsCount: regClaims.length,
      policyCount: regPolicies.length,
      lossRatio,
    };
  });

  // Calculate max metric values for color scaling
  const maxValues = {
    gwp: Math.max(...Object.values(regionStatsMap).map((s) => s.gwp), 1),
    claims: Math.max(...Object.values(regionStatsMap).map((s) => s.claimsPaid), 1),
    lossRatio: Math.max(...Object.values(regionStatsMap).map((s) => s.lossRatio), 1),
    policies: Math.max(...Object.values(regionStatsMap).map((s) => s.policyCount), 1),
  };

  const getRegionColor = (regName: string) => {
    const stats = regionStatsMap[regName];
    if (!stats) return "#cbd5e1";
    
    const isSelected = selectedRegion === regName;
    const isHovered = hoveredRegion === regName;

    let ratio = 0;
    if (metricMode === "gwp") ratio = stats.gwp / maxValues.gwp;
    else if (metricMode === "claims") ratio = stats.claimsPaid / maxValues.claims;
    else if (metricMode === "lossRatio") ratio = Math.min(stats.lossRatio / 100, 1);
    else ratio = stats.policyCount / maxValues.policies;

    // HSL Color Generation
    if (metricMode === "lossRatio") {
      // Red gradient for loss ratio
      const lightness = 92 - Math.round(ratio * 45);
      return isSelected || isHovered ? "#ef4444" : `hsl(0, 84%, ${lightness}%)`;
    }
    
    // Blue gradient for GWP and Volume
    const lightness = 92 - Math.round(ratio * 50);
    return isSelected || isHovered ? "#2563eb" : `hsl(217, 91%, ${lightness}%)`;
  };

  const fmtCompact = (v: number) =>
    v >= 1_000_000 ? `PKR ${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `PKR ${(v / 1_000).toFixed(0)}K` : `PKR ${v.toFixed(0)}`;

  const activeStats = hoveredRegion ? regionStatsMap[hoveredRegion] : selectedRegion !== "ALL" ? regionStatsMap[selectedRegion] : null;

  return (
    <PillarCard
      icon={
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.782V8.018a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
        </svg>
      }
      title="Regional Geospatial Heatmap — Pakistan"
      barClass="bg-blue-600"
      iconBg="bg-blue-50"
      iconColor="text-blue-600"
    >
      <div className="space-y-4">
        {/* Metric Selector Bar */}
        <div className="flex items-center justify-between gap-2 flex-wrap pb-1 border-b border-slate-100">
          <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-xl text-[11px] font-semibold">
            {(["gwp", "claims", "lossRatio", "policies"] as MapMetricMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setMetricMode(mode)}
                className={`px-3 py-1 rounded-lg transition-all ${
                  metricMode === mode
                    ? "bg-white text-blue-700 shadow-xs font-bold"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {mode === "gwp" && "GWP (Premium)"}
                {mode === "claims" && "Claims Paid"}
                {mode === "lossRatio" && "Loss Ratio %"}
                {mode === "policies" && "Policy Volume"}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-[10px] text-slate-500">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-200 inline-block"></span> Low
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-700 inline-block"></span> High
            </span>
            {selectedRegion !== "ALL" && (
              <button
                onClick={() => onSelectRegion("ALL")}
                className="ml-2 text-blue-600 font-bold hover:underline"
              >
                Reset Region Filter (Showing {selectedRegion})
              </button>
            )}
          </div>
        </div>

        {/* Card Content Grid: Left Map Vector, Right Regional Breakdown */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
          {/* Vector Map Container */}
          <div className="md:col-span-7 relative flex justify-center items-center bg-slate-900/5 rounded-2xl p-4 border border-slate-200/60 min-h-[300px]">
            <svg
              viewBox="0 0 450 480"
              className="w-full h-auto max-h-[340px] drop-shadow-md transition-all duration-300"
            >
              {PROVINCE_PATHS.map((p) => {
                const isSelected = selectedRegion === p.id;
                const isHovered = hoveredRegion === p.id;
                const stats = regionStatsMap[p.id];

                return (
                  <g key={p.id} className="cursor-pointer group">
                    <path
                      d={p.d}
                      fill={getRegionColor(p.id)}
                      stroke={isSelected ? "#1e3a8a" : "#ffffff"}
                      strokeWidth={isSelected ? "3" : "1.5"}
                      className="transition-all duration-300 hover:opacity-90 hover:stroke-blue-900 hover:stroke-[2.5]"
                      onMouseEnter={() => setHoveredRegion(p.id)}
                      onMouseLeave={() => setHoveredRegion(null)}
                      onClick={() => onSelectRegion(isSelected ? "ALL" : p.id)}
                    />
                    <text
                      x={p.labelX}
                      y={p.labelY}
                      fill={isSelected || isHovered ? "#ffffff" : "#1e293b"}
                      fontSize={p.id === "Islamabad Capital Territory" ? "10" : "12"}
                      fontWeight="bold"
                      textAnchor="middle"
                      pointerEvents="none"
                      className="drop-shadow-xs select-none"
                    >
                      {p.id === "Islamabad Capital Territory" ? "ICT" : p.id === "Khyber Pakhtunkhwa" ? "KP" : p.id}
                    </text>
                    {stats && (
                      <text
                        x={p.labelX}
                        y={p.labelY + 14}
                        fill={isSelected || isHovered ? "#e0f2fe" : "#475569"}
                        fontSize="9"
                        fontWeight="600"
                        textAnchor="middle"
                        pointerEvents="none"
                        className="select-none"
                      >
                        {metricMode === "gwp"
                          ? fmtCompact(stats.gwp)
                          : metricMode === "claims"
                          ? fmtCompact(stats.claimsPaid)
                          : metricMode === "lossRatio"
                          ? `${stats.lossRatio.toFixed(0)}%`
                          : `${stats.policyCount} pols`}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>

            {/* Hover Tooltip Overlay */}
            {hoveredRegion && regionStatsMap[hoveredRegion] && (
              <div className="absolute top-3 left-3 bg-slate-900/90 text-white p-3 rounded-xl shadow-xl text-xs backdrop-blur-md border border-slate-700 pointer-events-none z-20 space-y-1 animate-in fade-in zoom-in-95 duration-150">
                <p className="font-bold text-blue-300 text-sm">{hoveredRegion}</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] pt-1 border-t border-slate-700">
                  <span className="text-slate-400">GWP Premium:</span>
                  <span className="font-mono font-bold text-right">{fmtCompact(regionStatsMap[hoveredRegion].gwp)}</span>
                  <span className="text-slate-400">Claims Paid:</span>
                  <span className="font-mono font-bold text-right">{fmtCompact(regionStatsMap[hoveredRegion].claimsPaid)}</span>
                  <span className="text-slate-400">Loss Ratio:</span>
                  <span className="font-mono font-bold text-right text-emerald-400">
                    {regionStatsMap[hoveredRegion].lossRatio.toFixed(1)}%
                  </span>
                  <span className="text-slate-400">Active Policies:</span>
                  <span className="font-mono font-bold text-right">{regionStatsMap[hoveredRegion].policyCount}</span>
                </div>
                <p className="text-[9px] text-blue-400 pt-1 italic">Click region to filter entire dashboard</p>
              </div>
            )}
          </div>

          {/* Regional Performance Leaderboard Sidebar */}
          <div className="md:col-span-5 space-y-3">
            <div className="flex justify-between items-center">
              <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Provincial Breakdown</h4>
              <span className="text-[10px] text-slate-400 font-semibold">5 Provinces &amp; Territories</span>
            </div>

            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
              {Object.values(regionStatsMap)
                .sort((a, b) => b.gwp - a.gwp)
                .map((r) => {
                  const isSelected = selectedRegion === r.id;
                  const gwpShare = maxValues.gwp > 0 ? (r.gwp / Object.values(regionStatsMap).reduce((s, x) => s + x.gwp, 0)) * 100 : 0;

                  return (
                    <div
                      key={r.id}
                      onClick={() => onSelectRegion(isSelected ? "ALL" : r.id)}
                      className={`p-2.5 rounded-xl border transition-all cursor-pointer ${
                        isSelected
                          ? "bg-blue-50/90 border-blue-300 ring-2 ring-blue-500/20"
                          : "bg-slate-50/70 border-slate-200/80 hover:bg-slate-100 hover:border-slate-300"
                      }`}
                    >
                      <div className="flex justify-between items-center mb-1.5">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2.5 h-2.5 rounded-full ${
                              isSelected ? "bg-blue-600 animate-pulse" : "bg-slate-400"
                            }`}
                          ></span>
                          <span className="text-xs font-bold text-slate-800">{r.name}</span>
                        </div>
                        <span className="text-xs font-extrabold font-mono text-slate-900">{fmtCompact(r.gwp)}</span>
                      </div>

                      <div className="grid grid-cols-3 gap-2 text-[10px] text-slate-500 pt-1 border-t border-slate-200/60">
                        <div>
                          <span className="text-slate-400 block">Policies</span>
                          <span className="font-bold text-slate-800">{r.policyCount}</span>
                        </div>
                        <div>
                          <span className="text-slate-400 block">Claims</span>
                          <span className="font-bold text-slate-800">{r.claimsCount}</span>
                        </div>
                        <div>
                          <span className="text-slate-400 block">Loss Ratio</span>
                          <span className={`font-bold ${r.lossRatio > 75 ? "text-rose-600" : "text-emerald-700"}`}>
                            {r.lossRatio.toFixed(1)}%
                          </span>
                        </div>
                      </div>

                      {/* Share Progress Bar */}
                      <div className="mt-2 w-full bg-slate-200/80 h-1.5 rounded-full overflow-hidden">
                        <div
                          className="bg-blue-600 h-full rounded-full transition-all duration-500"
                          style={{ width: `${Math.min(gwpShare, 100)}%` }}
                        ></div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      </div>
    </PillarCard>
  );
}
