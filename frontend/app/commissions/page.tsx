"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CHANNEL_LABELS,
  CommissionLedgerEntry,
  CommissionPayee,
  CommissionSummaryStats,
  PAYEE_TYPE_LABELS,
  RELEASE_STAGE_LABELS,
  computeCommissionStats,
  getCommissionStats,
  listCommissionLedger,
  listPayees,
  listPayoutRuns,
  resetLedgerCache,
} from "../services/commissions";
import { DateRangeFilter, filterLedgerByDate, resolvePreset, type DatePreset, type DateRange } from "../../components/commissions/DateRangeFilter";
import { listBranches, distinctRegions, resolvePayeeRegion, type Branch } from "@/app/services/branches";
import { RegionFilter, ALL_REGIONS } from "@/components/RegionFilter";
import { FilterDropdown, type FilterOption } from "@/components/FilterDropdown";
import { MetricCard } from "@/components/MetricCard";
import { RingGauge } from "@/components/dashboard/shared";
import { InteractiveMapCard } from "@/components/dashboard/InteractiveMapCard";
import { TimeTrendChartCard } from "@/components/dashboard/TimeTrendChartCard";
import { listPolicies, type PolicyListItem } from "@/app/services/policies";
import { listClaims, type Claim } from "@/app/services/claims";
import {
  fmtPKR,
  fmtPKRCompact,
  StatusPill,
} from "../../components/commissions/shared";

// ── Icons for visual diversity ──────────────────────────────────────────────
const BankIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M3 10h18M3 7l9-4 9 4M4 10v11M8 10v11M12 10v11M16 10v11M20 10v11" />
  </svg>
);

const AgentIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
  </svg>
);

const BrokerIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
  </svg>
);

const CorporateIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5m0 0v-5a2 2 0 012-2h2a2 2 0 012 2v5m-4 0h4" />
  </svg>
);

const ReferralIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
  </svg>
);

const DigitalIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
  </svg>
);

const ManagerIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
  </svg>
);

const BranchIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10v11M20 10v11" />
  </svg>
);

const CHANNEL_CONFIG: Record<string, { icon: React.ReactNode; iconBg: string; iconColor: string; barColor: string }> = {
  DIRECT_AGENCY: { icon: AgentIcon, iconBg: "bg-sky-50", iconColor: "text-sky-600", barColor: "bg-sky-500" },
  BANCASSURANCE: { icon: BankIcon, iconBg: "bg-emerald-50", iconColor: "text-emerald-600", barColor: "bg-emerald-500" },
  BROKER: { icon: BrokerIcon, iconBg: "bg-purple-50", iconColor: "text-purple-600", barColor: "bg-purple-500" },
  CORPORATE_AGENT: { icon: CorporateIcon, iconBg: "bg-amber-50", iconColor: "text-amber-600", barColor: "bg-amber-500" },
  REFERRAL: { icon: ReferralIcon, iconBg: "bg-indigo-50", iconColor: "text-indigo-600", barColor: "bg-indigo-500" },
  DIGITAL_DIRECT: { icon: DigitalIcon, iconBg: "bg-teal-50", iconColor: "text-teal-600", barColor: "bg-teal-500" },
};

const PAYEE_CONFIG: Record<string, { icon: React.ReactNode; iconBg: string; iconColor: string; barColor: string }> = {
  AGENT: { icon: AgentIcon, iconBg: "bg-indigo-50", iconColor: "text-indigo-600", barColor: "bg-indigo-500" },
  SALES_MANAGER: { icon: ManagerIcon, iconBg: "bg-violet-50", iconColor: "text-violet-600", barColor: "bg-violet-500" },
  BRANCH_MANAGER: { icon: BranchIcon, iconBg: "bg-sky-50", iconColor: "text-sky-600", barColor: "bg-sky-500" },
  BANK_PARTNER: { icon: BankIcon, iconBg: "bg-emerald-50", iconColor: "text-emerald-600", barColor: "bg-emerald-500" },
  BROKER: { icon: BrokerIcon, iconBg: "bg-amber-50", iconColor: "text-amber-600", barColor: "bg-amber-500" },
  CORPORATE_AGENT: { icon: CorporateIcon, iconBg: "bg-purple-50", iconColor: "text-purple-600", barColor: "bg-purple-500" },
};

