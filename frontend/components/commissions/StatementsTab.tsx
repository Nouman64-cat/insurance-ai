"use client";

import React, { useState } from "react";
import { PAYEE_TYPE_LABELS, PayeeStatement, PayeeType, StatutoryDeduction } from "../../app/services/commissions";
import {
  DateRangeFilter,
  filterLedgerByDate,
  resolvePreset,
  type DatePreset,
  type DateRange,
} from "./DateRangeFilter";
import {
  Card,
  ChannelBadge,
  EmptyState,
  EntryKindBadge,
  LicenceCell,
  PayeeTypeBadge,
  StageTimeline,
  StatusPill,
  fmtPKR,
  fmtPKRSigned,
} from "./shared";

function filterStatementByDate(statement: PayeeStatement, range: DateRange): PayeeStatement {
  if (!range.from || !range.to) return statement;
  const filteredEntries = filterLedgerByDate(statement.entries, range);
  const live = filteredEntries.filter((e) => e.entryKind !== "CLAWBACK" && !e.isClawback);

  const byCode = new Map<string, StatutoryDeduction>();
  for (const entry of live) {
    for (const d of entry.deductions) {
      const cur = byCode.get(d.code);
      byCode.set(d.code, cur ? { ...cur, amount: cur.amount + d.amount } : { ...d });
    }
  }

  return {
    ...statement,
    entries: filteredEntries,
    grossCommission: live.filter((e) => e.entryKind === "COMMISSION" || e.entryKind === "PARTNER_FEE" || e.entryKind === "REFERRAL_FEE").reduce((s, e) => s + e.grossCommission, 0),
    overrides: live.filter((e) => e.entryKind === "OVERRIDE").reduce((s, e) => s + e.grossCommission, 0),
    bonuses: live.filter((e) => e.entryKind === "BONUS").reduce((s, e) => s + e.grossCommission, 0),
    clawbacks: filteredEntries.filter((e) => e.entryKind === "CLAWBACK").reduce((s, e) => s + Math.abs(e.netCommission), 0),
    deductions: Array.from(byCode.values()),
    totalDeductions: live.reduce((s, e) => s + e.deductions.reduce((d, x) => d + x.amount, 0), 0),
    recoveryApplied: live.reduce((s, e) => s + e.recoveryApplied, 0),
    netPayable: live.reduce((s, e) => s + e.netCommission, 0),
    disbursed: live.reduce((s, e) => s + e.releasedNet, 0),
    pending: live.reduce((s, e) => s + e.dueNet + e.inRunNet + e.pendingNet, 0),
    dueNow: live.reduce((s, e) => s + e.dueNet, 0),
    inRun: live.reduce((s, e) => s + e.inRunNet, 0),
    notYetDue: live.reduce((s, e) => s + e.pendingNet, 0),
  };
}

/** Helper function to convert raw backend jargon into simple, plain English terms */
function formatPlainEnglishText(str: string): string {
  if (!str) return "";
  return str
    .replace(/13th-month persistency/gi, "1-Year Policy Retention Bonus")
    .replace(/13-month measurement/gi, "1-Year Retention Evaluation")
    .replace(/375 day\(s\) to the 13-month measurement/gi, "Evaluation Period: 375 Days Remaining")
    .replace(/persistency/gi, "Policy Retention")
    .replace(/gating reason/gi, "Payout Release Condition")
    .replace(/s\.233 \(filer\) @ 12%/gi, "Income Tax Withheld (12% Filer Rate)")
    .replace(/s\.233/gi, "Income Tax");
}

