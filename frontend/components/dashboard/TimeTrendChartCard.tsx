"use client";

import React, { useState } from "react";
import { PillarCard } from "./shared";
import type { PolicyListItem } from "@/app/services/policies";
import type { Claim } from "@/app/services/claims";
import type { CommissionLedgerEntry } from "@/app/services/commissions";

interface TimeTrendChartCardProps {
  policies: PolicyListItem[];
  claims: Claim[];
  ledger: CommissionLedgerEntry[];
}

type Granularity = "daily" | "weekly" | "monthly" | "yearly";
type ViewMetric = "financials" | "volume";
type ChartStyle = "line" | "area";

interface DataPoint {
  label: string;
  key: string;
  premium: number; // in PKR
  claims: number;  // in PKR
  commissions: number; // in PKR
  netMargin: number; // in PKR
  policyCount: number;
  claimCount: number;
}

export function TimeTrendChartCard({ policies, claims, ledger }: TimeTrendChartCardProps) {
  const [granularity, setGranularity] = useState<Granularity>("monthly");
  const [viewMetric, setViewMetric] = useState<ViewMetric>("financials");
  const [chartStyle, setChartStyle] = useState<ChartStyle>("line");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Helper to format currency values cleanly
  const fmtPKR = (v: number) =>
    v >= 1_000_000 ? `PKR ${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `PKR ${(v / 1_000).toFixed(0)}K` : `PKR ${v.toFixed(0)}`;

  const fmtCompact = (v: number) =>
    v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(0)}K` : `${v.toFixed(0)}`;

  // Generate aggregate points based on granularity
  const generateDataPoints = (): DataPoint[] => {
    const pointsMap: Record<string, DataPoint> = {};
    const now = new Date();

    if (granularity === "daily") {
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        const label = d.toLocaleDateString("en", { month: "short", day: "numeric" });
        pointsMap[key] = { label, key, premium: 0, claims: 0, commissions: 0, netMargin: 0, policyCount: 0, claimCount: 0 };
      }
    } else if (granularity === "weekly") {
      for (let i = 7; i >= 0; i--) {
        const key = `W${8 - i}`;
        const label = `Week ${8 - i}`;
        pointsMap[key] = { label, key, premium: 0, claims: 0, commissions: 0, netMargin: 0, policyCount: 0, claimCount: 0 };
      }
    } else if (granularity === "monthly") {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        const label = d.toLocaleString("en", { month: "short" });
        pointsMap[key] = { label, key, premium: 0, claims: 0, commissions: 0, netMargin: 0, policyCount: 0, claimCount: 0 };
      }
    } else {
      for (let i = 3; i >= 0; i--) {
        const yr = now.getFullYear() - i;
        const key = String(yr);
        pointsMap[key] = { label: key, key, premium: 0, claims: 0, commissions: 0, netMargin: 0, policyCount: 0, claimCount: 0 };
      }
    }

    // Populate ledger premiums & commissions
    ledger.forEach((e) => {
      const dateStr = e.accruedAt ? e.accruedAt.slice(0, 10) : "";
      let targetKey = "";

      if (granularity === "daily") {
        targetKey = dateStr;
      } else if (granularity === "monthly") {
        targetKey = dateStr.slice(0, 7);
      } else if (granularity === "yearly") {
        targetKey = dateStr.slice(0, 4);
      } else if (granularity === "weekly" && dateStr) {
        const eDate = new Date(dateStr);
        const diffDays = Math.floor((now.getTime() - eDate.getTime()) / (86400 * 1000));
        const weekNum = 8 - Math.floor(diffDays / 7);
        if (weekNum >= 1 && weekNum <= 8) targetKey = `W${weekNum}`;
      }

      if (pointsMap[targetKey]) {
        pointsMap[targetKey].premium += e.collectedPremium || 0;
        pointsMap[targetKey].commissions += e.netCommission || 0;
      }
    });

    // Populate claims
    claims.forEach((c) => {
      const dateStr = c.created_at ? c.created_at.slice(0, 10) : "";
      let targetKey = "";

      if (granularity === "daily") {
        targetKey = dateStr;
      } else if (granularity === "monthly") {
        targetKey = dateStr.slice(0, 7);
      } else if (granularity === "yearly") {
        targetKey = dateStr.slice(0, 4);
      } else if (granularity === "weekly" && dateStr) {
        const cDate = new Date(dateStr);
        const diffDays = Math.floor((now.getTime() - cDate.getTime()) / (86400 * 1000));
        const weekNum = 8 - Math.floor(diffDays / 7);
        if (weekNum >= 1 && weekNum <= 8) targetKey = `W${weekNum}`;
      }

      if (pointsMap[targetKey]) {
        pointsMap[targetKey].claims += c.approved_amount || c.submitted_amount || 0;
        pointsMap[targetKey].claimCount += 1;
      }
    });

    // Populate policies count
    policies.forEach((p) => {
      const dateStr = p.created_at ? p.created_at.slice(0, 10) : "";
      let targetKey = "";

      if (granularity === "daily") {
        targetKey = dateStr;
      } else if (granularity === "monthly") {
        targetKey = dateStr.slice(0, 7);
      } else if (granularity === "yearly") {
        targetKey = dateStr.slice(0, 4);
      } else if (granularity === "weekly" && dateStr) {
        const pDate = new Date(dateStr);
        const diffDays = Math.floor((now.getTime() - pDate.getTime()) / (86400 * 1000));
        const weekNum = 8 - Math.floor(diffDays / 7);
        if (weekNum >= 1 && weekNum <= 8) targetKey = `W${weekNum}`;
      }

      if (pointsMap[targetKey]) {
        pointsMap[targetKey].policyCount += 1;
      }
    });

    Object.values(pointsMap).forEach((p) => {
      p.netMargin = p.premium - p.claims - p.commissions;
    });

    return Object.values(pointsMap);
  };

  const dataPoints = generateDataPoints();

  // Find max scales
  const maxFinancial = Math.max(
    ...dataPoints.map((p) => Math.max(p.premium, p.claims, p.commissions, 1)),
    100_000
  );
  const maxVolume = Math.max(...dataPoints.map((p) => Math.max(p.policyCount, p.claimCount, 1)), 10);

  const activeMax = viewMetric === "financials" ? maxFinancial : maxVolume;

  // Top summary KPIs
  const totalPremiumPeriod = dataPoints.reduce((s, p) => s + p.premium, 0);
  const totalClaimsPeriod = dataPoints.reduce((s, p) => s + p.claims, 0);
  const totalCommissionsPeriod = dataPoints.reduce((s, p) => s + p.commissions, 0);
  const netMarginPeriod = totalPremiumPeriod - totalClaimsPeriod - totalCommissionsPeriod;
  const overallLossRatio = totalPremiumPeriod > 0 ? (totalClaimsPeriod / totalPremiumPeriod) * 100 : 0;

  // SVG Chart Geometry Constants
  const width = 800;
  const height = 420;
  const padLeft = 52;
  const padRight = 24;
  const padTop = 24;
  const padBottom = 34;

  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  // Calculate coordinates for points
  const getX = (idx: number) => {
    if (dataPoints.length <= 1) return padLeft + chartW / 2;
    return padLeft + (idx / (dataPoints.length - 1)) * chartW;
  };

  const getY = (val: number) => {
    return padTop + chartH - (val / (activeMax || 1)) * chartH;
  };

  // Generate smooth cubic spline SVG path string
  const generateSmoothPath = (values: number[]) => {
    if (values.length === 0) return "";
    const pts = values.map((val, idx) => ({ x: getX(idx), y: getY(val) }));
    if (pts.length === 1) return `M ${pts[0].x},${pts[0].y}`;

    let d = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? i : i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];

      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return d;
  };

  const generateAreaPath = (values: number[]) => {
    const linePath = generateSmoothPath(values);
    if (!linePath) return "";
    const firstX = getX(0).toFixed(1);
    const lastX = getX(values.length - 1).toFixed(1);
    const bottomY = (padTop + chartH).toFixed(1);
    return `${linePath} L ${lastX},${bottomY} L ${firstX},${bottomY} Z`;
  };

  // Metric series values
  const premiumValues = dataPoints.map((p) => p.premium);
  const claimsValues = dataPoints.map((p) => p.claims);
  const commissionsValues = dataPoints.map((p) => p.commissions);
  const policyValues = dataPoints.map((p) => p.policyCount);
  const claimCountValues = dataPoints.map((p) => p.claimCount);

  const hoveredPoint = hoverIndex !== null ? dataPoints[hoverIndex] : null;

  return (
    <PillarCard
      icon={
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
        </svg>
      }
      title="Financial Trends"
      barClass="bg-blue-600"
      iconBg="bg-blue-50"
      iconColor="text-blue-600"
      hideLive={true}
      className="h-full"
      headerExtra={
        <div className="flex items-center gap-2 flex-wrap ml-1">
          {/* Granularity dropdown */}
          <select
            value={granularity}
            onChange={(e) => setGranularity(e.target.value as Granularity)}
            className="text-[10px] font-bold bg-slate-100/90 border border-slate-200 rounded-lg px-2 py-1 text-slate-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-200 capitalize"
          >
            {(["daily", "weekly", "monthly", "yearly"] as Granularity[]).map((g) => (
              <option key={g} value={g} className="capitalize">{g.charAt(0).toUpperCase() + g.slice(1)}</option>
            ))}
          </select>

          {/* View metric dropdown */}
          <select
            value={viewMetric}
            onChange={(e) => setViewMetric(e.target.value as ViewMetric)}
            className="text-[10px] font-bold bg-slate-100/90 border border-slate-200 rounded-lg px-2 py-1 text-slate-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-200"
          >
            <option value="financials">Financial Dynamics</option>
            <option value="volume">Policy / Claim Volume</option>
          </select>

          {/* Chart style toggle */}
          <div className="flex items-center gap-0.5 bg-slate-100/90 p-0.5 rounded-lg border border-slate-200">
            <button
              onClick={() => setChartStyle("line")}
              title="Line Graph"
              className={`p-1 rounded transition-all ${chartStyle === "line" ? "bg-white text-blue-700 shadow-xs" : "text-slate-500 hover:text-slate-800"}`}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 17l4-8 4 4 4-6 4 3" />
              </svg>
            </button>
            <button
              onClick={() => setChartStyle("area")}
              title="Area Fill"
              className={`p-1 rounded transition-all ${chartStyle === "area" ? "bg-white text-blue-700 shadow-xs" : "text-slate-500 hover:text-slate-800"}`}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 19l4-4 4 4 8-10v10H4z" />
              </svg>
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col h-full space-y-2">
        {/* Executive SVG Line Chart Engine */}
        <div className="flex-1 flex flex-col relative pt-1 h-full min-h-0">
          {/* Legend & Info Bar */}
          <div className="flex justify-between items-center text-[11px] mb-2 px-1 flex-wrap gap-2 shrink-0">
            <div className="flex items-center gap-4">
              {viewMetric === "financials" ? (
                <>
                  <span className="flex items-center gap-1.5 font-bold text-slate-700">
                    <span className="w-3 h-1 rounded-full bg-blue-600 inline-block shadow-xs"></span> GWP Premium
                  </span>
                  <span className="flex items-center gap-1.5 font-bold text-slate-700">
                    <span className="w-3 h-1 rounded-full bg-rose-500 inline-block shadow-xs"></span> Claims Paid
                  </span>
                  <span className="flex items-center gap-1.5 font-bold text-slate-700">
                    <span className="w-3 h-1 rounded-full bg-amber-400 inline-block shadow-xs"></span> Commissions
                  </span>
                </>
              ) : (
                <>
                  <span className="flex items-center gap-1.5 font-bold text-slate-700">
                    <span className="w-3 h-1 rounded-full bg-blue-500 inline-block shadow-xs"></span> Policies Issued
                  </span>
                  <span className="flex items-center gap-1.5 font-bold text-slate-700">
                    <span className="w-3 h-1 rounded-full bg-purple-500 inline-block shadow-xs"></span> Claims Filed
                  </span>
                </>
              )}
            </div>
            <span className="text-[10px] text-slate-400 font-medium italic">Hover node points for detailed dynamics</span>
          </div>

          {/* SVG Canvas Box */}
          <div className="flex-1 bg-slate-900/5 rounded-2xl p-2 border border-slate-200/80 relative overflow-hidden flex flex-col justify-center">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="w-full h-full min-h-[320px] overflow-visible select-none"
              onMouseLeave={() => setHoverIndex(null)}
            >
              <defs>
                {/* Area Gradients */}
                <linearGradient id="blueGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2563eb" stopOpacity="0.30" />
                  <stop offset="100%" stopColor="#2563eb" stopOpacity="0.0" />
                </linearGradient>
                <linearGradient id="roseGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#f43f5e" stopOpacity="0.0" />
                </linearGradient>
                <linearGradient id="amberGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.20" />
                  <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.0" />
                </linearGradient>
                <linearGradient id="purpleGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#a855f7" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#a855f7" stopOpacity="0.0" />
                </linearGradient>
              </defs>

              {/* Horizontal Gridlines & Y-Axis Scale */}
              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                const yVal = padTop + chartH * (1 - ratio);
                const scaleNum = activeMax * ratio;
                return (
                  <g key={ratio}>
                    <line
                      x1={padLeft}
                      y1={yVal}
                      x2={padLeft + chartW}
                      y2={yVal}
                      stroke="#cbd5e1"
                      strokeDasharray="4 4"
                      strokeWidth="1"
                      opacity="0.6"
                    />
                    <text
                      x={padLeft - 8}
                      y={yVal + 3.5}
                      textAnchor="end"
                      fill="#64748b"
                      fontSize="9"
                      fontWeight="600"
                    >
                      {viewMetric === "financials" ? fmtCompact(scaleNum) : scaleNum.toFixed(0)}
                    </text>
                  </g>
                );
              })}

              {/* X-Axis Data Point Labels */}
              {dataPoints.map((pt, idx) => (
                <text
                  key={pt.key}
                  x={getX(idx)}
                  y={padTop + chartH + 20}
                  textAnchor="middle"
                  fill={hoverIndex === idx ? "#1e3a8a" : "#64748b"}
                  fontSize="10"
                  fontWeight={hoverIndex === idx ? "800" : "600"}
                >
                  {pt.label}
                </text>
              ))}

              {/* Series Area Fills */}
              {chartStyle === "area" && viewMetric === "financials" && (
                <>
                  <path d={generateAreaPath(premiumValues)} fill="url(#blueGrad)" />
                  <path d={generateAreaPath(claimsValues)} fill="url(#roseGrad)" />
                  <path d={generateAreaPath(commissionsValues)} fill="url(#amberGrad)" />
                </>
              )}

              {chartStyle === "area" && viewMetric === "volume" && (
                <>
                  <path d={generateAreaPath(policyValues)} fill="url(#blueGrad)" />
                  <path d={generateAreaPath(claimCountValues)} fill="url(#purpleGrad)" />
                </>
              )}

              {/* Series Line Paths */}
              {viewMetric === "financials" ? (
                <>
                  {/* GWP Premium Line */}
                  <path
                    d={generateSmoothPath(premiumValues)}
                    fill="none"
                    stroke="#2563eb"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="transition-all duration-300"
                  />
                  {/* Claims Paid Line */}
                  <path
                    d={generateSmoothPath(claimsValues)}
                    fill="none"
                    stroke="#f43f5e"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="transition-all duration-300"
                  />
                  {/* Commissions Line */}
                  <path
                    d={generateSmoothPath(commissionsValues)}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="transition-all duration-300"
                  />
                </>
              ) : (
                <>
                  {/* Policy Volume Line */}
                  <path
                    d={generateSmoothPath(policyValues)}
                    fill="none"
                    stroke="#2563eb"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {/* Claim Volume Line */}
                  <path
                    d={generateSmoothPath(claimCountValues)}
                    fill="none"
                    stroke="#a855f7"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </>
              )}

              {/* Hover Indicator Vertical Line */}
              {hoverIndex !== null && (
                <line
                  x1={getX(hoverIndex)}
                  y1={padTop}
                  x2={getX(hoverIndex)}
                  y2={padTop + chartH}
                  stroke="#3b82f6"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                  opacity="0.8"
                />
              )}

              {/* Data Node Circles & Invisible Hit Targets */}
              {dataPoints.map((pt, idx) => {
                const cx = getX(idx);
                const isHovered = hoverIndex === idx;

                if (viewMetric === "financials") {
                  const cyPrem = getY(pt.premium);
                  const cyClaim = getY(pt.claims);
                  const cyComm = getY(pt.commissions);

                  return (
                    <g key={pt.key}>
                      {/* Premium Node Circle */}
                      <circle
                        cx={cx}
                        cy={cyPrem}
                        r={isHovered ? 6 : 4}
                        fill="#2563eb"
                        stroke="#ffffff"
                        strokeWidth="2"
                        className="transition-all duration-150"
                      />
                      {/* Claims Node Circle */}
                      <circle
                        cx={cx}
                        cy={cyClaim}
                        r={isHovered ? 5.5 : 3.5}
                        fill="#f43f5e"
                        stroke="#ffffff"
                        strokeWidth="2"
                        className="transition-all duration-150"
                      />
                      {/* Commissions Node Circle */}
                      <circle
                        cx={cx}
                        cy={cyComm}
                        r={isHovered ? 5 : 3}
                        fill="#f59e0b"
                        stroke="#ffffff"
                        strokeWidth="2"
                        className="transition-all duration-150"
                      />

                      {/* Invisible Mouse Hover Catchment Column */}
                      <rect
                        x={cx - chartW / (dataPoints.length * 2)}
                        y={padTop}
                        width={chartW / dataPoints.length}
                        height={chartH + 20}
                        fill="transparent"
                        className="cursor-pointer"
                        onMouseEnter={() => setHoverIndex(idx)}
                      />
                    </g>
                  );
                } else {
                  const cyPol = getY(pt.policyCount);
                  const cyClm = getY(pt.claimCount);

                  return (
                    <g key={pt.key}>
                      <circle
                        cx={cx}
                        cy={cyPol}
                        r={isHovered ? 6 : 4}
                        fill="#2563eb"
                        stroke="#ffffff"
                        strokeWidth="2"
                      />
                      <circle
                        cx={cx}
                        cy={cyClm}
                        r={isHovered ? 5.5 : 3.5}
                        fill="#a855f7"
                        stroke="#ffffff"
                        strokeWidth="2"
                      />
                      <rect
                        x={cx - chartW / (dataPoints.length * 2)}
                        y={padTop}
                        width={chartW / dataPoints.length}
                        height={chartH + 20}
                        fill="transparent"
                        className="cursor-pointer"
                        onMouseEnter={() => setHoverIndex(idx)}
                      />
                    </g>
                  );
                }
              })}
            </svg>
          </div>

          {/* Interactive Hover Tooltip Popup */}
          {hoveredPoint && (
            <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-slate-900/95 text-white p-3.5 rounded-2xl shadow-2xl backdrop-blur-md border border-slate-700 pointer-events-none z-30 min-w-[250px] animate-in fade-in zoom-in-95 duration-150">
              <div className="flex justify-between items-center border-b border-slate-700 pb-1.5 mb-2">
                <span className="font-extrabold text-blue-300 text-xs">{hoveredPoint.label} Dynamics</span>
                <span className="text-[10px] bg-blue-900/80 px-2 py-0.5 rounded-full text-blue-200 capitalize font-semibold">
                  {granularity}
                </span>
              </div>
              <div className="space-y-1.5 text-[11px]">
                <div className="flex justify-between items-center">
                  <span className="text-slate-400 flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block"></span> GWP Premium:
                  </span>
                  <span className="font-mono font-extrabold text-blue-400">{fmtPKR(hoveredPoint.premium)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400 flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block"></span> Claims Incurred:
                  </span>
                  <span className="font-mono font-extrabold text-rose-400">{fmtPKR(hoveredPoint.claims)}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400 flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block"></span> Commissions Paid:
                  </span>
                  <span className="font-mono font-extrabold text-amber-400">{fmtPKR(hoveredPoint.commissions)}</span>
                </div>
                <div className="flex justify-between items-center pt-1.5 border-t border-slate-800">
                  <span className="text-slate-300 font-semibold">Net Operating Surplus:</span>
                  <span
                    className={`font-mono font-extrabold ${
                      hoveredPoint.netMargin >= 0 ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {fmtPKR(hoveredPoint.netMargin)}
                  </span>
                </div>
                <div className="flex justify-between text-[10px] text-slate-400 pt-1 border-t border-slate-800/60">
                  <span>Policies Issued: <strong className="text-white">{hoveredPoint.policyCount}</strong></span>
                  <span>Claims Filed: <strong className="text-white">{hoveredPoint.claimCount}</strong></span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </PillarCard>
  );
}
