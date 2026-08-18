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
import LedgerTab from "../../components/commissions/LedgerTab";
import PayoutRunsTab from "../../components/commissions/PayoutRunsTab";
import StatementsTab from "../../components/commissions/StatementsTab";
import { MetricCard } from "@/components/MetricCard";
import { PillarCard, RingGauge, Stat, Divider } from "@/components/dashboard/shared";
import {
  Card,
  fmtPKR,
  fmtPKRCompact,
  selectClass,
} from "../../components/commissions/shared";

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

type OpsTab = "overview" | "ledger" | "runs" | "statements";

const OPS_TABS: [OpsTab, string][] = [
  ["overview", "Overview"],
  ["ledger", "Commission Ledger"],
  ["runs", "Payout Runs"],
  ["statements", "Statements"],
];

const CLAWBACK_REASONS = [
  "Policy cancelled within the free-look window",
  "Policy lapsed due to non-payment of renewal premium",
  "Underwriting rejection / material misrepresentation",
  "Proposer bank chargeback / cheque returned",
  "Commission overpaid — rate applied in error",
  "Producer licence found invalid at the date of sale",
];

export default function CommissionOpsPage() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab") as OpsTab | null;
  const [activeTab, setActiveTab] = useState<OpsTab>(
    tabParam && OPS_TABS.some(([k]) => k === tabParam) ? tabParam : "ledger"
  );

  useEffect(() => {
    if (tabParam && OPS_TABS.some(([k]) => k === tabParam)) {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  const [ledger, setLedger] = useState<CommissionLedgerEntry[]>([]);
  const [payees, setPayees] = useState<CommissionPayee[]>([]);
  const [runs, setRuns] = useState<PayoutRun[]>([]);
  const [statements, setStatements] = useState<PayeeStatement[]>([]);
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
    } catch (err) {
      console.error(err);
      notify("Could not load the commission operational ledger.", false);
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
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Commission Ops</h1>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
              Operations &amp; Execution
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Execute disburse &amp; hold workflows, track policy stack ledgers, trigger payout runs, and issue payee stubs
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/commissions"
            className="px-3.5 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-bold transition-all shadow-xs flex items-center gap-1.5"
          >
            <span>← Go to Commission Admin</span>
          </Link>
          <button
            onClick={() => refresh(true)}
            className="px-3 py-2 bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-lg text-xs font-medium transition-colors"
          >
            Recompute Ledger
          </button>
        </div>
      </div>

      {stats && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              title="Ready to Pay (Actionable)"
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
              title="Upcoming Pipeline"
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
              title="Total Paid Out"
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
              title="Total Pending Net"
              value={fmtPKRCompact(stats.totalAccruedLiability)}
              subtitle={`Across ${ledger.length} ledger entries`}
              accent="violet"
              trend={{ value: "Active Ledger", direction: "up" }}
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              }
            />
          </div>

          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-[0_2px_10px_rgb(0,0,0,0.02)] px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Commission Operations Totals</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-xs">
              <SummaryStat label="Ready to Pay" value={fmtPKR(stats.totalDueNow)} tone="default" />
              <SummaryStat label="Processing Payments" value={fmtPKR(stats.totalInRun)} />
              <SummaryStat label="Settled Payouts" value={fmtPKR(stats.totalDisbursed)} />
              <SummaryStat label="Tax Withheld" value={fmtPKR(stats.totalWithheldTax)} />
              <SummaryStat label="Policy Reversals" value={fmtPKR(stats.totalClawbacks)} tone={stats.totalClawbacks > 0 ? "warn" : "muted"} />
            </div>
          </div>
        </div>
      )}

      <div className="border-b border-slate-200 flex gap-6 overflow-x-auto">
        {OPS_TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`pb-3 -mb-px text-[13px] font-medium border-b-2 whitespace-nowrap transition-colors ${
              activeTab === key
                ? "border-blue-600 text-blue-600 font-bold"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && ledger.length === 0 ? (
        <Card>
          <div className="px-5 py-12 text-center text-xs text-slate-400">Loading commission operational ledger…</div>
        </Card>
      ) : (
        <>
          {activeTab === "overview" && stats && <OpsOverviewTab stats={stats} ledger={ledger} />}
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

function OpsOverviewTab({ stats, ledger }: { stats: CommissionSummaryStats; ledger: CommissionLedgerEntry[] }) {
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

  const channelTotalNet = stats.byChannel.reduce((sum, item) => sum + item.net, 0);
  const topChannel = stats.byChannel.length > 0 ? [...stats.byChannel].sort((a, b) => b.net - a.net)[0] : null;
  const topChannelPct = topChannel && channelTotalNet > 0 ? Math.round((topChannel.net / channelTotalNet) * 100) : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <PillarCard
        icon={
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        }
        title="Release Pipeline & Operations"
        barClass="bg-emerald-600"
        iconBg="bg-emerald-50"
        iconColor="text-emerald-600"
      >
        <div className="flex flex-col sm:flex-row gap-5 items-center">
          <div className="flex gap-4 shrink-0 items-center justify-center">
            <RingGauge
              value={vestedPct}
              strokeHex="#059669"
              label="Settled Ratio"
              sublabel="Ratio"
              valueLabel={`${vestedPct}%`}
              size={80}
              strokeW={8}
            />
            <RingGauge
              value={duePct}
              strokeHex="#2563eb"
              label="Ready to Pay"
              sublabel="Due"
              valueLabel={`${duePct}%`}
              size={80}
              strokeW={8}
            />
          </div>
          <div className="flex-1 w-full space-y-2 text-xs">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Operational Milestone Metrics</p>
            <div className="space-y-1.5">
              <div className="flex justify-between font-semibold text-slate-700">
                <span>Vested &amp; Settled Payouts</span>
                <span className="font-mono text-emerald-700 font-bold">{fmtPKRCompact(stageTotals.released)}</span>
              </div>
              <div className="flex justify-between font-semibold text-slate-700">
                <span>Ready to Release Now</span>
                <span className="font-mono text-blue-700 font-bold">{fmtPKRCompact(stageTotals.due)}</span>
              </div>
              <div className="flex justify-between font-semibold text-slate-700">
                <span>Upcoming Milestones</span>
                <span className="font-mono text-slate-500 font-bold">{fmtPKRCompact(stageTotals.pending)}</span>
              </div>
            </div>
          </div>
        </div>
        <Divider className="my-3.5" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Total Ledger Rows" value={ledger.length} sub="entries" />
          <Stat label="Actionable Due" value={fmtPKRCompact(stageTotals.due)} valueClass="text-blue-600" sub="ready now" />
          <Stat label="Settled Disbursed" value={fmtPKRCompact(stageTotals.released)} valueClass="text-emerald-600" sub="completed" />
          <Stat label="Avg Run Cycle" value="3.5d" sub="processing speed" />
        </div>
      </PillarCard>

      <PillarCard
        icon={
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 13h2l2-7 4 12 4-9 2 4h2" />
          </svg>
        }
        title="Channel Execution Breakdown"
        barClass="bg-emerald-600"
        iconBg="bg-emerald-50"
        iconColor="text-emerald-600"
      >
        <div className="flex flex-col sm:flex-row gap-5">
          <div className="flex gap-4 shrink-0 items-center justify-center">
            <RingGauge
              value={topChannelPct}
              strokeHex="#059669"
              label="Top Channel"
              sublabel="Share"
              valueLabel={`${topChannelPct}%`}
              size={80}
              strokeW={8}
            />
          </div>

          <div className="flex-1 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Execution Share by Channel</p>
            {stats.byChannel.map((c) => {
              const pct = channelTotalNet > 0 ? Math.round((c.net / channelTotalNet) * 100) : 0;
              return (
                <div key={c.channel} className="flex justify-between items-center text-xs py-1 border-b border-slate-100">
                  <span className="font-semibold text-slate-700">{CHANNEL_LABELS[c.channel]}</span>
                  <span className="font-mono font-bold text-slate-900">{fmtPKRCompact(c.net)} ({pct}%)</span>
                </div>
              );
            })}
          </div>
        </div>

        <Divider className="my-3.5" />

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Top Channel" value={topChannel ? CHANNEL_LABELS[topChannel.channel] : "—"} sub={`${topChannelPct}% share`} />
          <Stat label="Active Channels" value={stats.byChannel.length} sub="sources" />
          <Stat label="Total Operational Payout" value={fmtPKRCompact(channelTotalNet)} sub="all channels" />
          <Stat label="Avg / Channel" value={fmtPKRCompact(stats.byChannel.length > 0 ? channelTotalNet / stats.byChannel.length : 0)} sub="average" />
        </div>
      </PillarCard>
    </div>
  );
}
