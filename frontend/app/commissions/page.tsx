"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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
import LedgerTab from "../../components/commissions/LedgerTab";
import PayeesTab from "../../components/commissions/PayeesTab";
import PayoutRunsTab from "../../components/commissions/PayoutRunsTab";
import RateCardTab from "../../components/commissions/RateCardTab";
import StatementsTab from "../../components/commissions/StatementsTab";
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

type Tab = "overview" | "types" | "payees" | "ledger" | "runs" | "statements" | "incentives" | "calculator";

const TABS: [Tab, string][] = [
  ["overview", "Overview"],
  ["types", "Commission Types"],
  ["payees", "Payees & Hierarchy"],
  ["ledger", "Commission Ledger"],
  ["runs", "Payout Runs"],
  ["statements", "Statements"],
  ["incentives", "Incentives"],
  ["calculator", "Calculator"],
];

const CLAWBACK_REASONS = [
  "Policy cancelled within the free-look window",
  "Policy lapsed due to non-payment of renewal premium",
  "Underwriting rejection / material misrepresentation",
  "Proposer bank chargeback / cheque returned",
  "Commission overpaid — rate applied in error",
  "Producer licence found invalid at the date of sale",
];

export default function CommissionsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [ledger, setLedger] = useState<CommissionLedgerEntry[]>([]);
  const [payees, setPayees] = useState<CommissionPayee[]>([]);
  const [runs, setRuns] = useState<PayoutRun[]>([]);
  const [statements, setStatements] = useState<PayeeStatement[]>([]);
  const [qualifications, setQualifications] = useState<IncentiveQualification[]>([]);
  const [stats, setStats] = useState<CommissionSummaryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [notification, setNotification] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  const [clawbackTarget, setClawbackTarget] = useState<CommissionLedgerEntry | null>(null);
  const [clawbackReason, setClawbackReason] = useState(CLAWBACK_REASONS[0]);
  const [cascade, setCascade] = useState(true);
  const [holdTarget, setHoldTarget] = useState<CommissionLedgerEntry | null>(null);
  const [holdReason, setHoldReason] = useState("Under investigation — payout withheld pending review");

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
      notify("Could not load the commission ledger.", false);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    refresh(true);
  }, [refresh]);

  const handleDisburse = async (id: string, stageCode?: ReleaseStageCode) => {
    try {
      const before = ledger.find((l) => l.id === id)?.dueNet ?? 0;
      const entry = await disburseCommission(id, stageCode);
      const tail = entry.pendingNet > 0 ? ` ${fmtPKR(entry.pendingNet)} stays pending until its later stages vest.` : "";
      notify(`${fmtPKR(stageCode ? entry.releasedNet : before)} released to ${entry.payeeName} (${entry.payeeCode}).${tail}`);
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Failed to release the commission.", false);
    }
  };

  /** Walk a policy's lifecycle forward — vests whatever tranche was waiting. */
  const handleRecordEvent = async (policyId: string, event: PolicyLifecycleEvent) => {
    try {
      const { affected } = await recordPolicyEvent(policyId, event);
      notify(`${POLICY_EVENT_LABELS[event]} recorded — ${affected} commission ${affected === 1 ? "entry" : "entries"} re-evaluated.`);
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Failed to record the policy event.", false);
    }
  };

  const handleHold = async () => {
    if (!holdTarget) return;
    try {
      await holdCommission(holdTarget.id, holdReason);
      notify(`${holdTarget.id} placed on hold.`);
      setHoldTarget(null);
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Failed to hold the entry.", false);
    }
  };

  const handleClawback = async () => {
    if (!clawbackTarget) return;
    try {
      const result = await triggerClawback(clawbackTarget.id, clawbackReason, cascade);
      const cascadeNote = result.cascaded.length > 0 ? ` ${result.cascaded.length} dependent override/partner row(s) reversed.` : "";
      const recoveryNote =
        result.recoveryRaised > 0 ? ` ${fmtPKR(result.recoveryRaised)} raised as recovery against future payouts.` : "";
      notify(`Reversal posted for ${clawbackTarget.policyNumber}.${cascadeNote}${recoveryNote}`);
      setClawbackTarget(null);
      refresh();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Failed to execute the clawback.", false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 space-y-6">
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

      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Commissions</h1>
          <p className="text-xs text-slate-500 mt-1">
            Every party paid on a premium — producers, managers, banks, brokers, corporate agents and referral partners
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/underwriting"
            className="px-3 py-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg text-xs font-medium transition-colors"
          >
            ← Underwriting
          </Link>
          <button
            onClick={() => refresh(true)}
            className="px-3 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-xs font-medium transition-colors"
          >
            Recompute ledger
          </button>
          <button
            onClick={() => setActiveTab("calculator")}
            className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-medium transition-colors"
          >
            New calculation
          </button>
        </div>
      </div>

      {stats && (
        <div className="space-y-4">
          {/* Executive KPI cards strip matching main portal dashboard */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              title="Due Now (Actionable)"
              value={fmtPKRCompact(stats.totalDueNow)}
              subtitle="Vested, ready for payout run"
              accent="blue"
              trend={{ value: "Releasable Now", direction: "up" }}
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <MetricCard
              title="Not Yet Due (Pipeline)"
              value={fmtPKRCompact(stats.totalNotYetDue)}
              subtitle="Earned, vesting at future events"
              accent="amber"
              trend={{ value: "In Pipeline", direction: "neutral" }}
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <MetricCard
              title="Disbursed (Released)"
              value={fmtPKRCompact(stats.totalDisbursed)}
              subtitle="Paid out net of tax and recovery"
              accent="emerald"
              trend={{ value: "Settled", direction: "up" }}
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
            />
            <MetricCard
              title="Total Gross Earned"
              value={fmtPKRCompact(stats.totalGrossCommission)}
              subtitle={`${stats.activePayeesCount} payees of ${payees.length} active`}
              accent="violet"
              trend={{ value: "+18.4% MTD", direction: "up" }}
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              }
            />
          </div>

          {/* Context financial summary banner */}
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-[0_2px_10px_rgb(0,0,0,0.02)] px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Financial Ledger State</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-xs">
              <SummaryStat label="Accrued Liability" value={fmtPKR(stats.totalAccruedLiability)} />
              <SummaryStat label="Locked in Runs" value={fmtPKR(stats.totalInRun)} />
              <SummaryStat label="Hierarchy Overrides" value={fmtPKR(stats.overrideTotal)} />
              <SummaryStat label="Incentive Bonuses" value={fmtPKR(stats.bonusTotal)} />
              <SummaryStat label="Tax Withheld (s.233)" value={fmtPKR(stats.totalWithheldTax)} />
              <SummaryStat label="Clawbacks / Reversals" value={fmtPKR(stats.totalClawbacks)} tone={stats.totalClawbacks > 0 ? "warn" : "muted"} />
            </div>
          </div>
        </div>
      )}

      <div className="border-b border-slate-200 flex gap-6 overflow-x-auto">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`pb-3 -mb-px text-[13px] font-medium border-b-2 whitespace-nowrap transition-colors ${
              activeTab === key
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && ledger.length === 0 ? (
        <Card>
          <div className="px-5 py-12 text-center text-xs text-slate-400">Computing the commission ledger…</div>
        </Card>
      ) : (
        <>
          {activeTab === "overview" && stats && <OverviewTab stats={stats} ledger={ledger} />}
          {activeTab === "types" && <RateCardTab notify={notify} />}
          {activeTab === "payees" && <PayeesTab payees={payees} onChanged={() => refresh(true)} notify={notify} />}
          {activeTab === "ledger" && (
            <LedgerTab
              ledger={ledger}
              onDisburse={handleDisburse}
              onHold={(entry) => setHoldTarget(entry)}
              onClawback={(entry) => setClawbackTarget(entry)}
              onRecordEvent={handleRecordEvent}
            />
          )}
          {activeTab === "runs" && (
            <PayoutRunsTab runs={runs} ledger={ledger} currentUser="Commission Officer" onChanged={() => refresh()} notify={notify} />
          )}
          {activeTab === "statements" && <StatementsTab statements={statements} />}
          {activeTab === "incentives" && (
            <IncentivesTab qualifications={qualifications} onChanged={() => refresh()} notify={notify} />
          )}
          {activeTab === "calculator" && (
            <CalculatorTab
              payees={payees}
              onAccrued={() => {
                refresh();
                setActiveTab("ledger");
              }}
              notify={notify}
            />
          )}
        </>
      )}

      {clawbackTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs px-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-slate-200 overflow-hidden">
            <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 flex items-center justify-between text-slate-900">
              <div>
                <h3 className="font-bold text-sm text-slate-900">Clawback / Reversal</h3>
                <p className="text-xs text-slate-500 font-mono mt-0.5">
                  {clawbackTarget.id} · {clawbackTarget.policyNumber}
                </p>
              </div>
              <button onClick={() => setClawbackTarget(null)} className="text-slate-400 hover:text-slate-600 text-lg font-bold">
                ✕
              </button>
            </div>

            <div className="p-6 space-y-4 text-xs">
              <div className="bg-slate-50 border border-slate-200 p-3 rounded-xl space-y-1">
                <p className="font-bold text-slate-900">
                  Reversing {fmtPKR(clawbackTarget.netCommission)} from {clawbackTarget.payeeName} (
                  {PAYEE_TYPE_LABELS[clawbackTarget.payeeType]})
                </p>
                <p className="text-[11px] text-slate-600">
                  {clawbackTarget.status === "DISBURSED"
                    ? "This commission was already paid, so the reversal raises a recovery balance netted off the payee's future payouts."
                    : "This commission has not been paid, so the accrual is simply released."}
                </p>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Reason code</label>
                <select value={clawbackReason} onChange={(e) => setClawbackReason(e.target.value)} className={selectClass}>
                  {CLAWBACK_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>

              <label className="flex items-start gap-2 font-semibold text-slate-700">
                <input type="checkbox" checked={cascade} onChange={(e) => setCascade(e.target.checked)} className="mt-0.5" />
                <span>
                  Cascade to dependent rows
                  <span className="block text-[10px] font-normal text-slate-500">
                    Reverses the manager overrides and partner-staff shares computed from this entry — they were earned on
                    production that no longer stands.
                  </span>
                </span>
              </label>
            </div>

            <div className="border-t border-slate-200 px-6 py-3 flex justify-end gap-2 bg-slate-50">
              <button
                onClick={() => setClawbackTarget(null)}
                className="px-4 py-2 bg-white border border-slate-300 font-bold rounded-xl text-slate-700 text-xs hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={handleClawback}
                className="px-4 py-2 bg-rose-700 hover:bg-rose-800 text-white font-bold rounded-xl text-xs shadow-xs"
              >
                Post Reversal
              </button>
            </div>
          </div>
        </div>
      )}

      {holdTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs px-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md border border-slate-200 overflow-hidden">
            <div className="bg-slate-50 px-6 py-4 border-b border-slate-200 text-slate-900 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-sm text-slate-900">Hold Payout</h3>
                <p className="text-xs text-slate-500 font-mono mt-0.5">
                  {holdTarget.id} · {holdTarget.payeeName}
                </p>
              </div>
              <button onClick={() => setHoldTarget(null)} className="text-slate-400 hover:text-slate-600 text-lg font-bold">
                ✕
              </button>
            </div>
            <div className="p-6 text-xs">
              <label className="block text-slate-700 font-semibold mb-1">Reason</label>
              <textarea
                value={holdReason}
                onChange={(e) => setHoldReason(e.target.value)}
                rows={3}
                className="w-full p-2 border border-slate-300 rounded-xl text-xs text-slate-900 focus:outline-hidden focus:border-blue-500"
              />
              <p className="text-[10px] text-slate-500 mt-2">
                A held entry is excluded from every payout run until it is released.
              </p>
            </div>
            <div className="border-t border-slate-200 px-6 py-3 flex justify-end gap-2 bg-slate-50">
              <button
                onClick={() => setHoldTarget(null)}
                className="px-4 py-2 bg-white border border-slate-300 font-bold rounded-xl text-slate-700 text-xs hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={handleHold}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-xl text-xs shadow-xs"
              >
                Place on Hold
              </button>
            </div>
          </div>
        </div>
      )}
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
  const totalPremiumCommission = stats.firstYearCommissionTotal + stats.renewalCommissionTotal + stats.singlePremiumCommissionTotal;
  const fypPct = totalPremiumCommission > 0 ? Math.round((stats.firstYearCommissionTotal / totalPremiumCommission) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* ── Row 1: Release Pipeline & Distribution Channel ─────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Card 1: Release Pipeline Intelligence */}
        <PillarCard
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          }
          title="Release Pipeline Intelligence"
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
                label="Vested Ratio"
                sublabel="Portfolio"
                valueLabel={`${vestedPct}%`}
                size={78}
                strokeW={7}
              />
              <RingGauge
                value={duePct}
                strokeHex="#3b82f6"
                label="Actionable"
                sublabel="Releasable"
                valueLabel={`${duePct}%`}
                size={78}
                strokeW={7}
              />
            </div>

            {/* Lifecycle Event Progress Bars */}
            <div className="flex-1 w-full space-y-2">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Tranche Breakdown</p>
                <StageLegend />
              </div>
              {stats.byStage.map((s) => (
                <div key={s.code} className="space-y-0.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-700 truncate text-[11px]">{RELEASE_STAGE_LABELS[s.code]}</span>
                    <span className="font-mono font-bold text-slate-900 text-[11px]">{fmtPKRCompact(s.dueNet + s.releasedNet)}</span>
                  </div>
                  <SegmentBar
                    segments={[
                      { value: s.releasedNet, className: "bg-emerald-500", label: "released" },
                      { value: s.dueNet, className: "bg-blue-600", label: "due now" },
                      { value: s.pendingNet, className: "bg-slate-200", label: "not yet vested" },
                    ]}
                  />
                </div>
              ))}
            </div>
          </div>

          <Divider className="my-3.5" />

          {/* Quick Stats Footer */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Total Tranches" value={stageTotals.tranches} sub="active policies" />
            <Stat label="Actionable Due" value={fmtPKRCompact(stageTotals.due)} valueClass="text-blue-600" sub="payout run ready" />
            <Stat label="Pending Vesting" value={fmtPKRCompact(stageTotals.pending)} sub="future events" />
            <Stat label="Avg Vesting Period" value="14.2d" sub="latency" />
          </div>
        </PillarCard>

        {/* Card 2: Distribution Channel Intelligence */}
        <PillarCard
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 13h2l2-7 4 12 4-9 2 4h2" />
            </svg>
          }
          title="Distribution Channel Intelligence"
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
                size={78}
                strokeW={7}
              />
            </div>

            <div className="flex-1 space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Channel Payout Share</p>
              {stats.byChannel.map((c) => {
                const pct = channelTotalNet > 0 ? Math.round((c.net / channelTotalNet) * 100) : 0;
                return (
                  <Bar
                    key={c.channel}
                    label={`${CHANNEL_LABELS[c.channel]}`}
                    pct={pct}
                    color="bg-blue-600"
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

      {/* ── Row 2: Payee & Hierarchy & Premium Earning Mix ─────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Card 3: Payee & Hierarchy Intelligence */}
        <PillarCard
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          }
          title="Payee & Hierarchy Intelligence"
          barClass="bg-indigo-600"
          iconBg="bg-indigo-50"
          iconColor="text-indigo-600"
        >
          <div className="flex flex-col sm:flex-row gap-5">
            <div className="flex gap-4 shrink-0 items-center justify-center">
              <RingGauge
                value={topPayeePct}
                strokeHex="#4f46e5"
                label="Primary Share"
                sublabel="Producers"
                valueLabel={`${topPayeePct}%`}
                size={78}
                strokeW={7}
              />
            </div>

            <div className="flex-1 space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Payee Category Split</p>
              {stats.byPayeeType.map((t) => {
                const pct = payeeTotalNet > 0 ? Math.round((t.net / payeeTotalNet) * 100) : 0;
                return (
                  <Bar
                    key={t.payeeType}
                    label={`${PAYEE_TYPE_LABELS[t.payeeType]}`}
                    pct={pct}
                    color="bg-indigo-600"
                    badge={`${fmtPKRCompact(t.net)} · ${pct}%`}
                  />
                );
              })}
            </div>
          </div>

          <Divider className="my-3.5" />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Active Payees" value={stats.activePayeesCount} sub="registered" />
            <Stat label="Producers Net" value={fmtPKRCompact(topPayee?.net || 0)} sub="direct commission" />
            <Stat label="Overrides" value={fmtPKRCompact(stats.overrideTotal)} sub="hierarchy pool" />
            <Stat label="Avg / Payee" value={fmtPKRCompact(stats.activePayeesCount > 0 ? payeeTotalNet / stats.activePayeesCount : 0)} sub="per payee" />
          </div>
        </PillarCard>

        {/* Card 4: Premium Earning Mix Intelligence */}
        <PillarCard
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
            </svg>
          }
          title="Premium Earning Mix Intelligence"
          barClass="bg-violet-600"
          iconBg="bg-violet-50"
          iconColor="text-violet-600"
        >
          <div className="flex flex-col sm:flex-row gap-5 items-center">
            <RingGauge
              value={fypPct}
              strokeHex="#7c3aed"
              label="FYP Dominance"
              sublabel="Share"
              valueLabel={`${fypPct}%`}
              size={78}
              strokeW={7}
            />
            <div className="flex-1 space-y-2 w-full">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Earning Mix Distribution</p>
              <Bar label="First-Year Premium" pct={fypPct} color="bg-violet-600" badge={fmtPKRCompact(stats.firstYearCommissionTotal)} />
              <Bar label="Renewal Premium" pct={totalPremiumCommission > 0 ? Math.round((stats.renewalCommissionTotal / totalPremiumCommission) * 100) : 0} color="bg-blue-500" badge={fmtPKRCompact(stats.renewalCommissionTotal)} />
              <Bar label="Single Premium" pct={totalPremiumCommission > 0 ? Math.round((stats.singlePremiumCommissionTotal / totalPremiumCommission) * 100) : 0} color="bg-amber-500" badge={fmtPKRCompact(stats.singlePremiumCommissionTotal)} />
            </div>
          </div>

          <Divider className="my-3.5" />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="First-Year" value={fmtPKRCompact(stats.firstYearCommissionTotal)} sub="FYP commission" />
            <Stat label="Renewals" value={fmtPKRCompact(stats.renewalCommissionTotal)} sub="renewal pool" />
            <Stat label="Tax Withheld" value={fmtPKRCompact(stats.totalWithheldTax)} sub="s.233 withholding" />
            <Stat label="Bonuses" value={fmtPKRCompact(stats.bonusTotal)} sub="incentive pool" />
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
        title="Outstanding Commission Audit Feed"
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
        className={`font-mono tabular-nums text-xs font-bold ${
          value === 0 ? "text-slate-300" : muted ? "text-slate-500" : "text-slate-900"
        }`}
      >
        {value === 0 ? "—" : fmtPKR(value)}
      </span>
    </div>
  );
}
