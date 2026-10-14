"use client";

import { useEffect, useState } from "react";
import { displayDate } from "../../lib/dateDisplay";
import { getPolicyReceipt, type PaymentReceipt } from "@/app/services/initialPremiumPayment";
import { tx } from "@/lib/i18n/tx";

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
    </table><script>window.onload=()=>window.print()</script>`);
  w.document.close();
}

/** A simple receipt for the initial premium: shown once the payment has been received. */
export function ReceiptCard({ policyId }: { policyId: string }) {
  const [r, setR] = useState<PaymentReceipt | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { getPolicyReceipt(policyId).then(setR).catch(() => setFailed(true)); }, [policyId]);
  if (failed) return null;
  if (!r) return <div className="h-24 rounded-lg border border-slate-200 bg-white animate-pulse" />;
  const rows: [string, string][] = [
    [tx("Received from"), r.customer_name ?? "—"], [tx("For"), `${r.plan_label ?? "—"} — ${tx("initial premium")}`], [tx("Date received"), displayDate(r.received_at)],
    [tx("Paid by"), r.method ?? "—"], [tx("Reference"), r.reference ?? "—"], [tx("Confirmed by"), r.confirmed_by ?? "—"],
  ];
  return (
    <div className="rounded-lg border border-emerald-200 bg-white text-xs text-slate-600">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 border-b border-emerald-100 bg-emerald-50/60 rounded-t-lg">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">{tx("Payment receipt")}</p>
          <p className="text-sm font-bold text-slate-900 font-mono">{r.receipt_no}</p>
        </div>
        <button type="button" onClick={() => printReceipt(r)} className="px-3 py-1.5 text-[11px] font-semibold rounded-md bg-white text-emerald-700 border border-emerald-200 hover:bg-emerald-50">{tx("Print / save PDF")}</button>
      </div>
      <dl className="px-3.5 py-2.5 divide-y divide-slate-100">
        {rows.map(([k, v]) => <div key={k} className="flex justify-between gap-4 py-1.5"><dt className="text-slate-400">{k}</dt><dd className="font-medium text-slate-800 text-end">{v}</dd></div>)}
        <div className="flex justify-between gap-4 pt-2"><dt className="font-semibold text-slate-700">{tx("Amount received")}</dt><dd className="text-sm font-bold text-emerald-700">{pkr(r.amount)}</dd></div>
      </dl>
    </div>
  );
}
