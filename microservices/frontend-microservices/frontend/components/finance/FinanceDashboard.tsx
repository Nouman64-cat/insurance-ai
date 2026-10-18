"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { listClaims, type Claim } from "@/app/services/claims";
import { tx } from "@/lib/i18n/tx";

import { money, paymentQueue } from "./paymentQueue";

export default function FinanceDashboard() {
  const params = useSearchParams();
  const view = ["history", "reconciliation"].includes(params.get("view") ?? "") ? params.get("view")! : "payouts";
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [updated, setUpdated] = useState("");
  async function refresh() {
    setLoading(true); setError("");
    try { setClaims(await listClaims()); setUpdated(new Date().toLocaleTimeString()); }
    catch (e: any) { setError(e.response?.data?.detail || tx("Could not load payments. Please retry.")); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  const pending = paymentQueue(claims, "payouts", "");
  const paid = paymentQueue(claims, "history", "");
  const reconciliation = paymentQueue(claims, "reconciliation", "");
  const rows = paymentQueue(claims, view, search);
  return <main className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div><p className="text-xs font-bold uppercase tracking-widest text-blue-600">{tx("Finance workspace")}</p>
        <h1 className="mt-2 text-3xl font-bold text-slate-900">{tx("Payments dashboard")}</h1>
        <p className="mt-2 text-sm text-slate-500">{tx("Review approved claims, execute authorised payouts and reconcile payments.")}</p></div>
      <button onClick={refresh} disabled={loading} className="rounded-lg border bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50">{loading ? tx("Loading…") : tx("Refresh")}</button>
    </header>
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {[{label:"Awaiting payout", value:String(pending.length), hint:"Approved claims awaiting payment"},
        {label:"Approved amount pending", value:money(pending.reduce((s,c)=>s+c.approved_amount,0)),hint:"Subject to payment authorisation"},
        {label:"Recorded payments",value:money(paid.reduce((s,c)=>s+(c.settlement_amount ?? 0),0)),hint:"Total paid across settled and closed claims"},
        {label:"To reconcile",value:String(reconciliation.length),hint:"Settled claims awaiting reconciliation"}].map(m=><div key={m.label} className="rounded-xl border bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500">{tx(m.label)}</p><p className="mt-3 text-2xl font-bold tracking-tight text-slate-900">{loading && !updated ? "—" : m.value}</p><p className="mt-2 text-xs text-slate-500">{tx(m.hint)}</p>
        </div>)}
    </div>
    <section className="overflow-hidden rounded-xl border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b p-5">
        <nav aria-label={tx("Payment queues")} className="flex gap-2">
          {[{id:"payouts",label:"Awaiting payout",count:pending.length},{id:"reconciliation",label:"To reconcile",count:reconciliation.length},{id:"history",label:"Payment history",count:paid.length}].map(tab=><Link key={tab.id} href={`/finance?view=${tab.id}`} aria-current={view===tab.id?"page":undefined} className={`rounded-lg px-4 py-2 text-sm font-semibold ${view===tab.id?"bg-blue-50 text-blue-700":"text-slate-500 hover:bg-slate-50"}`}>{tx(tab.label)} · {tab.count}</Link>)}
        </nav>
        <input aria-label={tx("Search payments")} value={search} onChange={e=>setSearch(e.target.value)} placeholder={tx("Search claim, policy or payee…")} className="w-full rounded-lg border px-3 py-2 text-sm sm:w-72" />
      </div>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{["Claim / policy","Policyholder / claimant","Approved","Paid","Status",""].map((h,i)=><th key={i} className="px-5 py-3 font-semibold">{tx(h)}</th>)}</tr></thead>
        <tbody className="divide-y">{rows.map(c=><tr key={c.id} className="hover:bg-slate-50">
          <td className="px-5 py-4"><p className="font-semibold text-slate-900">{c.claim_number}</p><p className="mt-1 text-xs text-slate-500">{c.policy_number} · {c.claim_type}</p></td>
          <td className="px-5 py-4"><p>{c.customer_name || "—"}</p><p className="mt-1 text-xs text-slate-500">{tx("Claimant")}: {c.claimant_name}</p></td>
          <td className="whitespace-nowrap px-5 py-4 font-semibold">{money(c.approved_amount)}</td><td className="whitespace-nowrap px-5 py-4">{money(c.settlement_amount ?? 0)}</td>
          <td className="px-5 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${view==="history"?"bg-emerald-50 text-emerald-700":"bg-amber-50 text-amber-700"}`}>{view==="history"?tx(c.status):tx(view==="reconciliation"?"To reconcile":c.finance_summary?.authorized_at?"Authorised":"Awaiting authorisation")}</span></td>
          <td className="px-5 py-4"><Link href={`/claims/${c.id}`} className="whitespace-nowrap font-semibold text-blue-600">{tx(view==="history"?"View payment →":view==="reconciliation"?"Reconcile →":"Review payment →")}</Link></td>
        </tr>)}</tbody>
      </table></div>
      {!rows.length && <div className="p-12 text-center"><p className="font-semibold text-slate-700">{loading?tx("Loading payments…"):tx(search?"No matching payments":view==="history"?"No recorded payments yet":view==="reconciliation"?"No payments awaiting reconciliation":"No claims awaiting payout")}</p><p className="mt-2 text-sm text-slate-500">{tx("Approved claims appear here after the claims team records its decision.")}</p></div>}
    </section>
    <p className="text-xs text-slate-500">{tx("Claims Managers authorise settlements. Finance executes and reconciles payments.")}{updated && ` · ${tx("Updated")} ${updated}`}</p>
  </main>;
}
