"use client";

import type { PremiumBreakdown } from "@/app/services/initialPremiumPayment";
import { tx } from "@/lib/i18n/tx";

const pkr = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;

/** How a premium is made up: base, loading, policy fee, stamp duty, sales tax, and the total. */
export function BreakdownTable({ b, compact = false }: { b: PremiumBreakdown; compact?: boolean }) {
  const rows: [string, number][] = [
    [tx("Base premium"), b.base_premium], [tx("Loading"), b.loading_amount], [tx("Policy fee"), b.policy_fee],
    [tx("Stamp duty"), b.stamp_duty_amount], [tx("Sales tax"), b.tax_amount],
  ];
  return (
    <dl className={`rounded-lg border border-slate-200 bg-white ${compact ? "text-xs" : "text-sm"}`}>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 border-b border-slate-100 px-3 py-1.5"><dt className="text-slate-500">{k}</dt><dd className="font-mono font-medium text-slate-800">{pkr(v)}</dd></div>
      ))}
      <div className="flex justify-between gap-4 rounded-b-lg bg-blue-50/60 px-3 py-2"><dt className="font-semibold text-slate-800">{tx("Total premium")}</dt><dd className="font-mono font-bold text-blue-700">{pkr(b.total_premium)}</dd></div>
    </dl>
  );
}
