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
 * The policy's lifecycle as buttons: recording an event vests the tranche that
 * was waiting on it, across every payee on the policy at once.
 */
function PolicyEventBar({
  events,
  onRecord,
}: {
  events: PolicyEventState;
  onRecord: (event: PolicyLifecycleEvent) => void;
}) {
  const state: [PolicyLifecycleEvent, string | null][] = [
    ["LEAD_GENERATED", events.leadGeneratedAt],
    ["ISSUED", events.issuedAt],
    ["PREMIUM_COLLECTED", events.premiumCollectedAt],
    ["RENEWAL_COLLECTED", events.renewalCollectedAt],
    ["PERSISTENCY_13M", events.persistency13mAt],
  ];

  return (
    <div className="px-5 py-2 border-b border-slate-100 flex flex-wrap items-center gap-1.5 bg-slate-50/40">
      <span className="text-[10px] text-slate-400 mr-1">Lifecycle</span>
      {state.map(([event, at]) => (
        <button
          key={event}
          onClick={() => onRecord(event)}
          title={at ? `Recorded ${at} — click to re-stamp` : `Record: ${POLICY_EVENT_LABELS[event]}`}
          className={`px-2 py-1 rounded-md text-[10px] font-medium border transition-colors ${
            at
              ? "bg-white text-slate-700 border-slate-200"
              : "bg-transparent text-slate-400 border-dashed border-slate-300 hover:text-slate-700 hover:border-slate-400"
          }`}
        >
          <span className={at ? "text-emerald-600 mr-1" : "text-slate-300 mr-1"}>{at ? "✓" : "○"}</span>
          {POLICY_EVENT_LABELS[event]}
        </button>
      ))}
    </div>
  );
}

export type LedgerView = "stack" | "finance" | "general";

const ENTRY_KINDS: CommissionEntryKind[] = ["COMMISSION", "OVERRIDE", "PARTNER_FEE", "REFERRAL_FEE", "BONUS", "CLAWBACK"];
const STATUSES: CommissionStatus[] = ["ACCRUED", "PAYABLE", "IN_RUN", "DISBURSED", "HELD", "CLAWED_BACK"];

/**
 * The ledger. Three ways to read the same rows: the payout stack per policy
 * (who gets what out of one premium), the money view, and the parties view.
 */
