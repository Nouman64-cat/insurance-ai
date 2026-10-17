"use client";

import { useEffect, useState } from "react";
import { displayDate } from "../../lib/dateDisplay";
import { getPolicyReceipt, type PaymentReceipt } from "@/app/services/initialPremiumPayment";
import { tx } from "@/lib/i18n/tx";
import { BreakdownTable } from "./BreakdownTable";

const pkr = (n: number) => `PKR ${Math.round(n).toLocaleString()}`;
const esc = (v: unknown) => String(v ?? "—").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Opens the receipt on its own, ready to print or save as PDF. */
function printReceipt(r: PaymentReceipt) {
  const w = window.open("", "_blank", "width=520,height=640");
  if (!w) return;
  w.document.write(`<!doctype html><title>${esc(r.receipt_no)}</title><style>body{font:14px system-ui,sans-serif;margin:32px;color:#0f172a}h1{font-size:18px;margin:0}
    p.s{color:#64748b;margin:2px 0 18px}table{width:100%;border-collapse:collapse}td{padding:8px 0;border-bottom:1px solid #e2e8f0}td:first-child{color:#64748b;width:42%}
    .t td{font-weight:700;font-size:16px;border-bottom:2px solid #0f172a}</style>
    <h1>${esc(r.insurer.name)}</h1><p class="s">${esc(tx("Payment receipt"))} · ${esc(r.receipt_no)}</p>
    <table>
      <tr><td>${esc(tx("Received from"))}</td><td>${esc(r.customer_name)}</td></tr>
      <tr><td>${esc(tx("For"))}</td><td>${esc(r.plan_label)} — ${esc(tx("initial premium"))}</td></tr>
      <tr><td>${esc(tx("Date received"))}</td><td>${esc(displayDate(r.received_at))}</td></tr>
      <tr><td>${esc(tx("Paid by"))}</td><td>${esc(r.method)}</td></tr>
      <tr><td>${esc(tx("Reference"))}</td><td>${esc(r.reference)}</td></tr>
      <tr><td>${esc(tx("Confirmed by"))}</td><td>${esc(r.confirmed_by)}</td></tr>
      <tr class="t"><td>${esc(tx("Amount received"))}</td><td>${esc(pkr(r.amount))}</td></tr>
    </table>${r.breakdown ? `<p class="s" style="margin-top:18px">${esc(tx("How the amount is made up"))}</p><table>
      <tr><td>${esc(tx("Base premium"))}</td><td>${esc(pkr(r.breakdown.base_premium))}</td></tr>
      <tr><td>${esc(tx("Loading"))}</td><td>${esc(pkr(r.breakdown.loading_amount))}</td></tr>
      <tr><td>${esc(tx("Policy fee"))}</td><td>${esc(pkr(r.breakdown.policy_fee))}</td></tr>
      <tr><td>${esc(tx("Stamp duty"))}</td><td>${esc(pkr(r.breakdown.stamp_duty_amount))}</td></tr>
      <tr><td>${esc(tx("Sales tax"))}</td><td>${esc(pkr(r.breakdown.tax_amount))}</td></tr></table>` : ""}<script>window.onload=()=>window.print()</script>`);
  w.document.close();
}

/** A simple receipt for the initial premium: shown once the payment has been received. */
export function ReceiptCard({ policyId }: { policyId: string }) {
  const [r, setR] = useState<PaymentReceipt | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  useEffect(() => { getPolicyReceipt(policyId).then(setR).catch(() => setFailed(true)); }, [policyId]);
  if (failed) return null;
  if (!r) return <div className="h-24 rounded-lg border border-slate-200 bg-white animate-pulse" />;
  const rows: [string, string][] = [
    [tx("Received from"), r.customer_name ?? "—"], [tx("For"), `${r.plan_label ?? "—"} — ${tx("initial premium")}`], [tx("Date received"), displayDate(r.received_at)],
    [tx("Paid by"), r.method ?? "—"], [tx("Reference"), r.reference ?? "—"], [tx("Confirmed by"), r.confirmed_by ?? "—"],
  ];
  const split = r.breakdown?.split && r.breakdown.split.remaining_amount > 0 ? r.breakdown.split : null;
  const chevron = (o: boolean) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-300 ${o ? "rotate-180" : ""}`}><polyline points="6 9 12 15 18 9" /></svg>
  );
  return (
    <div className="overflow-hidden rounded-2xl border border-emerald-200/80 bg-white text-sm text-slate-600 shadow-sm shadow-emerald-900/5">
      {/* Summary: always visible, one line. Everything else is one click away. */}
      <button
        type="button"
        onClick={() => setShowDetails((o) => !o)}
        aria-expanded={showDetails}
        aria-controls="receipt-details"
        className="flex w-full items-center gap-3 bg-gradient-to-r from-emerald-50 to-white px-4 py-3 text-start transition-colors hover:from-emerald-100/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white shadow-sm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><polyline points="20 6 9 17 4 12" /></svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-semibold uppercase tracking-wider text-emerald-700">{tx("Initial premium received")}</span>
          <span className="block truncate font-mono text-xs text-slate-500">{r.receipt_no}</span>
        </span>
        <span className="text-lg font-extrabold tracking-tight text-emerald-700 tabular-nums">{pkr(r.amount)}</span>
        {chevron(showDetails)}
      </button>

      <div id="receipt-details" className={`grid transition-all duration-300 ease-out ${showDetails ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`} aria-hidden={!showDetails}>
        <div className="overflow-hidden">
          <div className="border-t border-emerald-100">
            {split && (
              <p className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                {tx("{0}% of the premium has been paid. The remaining {1}% (PKR {2}) is paid at policy issuance.", { 0: split.upfront_pct, 1: split.remaining_pct, 2: Math.round(split.remaining_amount).toLocaleString() })}
              </p>
            )}
            <dl className="grid gap-x-8 px-4 py-2 sm:grid-cols-2">
              {rows.map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-4 border-b border-slate-100 py-2 last:border-0 sm:[&:nth-last-child(2):nth-child(odd)]:border-0">
                  <dt className="text-xs text-slate-400">{k}</dt>
                  <dd className="text-end text-[13px] font-semibold text-slate-800">{v}</dd>
                </div>
              ))}
            </dl>

            <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-3">
              {r.breakdown && (
                <button
                  type="button"
                  onClick={() => setOpen((o) => !o)}
                  aria-expanded={open}
                  aria-controls="receipt-breakdown"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-1.5 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  {open ? tx("Hide payment breakdown") : tx("View payment breakdown")}
                  {chevron(open)}
                </button>
              )}
              <button type="button" onClick={() => printReceipt(r)} className="ms-auto inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 shadow-sm transition-colors hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><polyline points="6 9 6 2 18 2 18 9" /><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2" /><rect x="6" y="14" width="12" height="8" /></svg>
                {tx("Print / save PDF")}
              </button>
            </div>
            {r.breakdown && (
              <div id="receipt-breakdown" className={`grid transition-all duration-300 ease-out ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`} aria-hidden={!open}>
                <div className="overflow-hidden px-4"><div className="pb-4"><BreakdownTable b={r.breakdown} compact /></div></div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
