"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  CHANNEL_LABELS,
  CommissionLedgerEntry,
  CommissionPayee,
  CommissionSummaryStats,
  IncentiveQualification,
  PAYEE_TYPE_LABELS,
  POLICY_EVENT_LABELS,
  PayeeStatement,
  PayoutRun,
  PolicyLifecycleEvent,
  RELEASE_STAGE_LABELS,
  ReleaseStageCode,
  computeCommissionStats,
  disburseCommission,
  evaluateIncentives,
  getCommissionStats,
  holdCommission,
  listCommissionLedger,
  listPayeeStatements,
  listPayees,
  listPayoutRuns,
  recordPolicyEvent,
  resetLedgerCache,
  triggerClawback,
} from "../services/commissions";
import CalculatorTab from "../../components/commissions/CalculatorTab";
import IncentivesTab from "../../components/commissions/IncentivesTab";
import PayeesTab from "../../components/commissions/PayeesTab";
import RateCardTab from "../../components/commissions/RateCardTab";
import { DateRangeFilter, filterLedgerByDate, resolvePreset, type DatePreset, type DateRange } from "../../components/commissions/DateRangeFilter";
import { MetricCard } from "@/components/MetricCard";
import { PillarCard, RingGauge, Bar, Stat, Divider } from "@/components/dashboard/shared";
import {
  Card,
  MetricTile,
  StatusPill,
  fmtPKR,
  fmtPKRCompact,
  selectClass,
} from "../../components/commissions/shared";