export default function LedgerTab({
  ledger,
  onDisburse,
  onHold,
  onClawback,
  onRecordEvent,
}: {
  ledger: CommissionLedgerEntry[];
  onDisburse: (id: string, stageCode?: ReleaseStageCode) => void;
  onHold: (entry: CommissionLedgerEntry) => void;
  onClawback: (entry: CommissionLedgerEntry) => void;
  /** Walks a policy's lifecycle forward so the next tranche can vest. */
  onRecordEvent?: (policyId: string, event: PolicyLifecycleEvent) => void;
}) {
  const [view, setView] = useState<LedgerView>("stack");
  const [channel, setChannel] = useState<DistributionChannel | "all">("all");
  const [payeeType, setPayeeType] = useState<PayeeType | "all">("all");
  const [kind, setKind] = useState<CommissionEntryKind | "all">("all");
  const [status, setStatus] = useState<CommissionStatus | "all">("all");
  const [segment, setSegment] = useState<string>("all");
  const [premiumType, setPremiumType] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = ledger.filter((l) => {
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

  return (
    <div className="space-y-4">
      <div className="bg-white p-3 rounded-xl border border-slate-200/80 flex flex-wrap gap-3 items-center justify-between">
        {/* Segmented control — one pressed state, no competing fills. */}
        <div className="flex p-0.5 rounded-lg bg-slate-100">
          {(
            [
              ["stack", "Payout stack"],
              ["finance", "Finance"],
              ["general", "Parties"],
            ] as [LedgerView, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={`px-3 py-1.5 text-[11px] font-medium rounded-md transition-colors ${
                view === key ? "bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.06)]" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search payee, customer, policy #, lead or entry ID…"
          className="flex-1 min-w-[240px] bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs placeholder:text-slate-400 focus:outline-hidden focus:border-slate-400"
        />

        <div className="flex flex-wrap gap-2 text-xs">
          <select value={channel} onChange={(e) => setChannel(e.target.value as DistributionChannel | "all")} className={filterClass}>
            <option value="all">All channels</option>
            {(Object.keys(CHANNEL_LABELS) as DistributionChannel[]).map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
          <select value={payeeType} onChange={(e) => setPayeeType(e.target.value as PayeeType | "all")} className={filterClass}>
            <option value="all">All payee types</option>
            {(Object.keys(PAYEE_TYPE_LABELS) as PayeeType[]).map((t) => (
              <option key={t} value={t}>
                {PAYEE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <select value={kind} onChange={(e) => setKind(e.target.value as CommissionEntryKind | "all")} className={filterClass}>
            <option value="all">All entry kinds</option>
            {ENTRY_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace("_", " ")}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as CommissionStatus | "all")} className={filterClass}>
            <option value="all">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
          <select value={segment} onChange={(e) => setSegment(e.target.value)} className={filterClass}>
            <option value="all">All segments</option>
            <option value="individual">Individual Life</option>
            <option value="group">Group Corporate</option>
            <option value="family">Family Takaful</option>
          </select>
          <select value={premiumType} onChange={(e) => setPremiumType(e.target.value)} className={filterClass}>
            <option value="all">All premium types</option>
            <option value="FIRST_YEAR">First-Year Premium (FYP)</option>
            <option value="RENEWAL">Renewal Premium (RYP)</option>
            <option value="SINGLE_PREMIUM">Single Premium (SP)</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState message="No commission entries match these filters." />
        </Card>
      ) : view === "stack" ? (
        <div className="space-y-4">
          {groups.map((group) => (
            <Card key={group.policyId} className="overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-[13px] text-slate-900">{group.customerName}</p>
                    <span className="font-mono text-[11px] text-slate-500">{group.policyNumber}</span>
                    <ChannelBadge channel={group.channel} />
                    <span className="text-[10px] capitalize px-1.5 py-0.5 rounded bg-slate-50 border border-slate-200 font-medium text-slate-500">
                      {group.segment}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">
                    Premium <span className="font-semibold tabular-nums text-slate-700">{fmtPKR(group.collectedPremium)}</span>
                    <span className="mx-1.5 text-slate-300">·</span>
                    {group.entries.length} payout {group.entries.length === 1 ? "row" : "rows"}
                    <span className="mx-1.5 text-slate-300">·</span>
                    <span className={group.ceilingBreached ? "font-semibold text-rose-600" : ""}>
                      {fmtPct(group.effectiveRatePct)} of premium against a {fmtPct(group.ceilingPct)} ceiling
                      {group.ceilingBreached ? " — breached" : ""}
                    </span>
                  </p>
                </div>
                <div className="flex items-center gap-8 shrink-0">
                  <div className="text-right">
                    <p className="text-[10px] text-slate-400">Release position</p>
                    <DueBreakdown
                      dueNet={group.dueNet}
                      inRunNet={group.inRunNet}
                      pendingNet={group.pendingNet}
                      releasedNet={group.releasedNet}
                    />
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] text-slate-400">Total commission</p>
                    <p className="text-base font-semibold tabular-nums text-slate-900">{fmtPKR(group.totalGross)}</p>
                  </div>
                </div>
              </div>

              {onRecordEvent && (
                <PolicyEventBar
                  events={group.events}
                  onRecord={(event) => onRecordEvent(group.policyId, event)}
                />
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                    <tr>
                      <th className="p-3">Payee</th>
                      <th className="p-3">Entry</th>
                      <th className="p-3">Basis</th>
                      <th className="p-3 text-right">Rate</th>
                      <th className="p-3 text-right">Gross</th>
                      <th className="p-3 text-right">Deductions</th>
                      <th className="p-3 text-right">Net</th>
                      <th className="p-3">Release Schedule</th>
                      <th className="p-3 text-right">Due Now</th>
                      <th className="p-3 text-center">Status</th>
                      <th className="p-3 text-right">Actions</th>
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
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                <tr>
                  <th className="p-3">Ref ID &amp; Lead ID</th>
                  <th className="p-3">Payee</th>
                  {view === "general" && <th className="p-3">Customer</th>}
                  <th className="p-3">Premium Type &amp; Rate</th>
                  <th className="p-3 text-right">Collected Premium</th>
                  {view === "finance" && <th className="p-3 text-right">Gross</th>}
                  {view === "finance" && <th className="p-3 text-right">Deductions</th>}
                  {view === "finance" && <th className="p-3 text-right">Net</th>}
                  {view === "finance" && <th className="p-3">Release Schedule</th>}
                  {view === "finance" && <th className="p-3 text-right">Due Now</th>}
                  {view === "finance" && <th className="p-3 text-center">Status</th>}
                  {view === "finance" && <th className="p-3 text-right">Actions</th>}
                  {view === "general" && <th className="p-3">Channel</th>}
                  {view === "general" && <th className="p-3">Rate-Card Row</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-800">
                {filtered.map((item) => (
                  <React.Fragment key={item.id}>
                    <tr className="hover:bg-slate-50/80">
                      <td className="p-3">
                        <p className="font-mono font-bold text-blue-900">{item.id}</p>
                        <span className="text-[10px] text-slate-400 font-mono">Trace: {item.leadId}</span>
                        <div className="mt-1">
                          <EntryKindBadge kind={item.entryKind} />
                        </div>
                      </td>
                      <td className="p-3">
                        <p className="font-bold text-slate-900">{item.payeeName}</p>
                        <p className="text-[10px] font-mono text-slate-400">{item.payeeCode}</p>
                        <div className="mt-1">
                          <PayeeTypeBadge type={item.payeeType} />
                        </div>
                      </td>
                      {view === "general" && (
                        <td className="p-3">
                          <p className="font-semibold text-slate-800">{item.customerName}</p>
                          <p className="text-[10px] font-mono text-blue-700">{item.policyNumber}</p>
                          <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-slate-100 font-bold text-slate-500">
                            {item.segment}
                          </span>
                        </td>
                      )}
                      <td className="p-3">
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold border bg-blue-50 text-blue-700 border-blue-200">
                          {item.premiumType.replace("_", " ")} (Yr {item.policyYear})
                        </span>
                        <p className="text-[10px] font-bold text-slate-600 mt-1">
                          Rate: {fmtPct(item.ratePct)}
                          {item.splitPct !== 100 && ` · split ${fmtPct(item.splitPct)}`}
                        </p>
                      </td>
                      <td className="p-3 text-right font-semibold tabular-nums text-slate-800">{fmtPKR(item.collectedPremium)}</td>
                      {view === "finance" && (
                        <>
                          <td className="p-3 text-right font-semibold tabular-nums text-slate-900">
                            {fmtPKRSigned(item.grossCommission)}
                          </td>
                          <td className="p-3 text-right">
                            <DeductionSummary entry={item} />
                          </td>
                          <td className="p-3 text-right font-semibold tabular-nums text-blue-700 text-sm">
                            {fmtPKRSigned(item.netCommission)}
                          </td>
                          <td className="p-3 min-w-[180px]">
                            <StageTimeline stages={item.stages} compact />
                          </td>
                          <td className="p-3 text-right">
                            <DueBreakdown
                              dueNet={item.dueNet}
                              inRunNet={item.inRunNet}
                              pendingNet={item.pendingNet}
                              releasedNet={item.releasedNet}
                            />
                          </td>
                          <td className="p-3 text-center">
                            <StatusPill status={item.status} title={item.gatingReason} />
                          </td>
                          <td className="p-3 text-right">
                            <EntryActions entry={item} onDisburse={onDisburse} onHold={onHold} onClawback={onClawback} />
                          </td>
                        </>
                      )}
                      {view === "general" && (
                        <td className="p-3">
                          <ChannelBadge channel={item.channel} />
                        </td>
                      )}
                      {view === "general" && (
                        <td className="p-3">
                          <p className="font-mono text-[10px] font-bold text-slate-700">{item.ruleId ?? "—"}</p>
                          <p className="text-[10px] text-slate-400">{item.secpRef}</p>
                        </td>
                      )}
                    </tr>
                  </React.Fragment>
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
  "bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-slate-600 hover:border-slate-300 focus:outline-hidden focus:border-slate-400";

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
      <p className="font-mono text-slate-600">- {fmtPKR(Math.abs(total))}</p>
      <p className="text-[9px] text-slate-400">
        WHT {entry.whtPct}%{entry.deductions.length > 1 ? " + PST" : ""}
        {entry.recoveryApplied > 0 ? " + recovery" : ""}
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
    return <span className="text-[10px] text-slate-400">Reversal of {entry.reversalOfEntryId}</span>;
  }
  if (entry.payeeType === "HOUSE") {
    return <span className="text-[10px] text-slate-400">Retained — not paid out</span>;
  }

  const dueStages = entry.stages.filter((s) => s.status === "DUE").length;

  return (
    <div className="flex justify-end gap-1">
      {dueStages > 0 && (
        <>
          <button
            onClick={() => onDisburse(entry.id)}
            title={`Releases the ${dueStages} tranche(s) that have fallen due; later stages stay pending`}
            className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white text-[10px] font-medium rounded-md transition-colors"
          >
            Release {dueStages > 1 ? `${dueStages} due` : "due"} →
          </button>
          <button
            onClick={() => onHold(entry)}
            className="px-2 py-1 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 text-[10px] font-medium rounded-md transition-colors"
          >
            Hold
          </button>
        </>
      )}
      {entry.inRunNet > 0 && <span className="text-[10px] font-bold text-indigo-700">In {entry.payoutRunId}</span>}
      {entry.status !== "CLAWED_BACK" && (
        <button
          onClick={() => onClawback(entry)}
          className="px-2 py-1 bg-white hover:bg-rose-50 hover:border-rose-200 border border-slate-200 text-rose-600 text-[10px] font-medium rounded-md transition-colors"
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
      <tr className={`hover:bg-slate-50/80 ${entry.parentEntryId ? "bg-slate-50/40" : ""}`}>
        <td className="p-3">
          <div className="flex items-start gap-2">
            {entry.parentEntryId && <span className="text-slate-300 font-mono text-xs mt-0.5">└</span>}
            <div>
              <p className="font-bold text-slate-900">{entry.payeeName}</p>
              <p className="text-[10px] font-mono text-slate-400">
                {entry.payeeCode} · {entry.id}
              </p>
              <div className="mt-1">
                <PayeeTypeBadge type={entry.payeeType} />
              </div>
            </div>
          </div>
        </td>
        <td className="p-3">
          <EntryKindBadge kind={entry.entryKind} />
          <p className="text-[10px] text-slate-400 mt-1 font-mono">{entry.ruleId ?? "no rule"}</p>
        </td>
        <td className="p-3">
          <BasisLabel basis={entry.basis} amount={entry.basisAmount} />
          {entry.splitPct !== 100 && (
            <p className="text-[10px] font-bold text-amber-700">Split {fmtPct(entry.splitPct)}</p>
          )}
        </td>
        <td className="p-3 text-right font-semibold tabular-nums text-slate-800">{fmtPct(entry.ratePct)}</td>
        <td className="p-3 text-right font-semibold tabular-nums text-slate-900">{fmtPKRSigned(entry.grossCommission)}</td>
        <td className="p-3 text-right">
          <DeductionSummary entry={entry} />
        </td>
        <td className="p-3 text-right font-semibold tabular-nums text-blue-700">{fmtPKRSigned(entry.netCommission)}</td>
        <td className="p-3 min-w-[180px]">
          <StageTimeline stages={entry.stages} compact />
        </td>
        <td className="p-3 text-right">
          <DueBreakdown
            dueNet={entry.dueNet}
            inRunNet={entry.inRunNet}
            pendingNet={entry.pendingNet}
            releasedNet={entry.releasedNet}
          />
        </td>
        <td className="p-3 text-center">
          <button onClick={onToggle} title="Show the release schedule and checks for this entry">
            <StatusPill status={entry.status} title={entry.gatingReason} />
          </button>
        </td>
        <td className="p-3 text-right">
          <EntryActions entry={entry} onDisburse={onDisburse} onHold={onHold} onClawback={onClawback} />
        </td>
      </tr>
      {expanded && (
        <tr className="bg-slate-50">
          <td colSpan={11} className="px-5 py-3 space-y-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                Release schedule — {entry.releaseScheduleId}
              </p>
              <StageTimeline stages={entry.stages} onRelease={(code) => onDisburse(entry.id, code)} />
            </div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Release checks</p>
            <GatingList checks={entry.gatingChecks} />
            <p className="text-[10px] text-slate-500">
              <span className="font-bold">Rate-card row:</span> {entry.ruleId ?? "none matched"} — {entry.secpRef}
              {entry.parentEntryId && (
                <>
                  {" · "}
                  <span className="font-bold">Computed from:</span> {entry.parentEntryId}
                </>
              )}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
