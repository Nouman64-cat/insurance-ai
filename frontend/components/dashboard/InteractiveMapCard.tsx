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
      <div className="space-y-3">
        {/* Top Toolbar: Dropdown 1 (Metric) & Dropdown 2 (Region / Province) */}
        <div className="flex items-center justify-between gap-3 flex-wrap pb-2 border-b border-slate-100">
          <div className="flex items-center gap-2.5 flex-wrap">
            {/* Metric Dropdown */}
            <div className="flex items-center gap-1.5 bg-slate-100/90 border border-slate-200 rounded-xl px-2.5 py-1 text-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Metric:</span>
              <select
                value={metricMode}
                onChange={(e) => setMetricMode(e.target.value as MapMetricMode)}
                className="bg-transparent font-bold text-blue-700 text-xs cursor-pointer focus:outline-none"
              >
                <option value="gwp">GWP (Premium)</option>
                <option value="claims">Claims Paid</option>
                <option value="lossRatio">Loss Ratio %</option>
                <option value="policies">Policy Volume</option>
              </select>
            </div>

            {/* Province / Region Dropdown */}
            <div className="flex items-center gap-1.5 bg-slate-100/90 border border-slate-200 rounded-xl px-2.5 py-1 text-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Region:</span>
              <select
                value={selectedRegion}
                onChange={(e) => onSelectRegion(e.target.value)}
                className="bg-transparent font-bold text-slate-800 text-xs cursor-pointer focus:outline-none max-w-[170px] truncate"
              >
                <option value="ALL">All Provinces (5)</option>
                {Object.values(regionStatsMap).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({fmtCompact(r.gwp)})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Intensity Legend + Reset */}
          <div className="flex items-center gap-3 text-[10px] text-slate-500">
            <div className="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-lg border border-slate-200/60">
              <span className="text-slate-400 font-semibold">Intensity:</span>
              <span className="w-2.5 h-2.5 rounded-full bg-blue-200 inline-block"></span>
              <span className="text-[9px] font-medium text-slate-600">Low</span>
              <span className="w-2.5 h-2.5 rounded-full bg-blue-700 inline-block ml-1"></span>
              <span className="text-[9px] font-medium text-slate-600">High</span>
            </div>

            {selectedRegion !== "ALL" && (
              <button
                onClick={() => onSelectRegion("ALL")}
                className="text-xs font-bold text-blue-600 hover:text-blue-800 underline"
              >
                Reset Filter
              </button>
            )}
          </div>
        </div>

        {/* Full-Width Map Canvas */}
        <div className="relative flex justify-center items-center bg-slate-900/5 rounded-2xl p-4 border border-slate-200/60 min-h-[260px]">
          <svg
            viewBox="0 0 450 480"
            className="w-full h-auto max-h-[300px] drop-shadow-md transition-all duration-300"
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

        {/* 5-Column Horizontal Province Summary Strip */}
        <div className="grid grid-cols-5 gap-2 pt-1">
          {Object.values(regionStatsMap).map((r) => {
            const isSelected = selectedRegion === r.id || hoveredRegion === r.id;
            return (
              <div
                key={r.id}
                onClick={() => onSelectRegion(selectedRegion === r.id ? "ALL" : r.id)}
                onMouseEnter={() => setHoveredRegion(r.id)}
                onMouseLeave={() => setHoveredRegion(null)}
                className={`p-2 rounded-xl border transition-all cursor-pointer text-center ${
                  isSelected
                    ? "bg-blue-50 border-blue-300 ring-2 ring-blue-500/20"
                    : "bg-slate-50/70 border-slate-200/60 hover:bg-slate-100"
                }`}
              >
                <div className="flex items-center justify-center gap-1">
                  <span className={`w-1.5 h-1.5 rounded-full ${isSelected ? "bg-blue-600 animate-pulse" : "bg-slate-400"}`} />
                  <p className="text-[10px] font-bold text-slate-700 truncate">{r.shortName}</p>
                </div>
                <p className="text-xs font-extrabold font-mono text-slate-900 mt-0.5">{fmtCompact(r.gwp)}</p>
                <p className="text-[9px] text-slate-400 font-medium">LR: {r.lossRatio.toFixed(0)}%</p>
              </div>
            );
          })}
        </div>
      </div>
    </PillarCard>
  );
}