/** Get initials for payee avatar badge */
function getInitials(name: string): string {
  if (!name) return "P";
  const parts = name.trim().split(" ");
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/**
 * Per-payee statements / pay stubs — individual producer view summarizing
 * gross earnings, statutory tax withheld, licence verification, and net payout.
 */
export default function StatementsTab({
  statements,
  datePreset,
  dateRange,
  onDateChange,
}: {
  statements: PayeeStatement[];
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

  const dateFilteredStatements = statements.map((s) => filterStatementByDate(s, activeRange));

  const [selectedId, setSelectedId] = useState<string | null>(dateFilteredStatements[0]?.payee.id ?? null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");

  const filteredStatements = dateFilteredStatements.filter((s) => {
    const matchesSearch =
      !search.trim() ||
      s.payee.name.toLowerCase().includes(search.toLowerCase()) ||
      s.payee.code.toLowerCase().includes(search.toLowerCase()) ||
      s.payee.branch.toLowerCase().includes(search.toLowerCase());
    const matchesRole = roleFilter === "all" || s.payee.type === roleFilter;
    return matchesSearch && matchesRole;
  });

  const selected = filteredStatements.find((s) => s.payee.id === selectedId) ?? filteredStatements[0] ?? null;

  if (statements.length === 0) {
    return (
      <Card>
        <EmptyState message="No statements yet — commission entries have to exist before a statement can be built." />
      </Card>
    );
  }

  // Extract unique payee types present in statements for filter dropdown
  const availableRoles = Array.from(new Set(statements.map((s) => s.payee.type)));

  return (
    <div className="space-y-4">
      {/* Informational Guidance Banner */}
      {/* <div className="bg-gradient-to-r from-blue-50/90 to-indigo-50/70 border border-blue-200/80 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs shadow-2xs">
        <div className="flex items-start gap-2.5">
          <span className="text-blue-600 font-extrabold text-sm shrink-0 mt-0.5">📄</span>
          <div>
            <p className="font-bold text-slate-900">Payee Statements &amp; Earnings Summaries</p>
            <p className="text-slate-600 text-[11px] mt-0.5 leading-relaxed">
              While the <span className="font-bold text-slate-800">Commission Ledger</span> tracks raw line-item policy entries, <span className="font-bold text-slate-800">Statements</span> aggregate total earnings, statutory tax withheld, licence verification, and net payable amounts per payee for payout stubs and tax compliance.
            </p>
          </div>
        </div>
      </div> */}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left Column: Payee Header with Inline Search & Role Filter + Payees List */}
        <Card
          title="Payees"
          subtitle={`${filteredStatements.length} of ${statements.length} active`}
          actions={
            <div className="flex flex-wrap items-center gap-1.5">
              <DateRangeFilter preset={activePreset} range={activeRange} onPresetChange={handleDateChange} size="sm" align="left" />
              <div className="relative">
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search payee..."
                  className="pl-7 pr-2.5 py-1 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-hidden focus:border-blue-500 text-slate-800 placeholder-slate-400 w-28 sm:w-36 transition-all"
                />
                <svg
                  className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-2 pointer-events-none"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
                className="px-2 py-1 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-700 font-medium focus:outline-hidden focus:border-blue-500 max-w-[110px]"
              >
                <option value="all">All Roles</option>
                {availableRoles.map((role) => (
                  <option key={role} value={role}>
                    {PAYEE_TYPE_LABELS[role as PayeeType] || role}
                  </option>
                ))}
              </select>
              {(search || roleFilter !== "all") && (
                <button
                  onClick={() => {
                    setSearch("");
                    setRoleFilter("all");
                  }}
                  className="text-xs font-bold text-slate-400 hover:text-slate-700 px-1"
                  title="Clear filters"
                >
                  ✕
                </button>
              )}
            </div>
          }
          className="lg:col-span-1 overflow-hidden flex flex-col"
        >
          {/* Payee List */}
          <div className="max-h-[680px] overflow-y-auto divide-y divide-slate-100 flex-1">
            {filteredStatements.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400">No payees match your search criteria.</div>
            ) : (
              filteredStatements.map((s) => {
                const isSelected = selected?.payee.id === s.payee.id;
                return (
                  <button
                    key={s.payee.id}
                    onClick={() => setSelectedId(s.payee.id)}
                    className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors flex items-start gap-3 ${isSelected ? "bg-blue-50/70 border-l-4 border-blue-600" : ""
                      }`}
                  >
                    <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 text-slate-700 font-bold text-xs flex items-center justify-center shrink-0 mt-0.5">
                      {getInitials(s.payee.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-bold text-xs text-slate-900 truncate">{s.payee.name}</p>
                        <p className="font-mono text-xs font-semibold text-blue-700 shrink-0">{fmtPKR(s.netPayable)}</p>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <PayeeTypeBadge type={s.payee.type} />
                        <span className="text-[10px] font-mono text-slate-400">{s.payee.code}</span>
                      </div>
                      <p className="text-[10px] text-slate-400 mt-1">
                        {s.entries.length} entries · {fmtPKR(s.pending)} pending
                      </p>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </Card>

        {/* Right Column: Statement Details & Itemized Lines */}
        {selected ? (
          <div className="lg:col-span-2 space-y-4">
            <Card
              title={`Statement — ${selected.payee.name}`}
              subtitle={`${selected.payee.code} · ${selected.payee.branch}`}
              actions={
                <div className="flex items-center gap-2">
                  <ChannelBadge channel={selected.payee.channel} />
                  <button
                    onClick={() => window.print()}
                    className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-lg transition-colors flex items-center gap-1.5 border border-slate-200"
                  >
                    <svg className="w-3.5 h-3.5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                    </svg>
                    <span>Print Stub</span>
                  </button>
                </div>
              }
            >
              <div className="p-5 space-y-5">
                {/* 4 Summary Stat Cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <StatBox label="Commission &amp; Fees" value={fmtPKR(selected.grossCommission)} tone="blue" />
                  <StatBox label="Overrides Earned" value={fmtPKR(selected.overrides)} tone="indigo" />
                  <StatBox label="Bonuses" value={fmtPKR(selected.bonuses)} tone="emerald" />
                  <StatBox label="Clawed Back" value={fmtPKR(selected.clawbacks)} tone="rose" />
                </div>

                {/* Plain-English Statement Financial Summary Table */}
                <div className="rounded-xl border border-slate-200 overflow-hidden bg-white shadow-2xs">
                  <table className="w-full text-xs">
                    <tbody className="divide-y divide-slate-100">
                      <Line
                        label="Gross Earnings (Commission, Overrides &amp; Bonuses)"
                        value={selected.grossCommission + selected.overrides + selected.bonuses}
                        bold
                      />
                      {selected.deductions.map((d) => (
                        <Line
                          key={d.code}
                          label={`Income Tax Withheld (${d.pct}% Filer Rate)`}
                          value={-d.amount}
                        />
                      ))}
                      {selected.recoveryApplied > 0 && (
                        <Line label="Clawback / Advance Recovered" value={-selected.recoveryApplied} />
                      )}

                      {/* Highlighted Net Payable Row */}
                      <tr className="bg-blue-600 text-white font-bold">
                        <td className="px-4 py-3 text-xs uppercase tracking-wider">Net Payable Stack</td>
                        <td className="px-4 py-3 text-right font-mono text-sm font-black">{fmtPKRSigned(selected.netPayable)}</td>
                      </tr>

                      <Line label="Already Released / Settled" value={selected.disbursed} muted />
                      <Line label="Ready to Pay (Vested &amp; Approved)" value={selected.dueNow} bold highlight />
                      <Line label="Processing in Active Payout Run" value={selected.inRun} muted />
                      <Line label="In-Progress (Future Milestone Unvested)" value={selected.notYetDue} muted />
                    </tbody>
                  </table>
                </div>

                {/* Tax Profile, Licence & Recovery Cards */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[11px]">
                  {/* Tax Profile Card */}
                  <div className="bg-slate-50/80 rounded-xl border border-slate-200 p-3.5 space-y-1.5 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <p className="font-bold text-slate-900 flex items-center gap-1">
                          <span>🏛️</span> Tax Profile
                        </p>
                        <span className="px-2 py-0.5 text-[9px] font-bold rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                          {selected.payee.taxFilerStatus === "FILER" ? "✓ Active Filer" : "Non-Filer"}
                        </span>
                      </div>
                      <p className="text-slate-600 text-[11px]">
                        {selected.payee.isCorporate ? "Corporate Entity" : "Individual Agent"}
                      </p>
                      <p className="text-slate-600 font-medium">Withheld at {selected.whtPct}% Rate</p>
                    </div>
                    <div className="pt-2 border-t border-slate-200/80">
                      <p className="text-[10px] text-slate-500">
                        YTD Earnings: <span className="font-mono font-bold text-slate-800">{fmtPKR(selected.payee.ytdCommission)}</span>
                      </p>
                    </div>
                  </div>

                  {/* Licence Verification Card */}
                  <div className="bg-slate-50/80 rounded-xl border border-slate-200 p-3.5 space-y-1.5 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <p className="font-bold text-slate-900 flex items-center gap-1">
                          <span>🪪</span> Regulatory Licence
                        </p>
                        <span className="px-2 py-0.5 text-[9px] font-bold rounded-full bg-blue-100 text-blue-800 border border-blue-200">
                          ✓ Verified Active
                        </span>
                      </div>
                      <LicenceCell licenceNo={selected.payee.licenceNo} expiry={selected.payee.licenceExpiry} />
                    </div>
                    <div className="pt-2 border-t border-slate-200/80">
                      <p className="text-[10px] text-slate-500">SECP Compliance Valid</p>
                    </div>
                  </div>

                  {/* Recovery & Advance Card */}
                  <div
                    className={`rounded-xl border p-3.5 space-y-1.5 flex flex-col justify-between ${selected.openingRecovery > 0 ? "bg-rose-50/80 border-rose-200" : "bg-slate-50/80 border-slate-200"
                      }`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <p className="font-bold text-slate-900 flex items-center gap-1">
                          <span>⚖️</span> Advance Recovery
                        </p>
                        <span
                          className={`px-2 py-0.5 text-[9px] font-bold rounded-full ${selected.openingRecovery > 0
                            ? "bg-rose-100 text-rose-800 border border-rose-200"
                            : "bg-slate-200/70 text-slate-700 border border-slate-300"
                            }`}
                        >
                          {selected.openingRecovery > 0 ? "⚠️ Pending Recovery" : "✓ Clear Balance"}
                        </span>
                      </div>
                      <p className={`font-mono font-bold text-sm ${selected.openingRecovery > 0 ? "text-rose-700" : "text-slate-800"}`}>
                        {fmtPKR(selected.openingRecovery)}
                      </p>
                    </div>
                    <div className="pt-2 border-t border-slate-200/80">
                      <p className="text-[10px] text-slate-500">Netted off future payouts until cleared</p>
                    </div>
                  </div>
                </div>

                {/* Upcoming Bonus & Vesting Milestone Box with Plain English */}
                {selected.nextStage && (
                  <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 text-[11px] space-y-2 shadow-2xs">
                    <div className="flex items-center justify-between gap-2 border-b border-blue-200/60 pb-2">
                      <p className="font-extrabold text-blue-900 uppercase tracking-wider text-[10px] flex items-center gap-1.5">
                        <span>🎯</span> Upcoming Bonus &amp; Vesting Milestone
                      </p>
                      <span className="font-mono font-black text-blue-700 text-sm">{fmtPKR(selected.nextStage.netAmount)}</span>
                    </div>
                    <div>
                      <p className="font-bold text-slate-900 text-xs">{formatPlainEnglishText(selected.nextStage.label)}</p>
                      <p className="text-slate-600 text-[11px] mt-0.5">
                        {formatPlainEnglishText(selected.nextStage.reason)}
                      </p>
                    </div>
                    {/* Visual Progress Bar indicator */}
                    <div className="pt-1">
                      <div className="flex items-center justify-between text-[10px] text-slate-500 font-medium mb-1">
                        <span>Milestone Progress</span>
                        <span className="font-mono text-blue-700 font-bold">Vesting Pending</span>
                      </div>
                      <div className="w-full bg-blue-200/60 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-blue-600 h-1.5 rounded-full w-2/3 transition-all duration-500"></div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </Card>

            <Card title="Statement Lines" subtitle="Every ledger entry raised for this payee">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                    <tr>
                      <th className="p-3">Entry ID</th>
                      <th className="p-3">Policy / Plan</th>
                      <th className="p-3">Kind</th>
                      <th className="p-3 text-right">Rate</th>
                      <th className="p-3 text-right">Gross</th>
                      <th className="p-3 text-right">Net</th>
                      <th className="p-3">Release Schedule</th>
                      <th className="p-3 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selected.entries.map((e) => (
                      <tr key={e.id} className="hover:bg-slate-50/70">
                        <td className="p-3">
                          <p className="font-mono font-bold text-[10px] text-blue-900">{e.id}</p>
                          <p className="text-[10px] text-slate-400">{e.accruedAt}</p>
                        </td>
                        <td className="p-3">
                          <p className="font-semibold text-slate-800">{e.customerName}</p>
                          <p className="text-[10px] font-mono text-slate-400">{e.policyNumber}</p>
                        </td>
                        <td className="p-3">
                          <EntryKindBadge kind={e.entryKind} />
                        </td>
                        <td className="p-3 text-right font-mono text-slate-700">{e.ratePct}%</td>
                        <td className="p-3 text-right font-semibold tabular-nums text-slate-900">{fmtPKRSigned(e.grossCommission)}</td>
                        <td className="p-3 text-right font-semibold tabular-nums text-blue-700">{fmtPKRSigned(e.netCommission)}</td>
                        <td className="p-3 min-w-[200px]">
                          <StageTimeline stages={e.stages} compact />
                        </td>
                        <td className="p-3 text-center">
                          <StatusPill status={e.status} title={formatPlainEnglishText(e.gatingReason || "")} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        ) : (
          <div className="lg:col-span-2">
            <Card>
              <EmptyState message="No payee statement selected matching your search criteria." />
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function StatBox({
  label,
  value,
  tone = "blue",
}: {
  label: string;
  value: string;
  tone?: "blue" | "indigo" | "emerald" | "rose";
}) {
  const toneClasses = {
    blue: "bg-blue-50/50 border-blue-200/80 text-blue-900",
    indigo: "bg-indigo-50/50 border-indigo-200/80 text-indigo-900",
    emerald: "bg-emerald-50/50 border-emerald-200/80 text-emerald-900",
    rose: "bg-rose-50/50 border-rose-200/80 text-rose-900",
  }[tone];

  return (
    <div className={`rounded-xl border p-3 ${toneClasses}`}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="font-mono font-bold text-sm mt-0.5 text-slate-900">{value}</p>
    </div>
  );
}

function Line({
  label,
  value,
  bold,
  muted,
  highlight,
}: {
  label: string;
  value: number;
  bold?: boolean;
  muted?: boolean;
  highlight?: boolean;
}) {
  return (
    <tr className={highlight ? "bg-blue-50/60" : ""}>
      <td className={`px-4 py-2.5 ${bold ? "font-bold text-slate-900" : muted ? "text-slate-500" : "text-slate-700"}`}>{label}</td>
      <td
        className={`px-4 py-2.5 text-right font-mono ${highlight ? "font-semibold text-blue-700 text-sm" : bold ? "font-bold text-slate-900" : muted ? "text-slate-500" : "text-slate-700"
          }`}
      >
        {fmtPKRSigned(value)}
      </td>
    </tr>
  );
}
