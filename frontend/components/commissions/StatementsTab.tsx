"use client";

import React, { useState } from "react";
import { PayeeStatement } from "../../app/services/commissions";
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

/**
 * Per-payee statements — the document each producer, manager, bank and broker
 * queries: what they earned, what was deducted, what is still owed.
 */
export default function StatementsTab({ statements }: { statements: PayeeStatement[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(statements[0]?.payee.id ?? null);
  const selected = statements.find((s) => s.payee.id === selectedId) ?? statements[0] ?? null;

  if (statements.length === 0) {
    return (
      <Card>
        <EmptyState message="No statements yet — commission entries have to exist before a statement can be built." />
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card title="Payees" subtitle={`${statements.length} with ledger activity`} className="lg:col-span-1 overflow-hidden">
        <div className="max-h-[720px] overflow-y-auto divide-y divide-slate-100">
          {statements.map((s) => (
            <button
              key={s.payee.id}
              onClick={() => setSelectedId(s.payee.id)}
              className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${
                selected?.payee.id === s.payee.id ? "bg-blue-50/70 border-l-4 border-blue-600" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-bold text-xs text-slate-900">{s.payee.name}</p>
                <p className="font-mono text-xs font-semibold text-blue-700">{fmtPKR(s.netPayable)}</p>
              </div>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <PayeeTypeBadge type={s.payee.type} />
                <span className="text-[10px] font-mono text-slate-400">{s.payee.code}</span>
              </div>
              <p className="text-[10px] text-slate-400 mt-1">
                {s.entries.length} entries · {fmtPKR(s.pending)} pending
              </p>
            </button>
          ))}
        </div>
      </Card>

      {selected && (
        <div className="lg:col-span-2 space-y-4">
          <Card
            title={`Statement — ${selected.payee.name}`}
            subtitle={`${selected.payee.code} · ${selected.payee.branch}`}
            actions={<ChannelBadge channel={selected.payee.channel} />}
          >
            <div className="p-5 space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatBox label="Commission &amp; fees" value={fmtPKR(selected.grossCommission)} />
                <StatBox label="Overrides earned" value={fmtPKR(selected.overrides)} />
                <StatBox label="Bonuses" value={fmtPKR(selected.bonuses)} />
                <StatBox label="Clawed back" value={fmtPKR(selected.clawbacks)} tone="rose" />
              </div>

              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-slate-100">
                    <Line label="Gross earnings (commission, fees, overrides, bonuses)" value={selected.grossCommission + selected.overrides + selected.bonuses} bold />
                    {selected.deductions.map((d) => (
                      <Line key={d.code} label={`${d.label} @ ${d.pct}%`} value={-d.amount} />
                    ))}
                    {selected.recoveryApplied > 0 && (
                      <Line label="Clawback / advance recovered this period" value={-selected.recoveryApplied} />
                    )}
                    <Line label="Net payable" value={selected.netPayable} bold highlight />
                    <Line label="Already released" value={selected.disbursed} muted />
                    <Line label="Due now — vested, awaiting a payout run" value={selected.dueNow} muted />
                    <Line label="Locked into a payout run" value={selected.inRun} muted />
                    <Line label="Not yet due — vests at a later event" value={selected.notYetDue} muted />
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[11px]">
                <div className="bg-slate-50 rounded-xl border border-slate-200 p-3">
                  <p className="font-bold text-slate-700 mb-1">Tax profile</p>
                  <p className="text-slate-600">
                    {selected.payee.isCorporate ? "Corporate" : "Individual"} ·{" "}
                    {selected.payee.taxFilerStatus === "FILER" ? "Filer" : "Non-filer"}
                  </p>
                  <p className="text-slate-600">Withheld at {selected.whtPct}%</p>
                  <p className="text-slate-500">YTD commission {fmtPKR(selected.payee.ytdCommission)}</p>
                </div>
                <div className="bg-slate-50 rounded-xl border border-slate-200 p-3">
                  <p className="font-bold text-slate-700 mb-1">Licence</p>
                  <LicenceCell licenceNo={selected.payee.licenceNo} expiry={selected.payee.licenceExpiry} />
                </div>
                <div
                  className={`rounded-xl border p-3 ${
                    selected.openingRecovery > 0 ? "bg-rose-50 border-rose-200" : "bg-slate-50 border-slate-200"
                  }`}
                >
                  <p className="font-bold text-slate-700 mb-1">Outstanding recovery</p>
                  <p className={`font-mono font-bold ${selected.openingRecovery > 0 ? "text-rose-700" : "text-slate-500"}`}>
                    {fmtPKR(selected.openingRecovery)}
                  </p>
                  <p className="text-[10px] text-slate-500 mt-0.5">Netted off future payouts until cleared</p>
                </div>
              </div>

              {selected.nextStage && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px]">
                  <p className="font-bold text-slate-700">Next tranche to vest</p>
                  <p className="text-slate-600">
                    {selected.nextStage.label} —{" "}
                    <span className="font-semibold tabular-nums text-slate-800">{fmtPKR(selected.nextStage.netAmount)}</span>
                  </p>
                  <p className="text-[10px] text-slate-500 mt-0.5">{selected.nextStage.reason}</p>
                </div>
              )}
            </div>
          </Card>

          <Card title="Statement Lines" subtitle="Every ledger entry raised for this payee">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                  <tr>
                    <th className="p-3">Entry</th>
                    <th className="p-3">Policy / Scheme</th>
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
                        <StatusPill status={e.status} title={e.gatingReason} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value, tone = "slate" }: { label: string; value: string; tone?: "slate" | "rose" }) {
  return (
    <div className={`rounded-xl border p-3 ${tone === "rose" ? "bg-rose-50 border-rose-200" : "bg-slate-50 border-slate-200"}`}>
      <p className="text-[10px] font-semibold text-slate-500">{label}</p>
      <p className={`font-mono font-semibold ${tone === "rose" ? "text-rose-700" : "text-slate-900"}`}>{value}</p>
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
        className={`px-4 py-2.5 text-right font-mono ${
          highlight ? "font-semibold text-blue-700 text-sm" : bold ? "font-bold text-slate-900" : muted ? "text-slate-500" : "text-slate-700"
        }`}
      >
        {fmtPKRSigned(value)}
      </td>
    </tr>
  );
}
