"use client";

import React, { useState } from "react";
import {
  CHANNEL_LABELS,
  CommissionEntryKind,
  CommissionLedgerEntry,
  CommissionStatus,
  DistributionChannel,
  PAYEE_TYPE_LABELS,
  POLICY_EVENT_LABELS,
  PayeeType,
  PolicyEventState,
  PolicyLifecycleEvent,
  ReleaseStageCode,
  groupLedgerByPolicy,
} from "../../app/services/commissions";
import {
  DateRangeFilter,
  filterLedgerByDate,
  resolvePreset,
  type DatePreset,
  type DateRange,
} from "./DateRangeFilter";
import {
  BasisLabel,
  Card,
  ChannelBadge,
  DueBreakdown,
  EmptyState,
  EntryKindBadge,
  GatingList,
  PayeeTypeBadge,
  StageTimeline,
  StatusPill,
  fmtPKR,
  fmtPKRSigned,
  fmtPct,
} from "./shared";

/**
 * Clean interactive Policy Lifecycle Bar to record milestone events.
 */
function PolicyEventBar({
  events,
  onRecord,
}: {
  events: PolicyEventState;
  onRecord: (event: PolicyLifecycleEvent) => void;
}) {
  const state: [PolicyLifecycleEvent, string][] = [
    ["LEAD_GENERATED", events.leadGeneratedAt ?? ""],
    ["ISSUED", events.issuedAt ?? ""],
    ["PREMIUM_COLLECTED", events.premiumCollectedAt ?? ""],
    ["RENEWAL_COLLECTED", events.renewalCollectedAt ?? ""],
    ["PERSISTENCY_13M", events.persistency13mAt ?? ""],
  ];

  return (
    <div className="px-4 py-3 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Policy Events:</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {state.map(([event, at]) => (
            <button
              key={event}
              onClick={() => onRecord(event)}
              title={at ? `Recorded on ${at} — click to update` : `Record: ${POLICY_EVENT_LABELS[event]}`}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold border transition-all ${at
                ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                : "bg-white text-slate-500 border-slate-200 border-dashed hover:text-slate-800 hover:border-slate-300"
                }`}
            >
              <span className={at ? "text-emerald-600 mr-1" : "text-slate-300 mr-1"}>{at ? "✓" : "○"}</span>
              {POLICY_EVENT_LABELS[event]}
            </button>
          ))}
        </div>
      </div>
      <span className="text-[10px] text-slate-400 italic">Click an event to trigger payout vesting</span>
    </div>
  );
}

export type LedgerView = "stack" | "finance" | "general";

const ENTRY_KINDS: CommissionEntryKind[] = ["COMMISSION", "OVERRIDE", "PARTNER_FEE", "REFERRAL_FEE", "BONUS", "CLAWBACK"];
const STATUSES: CommissionStatus[] = ["ACCRUED", "PAYABLE", "IN_RUN", "DISBURSED", "HELD", "CLAWED_BACK"];

/**
 * Modern, Executive-Grade Commission Ledger
 */
export default function LedgerTab({
  ledger,
  onDisburse,
  onHold,
  onClawback,
  onRecordEvent,
  datePreset,
  dateRange,
  onDateChange,
}: {
  ledger: CommissionLedgerEntry[];
  onDisburse: (id: string, stageCode?: ReleaseStageCode) => void;
  onHold: (entry: CommissionLedgerEntry) => void;
  onClawback: (entry: CommissionLedgerEntry) => void;
  onRecordEvent?: (policyId: string, event: PolicyLifecycleEvent) => void;
  datePreset?: DatePreset;
  dateRange?: DateRange;
  onDateChange?: (preset: DatePreset, range: DateRange) => void;
}) {
  const [internalPreset, setInternalPreset] = useState<DatePreset>("all");
  const [internalRange, setInternalRange] = useState<DateRange>(() => resolvePreset("all"));

  const activePreset = datePreset ?? internalPreset;
  const activeRange = dateRange ?? internalRange;

  const handleDateChange = (p: DatePreset, r: DateRange) => {
    if (onDateChange) onDateChange(p, r);
    else {
      setInternalPreset(p);
      setInternalRange(r);
    }
  };

  const [view, setView] = useState<LedgerView>("stack");
  const [channel, setChannel] = useState<DistributionChannel | "all">("all");
  const [payeeType, setPayeeType] = useState<PayeeType | "all">("all");
  const [kind, setKind] = useState<CommissionEntryKind | "all">("all");
  const [status, setStatus] = useState<CommissionStatus | "all">("all");
  const [segment, setSegment] = useState<string>("all");
  const [premiumType, setPremiumType] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const dateFilteredLedger = filterLedgerByDate(ledger, activeRange);

  const filtered = dateFilteredLedger.filter((l) => {
    if (channel !== "all" && l.channel !== channel) return false;
    if (payeeType !== "all" && l.payeeType !== payeeType) return false;
    if (kind !== "all" && l.entryKind !== kind) return false;
    if (status !== "all" && l.status !== status) return false;
    if (segment !== "all" && l.segment !== segment) return false;
    if (premiumType !== "all" && l.premiumType !== premiumType) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        l.payeeName.toLowerCase().includes(q) ||
        l.payeeCode.toLowerCase().includes(q) ||
        l.customerName.toLowerCase().includes(q) ||
        l.policyNumber.toLowerCase().includes(q) ||
        l.leadId.toLowerCase().includes(q) ||
        l.id.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const groups = groupLedgerByPolicy(filtered);

  // Summary Metrics calculation
  const totalGross = filtered.reduce((acc, item) => acc + item.grossCommission, 0);
  const totalNet = filtered.reduce((acc, item) => acc + item.netCommission, 0);
  const totalDue = filtered.reduce((acc, item) => acc + item.dueNet, 0);
  const totalPaid = filtered.reduce((acc, item) => acc + item.releasedNet, 0);

  const [openPolicyIds, setOpenPolicyIds] = useState<Set<string>>(() => {
    // Default open the first policy card for immediate context
    return groups.length > 0 ? new Set([groups[0].policyId]) : new Set();
  });

  const togglePolicy = (policyId: string) => {
    setOpenPolicyIds((prev) => {
      const next = new Set(prev);
      if (next.has(policyId)) {
        next.delete(policyId);
      } else {
        next.add(policyId);
      }
      return next;
    });
  };

  const toggleAllPolicies = () => {
    if (openPolicyIds.size === groups.length) {
      setOpenPolicyIds(new Set());
    } else {
      setOpenPolicyIds(new Set(groups.map((g) => g.policyId)));
    }
  };

  return (
    <div className="space-y-5">


      {/* Control Bar: View Switcher, Search, and Filters */}
      <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* View Segmented Toggle */}
          <div className="flex p-0.5 rounded-xl bg-slate-100 border border-slate-200/60">
            {(
              [
                ["stack", "Policy Wise"],
                ["finance", "All Transactions"],
                ["general", "By Payee & Channel"],
              ] as [LedgerView, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={`px-3.5 py-1.5 text-xs font-bold rounded-lg transition-all ${view === key
                  ? "bg-blue-600 text-white shadow-xs"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-200/50"
                  }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 flex-1 max-w-xl">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search payee, customer, policy ID, or lead ID..."
              className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-1.5 text-xs text-slate-800 focus:outline-hidden focus:border-blue-500"
            />
            {view === "stack" && (
              <button
                onClick={toggleAllPolicies}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-lg transition-colors whitespace-nowrap"
              >
                {openPolicyIds.size === groups.length ? "Collapse All" : "Expand All"}
              </button>
            )}
          </div>
        </div>

        {/* Filter Dropdowns */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100 text-xs">
          <DateRangeFilter preset={activePreset} range={activeRange} onPresetChange={handleDateChange} size="sm" align="left" />

          <select value={channel} onChange={(e) => setChannel(e.target.value as DistributionChannel | "all")} className={filterClass}>
            <option value="all">All Channels</option>
            {(Object.keys(CHANNEL_LABELS) as DistributionChannel[]).map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>

          <select value={payeeType} onChange={(e) => setPayeeType(e.target.value as PayeeType | "all")} className={filterClass}>
            <option value="all">All Roles</option>
            {(Object.keys(PAYEE_TYPE_LABELS) as PayeeType[]).map((t) => (
              <option key={t} value={t}>
                {PAYEE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>

          <select value={kind} onChange={(e) => setKind(e.target.value as CommissionEntryKind | "all")} className={filterClass}>
            <option value="all">All Payout Types</option>
            {ENTRY_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace("_", " ")}
              </option>
            ))}
          </select>

          <select value={status} onChange={(e) => setStatus(e.target.value as CommissionStatus | "all")} className={filterClass}>
            <option value="all">All Statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>

          <select value={segment} onChange={(e) => setSegment(e.target.value)} className={filterClass}>
            <option value="all">All Segments</option>
            <option value="individual">Individual Life</option>
            <option value="group">Group Corporate</option>
            <option value="family">Family Takaful</option>
          </select>

          <select value={premiumType} onChange={(e) => setPremiumType(e.target.value)} className={filterClass}>
            <option value="all">All Payment Types</option>
            <option value="FIRST_YEAR">First-Year Payment (FYP)</option>
            <option value="RENEWAL">Renewal Payment (RYP)</option>
            <option value="SINGLE_PREMIUM">Single Payment (SP)</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState message="No commission entries match these filters." />
        </Card>
      ) : view === "stack" ? (
        <Card className="overflow-hidden border border-slate-200 shadow-2xs">
          {/* Master Table Header Row for Policy Stack */}
          <div className="hidden sm:grid grid-cols-12 gap-3 px-5 py-3 bg-slate-100/70 border-b border-slate-200 text-slate-600 font-bold uppercase tracking-wider text-[10px]">
            <div className="col-span-2">Customer</div>
            <div className="col-span-2">Policy ID</div>
            <div className="col-span-1">Channel</div>
            <div className="col-span-1">Segment</div>
            <div className="col-span-1 text-right">Premium</div>
            <div className="col-span-1 text-right">Rate %</div>
            <div className="col-span-2 text-right">Payout Status</div>
            <div className="col-span-1 text-right">Total Comm.</div>
            <div className="col-span-1 text-center">Action</div>
          </div>

          <div className="divide-y divide-slate-100 bg-white">
          {groups.map((group) => {
            const isOpen = openPolicyIds.has(group.policyId);
            return (
              <div key={group.policyId} className="transition-all">
                {/* Clean Master Row Grid */}
                <div
                  onClick={() => togglePolicy(group.policyId)}
                  className={`px-5 py-3.5 cursor-pointer transition-all border-l-4 ${isOpen
                    ? "bg-slate-50 border-b border-slate-200 border-l-blue-600"
                    : "bg-white hover:bg-slate-50 border-l-transparent"
                    }`}
                >
                  <div className="grid grid-cols-12 gap-3 items-center text-xs">
                    {/* Col 1: Customer Name (2 cols) */}
                    <div className="col-span-12 sm:col-span-2 min-w-0">
                      <p className="font-extrabold text-sm text-slate-900 truncate">{group.customerName}</p>
                    </div>

                    {/* Col 2: Policy ID Badge (2 cols) */}
                    <div className="col-span-6 sm:col-span-2 min-w-0">
                      <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50 px-2 py-1 rounded-md border border-blue-200 inline-block">
                        {group.policyNumber}
                      </span>
                    </div>

                    {/* Col 3: Source Channel (1 col) */}
                    <div className="col-span-6 sm:col-span-1 min-w-0">
                      <ChannelBadge channel={group.channel} />
                    </div>

                    {/* Col 4: Segment (1 col) */}
                    <div className="col-span-6 sm:col-span-1 min-w-0">
                      <span className="text-[10px] capitalize px-2 py-0.5 rounded bg-white border border-slate-200 font-semibold text-slate-600 inline-block">
                        {group.segment}
                      </span>
                    </div>

                    {/* Col 5: Collected Premium (1 col) */}
                    <div className="col-span-6 sm:col-span-1 text-right min-w-0">
                      <p className="font-extrabold text-slate-900 tabular-nums">{fmtPKR(group.collectedPremium)}</p>
                    </div>

                    {/* Col 6: Effective Commission Rate (1 col) */}
                    <div className="col-span-6 sm:col-span-1 text-right min-w-0">
                      <p className={`font-bold tabular-nums ${group.ceilingBreached ? "text-rose-600" : "text-slate-800"}`}>
                        {fmtPct(group.effectiveRatePct)}
                      </p>
                      <p className="text-[9px] text-slate-400 font-medium">Cap: {fmtPct(group.ceilingPct)}</p>
                    </div>

                    {/* Col 7: Due Status Breakdown (2 cols) */}
                    <div className="col-span-6 sm:col-span-2 text-right min-w-0">
                      <DueBreakdown
                        dueNet={group.dueNet}
                        inRunNet={group.inRunNet}
                        pendingNet={group.pendingNet}
                        releasedNet={group.releasedNet}
                      />
                    </div>

                    {/* Col 8: Total Commission (1 col) */}
                    <div className="col-span-6 sm:col-span-1 text-right min-w-0">
                      <p className="font-extrabold text-sm text-slate-900 tabular-nums">{fmtPKR(group.totalGross)}</p>
                      <p className="text-[9px] text-slate-400 font-medium">{group.entries.length} payee {group.entries.length === 1 ? "row" : "rows"}</p>
                    </div>

                    {/* Col 9: Action Toggle Button (1 col) */}
                    <div className="col-span-12 sm:col-span-1 flex justify-center">
                      <button
                        type="button"
                        className={`px-3 py-1.5 rounded-lg border text-xs font-bold transition-all whitespace-nowrap flex items-center gap-1 ${isOpen
                          ? "bg-blue-100 text-blue-800 border-blue-200 shadow-none"
                          : "bg-white text-slate-700 border-slate-300 hover:bg-slate-100"
                          }`}
                      >
                        {isOpen ? "Hide ▲" : "View ▼"}
                      </button>
                    </div>
                  </div>
                </div>

                {isOpen && (
                  <div className="bg-slate-50 p-4 space-y-4 border-t border-slate-200 shadow-[inset_0_2px_4px_rgb(0,0,0,0.02)]">
                    {onRecordEvent && (
                      <PolicyEventBar
                        events={group.events}
                        onRecord={(event) => onRecordEvent(group.policyId, event)}
                      />
                    )}

                    {/* Clean Payee Table Layout with Split Columns */}
                    <div className="overflow-x-auto bg-white rounded-xl border border-slate-200 shadow-sm">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-100 text-slate-600 font-bold uppercase tracking-wider text-[10px] border-b border-slate-200">
                          <tr>
                            <th className="p-3 pl-5 text-center align-middle">PAYEE</th>
                            <th className="p-3 text-center align-middle">ROLE</th>
                            <th className="p-3 text-center align-middle">PAYOUT TYPE</th>
                            <th className="p-3 text-center align-middle">CALCULATED FROM</th>
                            <th className="p-3 text-center align-middle">RATE</th>
                            <th className="p-3 text-center align-middle">GROSS AMOUNT</th>
                            <th className="p-3 text-center align-middle">TAXES</th>
                            <th className="p-3 text-center align-middle">NET PAYOUT</th>
                            <th className="p-3 text-center align-middle">TRANSACTION DATE</th>
                            <th className="p-3 text-center align-middle">STATUS</th>
                            <th className="p-3 text-center align-middle">ACTIONS</th>
                            <th className="p-3 pr-5 text-center align-middle">DETAILS</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {group.entries.map((entry) => (
                            <EntryRow
                              key={entry.id}
                              entry={entry}
                              expanded={expanded === entry.id}
                              onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                              onDisburse={onDisburse}
                              onHold={onHold}
                              onClawback={onClawback}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          </div>
        </Card>
      ) : view === "finance" ? (
        <Card className="overflow-hidden border border-slate-200 shadow-2xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100/70 text-slate-600 font-bold uppercase tracking-wider text-[10px] border-b border-slate-200">
                <tr>
                  <th className="p-3 text-center align-middle">COMM. ID</th>
                  <th className="p-3 text-center align-middle">LEAD ID</th>
                  <th className="p-3 text-center align-middle">PAYEE</th>
                  <th className="p-3 text-center align-middle">ROLE</th>
                  <th className="p-3 text-center align-middle">PAYMENT YEAR</th>
                  <th className="p-3 text-center align-middle">RATE</th>
                  <th className="p-3 text-center align-middle">COLLECTED PREMIUM</th>
                  <th className="p-3 text-center align-middle">GROSS AMOUNT</th>
                  <th className="p-3 text-center align-middle">TAXES</th>
                  <th className="p-3 text-center align-middle">NET PAYOUT</th>
                  <th className="p-3 text-center align-middle">DATE</th>
                  <th className="p-3 text-center align-middle">PAYOUT STATUS</th>
                  <th className="p-3 text-center align-middle">STATUS</th>
                  <th className="p-3 text-center align-middle">ACTIONS</th>
                  <th className="p-3 text-center align-middle">DETAILS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-800 bg-white">
                {filtered.map((item) => (
                  <FinancialLedgerRow
                    key={item.id}
                    entry={item}
                    expanded={expanded === item.id}
                    onToggle={() => setExpanded(expanded === item.id ? null : item.id)}
                    onDisburse={onDisburse}
                    onHold={onHold}
                    onClawback={onClawback}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Card className="overflow-hidden border border-slate-200 shadow-2xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100/70 text-slate-600 font-bold uppercase tracking-wider text-[10px] border-b border-slate-200">
                <tr>
                  <th className="p-3 text-center align-middle">COMM. ID</th>
                  <th className="p-3 text-center align-middle">LEAD ID</th>
                  <th className="p-3 text-center align-middle">PAYEE</th>
                  <th className="p-3 text-center align-middle">ROLE</th>
                  <th className="p-3 text-center align-middle">CUSTOMER</th>
                  <th className="p-3 text-center align-middle">POLICY ID</th>
                  <th className="p-3 text-center align-middle">CHANNEL</th>
                  <th className="p-3 text-center align-middle">SEGMENT</th>
                  <th className="p-3 text-center align-middle">CALCULATED FROM</th>
                  <th className="p-3 text-center align-middle">RATE</th>
                  <th className="p-3 text-center align-middle">GROSS AMOUNT</th>
                  <th className="p-3 text-center align-middle">DATE</th>
                  <th className="p-3 text-center align-middle">RULE &amp; SECP REF</th>
                  <th className="p-3 text-center align-middle">DETAILS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-800 bg-white">
                {filtered.map((item) => (
                  <PayeeSummaryRow
                    key={item.id}
                    entry={item}
                    expanded={expanded === item.id}
                    onToggle={() => setExpanded(expanded === item.id ? null : item.id)}
                    onDisburse={onDisburse}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

const filterClass =
  "bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400 focus:outline-hidden focus:border-blue-500";

function DeductionSummary({ entry }: { entry: CommissionLedgerEntry }) {
  const total = entry.deductions.reduce((s, d) => s + d.amount, 0) + entry.recoveryApplied;
  if (total === 0) return <span className="font-mono text-slate-300">—</span>;
  return (
    <div
      className="leading-tight cursor-help"
      title={[
        ...entry.deductions.map((d) => `${d.label} @ ${d.pct}%: ${fmtPKR(d.amount)}`),
        entry.recoveryApplied > 0 ? `Clawback/advance recovery: ${fmtPKR(entry.recoveryApplied)}` : "",
      ]
        .filter(Boolean)
        .join("\n")}
    >
      <p className="font-mono text-xs font-semibold text-rose-600">- {fmtPKR(Math.abs(total))}</p>
      <p className="text-[9px] text-slate-400">
        WHT {entry.whtPct}%{entry.deductions.length > 1 ? " + PST" : ""}
        {entry.recoveryApplied > 0 ? " + Rec." : ""}
      </p>
    </div>
  );
}

function EntryActions({
  entry,
  onDisburse,
  onHold,
  onClawback,
}: {
  entry: CommissionLedgerEntry;
  onDisburse: (id: string) => void;
  onHold: (entry: CommissionLedgerEntry) => void;
  onClawback: (entry: CommissionLedgerEntry) => void;
}) {
  if (entry.entryKind === "CLAWBACK") {
    return <span className="text-[10px] text-slate-400 whitespace-nowrap">Reversal of {entry.reversalOfEntryId}</span>;
  }
  if (entry.payeeType === "HOUSE") {
    return <span className="text-[10px] text-slate-400 whitespace-nowrap">Company Retained</span>;
  }

  const dueStages = entry.stages.filter((s) => s.status === "DUE").length;

  return (
    <div className="flex items-center justify-end gap-1 whitespace-nowrap">
      {dueStages > 0 && (
        <>
          <button
            onClick={() => onDisburse(entry.id)}
            title={`Release the ${dueStages} tranche(s) that have fallen due`}
            className="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold rounded transition-colors shadow-2xs whitespace-nowrap"
          >
            Release {dueStages > 1 ? `${dueStages} Due` : "Due"} →
          </button>
          <button
            onClick={() => onHold(entry)}
            className="px-1.5 py-0.5 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-[10px] font-bold rounded transition-colors whitespace-nowrap"
          >
            Hold
          </button>
        </>
      )}
      {entry.inRunNet > 0 && <span className="text-[10px] font-bold text-indigo-700 whitespace-nowrap">In Run</span>}
      {entry.status !== "CLAWED_BACK" && (
        <button
          onClick={() => onClawback(entry)}
          className="px-1.5 py-0.5 bg-white hover:bg-rose-50 hover:border-rose-200 border border-slate-200 text-rose-600 text-[10px] font-semibold rounded transition-colors whitespace-nowrap"
        >
          Clawback
        </button>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  expanded,
  onToggle,
  onDisburse,
  onHold,
  onClawback,
}: {
  entry: CommissionLedgerEntry;
  expanded: boolean;
  onToggle: () => void;
  onDisburse: (id: string, stageCode?: ReleaseStageCode) => void;
  onHold: (entry: CommissionLedgerEntry) => void;
  onClawback: (entry: CommissionLedgerEntry) => void;
}) {
  return (
    <>
      <tr className={`hover:bg-slate-50/80 transition-colors border-b border-slate-100 last:border-b-0 ${entry.parentEntryId ? "bg-slate-50/50" : ""}`}>
        {/* Col 1: PAYEE */}
        <td className={`p-3 ${entry.parentEntryId ? "pl-10" : "pl-5"}`}>
          <div className="flex items-start gap-2">
            {entry.parentEntryId && (
              <svg className="w-4 h-4 text-slate-300 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            )}
            <div>
              <p className={`font-bold ${entry.parentEntryId ? "text-slate-700" : "text-slate-900"}`}>{entry.payeeName}</p>
              <p className="text-[10px] font-mono text-slate-400">
                {entry.payeeCode} · <span className="text-slate-500">{entry.id}</span>
              </p>
            </div>
          </div>
        </td>

        {/* Col 2: ROLE */}
        <td className="p-3">
          <PayeeTypeBadge type={entry.payeeType} />
        </td>

        {/* Col 3: PAYOUT TYPE */}
        <td className="p-3">
          <EntryKindBadge kind={entry.entryKind} />
        </td>

        {/* Col 4: CALCULATED ON */}
        <td className="p-3">
          <BasisLabel basis={entry.basis} amount={entry.basisAmount} />
          {entry.splitPct !== 100 && (
            <p className="text-[10px] font-bold text-amber-700 mt-0.5">Split {fmtPct(entry.splitPct)}</p>
          )}
        </td>

        {/* Col 5: RATE */}
        <td className="p-3 text-right font-bold tabular-nums text-slate-800">{fmtPct(entry.ratePct)}</td>

        {/* Col 6: GROSS */}
        <td className="p-3 text-right font-bold tabular-nums text-slate-900">{fmtPKRSigned(entry.grossCommission)}</td>

        {/* Col 7: TAX & DEDUCTIONS */}
        <td className="p-3 text-right">
          <DeductionSummary entry={entry} />
        </td>

        {/* Col 8: NET PAYABLE */}
        <td className="p-3 text-right font-extrabold tabular-nums text-blue-700 text-xs">{fmtPKRSigned(entry.netCommission)}</td>

        {/* Col 8.5: DATE */}
        <td className="p-3 text-center text-[10px] font-mono text-slate-500 whitespace-nowrap">
          {entry.accruedAt.split("T")[0]}
        </td>

        {/* Col 9: STATUS */}
        <td className="p-3 text-center">
          <StatusPill status={entry.status} title={entry.gatingReason} />
        </td>

        {/* Col 10: ACTIONS */}
        <td className="p-3 text-right">
          <EntryActions entry={entry} onDisburse={onDisburse} onHold={onHold} onClawback={onClawback} />
        </td>

        {/* Col 11: DETAILS */}
        <td className="p-3 text-center">
          <button
            onClick={onToggle}
            title="Toggle full payout schedule and gating checks"
            className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-all whitespace-nowrap inline-flex items-center gap-1 ${expanded
              ? "bg-blue-50 text-blue-700 border-blue-300"
              : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50 hover:text-slate-800"
              }`}
          >
            <span className="text-[9px]">{expanded ? "▲" : "▼"}</span>
            <span>Details</span>
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-100/60 border-b-2 border-slate-200/80 shadow-[inset_0_4px_6px_-4px_rgb(0,0,0,0.05)]">
          <td colSpan={12} className="p-5 space-y-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200/90 shadow-sm space-y-3">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-600"></span>
                  <h4 className="font-extrabold text-xs text-slate-900 uppercase tracking-wider">
                    Payout Schedule ({entry.releaseScheduleId})
                  </h4>
                </div>
                <span className="text-[10px] text-slate-500 font-mono bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
                  SECP Rule Ref: {entry.secpRef}
                </span>
              </div>
              <StageTimeline stages={entry.stages} onRelease={(code) => onDisburse(entry.id, code)} />
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200/90 shadow-2xs space-y-2.5">
              <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                <h4 className="font-extrabold text-xs text-slate-900 uppercase tracking-wider">
                  Compliance &amp; Release Verification
                </h4>
              </div>
              <GatingList checks={entry.gatingChecks} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function FinancialLedgerRow({
  entry,
  expanded,
  onToggle,
  onDisburse,
  onHold,
  onClawback,
}: {
  entry: CommissionLedgerEntry;
  expanded: boolean;
  onToggle: () => void;
  onDisburse: (id: string, stageCode?: ReleaseStageCode) => void;
  onHold: (entry: CommissionLedgerEntry) => void;
  onClawback: (entry: CommissionLedgerEntry) => void;
}) {
  return (
    <>
      <tr className="hover:bg-slate-50/80 transition-colors">
        {/* Col 1: COMM. ID */}
        <td className="p-3">
          <p className="font-mono font-bold text-blue-700">{entry.id}</p>
        </td>

        {/* Col 2: LEAD ID */}
        <td className="p-3">
          <p className="text-xs font-mono font-semibold text-slate-700">{entry.leadId}</p>
        </td>

        {/* Col 3: PAYEE */}
        <td className="p-3">
          <p className="font-bold text-slate-900">{entry.payeeName}</p>
          <p className="text-[10px] font-mono text-slate-400">{entry.payeeCode}</p>
        </td>

        {/* Col 4: ROLE */}
        <td className="p-3">
          <PayeeTypeBadge type={entry.payeeType} />
        </td>

        {/* Col 5: PREMIUM TYPE */}
        <td className="p-3">
          <span className="px-2 py-0.5 rounded text-[10px] font-semibold border bg-blue-50 text-blue-700 border-blue-200 whitespace-nowrap inline-block">
            {entry.premiumType.replace("_", " ")} (Yr {entry.policyYear})
          </span>
        </td>

        {/* Col 6: RATE */}
        <td className="p-3 text-right font-bold tabular-nums text-slate-800 text-xs">
          {fmtPct(entry.ratePct)}
        </td>

        {/* Col 7: COLLECTED PREMIUM */}
        <td className="p-3 text-right font-semibold tabular-nums text-slate-800">
          {fmtPKR(entry.collectedPremium)}
        </td>

        {/* Col 8: GROSS */}
        <td className="p-3 text-right font-bold tabular-nums text-slate-900">
          {fmtPKRSigned(entry.grossCommission)}
        </td>

        {/* Col 9: TAXES */}
        <td className="p-3 text-right">
          <DeductionSummary entry={entry} />
        </td>

        {/* Col 10: NET PAYABLE */}
        <td className="p-3 text-right font-extrabold tabular-nums text-blue-700 text-xs">
          {fmtPKRSigned(entry.netCommission)}
        </td>

        {/* Col 10.5: DATE */}
        <td className="p-3 text-center text-[10px] font-mono text-slate-500 whitespace-nowrap">
          {entry.accruedAt.split("T")[0]}
        </td>

        {/* Col 11: DUE STATUS */}
        <td className="p-3 text-right">
          <DueBreakdown
            dueNet={entry.dueNet}
            inRunNet={entry.inRunNet}
            pendingNet={entry.pendingNet}
            releasedNet={entry.releasedNet}
          />
        </td>

        {/* Col 12: STATUS */}
        <td className="p-3 text-center">
          <StatusPill status={entry.status} title={entry.gatingReason} />
        </td>

        {/* Col 13: ACTIONS */}
        <td className="p-3 text-right">
          <EntryActions entry={entry} onDisburse={onDisburse} onHold={onHold} onClawback={onClawback} />
        </td>

        {/* Col 14: DETAILS */}
        <td className="p-3 text-center">
          <button
            onClick={onToggle}
            className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-all whitespace-nowrap inline-flex items-center gap-1 ${expanded
              ? "bg-blue-50 text-blue-700 border-blue-300"
              : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50 hover:text-slate-800"
              }`}
          >
            <span className="text-[9px]">{expanded ? "▲" : "▼"}</span>
            <span>Details</span>
          </button>
        </td>
      </tr>

      {expanded && (
        <tr className="bg-slate-50/90 border-b border-slate-200">
          <td colSpan={15} className="p-4 space-y-3">
            <div className="bg-white p-4 rounded-xl border border-slate-200/90 shadow-2xs space-y-3">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-600"></span>
                  <h4 className="font-extrabold text-xs text-slate-900 uppercase tracking-wider">
                    Payout Schedule ({entry.releaseScheduleId})
                  </h4>
                </div>
                <span className="text-[10px] text-slate-500 font-mono bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
                  SECP Rule Ref: {entry.secpRef}
                </span>
              </div>
              <StageTimeline stages={entry.stages} onRelease={(code) => onDisburse(entry.id, code)} />
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200/90 shadow-2xs space-y-2.5">
              <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                <h4 className="font-extrabold text-xs text-slate-900 uppercase tracking-wider">
                  Compliance &amp; Release Verification
                </h4>
              </div>
              <GatingList checks={entry.gatingChecks} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function PayeeSummaryRow({
  entry,
  expanded,
  onToggle,
  onDisburse,
}: {
  entry: CommissionLedgerEntry;
  expanded: boolean;
  onToggle: () => void;
  onDisburse: (id: string, stageCode?: ReleaseStageCode) => void;
}) {
  return (
    <>
      <tr className="hover:bg-slate-50/80 transition-colors">
        {/* Col 1: COMM. ID */}
        <td className="p-3">
          <p className="font-mono font-bold text-blue-700">{entry.id}</p>
        </td>

        {/* Col 2: LEAD ID */}
        <td className="p-3">
          <p className="text-xs font-mono font-semibold text-slate-700">{entry.leadId}</p>
        </td>

        {/* Col 3: PAYEE */}
        <td className="p-3">
          <p className="font-bold text-slate-900">{entry.payeeName}</p>
          <p className="text-[10px] font-mono text-slate-400">{entry.payeeCode}</p>
        </td>

        {/* Col 4: ROLE */}
        <td className="p-3">
          <PayeeTypeBadge type={entry.payeeType} />
        </td>

        {/* Col 5: CUSTOMER */}
        <td className="p-3 min-w-0">
          <p className="font-bold text-slate-900 truncate">{entry.customerName}</p>
        </td>

        {/* Col 6: POLICY ID */}
        <td className="p-3">
          <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200 inline-block">
            {entry.policyNumber}
          </span>
        </td>

        {/* Col 7: SOURCE */}
        <td className="p-3">
          <ChannelBadge channel={entry.channel} />
        </td>

        {/* Col 8: SEGMENT */}
        <td className="p-3">
          <span className="text-[10px] capitalize px-2 py-0.5 rounded bg-white border border-slate-200 font-semibold text-slate-600 inline-block">
            {entry.segment}
          </span>
        </td>

        {/* Col 9: CALCULATED ON */}
        <td className="p-3">
          <BasisLabel basis={entry.basis} amount={entry.basisAmount} />
          {entry.splitPct !== 100 && (
            <p className="text-[10px] font-bold text-amber-700 mt-0.5">Split {fmtPct(entry.splitPct)}</p>
          )}
        </td>

        {/* Col 10: RATE */}
        <td className="p-3 text-right font-bold tabular-nums text-slate-800">{fmtPct(entry.ratePct)}</td>

        {/* Col 11: GROSS */}
        <td className="p-3 text-right font-bold tabular-nums text-slate-900">{fmtPKRSigned(entry.grossCommission)}</td>

        {/* Col 11.5: DATE */}
        <td className="p-3 text-center text-[10px] font-mono text-slate-500 whitespace-nowrap">
          {entry.accruedAt.split("T")[0]}
        </td>

        {/* Col 12: REGULATORY REF */}
        <td className="p-3">
          <p className="font-mono text-[10px] font-bold text-slate-700">{entry.ruleId ?? "—"}</p>
          <p className="text-[10px] text-slate-400 font-mono">{entry.secpRef}</p>
        </td>

        {/* Col 13: DETAILS */}
        <td className="p-3 text-center">
          <button
            onClick={onToggle}
            className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-all whitespace-nowrap inline-flex items-center gap-1 ${expanded
              ? "bg-blue-50 text-blue-700 border-blue-300"
              : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50 hover:text-slate-800"
              }`}
          >
            <span className="text-[9px]">{expanded ? "▲" : "▼"}</span>
            <span>Details</span>
          </button>
        </td>
      </tr>

      {expanded && (
        <tr className="bg-slate-50/90 border-b border-slate-200">
          <td colSpan={14} className="p-4 space-y-3">
            <div className="bg-white p-4 rounded-xl border border-slate-200/90 shadow-2xs space-y-3">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-600"></span>
                  <h4 className="font-extrabold text-xs text-slate-900 uppercase tracking-wider">
                    Payout Schedule ({entry.releaseScheduleId})
                  </h4>
                </div>
                <span className="text-[10px] text-slate-500 font-mono bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
                  SECP Rule Ref: {entry.secpRef}
                </span>
              </div>
              <StageTimeline stages={entry.stages} onRelease={(code) => onDisburse(entry.id, code)} />
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200/90 shadow-2xs space-y-2.5">
              <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                <h4 className="font-extrabold text-xs text-slate-900 uppercase tracking-wider">
                  Compliance &amp; Release Verification
                </h4>
              </div>
              <GatingList checks={entry.gatingChecks} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
