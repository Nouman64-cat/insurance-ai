"use client";

import React, { useState } from "react";
import {
  CHANNEL_LABELS,
  CommissionLedgerEntry,
  DistributionChannel,
  PayoutRun,
  PayoutRunStatus,
  ReleaseStage,
  approvePayoutRun,
  buildGlJournal,
  buildPayoutFile,
  collectDueStages,
  createPayoutRun,
  payPayoutRun,
  rejectPayoutRun,
  submitPayoutRun,
} from "../../app/services/commissions";
import {
  Card,
  EmptyState,
  Field,
  PayeeTypeBadge,
  btnAccent,
  btnDanger,
  btnGhost,
  btnPrimary,
  fmtPKR,
  inputClass,
  selectClass,
} from "./shared";

const RUN_STATUS_STYLES: Record<PayoutRunStatus, string> = {
  DRAFT: "bg-slate-50 text-slate-600 border-slate-200",
  PENDING_APPROVAL: "bg-amber-50 text-amber-800 border-amber-200",
  APPROVED: "bg-blue-50 text-blue-700 border-blue-200",
  PAID: "bg-emerald-600 text-white border-emerald-600",
  REJECTED: "bg-rose-50 text-rose-700 border-rose-200",
};

const RUN_STATUS_LABELS: Record<PayoutRunStatus, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Awaiting approval",
  APPROVED: "Approved",
  PAID: "Paid",
  REJECTED: "Rejected",
};

const PAYMENT_METHODS = ["Bank Transfer (IBFT)", "RTGS", "Cheque", "Payroll Credit"];

