"use client";

import type { PremiumBreakdown } from "@/app/services/initialPremiumPayment";
import { tx } from "@/lib/i18n/tx";

const pkr = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;

/** How a premium is made up: base, loading, policy fee, stamp duty, sales tax, and the total. */
export function BreakdownTable({ b, compact = false }: { b: PremiumBreakdown; compact?: boolean }) {
  // A split premium (paid in two parts) is quoted without loading: underwriting decides it, and it is added at policy issuance.
  const loadingLater = !!b.split && b.split.remaining_amount > 0 && !b.loading_amount;
  const rows: [string, number][] = [
    [tx("Base premium"), b.base_premium], ...(loadingLater ? [] : [[tx("Loading"), b.loading_amount] as [string, number]]), [tx("Policy fee"), b.policy_fee],
    [tx("Stamp duty"), b.stamp_duty_amount], [tx("Sales tax"), b.tax_amount],
  ];
  return (
    <dl className={`rounded-lg border border-slate-200 bg-white ${compact ? "text-xs" : "text-sm"}`}>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 border-b border-slate-100 px-3 py-1.5"><dt className="text-slate-500">{k}</dt><dd className="font-mono font-medium text-slate-800">{pkr(v)}</dd></div>
      ))}
      <div className={`flex justify-between gap-4 bg-blue-50/60 px-3 py-2 ${b.split && b.split.remaining_amount > 0 ? "" : "rounded-b-lg"}`}><dt className="font-semibold text-slate-800">{tx("Total premium")}</dt><dd className="font-mono font-bold text-blue-700">{pkr(b.total_premium)}</dd></div>
      {b.split && b.split.remaining_amount > 0 && (
        <>
          <div className="flex justify-between gap-4 border-t border-slate-100 bg-emerald-50/60 px-3 py-1.5"><dt className="font-semibold text-emerald-800">{tx("Pay now ({0}%)", { 0: b.split.upfront_pct })}</dt><dd className="font-mono font-bold text-emerald-700">{pkr(b.split.upfront_amount)}</dd></div>
          <div className="flex justify-between gap-4 bg-amber-50/60 px-3 py-1.5"><dt className="text-amber-800">{tx("At policy issuance ({0}%)", { 0: b.split.remaining_pct })}</dt><dd className="font-mono font-medium text-amber-700">{pkr(b.split.remaining_amount)}</dd></div>
          {loadingLater && <div className="rounded-b-lg border-t border-amber-100 bg-amber-50/60 px-3 py-1.5 text-amber-800">{tx("+ Loading, if underwriting adds any — charged only at policy issuance, with the remaining {0}%.", { 0: b.split.remaining_pct })}</div>}
        </>
      )}
    </dl>
  );
}
