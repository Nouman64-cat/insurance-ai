"use client";

import React, { useState } from "react";
import {
  INCENTIVE_SCHEMES,
  IncentiveQualification,
  PAYEE_TYPE_LABELS,
  awardIncentive,
} from "../../app/services/commissions";
import { Card, EmptyState, PayeeTypeBadge, fmtPKR } from "./shared";

type IncentiveSubTab = "schemes" | "qualified" | "shortfall";

/**
 * Performance bonuses & policy retention rewards evaluated on book volume
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
  const [subTab, setSubTab] = useState<IncentiveSubTab>("schemes");
  const [search, setSearch] = useState("");

  const qualified = qualifications.filter((q) => q.qualifies && q.awardAmount > 0);
  const shortfall = qualifications.filter((q) => !q.qualifies);

  const award = async (q: IncentiveQualification) => {
    try {
      await awardIncentive(q);
      notify(`${q.scheme.name} bonus of ${fmtPKR(q.awardAmount)} added to ${q.payee.name}'s payout ledger.`);
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not process bonus payout", false);
    }
  };

  const filteredSchemes = INCENTIVE_SCHEMES.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.code.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.metric.toLowerCase().includes(q)
    );
  });

  const filteredQualified = qualified.filter((q) => {
    if (!search.trim()) return true;
    const query = search.toLowerCase();
    return (
      q.payee.name.toLowerCase().includes(query) ||
      q.payee.code.toLowerCase().includes(query) ||
      q.scheme.name.toLowerCase().includes(query)
    );
  });

  const filteredShortfall = shortfall.filter((q) => {
    if (!search.trim()) return true;
    const query = search.toLowerCase();
    return (
      q.payee.name.toLowerCase().includes(query) ||
      q.payee.code.toLowerCase().includes(query) ||
      q.scheme.name.toLowerCase().includes(query)
    );
  });

  return (
    <div className="space-y-4">
      {/* 3-Category Control Bar */}
      <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex p-0.5 rounded-xl bg-slate-100 border border-slate-200/60">
            {(
              [
                ["schemes", "Bonus Plans & Rules"],
                ["qualified", `Earned Bonuses (${qualified.length})`],
                ["shortfall", `In-Progress Goals (${shortfall.length})`],
              ] as [IncentiveSubTab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSubTab(key)}
                className={`px-3.5 py-1.5 text-xs font-bold rounded-lg transition-all ${subTab === key
                  ? "bg-blue-600 text-white shadow-xs"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-200/50"
                  }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 flex-1 max-w-md">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agent, payee, or bonus plan..."
              className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-hidden focus:border-blue-500 text-slate-800 placeholder-slate-400"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="text-xs text-slate-400 hover:text-slate-600 font-bold px-1.5"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {subTab === "schemes" && (
        <Card title="Bonus Plans & Rules">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                <tr>
                  <th className="p-3">Bonus Plan</th>
                  <th className="p-3">Eligible Roles</th>
                  <th className="p-3">Target Metric</th>
                  <th className="p-3">Required Goal</th>
                  <th className="p-3">Bonus Reward</th>
                  <th className="p-3">Evaluation Period</th>
                  <th className="p-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredSchemes.map((s) => (
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
                      {s.rewardAmount !== null ? fmtPKR(s.rewardAmount) : `${s.rewardPct}% of 1st-Year Earnings`}
                    </td>
                    <td className="p-3 text-[10px] text-slate-500">{s.measuredAt}</td>
                    <td className="p-3 text-center">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold border bg-emerald-50 text-emerald-700 border-emerald-200">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        {s.active ? "Active Plan" : "Inactive"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {subTab === "qualified" && (
        <Card
          title="Earned Bonuses (Ready to Pay)"
        // subtitle="Approved bonuses earned by agents — click 'Add to Earnings' to add this bonus to the payout ledger"
        >
          {filteredQualified.length === 0 ? (
            <EmptyState message="No agents currently qualify for an uncollected bonus." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                  <tr>
                    <th className="p-3">Payee</th>
                    <th className="p-3">Role</th>
                    <th className="p-3">Bonus Plan</th>
                    <th className="p-3 text-right">Achieved Value</th>
                    <th className="p-3 text-right">Required Goal</th>
                    <th className="p-3 text-right">Bonus Reward</th>
                    <th className="p-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredQualified.map((q) => (
                    <tr key={`${q.payee.id}-${q.scheme.id}`} className="hover:bg-slate-50/70">
                      <td className="p-3">
                        <p className="font-bold text-slate-900">{q.payee.name}</p>
                        <p className="text-[10px] font-mono text-slate-400">{q.payee.code}</p>
                      </td>
                      <td className="p-3">
                        <PayeeTypeBadge type={q.payee.type} />
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
                          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-bold text-[10px] rounded-lg shadow-xs"
                        >
                          Add to Earnings →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {subTab === "shortfall" && (
        <Card title="In-Progress Sales & Retention Goals">
          {filteredShortfall.length === 0 ? (
            <EmptyState message="All active agents have reached their bonus targets." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50/80 text-slate-500 font-medium uppercase tracking-wider text-[10px] border-b border-slate-200">
                  <tr>
                    <th className="p-3">Payee</th>
                    <th className="p-3">Role</th>
                    <th className="p-3">Bonus Plan</th>
                    <th className="p-3 text-right">Current Achievement</th>
                    <th className="p-3 text-right">Required Goal</th>
                    <th className="p-3">Completion Progress</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredShortfall.map((q) => {
                    const pct = q.scheme.threshold > 0 ? Math.min(100, (q.metricValue / q.scheme.threshold) * 100) : 0;
                    const isPersistency = q.scheme.kind === "PERSISTENCY_BONUS";
                    return (
                      <tr key={`${q.payee.id}-${q.scheme.id}`} className="hover:bg-slate-50/70">
                        <td className="p-3">
                          <p className="font-bold text-slate-900">{q.payee.name}</p>
                          <p className="text-[10px] font-mono text-slate-400">{q.payee.code}</p>
                        </td>
                        <td className="p-3">
                          <PayeeTypeBadge type={q.payee.type} />
                        </td>
                        <td className="p-3 font-semibold text-slate-800">{q.scheme.name}</td>
                        <td className="p-3 text-right font-mono text-slate-700">
                          {isPersistency ? `${q.metricValue}%` : fmtPKR(q.metricValue)}
                        </td>
                        <td className="p-3 text-right font-mono text-slate-500">{q.scheme.thresholdLabel}</td>
                        <td className="p-3 w-40">
                          <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                            <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                          </div>
                          <p className="text-[10px] text-slate-400 mt-1">{pct.toFixed(0)}% reached</p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