export default function CommissionsPage() {
  const [ledger, setLedger] = useState<CommissionLedgerEntry[]>([]);
  const [payees, setPayees] = useState<CommissionPayee[]>([]);
  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [stats, setStats] = useState<CommissionSummaryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [notification, setNotification] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  // ── Filters ─────────────────────────────────────────────────────────────
  const [datePreset, setDatePreset] = useState<DatePreset>("ytd");
  const [dateRange, setDateRange] = useState<DateRange>(() => resolvePreset("ytd"));
  const [branches, setBranches] = useState<Branch[]>([]);
  const [regionFilter, setRegionFilter] = useState(ALL_REGIONS);
  const [channelFilter, setChannelFilter] = useState("ALL");
  const [payeeTypeFilter, setPayeeTypeFilter] = useState("ALL");

  useEffect(() => {
    const tid = typeof window !== "undefined" ? localStorage.getItem("tenant_id") ?? "" : "";
    if (tid) listBranches(tid).then(setBranches).catch(() => {});
  }, []);

  const regions = distinctRegions(branches);
  const payeeRegionById = new Map(payees.map((p) => [p.id, resolvePayeeRegion(p.branch, branches)]));

  const dateFilteredLedger: CommissionLedgerEntry[] = filterLedgerByDate(ledger, dateRange);
  const filteredLedger = dateFilteredLedger.filter((entry: CommissionLedgerEntry) => {
    if (regionFilter !== ALL_REGIONS && payeeRegionById.get(entry.payeeId) !== regionFilter) return false;
    if (channelFilter !== "ALL" && entry.channel !== channelFilter) return false;
    if (payeeTypeFilter !== "ALL" && entry.payeeType !== payeeTypeFilter) return false;
    return true;
  });
  const filteredStats = filteredLedger.length > 0 ? computeCommissionStats(filteredLedger) : stats;

  const channelOptions: FilterOption[] = [
    { value: "ALL", label: "All Channels" },
    ...Object.entries(CHANNEL_LABELS).map(([value, label]) => ({ value, label })),
  ];
  const payeeTypeOptions: FilterOption[] = [
    { value: "ALL", label: "All Roles" },
    ...Object.entries(PAYEE_TYPE_LABELS).map(([value, label]) => ({ value, label })),
  ];

  const notify = useCallback((msg: string, ok = true) => {
    setNotification({ msg, type: ok ? "success" : "error" });
    setTimeout(() => setNotification(null), 4500);
  }, []);

  const refresh = useCallback(async (rebuild = false) => {
    setLoading(true);
    try {
      if (rebuild) resetLedgerCache();
      const [ledgerData, payeeData, runData, policiesData, claimsData] = await Promise.all([
        listCommissionLedger(),
        listPayees(),
        listPayoutRuns(),
        listPolicies().catch(() => []),
        listClaims().catch(() => []),
      ]);
      const [statsData] = await Promise.all([getCommissionStats()]);
      setLedger([...ledgerData]);
      setPayees([...payeeData]);
      setPolicies([...policiesData]);
      setClaims([...claimsData]);
      setStats(statsData);
    } catch (err) {
      console.error(err);
      notify("Could not load the commission data.", false);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    refresh(true);
  }, [refresh]);

  // Derived metrics calculations
  const stageTotals = filteredStats?.byStage.reduce(
    (acc, s) => ({
      released: acc.released + s.releasedNet,
      due: acc.due + s.dueNet,
      pending: acc.pending + s.pendingNet,
      tranches: acc.tranches + s.stages,
    }),
    { released: 0, due: 0, pending: 0, tranches: 0 }
  ) || { released: 0, due: 0, pending: 0, tranches: 0 };

  const totalPortfolioValue = stageTotals.released + stageTotals.due + stageTotals.pending;
  const vestedPct = totalPortfolioValue > 0 ? Math.round(((stageTotals.released + stageTotals.due) / totalPortfolioValue) * 100) : 0;
  const duePct = totalPortfolioValue > 0 ? Math.round((stageTotals.due / totalPortfolioValue) * 100) : 0;

  const channelTotalNet = filteredStats?.byChannel.reduce((sum, item) => sum + item.net, 0) || 0;
  const topChannel = filteredStats?.byChannel.length ? [...filteredStats.byChannel].sort((a, b) => b.net - a.net)[0] : null;
  const topChannelPct = topChannel && channelTotalNet > 0 ? Math.round((topChannel.net / channelTotalNet) * 100) : 0;

  const payeeTotalNet = filteredStats?.byPayeeType.reduce((sum, item) => sum + item.net, 0) || 0;

  const outstanding = filteredLedger
    .filter((l) => l.pendingNet > 0 && !l.isClawback)
    .sort((a, b) => b.pendingNet - a.pendingNet);

  return (
    <div className="px-6 py-4 max-w-screen-2xl mx-auto w-full space-y-4 font-sans text-slate-900">
      {notification && (
        <div
          className={`fixed top-5 right-5 z-50 max-w-md px-4 py-3 rounded-xl shadow-lg border text-xs font-bold flex items-start gap-2 bg-white text-slate-800 ${
            notification.type === "success"
              ? "border-blue-200 text-blue-900"
              : "border-rose-200 text-rose-800"
          }`}
        >
          <span className={notification.type === "success" ? "text-blue-600" : "text-rose-600"}>
            {notification.type === "success" ? "✓" : "✕"}
          </span>
          <span>{notification.msg}</span>
        </div>
      )}

      {/* ── Executive Header & Filter Bar ─────────────────────────────────── */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 bg-white px-4 py-3 rounded-2xl border border-slate-200/80 shadow-xs">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-lg font-bold tracking-tight text-slate-900">Commission Dashboard</h1>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Live Engine Active
            </span>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Real-time Producer Payables, Performance Bonuses &amp; Channel Analytics
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <RegionFilter regions={regions} value={regionFilter} onChange={setRegionFilter} />
          <FilterDropdown value={channelFilter} options={channelOptions} onChange={setChannelFilter} />
          <FilterDropdown value={payeeTypeFilter} options={payeeTypeOptions} onChange={setPayeeTypeFilter} />
          <DateRangeFilter
            preset={datePreset}
            range={dateRange}
            onPresetChange={(p, r) => { setDatePreset(p); setDateRange(r); }}
            align="right"
          />
        </div>
      </div>

      {filteredStats && (
        <div className="space-y-4">
          
          {/* ── 1. Top Headline KPI Cards ─────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            <MetricCard
              title="Total Gross Calculated"
              value={loading ? "—" : fmtPKRCompact(filteredStats.totalGrossCommission)}
              subtitle="gross production across rules"
              accent="blue"
            />
            <MetricCard
              title="Active Payees"
              value={loading ? "—" : `${filteredStats.activePayeesCount} / ${payees.length}`}
              subtitle="producers, managers & partners"
              accent="emerald"
            />
            <MetricCard
              title="Pending Liability"
              value={loading ? "—" : fmtPKRCompact(filteredStats.totalAccruedLiability)}
              subtitle="accrued awaiting release"
              accent="amber"
            />
            <MetricCard
              title="Performance Bonuses"
              value={loading ? "—" : fmtPKRCompact(filteredStats.bonusTotal)}
              subtitle="volume & persistency qualified"
              accent="purple"
            />
          </div>

          {/* ── 2. Hero 75% / 25% Visual Analytics Split ────────────────────── */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-stretch">

            {/* ── LEFT: Main Column (75%) ──────────────────────────────────── */}
            <div className="xl:col-span-8 lg:col-span-7 space-y-4">

              {/* Row 1: Regional Heatmap & Time Trend Chart */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <InteractiveMapCard
                  policies={policies}
                  claims={claims}
                  ledger={filteredLedger}
                  selectedRegion={regionFilter}
                  onSelectRegion={setRegionFilter}
                />
                <TimeTrendChartCard
                  policies={policies}
                  claims={claims}
                  ledger={filteredLedger}
                />
              </div>

              {/* Row 2: Milestone Timeline Card (Horizontal Representation) */}
              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-xs">
                      ⚡
                    </div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900">
                      Release Pipeline Lifecycle
                    </h3>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200">
                      {stageTotals.tranches} Active Policies
                    </span>
                  </div>
                </div>

                {/* Horizontal Milestone Progress Strip */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-2 pt-1">
                  {filteredStats.byStage.map((s) => {
                    const stageName = RELEASE_STAGE_LABELS[s.code] || s.code;
                    const totalStageNet = s.dueNet + s.releasedNet;
                    return (
                      <div key={s.code} className="p-3 bg-slate-50 border border-slate-100 rounded-xl space-y-1.5 flex flex-col justify-between">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-slate-600 truncate">{stageName}</span>
                          <span className="text-[9px] font-extrabold px-1.5 py-0.2 bg-white rounded border border-slate-200 font-mono">
                            {s.stages}
                          </span>
                        </div>
                        <div className="text-sm font-extrabold text-slate-900 font-mono">
                          {fmtPKRCompact(totalStageNet)}
                        </div>
                        <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden flex">
                          <div className="bg-emerald-500 h-full" style={{ width: `${s.dueNet + s.releasedNet > 0 ? (s.releasedNet / (s.dueNet + s.releasedNet)) * 100 : 0}%` }} title="Paid" />
                          <div className="bg-blue-500 h-full" style={{ width: `${s.dueNet + s.releasedNet > 0 ? (s.dueNet / (s.dueNet + s.releasedNet)) * 100 : 0}%` }} title="Due Now" />
                        </div>
                        <div className="flex justify-between text-[9px] text-slate-500 font-medium">
                          <span>Paid: {fmtPKRCompact(s.releasedNet)}</span>
                          <span>Due: {fmtPKRCompact(s.dueNet)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Radial Ratio Callouts */}
                <div className="flex items-center justify-around bg-slate-50/70 border border-slate-100 rounded-xl p-3">
                  <div className="flex items-center gap-3">
                    <RingGauge
                      value={vestedPct}
                      strokeHex="#1d4ed8"
                      label="Released Ratio"
                      sublabel="Vested"
                      valueLabel={`${vestedPct}%`}
                      size={60}
                      strokeW={6}
                    />
                    <div>
                      <div className="text-xs font-bold text-slate-800">Total Vested Ratio</div>
                      <div className="text-[10px] text-slate-500">{fmtPKRCompact(stageTotals.released)} released</div>
                    </div>
                  </div>
                  <div className="h-8 w-px bg-slate-200" />
                  <div className="flex items-center gap-3">
                    <RingGauge
                      value={duePct}
                      strokeHex="#3b82f6"
                      label="Ready to Pay"
                      sublabel="Due"
                      valueLabel={`${duePct}%`}
                      size={60}
                      strokeW={6}
                    />
                    <div>
                      <div className="text-xs font-bold text-slate-800">Ready for Disbursement</div>
                      <div className="text-[10px] text-slate-500">{fmtPKRCompact(stageTotals.due)} payout ready</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Row 3: Sales Channel Distribution */}
              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900">
                    Distribution Channel Performance
                  </h3>
                  <span className="text-[10px] font-bold text-slate-400">
                    {filteredStats.byChannel.length} Active Channels
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
                  <div className="flex items-center justify-center p-3 bg-slate-50 border border-slate-100 rounded-xl gap-4">
                    <RingGauge
                      value={topChannelPct}
                      strokeHex="#2563eb"
                      label="Top Channel"
                      sublabel="Mix"
                      valueLabel={`${topChannelPct}%`}
                      size={70}
                      strokeW={7}
                    />
                    <div>
                      <div className="text-[10px] font-bold uppercase text-slate-400">Dominant Channel</div>
                      <div className="text-sm font-extrabold text-slate-900">
                        {topChannel ? CHANNEL_LABELS[topChannel.channel] || topChannel.channel : "—"}
                      </div>
                      <div className="text-xs font-semibold text-blue-600 mt-0.5">
                        {fmtPKRCompact(topChannel?.net || 0)} Total Net
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2 text-xs">
                    {filteredStats.byChannel.slice(0, 4).map((c) => {
                      const pct = channelTotalNet > 0 ? Math.round((c.net / channelTotalNet) * 100) : 0;
                      const cfg = CHANNEL_CONFIG[c.channel] || { icon: AgentIcon, iconBg: "bg-slate-50", iconColor: "text-slate-600", barColor: "bg-sky-500" };
                      return (
                        <div key={c.channel} className="flex items-center gap-2 p-1.5 rounded-lg bg-slate-50/80 border border-slate-100">
                          <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${cfg.iconBg} ${cfg.iconColor}`}>
                            {cfg.icon}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex justify-between items-center text-[11px] mb-0.5">
                              <span className="font-semibold text-slate-700 truncate">{CHANNEL_LABELS[c.channel] || c.channel}</span>
                              <span className="font-mono font-bold text-slate-900">{fmtPKRCompact(c.net)} ({pct}%)</span>
                            </div>
                            <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                              <div className={`h-full ${cfg.barColor} rounded-full`} style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

            </div>

            {/* ── RIGHT: Sidebar (25%) ────────────────────────────────────── */}
            <div className="xl:col-span-4 lg:col-span-5 space-y-4 flex flex-col justify-between">

              {/* Payee Role Distribution Card */}
              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-4 space-y-3 flex-1">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900">
                    Payee Role Breakdown
                  </h3>
                  <span className="text-[10px] font-bold text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full border border-purple-200">
                    {filteredStats.byPayeeType.length} Roles
                  </span>
                </div>

                <div className="space-y-2 text-xs">
                  {filteredStats.byPayeeType.map((t) => {
                    const pct = payeeTotalNet > 0 ? Math.round((t.net / payeeTotalNet) * 100) : 0;
                    const cfg = PAYEE_CONFIG[t.payeeType] || { icon: AgentIcon, iconBg: "bg-slate-50", iconColor: "text-slate-600", barColor: "bg-purple-500" };
                    return (
                      <div key={t.payeeType} className="p-2 bg-slate-50/90 border border-slate-100 rounded-xl space-y-1">
                        <div className="flex justify-between items-center text-[11px]">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className={`w-4 h-4 rounded flex items-center justify-center shrink-0 text-[10px] ${cfg.iconBg} ${cfg.iconColor}`}>
                              {cfg.icon}
                            </span>
                            <span className="font-bold text-slate-800 truncate">{PAYEE_TYPE_LABELS[t.payeeType] || t.payeeType}</span>
                          </div>
                          <span className="font-extrabold font-mono text-slate-900 shrink-0">{fmtPKRCompact(t.net)} · {pct}%</span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                          <div className={`h-full ${cfg.barColor} rounded-full`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 2x2 Financial Liabilities Quadrant Grid */}
              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-4 space-y-3 flex-1">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900">
                    Financial Reserves &amp; Liabilities
                  </h3>
                  <span className="text-[10px] font-bold text-slate-400">Live Accruals</span>
                </div>

                <div className="grid grid-cols-2 gap-2.5 text-xs">
                  <div className="p-3 bg-blue-50/60 border border-blue-100 rounded-xl space-y-0.5">
                    <div className="text-[10px] font-bold text-blue-900 uppercase tracking-wide">Processing Payments</div>
                    <div className="text-sm font-extrabold text-blue-800 font-mono">{fmtPKRCompact(filteredStats.totalInRun)}</div>
                    <div className="text-[9px] text-blue-600">Active payout runs</div>
                  </div>

                  <div className="p-3 bg-amber-50/60 border border-amber-100 rounded-xl space-y-0.5">
                    <div className="text-[10px] font-bold text-amber-900 uppercase tracking-wide">Withheld Tax</div>
                    <div className="text-sm font-extrabold text-amber-800 font-mono">{fmtPKRCompact(filteredStats.totalWithheldTax)}</div>
                    <div className="text-[9px] text-amber-600">Tax withheld for FBR</div>
                  </div>

                  <div className="p-3 bg-purple-50/60 border border-purple-100 rounded-xl space-y-0.5">
                    <div className="text-[10px] font-bold text-purple-900 uppercase tracking-wide">Team Overrides</div>
                    <div className="text-sm font-extrabold text-purple-800 font-mono">{fmtPKRCompact(filteredStats.overrideTotal)}</div>
                    <div className="text-[9px] text-purple-600">Manager overrides</div>
                  </div>

                  <div className="p-3 bg-rose-50/60 border border-rose-100 rounded-xl space-y-0.5">
                    <div className="text-[10px] font-bold text-rose-900 uppercase tracking-wide">Clawbacks</div>
                    <div className="text-sm font-extrabold text-rose-800 font-mono">{fmtPKRCompact(filteredStats.totalClawbacks)}</div>
                    <div className="text-[9px] text-rose-600">Lapse reversals</div>
                  </div>
                </div>
              </div>

              {/* Commission Audit Feed */}
              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-4 space-y-3 flex-1">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900">
                    Outstanding Audit Log
                  </h3>
                  <span className="text-[10px] font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                    {outstanding.length} Pending
                  </span>
                </div>

                <div className="max-h-48 overflow-y-auto space-y-2 text-xs pr-1">
                  {outstanding.slice(0, 10).map((entry) => (
                    <div key={entry.id} className="p-2 bg-slate-50 border border-slate-100 rounded-xl flex justify-between items-center">
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-slate-800 text-[11px] truncate">{entry.payeeName}</div>
                        <div className="text-[10px] text-slate-500 font-mono">Pol #{entry.policyNumber}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-extrabold text-slate-900 font-mono text-[11px]">{fmtPKRCompact(entry.pendingNet)}</div>
                        <StatusPill status={entry.status} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

            </div>

          </div>

        </div>
      )}

      {/* Footer Disclaimer */}
      <p className="text-center text-[10px] text-slate-400 pb-2 leading-relaxed">
        Commission metrics are computed live from real-time calculation engine datasets for the selected filters.
        &nbsp;·&nbsp; Model suite: <span className="font-mono">insurance-ai v0.1.0-commissions</span>
        &nbsp;·&nbsp; Commission Dashboard — Internal Use Only
      </p>
    </div>
  );
}
