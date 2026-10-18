"use client";

import { useState } from "react";
import Link from "next/link";
import type { Claim } from "@/app/services/claims";
import { disburseClaim, reconcileClaim, type ClaimWorkspace } from "@/app/services/postIssuance";
import { displayDate } from "@/lib/dateDisplay";
import { tx } from "@/lib/i18n/tx";

const money = (n: number) => `PKR ${n.toLocaleString("en-PK", { maximumFractionDigits: 2 })}`;
export default function FinanceClaimWorkspace({ claim, workspace, onReload }: {
  claim: Claim; workspace: ClaimWorkspace | null; onReload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [method, setMethod] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const settlement = workspace?.settlement;
  const payouts = settlement?.payouts ?? claim.payouts ?? [];
  const paid = payouts.reduce((sum,p) => sum + p.amount, 0);
  const approved = ["Approved", "Partial Approval"].includes(claim.status);
  const closed = claim.status === "Closed";
  const canPay = approved && !!workspace?.can.disburse && !!settlement?.authorized_at && paid === 0;
  const selectedMethod = method || settlement?.methods[0] || "Bank Transfer";
  async function run(action: () => Promise<unknown>, success: string, refresh = true) {
    setBusy(true); setError(""); setMessage("");
    try { await action(); setConfirming(false); if (refresh) await onReload(); setMessage(success); }
    catch(e: any) { const detail=e.response?.data?.detail; setError(typeof detail === "string" ? detail : tx("Payment action failed. Refresh and try again.")); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
    <Link href="/finance" className="text-sm font-medium text-slate-500 hover:text-blue-600">{tx("← Payments dashboard")}</Link>
    <header className="flex flex-wrap items-start justify-between gap-4"><div>
      <p className="text-xs font-bold uppercase tracking-widest text-blue-600">{tx("Claim payment")} · {claim.claim_number}</p>
      <h1 className="mt-2 text-3xl font-bold text-slate-900">{claim.customer_name || claim.claimant_name}</h1>
      <p className="mt-2 text-sm text-slate-500">{claim.policy_number} · {claim.claim_type} · {tx("Claimant")}: {claim.claimant_name}</p>
    </div><div className="flex items-center gap-3"><span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">{tx(claim.status)}</span><button disabled={busy} onClick={()=>run(onReload,tx("Payment details refreshed."),false)} className="rounded-lg border bg-white px-4 py-2 text-sm">{tx("Refresh")}</button></div></header>
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
    {message && <p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-700">{message}</p>}
    <div className="grid gap-4 sm:grid-cols-3">{[{label:"Approved amount",value:claim.approved_amount},{label:"Recorded payment",value:paid || claim.settlement_amount || 0},{label:"Outstanding",value:Math.max(0,claim.approved_amount-(paid || claim.settlement_amount || 0))}].map(m=><div key={m.label} className="rounded-xl border bg-white p-5"><p className="text-xs font-semibold text-slate-500">{tx(m.label)}</p><p className="mt-3 text-2xl font-bold text-slate-900">{money(m.value)}</p></div>)}</div>
    <div className="grid items-start gap-6 lg:grid-cols-[1.5fr_1fr]">
      <div className="space-y-6"><section className="rounded-xl border bg-white p-5"><h2 className="font-bold text-slate-900">{tx("Payees & bank details")}</h2>
        {!settlement?.payees.length && <p className="mt-4 text-sm text-slate-500">{tx("No verified settlement payees are on record. The claims team must prepare and authorise the settlement before Finance can pay.")}</p>}
        <div className="mt-4 space-y-3">{settlement?.payees.map(p=><div key={p.id} className="rounded-lg border p-4 text-sm"><div className="flex justify-between gap-3"><div><p className="font-semibold">{p.name}</p><p className="text-xs text-slate-500">{p.relationship} · {p.share_pct}%</p></div><span className={`text-xs font-semibold ${p.verified?"text-emerald-600":"text-amber-600"}`}>{tx(p.verified?"Verified":"Awaiting verification")}</span></div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">{[["Bank",p.bank_name],["Account title",p.account_title],["IBAN",p.iban],["Amount",money(p.amount)]].map(([label,value])=><div key={label}><dt className="text-slate-500">{tx(label || "")}</dt><dd className="mt-1 break-all font-medium">{value || "—"}</dd></div>)}</dl>
        </div>)}</div>
      </section>
      <section className="overflow-hidden rounded-xl border bg-white"><h2 className="border-b p-5 font-bold text-slate-900">{tx("Payment history")}</h2>
        {!payouts.length ? <p className="p-5 text-sm text-slate-500">{tx("No payout has been recorded for this claim.")}</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr>{["Reference / payee","Method","Amount","Completed"].map(h=><th key={h} className="px-5 py-3">{tx(h)}</th>)}</tr></thead><tbody className="divide-y">{payouts.map(p=><tr key={p.id}><td className="px-5 py-4"><p className="font-mono text-xs">{p.reference_number || "—"}</p>{"payee_name" in p && <p className="mt-1 text-xs text-slate-500">{p.payee_name}</p>}</td><td className="px-5 py-4">{p.method}</td><td className="whitespace-nowrap px-5 py-4 font-semibold">{money(p.amount)}</td><td className="px-5 py-4 text-xs text-slate-500">{p.completed_at?displayDate(p.completed_at):"—"}</td></tr>)}</tbody></table></div>}
      </section></div>
      <aside className="space-y-6"><section className="rounded-xl border bg-white p-5"><h2 className="font-bold text-slate-900">{tx("Payment authorisation")}</h2>
        <p className="mt-3 text-sm text-slate-600">{tx(settlement?.authorized_at?"Authorised by the Claims Manager":paid>0?"Payment recorded":closed?"Claim closed":"Awaiting Claims Manager authorisation")}</p>
        {settlement?.authorized_at && <p className="mt-2 text-xs text-slate-500">{settlement.authorized_by} · {displayDate(settlement.authorized_at)}<br/>{money(settlement.authorized_amount)}</p>}
        {canPay ? <div className="mt-5 space-y-3"><label className="block text-xs font-semibold">{tx("Payment method")}<select disabled={busy} value={selectedMethod} onChange={e=>setMethod(e.target.value)} className="mt-2 w-full rounded-lg border bg-white p-2 text-sm">{settlement?.methods.map(m=><option key={m}>{m}</option>)}</select></label>
          {confirming ? <div className="rounded-lg border border-blue-200 bg-blue-50 p-3"><p className="text-sm font-semibold">{tx("Confirm payout")} · {money(settlement?.authorized_amount || claim.approved_amount)}</p><p className="mt-1 text-xs text-slate-600">{tx("Record payment to the authorised payees using the selected method.")}</p><div className="mt-3 flex gap-2"><button disabled={busy} onClick={()=>run(()=>disburseClaim(claim.policy_id,claim.id,selectedMethod),tx("Payment recorded successfully."))} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy?tx("Processing…"):tx("Confirm payment")}</button><button disabled={busy} onClick={()=>setConfirming(false)} className="px-3 text-sm">{tx("Cancel")}</button></div></div> : <button disabled={busy} onClick={()=>setConfirming(true)} className="w-full rounded-lg bg-blue-600 p-3 text-sm font-semibold text-white">{tx("Record payout")}</button>}
        </div> : <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{tx(paid>0 || closed?"No further payout is available for this claim.":!workspace?"Payment workflow could not be loaded. Refresh to check authorisation.":"The claims team must verify payees and authorise settlement before Finance can record payment.")}</p>}
      </section>
      <section className="rounded-xl border bg-white p-5"><h2 className="font-bold text-slate-900">{tx("Reconciliation")}</h2>
        {settlement?.reconciled_at ? <p className="mt-3 text-sm text-emerald-700">{tx("Reconciled")} · {displayDate(settlement.reconciled_at)}<br/><span className="text-xs text-slate-500">{settlement.reconciled_by}</span></p> : workspace?.can.reconcile && claim.status==="Settled" ? <div className="mt-3 space-y-3">
          <p className="text-xs text-slate-500">{tx("Compare the recorded payout with the approved settlement.")}</p>
          {settlement?.reconciliation?.status==="Exception" && <p role="alert" className="text-sm text-amber-700">{tx("Reconciliation exception")} · {tx("Variance")}: {money(settlement.reconciliation.variance)}. {tx("Review the checks and provide a note to resolve the exception.")}</p>}
          {settlement?.reconciliation?.checks.map((c,i)=><p key={i} className="text-xs text-slate-600">{c.label}: {c.detail}</p>)}
          <textarea aria-label={tx("Reconciliation note")} value={note} onChange={e=>setNote(e.target.value)} placeholder={tx("Reconciliation note (required for an exception)")} className="w-full rounded-lg border p-3 text-sm" />
          <button disabled={busy || (settlement?.reconciliation?.status==="Exception" && !note.trim())} onClick={()=>run(()=>reconcileClaim(claim.policy_id,claim.id,note.trim() || undefined),tx("Reconciliation updated."))} className="w-full rounded-lg border border-blue-600 p-2 text-sm font-semibold text-blue-600 disabled:opacity-50">{tx("Reconcile payment")}</button>
        </div> : <p className="mt-3 text-sm text-slate-500">{tx(closed?"This claim is closed. Payment records remain available for reference.":"Reconciliation becomes available after payment.")}</p>}
      </section></aside>
    </div>
  </main>;
}
