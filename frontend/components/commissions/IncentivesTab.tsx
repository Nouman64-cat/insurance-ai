"use client";

import React from "react";
import {
  INCENTIVE_SCHEMES,
  IncentiveQualification,
  PAYEE_TYPE_LABELS,
  awardIncentive,
} from "../../app/services/commissions";
import { Card, EmptyState, PayeeTypeBadge, fmtPKR } from "./shared";

/**
 * Incentives sit alongside commission rather than inside it: persistency and
 * production bonuses are earned on a book of business, not on a single premium,
 * so they are evaluated per payee and posted as their own ledger entries.
 */
export default function IncentivesTab({
  qualifications,
  onChanged,
  notify,
}: {
  qualifications: IncentiveQualification[];
  onChanged: () => void;
  notify: (msg: string, ok?: boolean) => void;
}) {
  const qualified = qualifications.filter((q) => q.qualifies && q.awardAmount > 0);
  const shortfall = qualifications.filter((q) => !q.qualifies);

  const award = async (q: IncentiveQualification) => {
    try {
      await awardIncentive(q);
      notify(`${q.scheme.name} of ${fmtPKR(q.awardAmount)} posted to ${q.payee.name}'s ledger as payable.`);
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not award the incentive", false);
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Incentive Schemes" subtitle="Bonus programmes evaluated on the book, not on individual premiums">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
              <tr>
                <th className="p-3">Scheme</th>
                <th className="p-3">Eligible Payees</th>
                <th className="p-3">Qualifying Metric</th>
                <th className="p-3">Threshold</th>
                <th className="p-3">Reward</th>
                <th className="p-3">Measured</th>
                <th className="p-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {INCENTIVE_SCHEMES.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50/70">
                  <td className="p-3">
                    <p className="font-bold text-slate-900">{s.name}</p>
                    <p className="font-mono text-[10px] text-slate-400">{s.code}</p>
                    <p className="text-[10px] text-slate-500 mt-0.5 max-w-md">{s.description}</p>
                  </td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1">
                      {s.payeeTypes.map((t) => (
                        <PayeeTypeBadge key={t} type={t} />
                      ))}
                    </div>
                  </td>
                  <td className="p-3 text-slate-700 font-semibold">{s.metric}</td>
                  <td className="p-3 font-semibold tabular-nums text-slate-900">{s.thresholdLabel}</td>
                  <td className="p-3 font-mono font-bold text-blue-700">
                    {s.rewardAmount !== null ? fmtPKR(s.rewardAmount) : `${s.rewardPct}% of FY commission`}
                  </td>
                  <td className="p-3 text-[10px] text-slate-500">{s.measuredAt}</td>
                  <td className="p-3 text-center">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      {s.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Qualified for Award"
        subtitle="Awarding posts a payable bonus entry against the payee — withheld and released like any other commission"
      >
        {qualified.length === 0 ? (
          <EmptyState message="No payee currently clears a scheme threshold." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                <tr>
                  <th className="p-3">Payee</th>
                  <th className="p-3">Scheme</th>
                  <th className="p-3 text-right">Metric</th>
                  <th className="p-3 text-right">Threshold</th>
                  <th className="p-3 text-right">Award</th>
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {qualified.map((q) => (
                  <tr key={`${q.payee.id}-${q.scheme.id}`} className="hover:bg-slate-50/70">
                    <td className="p-3">
                      <p className="font-bold text-slate-900">{q.payee.name}</p>
                      <p className="text-[10px] font-mono text-slate-400">{q.payee.code}</p>
                      <div className="mt-1">
                        <PayeeTypeBadge type={q.payee.type} />
                      </div>
                    </td>
                    <td className="p-3">
                      <p className="font-semibold text-slate-800">{q.scheme.name}</p>
                      <p className="text-[10px] text-slate-400">{q.scheme.metric}</p>
                    </td>
                    <td className="p-3 text-right font-mono font-bold text-emerald-700">
                      {q.scheme.kind === "PERSISTENCY_BONUS" ? `${q.metricValue}%` : fmtPKR(q.metricValue)}
                    </td>
                    <td className="p-3 text-right font-mono text-slate-500">{q.scheme.thresholdLabel}</td>
                    <td className="p-3 text-right font-semibold tabular-nums text-blue-700">{fmtPKR(q.awardAmount)}</td>
                    <td className="p-3 text-right">
                      <button
                        onClick={() => award(q)}
                        className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-bold text-[10px] rounded-lg"
                      >
                        Award to Ledger →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Not Yet Qualifying" subtitle="How far each payee is from the next scheme threshold">
        {shortfall.length === 0 ? (
          <EmptyState message="Every eligible payee currently qualifies." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                <tr>
                  <th className="p-3">Payee</th>
                  <th className="p-3">Type</th>
                  <th className="p-3">Scheme</th>
                  <th className="p-3 text-right">Current</th>
                  <th className="p-3 text-right">Needs</th>
                  <th className="p-3">Progress</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shortfall.map((q) => {
                  const pct = q.scheme.threshold > 0 ? Math.min(100, (q.metricValue / q.scheme.threshold) * 100) : 0;
                  const isPersistency = q.scheme.kind === "PERSISTENCY_BONUS";
                  return (
                    <tr key={`${q.payee.id}-${q.scheme.id}`} className="hover:bg-slate-50/70">
                      <td className="p-3">
                        <p className="font-bold text-slate-900">{q.payee.name}</p>
                        <p className="text-[10px] font-mono text-slate-400">{q.payee.code}</p>
                      </td>
                      <td className="p-3 text-[10px] text-slate-500">{PAYEE_TYPE_LABELS[q.payee.type]}</td>
                      <td className="p-3 font-semibold text-slate-800">{q.scheme.name}</td>
                      <td className="p-3 text-right font-mono text-slate-700">
                        {isPersistency ? `${q.metricValue}%` : fmtPKR(q.metricValue)}
                      </td>
                      <td className="p-3 text-right font-mono text-slate-500">{q.scheme.thresholdLabel}</td>
                      <td className="p-3 w-40">
                        <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                          <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1">{pct.toFixed(0)}% of threshold</p>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
