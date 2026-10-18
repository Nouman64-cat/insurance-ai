"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listFinancePayments, type FinancePayment } from "@/app/services/claims";
import { tx } from "@/lib/i18n/tx";
import { displayDate } from "@/lib/dateDisplay";
import { money } from "./paymentQueue";

export default function PaymentRegister({ refreshKey }: {refreshKey: string}) {
  const [rows, setRows] = useState<FinancePayment[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setLoading(true); setError("");
    const timer = setTimeout(() => {
      listFinancePayments({search: search || undefined, payment_status: status || undefined, offset, limit: 25})
        .then(data => {if (current) {setRows(data.items); setTotal(data.total);}})
        .catch((e: any) => {if (current) setError(typeof e?.response?.data?.detail === "string" ? e.response.data.detail : tx("Could not load payments. Please retry."));})
        .finally(() => {if (current) setLoading(false);});
    }, 200);
    return () => {current = false; clearTimeout(timer);};
  }, [search, status, offset, refreshKey]);
  return <section className="overflow-hidden rounded-xl border bg-white shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
      <div><h2 className="font-bold text-slate-900">{tx("Payment register")}</h2><p className="mt-1 text-xs text-slate-500">{tx("Payments recorded outside the system, with their reference and status.")}</p></div>
      <div className="flex flex-wrap gap-2"><input aria-label={tx("Search payment records")} placeholder={tx("Search claim, payee or reference…")} value={search} onChange={e=>{setSearch(e.target.value);setOffset(0);}} className="rounded-lg border px-3 py-2 text-sm" />
        <select aria-label={tx("Payment status")} value={status} onChange={e=>{setStatus(e.target.value);setOffset(0);}} className="rounded-lg border bg-white px-3 py-2 text-sm"><option value="">{tx("All payment statuses")}</option><option value="Settled">{tx("Paid")}</option><option value="Initiated">{tx("Initiated")}</option><option value="Failed">{tx("Failed")}</option></select></div>
    </div>
    {error && <p role="alert" className="p-4 text-sm text-red-700">{error}</p>}
    {!error && <div className="overflow-x-auto" aria-busy={loading}><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{["Reference","Claim / policy","Payee","Method","Amount","Payment status","Paid on",""].map((h,i)=><th key={i} className="px-5 py-3">{tx(h)}</th>)}</tr></thead><tbody className="divide-y">{rows.map(p=><tr key={p.id}>
      <td className="px-5 py-4 font-mono text-xs">{p.reference_number || "—"}</td><td className="px-5 py-4"><p className="font-semibold">{p.claim_number}</p><p className="text-xs text-slate-500">{p.policy_number}</p></td>
      <td className="px-5 py-4">{p.payee_name || "—"}</td><td className="px-5 py-4">{p.method}</td><td className="whitespace-nowrap px-5 py-4 font-semibold">{money(p.amount)}</td>
      <td className="px-5 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${p.status === "Settled" ? "bg-emerald-50 text-emerald-700" : p.status === "Failed" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>{tx(p.status === "Settled" ? "Paid" : p.status)}</span></td>
      <td className="px-5 py-4 text-xs text-slate-500">{p.completed_at ? displayDate(p.completed_at) : "—"}</td><td className="px-5 py-4"><Link className="whitespace-nowrap font-semibold text-blue-600" href={`/claims/${p.claim_id}`}>{tx("View payment →")}</Link></td>
    </tr>)}</tbody></table>{!rows.length && <p className="p-10 text-center text-sm text-slate-500">{tx(loading ? "Loading payments…" : "No matching payments")}</p>}</div>}
    <div className="flex items-center justify-between border-t px-5 py-3 text-xs text-slate-500"><span>{total} {tx("payments")}</span><div className="flex gap-3"><button disabled={loading || offset===0} onClick={()=>setOffset(Math.max(0,offset-25))} className="disabled:opacity-40">{tx("Previous")}</button><button disabled={loading || offset+25>=total} onClick={()=>setOffset(offset+25)} className="disabled:opacity-40">{tx("Next")}</button></div></div>
  </section>;
}