/** One figure in the run-scope strip. */
function ScopeStat({
  label,
  value,
  note,
  tone = "default",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "default" | "accent" | "muted";
}) {
  const valueClass = { default: "text-slate-900", accent: "text-blue-700", muted: "text-slate-400" }[tone];
  return (
    <div>
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${valueClass}`}>{value}</p>
      {note && <p className="text-[10px] text-slate-400">{note}</p>}
    </div>
  );
}

function download(filename: string, contents: string) {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Payout runs: commission is released in batches, and a batch has to be made by
 * one person and approved by another before any money moves.
 */
export default function PayoutRunsTab({
  runs,
  ledger,
  currentUser,
  onChanged,
  notify,
}: {
  runs: PayoutRun[];
  ledger: CommissionLedgerEntry[];
  currentUser: string;
  onChanged: () => void;
  notify: (msg: string, ok?: boolean) => void;
}) {
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [channel, setChannel] = useState<DistributionChannel | "ALL">("ALL");
  const [maker, setMaker] = useState(currentUser);
  const [approver, setApprover] = useState("");
  const [paymentMethod, setPaymentMethod] = useState(PAYMENT_METHODS[0]);
  const [expanded, setExpanded] = useState<string | null>(null);

  // A run pays tranches, not entries: only the stages whose release event has
  // happened are in scope, which is why an entry can appear in several runs.
  const eligible = collectDueStages(ledger, { channel });
  const eligibleNet = eligible.reduce((s, l) => s + l.stage.netAmount, 0);
  const eligiblePayees = new Set(eligible.map((l) => l.entry.payeeId)).size;
  const notYetDueNet = ledger
    .filter((e) => channel === "ALL" || e.channel === channel)
    .reduce((s, e) => s + e.pendingNet, 0);

  const act = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      notify(success);
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Action failed", false);
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Create Payout Run" subtitle="Batches every payable entry in scope; gated and held entries are left behind">
        <div className="p-5 grid grid-cols-1 md:grid-cols-4 gap-4">
          <Field label="Payout Period">
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Channel Scope">
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as DistributionChannel | "ALL")}
              className={selectClass}
            >
              <option value="ALL">All channels</option>
              {(Object.keys(CHANNEL_LABELS) as DistributionChannel[]).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Prepared By (maker)">
            <input value={maker} onChange={(e) => setMaker(e.target.value)} className={inputClass} />
          </Field>
          <div className="flex items-end">
            <button
              onClick={() =>
                act(
                  () => createPayoutRun({ period, channel, createdBy: maker }),
                  `Payout run created for ${period} — ${eligiblePayees} payees, ${fmtPKR(eligibleNet)} net.`,
                )
              }
              disabled={eligible.length === 0}
              className="w-full px-4 py-2 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-white font-medium text-xs rounded-lg transition-colors"
            >
              Create run · {eligible.length} tranches
            </button>
          </div>
        </div>
        {/* Scope summary reads as one line of figures, not four coloured boxes. */}
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/40 flex flex-wrap items-center gap-x-8 gap-y-2">
          <ScopeStat label="Tranches fallen due" value={String(eligible.length)} note={`across ${new Set(eligible.map((l) => l.entry.id)).size} entries`} />
          <ScopeStat label="Distinct payees" value={String(eligiblePayees)} />
          <ScopeStat label="Due now" value={fmtPKR(eligibleNet)} tone="accent" />
          <ScopeStat label="Not yet due" value={fmtPKR(notYetDueNet)} note="vests at later events" tone="muted" />
        </div>
      </Card>

      <Card title="Payout Runs" subtitle="Maker–checker: the approver must be a different user from the preparer">
        {runs.length === 0 ? (
          <EmptyState message="No payout runs yet. Create one above to batch the payable entries." />
        ) : (
          <div className="divide-y divide-slate-100">
            {runs.map((run) => {
              // Resolve the run's lines back to (entry, stage) pairs: an entry
              // may have one tranche here and another in a later run.
              const runLines = run.lines
                .map((line) => {
                  const entry = ledger.find((e) => e.id === line.entryId);
                  const stage = entry?.stages.find((s) => s.code === line.stageCode);
                  return entry && stage ? { entry, stage } : null;
                })
                .filter((x): x is { entry: CommissionLedgerEntry; stage: ReleaseStage } => x !== null);
              return (
                <div key={run.id} className="p-5 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-bold text-sm text-slate-900">{run.id}</span>
                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border ${RUN_STATUS_STYLES[run.status]}`}>
                          {RUN_STATUS_LABELS[run.status]}
                        </span>
                        <span className="text-[11px] font-semibold text-slate-600">
                          {run.period} · {run.channel === "ALL" ? "All channels" : CHANNEL_LABELS[run.channel]}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-1">
                        Prepared by <span className="font-bold">{run.createdBy}</span> on {run.createdAt}
                        {run.approvedBy && (
                          <>
                            {" · approved by "}
                            <span className="font-bold">{run.approvedBy}</span> on {run.approvedAt}
                          </>
                        )}
                        {run.paidAt && (
                          <>
                            {" · paid "}
                            {run.paidAt} via {run.paymentMethod} ({run.paymentReference})
                          </>
                        )}
                        {run.rejectedReason && <> · rejected: {run.rejectedReason}</>}
                      </p>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-right text-xs">
                      <div>
                        <p className="text-[10px] text-slate-500 font-semibold">Payees</p>
                        <p className="font-semibold tabular-nums text-slate-900">{run.payeeCount}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-500 font-semibold">Gross</p>
                        <p className="font-semibold tabular-nums text-slate-900">{fmtPKR(run.grossTotal)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-500 font-semibold">Deductions</p>
                        <p className="font-mono font-bold text-slate-600">- {fmtPKR(run.deductionsTotal + run.recoveryTotal)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-blue-900 font-semibold">Net</p>
                        <p className="font-semibold tabular-nums text-blue-700">{fmtPKR(run.netTotal)}</p>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {run.status === "DRAFT" && (
                      <button
                        onClick={() => act(() => submitPayoutRun(run.id), `${run.id} submitted for approval.`)}
                        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-bold text-[11px] rounded-lg shadow-xs"
                      >
                        Submit for Approval →
                      </button>
                    )}
                    {run.status === "PENDING_APPROVAL" && (
                      <>
                        <input
                          value={approver}
                          onChange={(e) => setApprover(e.target.value)}
                          placeholder="Approver name (not the preparer)"
                          className="px-2.5 py-1.5 border border-slate-300 rounded-lg text-[11px] min-w-[220px]"
                        />
                        <button
                          onClick={() => act(() => approvePayoutRun(run.id, approver), `${run.id} approved.`)}
                          className={btnAccent}
                        >
                          Approve
                        </button>
                        <button
                          onClick={() =>
                            act(() => rejectPayoutRun(run.id, "Rejected on review"), `${run.id} rejected — entries returned to payable.`)
                          }
                          className={btnDanger}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {run.status === "APPROVED" && (
                      <>
                        <select
                          value={paymentMethod}
                          onChange={(e) => setPaymentMethod(e.target.value)}
                          className="px-2.5 py-1.5 border border-slate-300 rounded-lg text-[11px] bg-white"
                        >
                          {PAYMENT_METHODS.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => act(() => payPayoutRun(run.id, paymentMethod), `${run.id} released — ${run.payeeCount} payees paid.`)}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium rounded-lg transition-colors"
                        >
                          Release Payment
                        </button>
                      </>
                    )}
                    <button
                      onClick={async () => {
                        try {
                          download(`${run.id}-payout-file.csv`, await buildPayoutFile(run.id));
                          notify(`${run.id} bank payment file downloaded.`);
                        } catch (err) {
                          notify(err instanceof Error ? err.message : "Export failed", false);
                        }
                      }}
                      className={btnGhost}
                    >
                      ↓ Bank File
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          download(`${run.id}-gl-journal.csv`, await buildGlJournal(run.id));
                          notify(`${run.id} GL journal downloaded.`);
                        } catch (err) {
                          notify(err instanceof Error ? err.message : "Export failed", false);
                        }
                      }}
                      className={btnGhost}
                    >
                      ↓ GL Journal
                    </button>
                    <button
                      onClick={() => setExpanded(expanded === run.id ? null : run.id)}
                      className={btnGhost}
                    >
                      {expanded === run.id ? "Hide" : "Show"} {run.stageCount} tranches
                    </button>
                  </div>

                  {expanded === run.id && (
                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px]">
                          <tr>
                            <th className="p-3">Entry</th>
                            <th className="p-3">Payee</th>
                            <th className="p-3">Policy</th>
                            <th className="p-3">Tranche</th>
                            <th className="p-3 text-right">Gross</th>
                            <th className="p-3 text-right">Deductions</th>
                            <th className="p-3 text-right">Recovery</th>
                            <th className="p-3 text-right">Net</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {runLines.map(({ entry, stage }) => (
                            <tr key={`${entry.id}-${stage.code}`}>
                              <td className="p-3 font-mono text-[10px] text-blue-900 font-bold">{entry.id}</td>
                              <td className="p-3">
                                <p className="font-bold text-slate-900">{entry.payeeName}</p>
                                <PayeeTypeBadge type={entry.payeeType} />
                              </td>
                              <td className="p-3 font-mono text-[10px] text-slate-500">{entry.policyNumber}</td>
                              <td className="p-3">
                                <p className="font-semibold text-slate-800">{stage.label}</p>
                                <p className="text-[10px] text-slate-400">
                                  {stage.sharePct}% of {fmtPKR(entry.netCommission)}
                                </p>
                              </td>
                              <td className="p-3 text-right font-mono">{fmtPKR(stage.grossAmount)}</td>
                              <td className="p-3 text-right font-mono text-slate-500">- {fmtPKR(stage.deductionAmount)}</td>
                              <td className="p-3 text-right font-mono text-rose-600">
                                {stage.recoveryAmount > 0 ? `- ${fmtPKR(stage.recoveryAmount)}` : "—"}
                              </td>
                              <td className="p-3 text-right font-mono font-bold text-blue-700">{fmtPKR(stage.netAmount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