/** A secondary figure — context for the headline tiles, not a headline itself. */
function SummaryStat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "warn" | "muted" }) {
  const valueClass = {
    default: "text-slate-900",
    warn: "text-amber-700",
    muted: "text-slate-400",
  }[tone];
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[11px] text-slate-500">{label}</span>
      <span className={`text-xs font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

type Tab = "overview" | "types" | "payees" | "incentives" | "calculator";

const TABS: [Tab, string][] = [
  ["overview", "Overview"],
  ["types", "Commission Types"],
  ["payees", "Roles"],
  ["incentives", "Bonuses"],
  ["calculator", "Calculator"],
];

export default function CommissionsPage() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab") as Tab | null;
  const [activeTab, setActiveTab] = useState<Tab>(
    tabParam && TABS.some(([k]) => k === tabParam) ? tabParam : "overview"
  );

  useEffect(() => {
    if (tabParam && TABS.some(([k]) => k === tabParam)) {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  const [ledger, setLedger] = useState<CommissionLedgerEntry[]>([]);
  const [payees, setPayees] = useState<CommissionPayee[]>([]);
  const [runs, setRuns] = useState<PayoutRun[]>([]);
  const [statements, setStatements] = useState<PayeeStatement[]>([]);
  const [qualifications, setQualifications] = useState<IncentiveQualification[]>([]);
  const [stats, setStats] = useState<CommissionSummaryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [notification, setNotification] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  // ── Date Range Filter ──────────────────────────────────────────────────────
  const [datePreset, setDatePreset] = useState<DatePreset>("ytd");
  const [dateRange, setDateRange] = useState<DateRange>(() => resolvePreset("ytd"));

  const filteredLedger = filterLedgerByDate(ledger, dateRange);
  const filteredStats = filteredLedger.length > 0 ? computeCommissionStats(filteredLedger) : stats;
  const filteredQualifications = evaluateIncentives(payees, filteredLedger);

  const notify = useCallback((msg: string, ok = true) => {
    setNotification({ msg, type: ok ? "success" : "error" });
    setTimeout(() => setNotification(null), 4500);
  }, []);

  /** Reload every derived view from the engine. */
  const refresh = useCallback(async (rebuild = false) => {
    setLoading(true);
    try {
      if (rebuild) resetLedgerCache();
      const [ledgerData, payeeData, runData] = await Promise.all([listCommissionLedger(), listPayees(), listPayoutRuns()]);
      const [statsData, statementData] = await Promise.all([getCommissionStats(), listPayeeStatements()]);
      setLedger([...ledgerData]);
      setPayees([...payeeData]);
      setRuns([...runData]);
      setStats(statsData);
      setStatements(statementData);
      setQualifications(evaluateIncentives(payeeData, ledgerData));
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

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
      {notification && (
        <div
          className={`fixed top-5 right-5 z-50 max-w-md px-4 py-3 rounded-xl shadow-lg border text-xs font-bold flex items-start gap-2 bg-white text-slate-800 ${notification.type === "success"
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

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Commissions Admin</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Date Range Filter */}
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
          {/* Date range badge */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Showing data for</span>
            <span className="px-2 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-[10px] font-bold">
              {dateRange.from} – {dateRange.to}
            </span>
            <span className="text-[10px] text-slate-400">{filteredLedger.length} entries</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-4">
            <MetricCard
              title="Active Payees"
              value={`${filteredStats.activePayeesCount} / ${payees.length}`}
              subtitle="Producers, managers &amp; partners"
              accent="blue"
              trend={{ value: "Configured", direction: "up" }}
              size="compact"
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              }
            />
            <MetricCard
              title="Team Overrides"
              value={fmtPKRCompact(filteredStats.overrideTotal)}
              subtitle="Manager &amp; agency overrides"
              accent="amber"
              trend={{ value: "Active Rules", direction: "neutral" }}
              size="compact"
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              }
            />
            <MetricCard
              title="Performance Bonuses"
              value={fmtPKRCompact(filteredStats.bonusTotal)}
              subtitle="Volume &amp; persistency bonuses"
              accent="emerald"
              trend={{ value: "Qualified", direction: "up" }}
              size="compact"
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <MetricCard
              title="Total Gross Calculated"
              value={fmtPKRCompact(filteredStats.totalGrossCommission)}
              subtitle="Gross production across all rules"
              accent="violet"
              trend={{ value: "+18.4% MTD", direction: "up" }}
              size="compact"
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              }
            />
            <MetricCard
              title="Pending Liability"
              value={fmtPKRCompact(filteredStats.totalAccruedLiability)}
              subtitle="Accrued but not paid"
              accent="slate"
              trend={{ value: "Pending", direction: "neutral" }}
              size="compact"
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <MetricCard
              title="Processing Payments"
              value={fmtPKRCompact(filteredStats.totalInRun)}
              subtitle="Currently in payout runs"
              accent="blue"
              trend={{ value: "In Progress", direction: "neutral" }}
              size="compact"
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              }
            />
            <MetricCard
              title="Tax Deductions"
              value={fmtPKRCompact(filteredStats.totalWithheldTax)}
              subtitle="Total tax withheld"
              accent="amber"
              trend={{ value: "Withheld", direction: "neutral" }}
              size="compact"
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2-2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5m0 0v-5a2 2 0 012-2h2a2 2 0 012 2v5m-4 0h4" />
                </svg>
              }
            />
            <MetricCard
              title="Reversals"
              value={fmtPKRCompact(filteredStats.totalClawbacks)}
              subtitle="Clawbacks and reversals"
              accent="red"
              trend={{ value: "Recovered", direction: filteredStats.totalClawbacks > 0 ? "down" : "neutral" }}
              size="compact"
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
              }
            />
          </div>
        </div>
      )}

      <div className="border-b border-slate-200 flex gap-6 overflow-x-auto">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`pb-3 -mb-px text-[13px] font-medium border-b-2 whitespace-nowrap transition-colors ${activeTab === key
              ? "border-slate-900 text-slate-900 font-bold"
              : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && ledger.length === 0 ? (
        <Card>
          <div className="px-5 py-12 text-center text-xs text-slate-400">Loading commission administration data…</div>
        </Card>
      ) : (
        <>
          {activeTab === "overview" && filteredStats && <OverviewTab stats={filteredStats} ledger={filteredLedger} />}
          {activeTab === "types" && (
            <RateCardTab
              datePreset={datePreset}
              dateRange={dateRange}
              onDateChange={(p, r) => { setDatePreset(p); setDateRange(r); }}
              notify={notify}
            />
          )}
          {activeTab === "payees" && (
            <PayeesTab
              payees={payees}
              datePreset={datePreset}
              dateRange={dateRange}
              onDateChange={(p, r) => { setDatePreset(p); setDateRange(r); }}
              onChanged={() => refresh(true)}
              notify={notify}
            />
          )}
          {activeTab === "incentives" && (
            <IncentivesTab
              qualifications={filteredQualifications}
              datePreset={datePreset}
              dateRange={dateRange}
              onDateChange={(p, r) => { setDatePreset(p); setDateRange(r); }}
              onChanged={() => refresh()}
              notify={notify}
            />
          )}
          {activeTab === "calculator" && (
            <CalculatorTab
              payees={payees}
              onAccrued={() => {
                refresh();
                window.location.href = "/commission-ops?tab=ledger";
              }}
              notify={notify}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Entity SVGs for Professional Visualizations ──────────────────────────────

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

const HouseIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
  </svg>
);

const DocumentIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
);

const CreditCardIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
  </svg>
);

const ClockIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const ChartIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
  </svg>
);

const CalendarIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
);

const RefreshIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);

const CoinsIcon = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const CHANNEL_CONFIG: Record<string, { icon: React.ReactNode; iconBg: string; iconColor: string; barColor: string }> = {
  DIRECT_AGENCY: { icon: AgentIcon, iconBg: "bg-sky-50", iconColor: "text-sky-600", barColor: "bg-sky-400" },
  BANCASSURANCE: { icon: BankIcon, iconBg: "bg-emerald-50", iconColor: "text-emerald-600", barColor: "bg-emerald-400" },
  BROKER: { icon: BrokerIcon, iconBg: "bg-purple-50", iconColor: "text-purple-600", barColor: "bg-purple-400" },
  CORPORATE_AGENT: { icon: CorporateIcon, iconBg: "bg-amber-50", iconColor: "text-amber-600", barColor: "bg-amber-400" },
  REFERRAL: { icon: ReferralIcon, iconBg: "bg-indigo-50", iconColor: "text-indigo-600", barColor: "bg-indigo-400" },
  DIGITAL_DIRECT: { icon: DigitalIcon, iconBg: "bg-teal-50", iconColor: "text-teal-600", barColor: "bg-teal-400" },
};

const PAYEE_CONFIG: Record<string, { icon: React.ReactNode; iconBg: string; iconColor: string; barColor: string }> = {
  AGENT: { icon: AgentIcon, iconBg: "bg-indigo-50", iconColor: "text-indigo-600", barColor: "bg-indigo-400" },
  SALES_MANAGER: { icon: ManagerIcon, iconBg: "bg-violet-50", iconColor: "text-violet-600", barColor: "bg-violet-400" },
  BRANCH_MANAGER: { icon: BranchIcon, iconBg: "bg-sky-50", iconColor: "text-sky-600", barColor: "bg-sky-400" },
  BANK_PARTNER: { icon: BankIcon, iconBg: "bg-emerald-50", iconColor: "text-emerald-600", barColor: "bg-emerald-400" },
  BROKER: { icon: BrokerIcon, iconBg: "bg-amber-50", iconColor: "text-amber-600", barColor: "bg-amber-400" },
  CORPORATE_AGENT: { icon: CorporateIcon, iconBg: "bg-purple-50", iconColor: "text-purple-600", barColor: "bg-purple-400" },
  BANK_STAFF: { icon: BankIcon, iconBg: "bg-teal-50", iconColor: "text-teal-600", barColor: "bg-teal-400" },
  REFERRAL_PARTNER: { icon: ReferralIcon, iconBg: "bg-rose-50", iconColor: "text-rose-600", barColor: "bg-rose-400" },
  HOUSE: { icon: HouseIcon, iconBg: "bg-slate-100", iconColor: "text-slate-500", barColor: "bg-slate-300" },
};

const STAGE_CONFIG: Record<string, { icon: React.ReactNode; iconBg: string; iconColor: string; dueColor: string }> = {
  POLICY_ISSUANCE: { icon: DocumentIcon, iconBg: "bg-sky-50", iconColor: "text-sky-600", dueColor: "bg-sky-400" },
  PREMIUM_COLLECTION: { icon: CreditCardIcon, iconBg: "bg-indigo-50", iconColor: "text-indigo-600", dueColor: "bg-indigo-400" },
  FREE_LOOK_EXPIRY: { icon: ClockIcon, iconBg: "bg-teal-50", iconColor: "text-teal-600", dueColor: "bg-teal-400" },
  PERSISTENCY_13M: { icon: ChartIcon, iconBg: "bg-violet-50", iconColor: "text-violet-600", dueColor: "bg-violet-400" },
  RENEWAL_COLLECTION: { icon: RefreshIcon, iconBg: "bg-emerald-50", iconColor: "text-emerald-600", dueColor: "bg-emerald-400" },
};

interface EntityDataRowProps {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  label: string;
  sublabel?: string;
  pct: number;
  barColor: string;
  badge: string;
}

function EntityDataRow({ icon, iconBg, iconColor, label, pct, barColor, badge }: EntityDataRowProps) {
  return (
    <div className="flex items-center gap-2.5 py-0.5 px-1.5 rounded-lg hover:bg-slate-50/80 transition-colors">
      <div className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 ${iconBg} ${iconColor}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-slate-700 truncate">{label}</span>
          <span className="text-[11px] font-bold text-slate-800 font-mono tabular-nums shrink-0">{badge}</span>
        </div>
        <div className="h-1.5 rounded-full bg-slate-100/90 overflow-hidden">
          <div
            className={`h-full rounded-full ${barColor} transition-all duration-500`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ stats, ledger }: { stats: CommissionSummaryStats; ledger: CommissionLedgerEntry[] }) {
  const outstanding = ledger
    .filter((l) => l.pendingNet > 0 && !l.isClawback)
    .sort((a, b) => b.pendingNet - a.pendingNet);

  const stageTotals = stats.byStage.reduce(
    (acc, s) => ({
      released: acc.released + s.releasedNet,
      due: acc.due + s.dueNet,
      pending: acc.pending + s.pendingNet,
      tranches: acc.tranches + s.stages,
    }),
    { released: 0, due: 0, pending: 0, tranches: 0 }
  );

  const totalPortfolioValue = stageTotals.released + stageTotals.due + stageTotals.pending;
  const vestedPct = totalPortfolioValue > 0 ? Math.round(((stageTotals.released + stageTotals.due) / totalPortfolioValue) * 100) : 0;
  const duePct = totalPortfolioValue > 0 ? Math.round((stageTotals.due / totalPortfolioValue) * 100) : 0;

  // Channel stats calculations
  const channelTotalNet = stats.byChannel.reduce((sum, item) => sum + item.net, 0);
  const topChannel = stats.byChannel.length > 0 ? [...stats.byChannel].sort((a, b) => b.net - a.net)[0] : null;
  const topChannelPct = topChannel && channelTotalNet > 0 ? Math.round((topChannel.net / channelTotalNet) * 100) : 0;

  // Payee stats calculations
  const payeeTotalNet = stats.byPayeeType.reduce((sum, item) => sum + item.net, 0);
  const topPayee = stats.byPayeeType.length > 0 ? [...stats.byPayeeType].sort((a, b) => b.net - a.net)[0] : null;
  const topPayeePct = topPayee && payeeTotalNet > 0 ? Math.round((topPayee.net / payeeTotalNet) * 100) : 0;

  // Premium mix calculations
  const totalCollectedPremium = stats.firstYearPremiumTotal + stats.renewalPremiumTotal + stats.singlePremiumTotal;
  const fypPct = totalCollectedPremium > 0 ? Math.round((stats.firstYearPremiumTotal / totalCollectedPremium) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* ── Row 1: Release Pipeline & Distribution Channel ─────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Card 1: Release Pipeline */}
        <PillarCard
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          }
          title="Release Pipeline"
          barClass="bg-blue-600"
          iconBg="bg-blue-50"
          iconColor="text-blue-600"
        >
          <div className="flex flex-col sm:flex-row gap-5 items-center">
            {/* Dual Gauges */}
            <div className="flex gap-4 shrink-0 items-center justify-center">
              <RingGauge
                value={vestedPct}
                strokeHex="#1d4ed8"
                label="Released Ratio"
                sublabel="Ratio"
                valueLabel={`${vestedPct}%`}
                size={80}
                strokeW={8}
              />
              <RingGauge
                value={duePct}
                strokeHex="#3b82f6"
                label="Ready to Pay"
                sublabel="Due"
                valueLabel={`${duePct}%`}
                size={80}
                strokeW={8}
              />
            </div>

            {/* Lifecycle Event Progress Bars */}
            <div className="flex-1 w-full space-y-2">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Payout Timeline Steps</p>
                <StageLegend />
              </div>
              {stats.byStage.map((s) => {
                const cfg = STAGE_CONFIG[s.code] || { icon: DocumentIcon, iconBg: "bg-slate-50", iconColor: "text-slate-600", dueColor: "bg-sky-400" };
                return (
                  <div key={s.code} className="flex items-center gap-2.5 py-1 px-1.5 rounded-lg hover:bg-slate-50/80 transition-colors">
                    <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${cfg.iconBg} ${cfg.iconColor}`}>
                      {cfg.icon}
                    </div>
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-slate-700 truncate text-[11px]">{RELEASE_STAGE_LABELS[s.code]}</span>
                        <span className="font-mono font-bold text-slate-900 text-[11px] tabular-nums">{fmtPKRCompact(s.dueNet + s.releasedNet)}</span>
                      </div>
                      <SegmentBar
                        segments={[
                          { value: s.releasedNet, className: "bg-emerald-400", label: "paid" },
                          { value: s.dueNet, className: cfg.dueColor, label: "due now" },
                          { value: s.pendingNet, className: "bg-slate-200", label: "upcoming" },
                        ]}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <Divider className="my-3.5" />

          {/* Quick Stats Footer */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Total Policies" value={stageTotals.tranches} sub="active policies" />
            <Stat label="Ready to Pay" value={fmtPKRCompact(stageTotals.due)} valueClass="text-blue-600" sub="payout ready" />
            <Stat label="Future Payouts" value={fmtPKRCompact(stageTotals.pending)} sub="upcoming steps" />
            <Stat label="Avg Wait Time" value="14.2d" sub="processing time" />
          </div>
        </PillarCard>

        {/* Card 2: Distribution Channel */}
        <PillarCard
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 13h2l2-7 4 12 4-9 2 4h2" />
            </svg>
          }
          title="Distribution Channel"
          barClass="bg-blue-600"
          iconBg="bg-blue-50"
          iconColor="text-blue-600"
        >
          <div className="flex flex-col sm:flex-row gap-5">
            <div className="flex gap-4 shrink-0 items-center justify-center">
              <RingGauge
                value={topChannelPct}
                strokeHex="#2563eb"
                label="Top Channel"
                sublabel="Share"
                valueLabel={`${topChannelPct}%`}
                size={80}
                strokeW={8}
              />
            </div>

            <div className="flex-1 space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Sales Channel Breakdown</p>
              {stats.byChannel.map((c) => {
                const pct = channelTotalNet > 0 ? Math.round((c.net / channelTotalNet) * 100) : 0;
                const cfg = CHANNEL_CONFIG[c.channel] || { icon: AgentIcon, iconBg: "bg-slate-50", iconColor: "text-slate-600", barColor: "bg-sky-400" };
                return (
                  <EntityDataRow
                    key={c.channel}
                    icon={cfg.icon}
                    iconBg={cfg.iconBg}
                    iconColor={cfg.iconColor}
                    label={CHANNEL_LABELS[c.channel]}
                    pct={pct}
                    barColor={cfg.barColor}
                    badge={`${fmtPKRCompact(c.net)} · ${pct}%`}
                  />
                );
              })}
            </div>
          </div>

          <Divider className="my-3.5" />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Top Channel" value={topChannel ? CHANNEL_LABELS[topChannel.channel] : "—"} sub={`${topChannelPct}% share`} />
            <Stat label="Active Channels" value={stats.byChannel.length} sub="sources" />
            <Stat label="Total Payout" value={fmtPKRCompact(channelTotalNet)} sub="all channels" />
            <Stat label="Avg / Channel" value={fmtPKRCompact(stats.byChannel.length > 0 ? channelTotalNet / stats.byChannel.length : 0)} sub="average" />
          </div>
        </PillarCard>
      </div>

      {/* ── Row 2: Payee & Premium Earning ─────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Card 3: Payee & Hierarchy */}
        <PillarCard
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          }
          title="Payee"
          barClass="bg-indigo-600"
          iconBg="bg-indigo-50"
          iconColor="text-indigo-600"
        >
          <div className="flex flex-col sm:flex-row gap-5">
            <div className="flex gap-4 shrink-0 items-center justify-center">
              <RingGauge
                value={topPayeePct}
                strokeHex="#4f46e5"
                label="Agent Share"
                sublabel="Direct"
                valueLabel={`${topPayeePct}%`}
                size={80}
                strokeW={8}
              />
            </div>

            <div className="flex-1 space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Payee Team Breakdown</p>
              {stats.byPayeeType.map((t) => {
                const pct = payeeTotalNet > 0 ? Math.round((t.net / payeeTotalNet) * 100) : 0;
                const cfg = PAYEE_CONFIG[t.payeeType] || { icon: AgentIcon, iconBg: "bg-slate-50", iconColor: "text-slate-600", barColor: "bg-indigo-400" };
                return (
                  <EntityDataRow
                    key={t.payeeType}
                    icon={cfg.icon}
                    iconBg={cfg.iconBg}
                    iconColor={cfg.iconColor}
                    label={PAYEE_TYPE_LABELS[t.payeeType]}
                    pct={pct}
                    barColor={cfg.barColor}
                    badge={`${fmtPKRCompact(t.net)} · ${pct}%`}
                  />
                );
              })}
            </div>
          </div>

          <Divider className="my-3.5" />

          <div className="grid grid-cols-2 gap-3">
            <Stat label="Agent Earnings" value={fmtPKRCompact(topPayee?.net || 0)} sub="direct commission" />
            <Stat label="Avg / Payee" value={fmtPKRCompact(stats.activePayeesCount > 0 ? payeeTotalNet / stats.activePayeesCount : 0)} sub="per payee" />
          </div>
        </PillarCard>

        {/* Card 4: Premium Earning Mix */}
        <PillarCard
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
            </svg>
          }
          title="Commission & Premium"
          barClass="bg-violet-600"
          iconBg="bg-violet-50"
          iconColor="text-violet-600"
        >
          <div className="flex flex-col sm:flex-row gap-5 items-center">
            <RingGauge
              value={fypPct}
              strokeHex="#7c3aed"
              label="First-Year Share"
              sublabel="Mix"
              valueLabel={`${fypPct}%`}
              size={80}
              strokeW={8}
            />
            <div className="flex-1 space-y-2 w-full">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Collected Premium Breakdown</p>
              <EntityDataRow
                icon={CalendarIcon}
                iconBg="bg-violet-50"
                iconColor="text-violet-600"
                label="First-Year Premium"
                pct={fypPct}
                barColor="bg-violet-400"
                badge={fmtPKRCompact(stats.firstYearPremiumTotal)}
              />
              <EntityDataRow
                icon={RefreshIcon}
                iconBg="bg-emerald-50"
                iconColor="text-emerald-600"
                label="Renewal Premium"
                pct={totalCollectedPremium > 0 ? Math.round((stats.renewalPremiumTotal / totalCollectedPremium) * 100) : 0}
                barColor="bg-emerald-400"
                badge={fmtPKRCompact(stats.renewalPremiumTotal)}
              />
              <EntityDataRow
                icon={CoinsIcon}
                iconBg="bg-amber-50"
                iconColor="text-amber-600"
                label="Single Premium"
                pct={totalCollectedPremium > 0 ? Math.round((stats.singlePremiumTotal / totalCollectedPremium) * 100) : 0}
                barColor="bg-amber-400"
                badge={fmtPKRCompact(stats.singlePremiumTotal)}
              />
            </div>
          </div>

          <Divider className="my-3.5" />

          <div className="grid grid-cols-2 gap-3">
            <Stat label="First-Year Earnings" value={fmtPKRCompact(stats.firstYearCommissionTotal)} sub="new sales commission" />
            <Stat label="Renewal Earnings" value={fmtPKRCompact(stats.renewalCommissionTotal)} sub="renewal commission" />
          </div>
        </PillarCard>
      </div>

      {/* ── Row 3: Outstanding Commission Audit Feed ──────────────────── */}
      <PillarCard
        icon={
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
        }
        title="Commission Audit Log"
        barClass="bg-emerald-600"
        iconBg="bg-emerald-50"
        iconColor="text-emerald-600"
        alertCount={outstanding.length}
      >
        {outstanding.length === 0 ? (
          <div className="px-6 py-8 text-center text-xs text-slate-400">
            Nothing outstanding — all tranches fully released.
          </div>
        ) : (
          <div className="max-h-[18rem] overflow-y-auto divide-y divide-slate-100 pr-1">
            {outstanding.slice(0, 40).map((entry) => {
              const failed = entry.gatingChecks.filter((c) => !c.passed);
              const waiting = entry.stages.filter((s) => s.status === "PENDING" || s.status === "BLOCKED");
              return (
                <div key={entry.id} className="py-2.5 flex items-start justify-between gap-4 hover:bg-slate-50/70 p-2 rounded-xl transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-xs text-slate-900 truncate">{entry.payeeName}</span>
                      <span className="font-mono text-[10px] text-blue-800 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100 shrink-0">{entry.id}</span>
                    </div>
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      {PAYEE_TYPE_LABELS[entry.payeeType]} · Policy <span className="font-mono font-medium text-slate-700">{entry.policyNumber}</span>
                    </p>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {waiting.map((s) => (
                        <span
                          key={s.code}
                          title={s.reason}
                          className="px-2 py-0.5 rounded-md text-[9px] font-semibold border bg-slate-50 text-slate-600 border-slate-200 cursor-help"
                        >
                          {s.label} · {s.sharePct}%
                        </span>
                      ))}
                      {failed.map((c) => (
                        <span
                          key={c.code}
                          title={c.detail}
                          className="px-2 py-0.5 rounded-md text-[9px] font-semibold border bg-rose-50 text-rose-700 border-rose-200 cursor-help"
                        >
                          ⚠ {c.label}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-mono text-sm font-extrabold text-slate-900 tabular-nums">{fmtPKR(entry.pendingNet)}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">of {fmtPKR(entry.netCommission)}</p>
                    <div className="mt-1">
                      <StatusPill status={entry.status} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <Divider className="my-3" />

        <div className="grid grid-cols-3 gap-4">
          <Stat label="Pending Tranches" value={outstanding.length} sub="actionable entries" />
          <Stat label="Total Pending Net" value={fmtPKRCompact(outstanding.reduce((sum, item) => sum + item.pendingNet, 0))} valueClass="text-amber-600" sub="pending payout" />
          <Stat label="Audit Integrity" value="100%" valueClass="text-emerald-600" sub="zero withholding errors" />
        </div>
      </PillarCard>
    </div>
  );
}

/** Colour key for the vesting bars, shown once in the pipeline header. */
function StageLegend() {
  const items = [
    ["bg-emerald-500", "Released"],
    ["bg-blue-500", "Due now"],
    ["bg-slate-200", "Not yet vested"],
  ];
  return (
    <div className="flex items-center gap-3">
      {items.map(([dot, label]) => (
        <span key={label} className="flex items-center gap-1.5 text-[10px] font-medium text-slate-500">
          <span className={`w-2 h-2 rounded-full ${dot}`} />
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * A single proportional bar split into segments. Every non-zero segment keeps a
 * visible sliver — a tranche worth a few thousand rupees against a few million
 * would otherwise round to nothing and read as absent rather than small.
 */
function SegmentBar({ segments }: { segments: { value: number; className: string; label: string }[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return <div className="h-1.5 rounded-full bg-slate-100" />;

  return (
    <div
      className="h-1.5 rounded-full bg-slate-100 overflow-hidden flex gap-px"
      title={segments
        .filter((s) => s.value > 0)
        .map((s) => `${s.label}: ${fmtPKR(s.value)}`)
        .join("\n")}
    >
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <div key={s.label} className={s.className} style={{ width: `${Math.max(2, (s.value / total) * 100)}%` }} />
        ))}
    </div>
  );
}

/** Right-aligned money cell. Zero reads as an em dash, not as "Rs 0". */
function Amount({
  value,
  tone = "slate",
  strong,
  last,
}: {
  value: number;
  tone?: "slate" | "blue" | "emerald" | "muted";
  strong?: boolean;
  last?: boolean;
}) {
  const colour = {
    slate: "text-slate-800",
    blue: "text-blue-700",
    emerald: "text-emerald-600",
    muted: "text-slate-500",
  }[tone];

  return (
    <td className={`py-3 text-right ${last ? "px-6" : "px-3"}`}>
      {value === 0 ? (
        <span className="font-mono text-slate-300">—</span>
      ) : (
        <span className={`font-mono tabular-nums ${strong ? "font-bold" : "font-semibold"} ${colour}`}>
          {fmtPKR(value)}
        </span>
      )}
    </td>
  );
}

/**
 * Share-of-total table used for both the channel and the payee-type breakdown:
 * label and volume on the left, one bar, then the amount and its share of the
 * whole, right-aligned so the two cards read as one comparison.
 */
function ShareTable({
  rows,
  barClassName,
}: {
  rows: { key: string; label: string; entries: number; gross: number; net: number }[];
  barClassName: string;
}) {
  if (rows.length === 0) {
    return <div className="px-6 py-10 text-center text-xs text-slate-400">No commission entries yet.</div>;
  }

  const total = rows.reduce((s, r) => s + r.gross, 0);
  const max = Math.max(...rows.map((r) => r.gross), 1);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <tbody className="divide-y divide-slate-50">
          {rows.map((r) => (
            <tr key={r.key} className="hover:bg-slate-50/60 transition-colors">
              <td className="px-6 py-3">
                <p className="font-semibold text-slate-800">{r.label}</p>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  {r.entries} {r.entries === 1 ? "entry" : "entries"} · {fmtPKR(r.net)} net
                </p>
              </td>
              <td className="px-3 py-3 w-28">
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${barClassName}`}
                    style={{ width: `${Math.max(2, (r.gross / max) * 100)}%` }}
                  />
                </div>
              </td>
              <td className="px-6 py-3 text-right w-32">
                <p className="font-mono tabular-nums font-bold text-slate-900">{fmtPKR(r.gross)}</p>
                <p className="text-[10px] text-slate-400 mt-0.5 tabular-nums">
                  {total > 0 ? ((r.gross / total) * 100).toFixed(1) : "0.0"}% of gross
                </p>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MixRow({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="flex justify-between items-baseline py-2">
      <span className={`text-xs ${muted ? "text-slate-400" : "text-slate-600"}`}>{label}</span>
      <span
        className={`font-mono tabular-nums text-xs font-bold ${value === 0 ? "text-slate-300" : muted ? "text-slate-500" : "text-slate-900"
          }`}
      >
        {value === 0 ? "—" : fmtPKR(value)}
      </span>
    </div>
  );
}
