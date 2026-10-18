"use client";

import { useState } from "react";
import { authorizeClaimDisbursement, prepareClaimSettlement, verifyClaimPayees, type ClaimWorkspace, type ClaimPayee } from "@/app/services/postIssuance";
import { tx } from "@/lib/i18n/tx";
import { displayDate } from "@/lib/dateDisplay";

export default function ClaimSettlementApproval({role, policyId, claimId, workspace, onDone}: {
  role: string | null; policyId: string; claimId: string; workspace: ClaimWorkspace | null; onDone: () => Promise<void>;
}) {
  const [payees, setPayees] = useState<ClaimPayee[]>(() => workspace?.settlement.payees.map(p=>({...p})) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (role !== "ClaimsManager") return null;
  const settlement = workspace?.settlement;
  const authorised = !!settlement?.authorized_at;
  const dirty = payees.some(p => {
    const saved = settlement?.payees.find(row => row.id === p.id);
    return !saved || (['cnic','bank_name','account_title','iban','method','note'] as const).some(field => p[field] !== saved[field]);
  });
  const edit = (id: string, field: string, value: string) => setPayees(rows=>rows.map(p=>p.id===id?{...p,[field]:value}:p));
  async function act(operation: () => Promise<unknown>) {
    setBusy(true); setError("");
    try {await operation(); await onDone();}
    catch(e: any) {setError(typeof e?.response?.data?.detail === "string" ? e.response.data.detail : tx("Settlement action failed. Refresh and try again."));}
    finally {setBusy(false);}
  }
  return <section id="claim-settlement-approval" className="scroll-mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
    <h2 className="text-lg font-semibold text-slate-900">{tx("Authorise Finance to record payment")}</h2>
    <p className="mt-1 text-sm text-slate-500">{tx("Verify the rightful payees and bank details, then authorise the approved settlement. Finance records the external payment afterwards.")}</p>
    {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {workspace?.underwriting?.required && workspace.underwriting.state !== "cleared" && <p className="mt-4 text-sm text-amber-800">{workspace.underwriting.message}</p>}
    {authorised ? <div role="status" className="mt-4 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800"><p className="font-semibold">{tx("Finance payment authorised")}</p><p className="mt-1">PKR {settlement!.authorized_amount.toLocaleString()} · {settlement!.authorized_by} · {displayDate(settlement!.authorized_at!)}</p><p className="mt-1">{tx("Finance can now record the payment from the Payments dashboard.")}</p></div>
      : !payees.length ? <div className="mt-4"><p className="text-sm text-slate-600">{tx("Prepare the settlement payees from the existing claimant and beneficiary records. This does not authorise payment.")}</p><button type="button" disabled={busy} onClick={()=>void act(()=>prepareClaimSettlement(policyId,claimId))} className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{tx(busy?"Preparing…":"Prepare settlement payees")}</button></div>
      : <form className="mt-4 space-y-4" onSubmit={e=>{e.preventDefault();void act(()=>verifyClaimPayees(policyId,claimId,payees.map(p=>({id:p.id,cnic:p.cnic || "",bank_name:p.bank_name || "",account_title:p.account_title || "",iban:p.iban || "",method:p.method || "",note:p.note || "",verify:true}))));}}>
        {payees.map(p=><fieldset key={p.id} disabled={busy || !workspace?.can.verify_payees} className="rounded-xl border border-slate-200 p-4 disabled:opacity-70"><legend className="px-1 text-sm font-semibold">{p.name} · {p.share_pct}% · PKR {p.amount.toLocaleString()}</legend>
          <p className="mb-3 text-xs text-slate-500">{tx(p.verified?"Verified":"Awaiting verification")}{p.is_minor && p.guardian_name ? ` · ${tx("Guardian")}: ${p.guardian_name}` : ""}</p>
          <div className="grid gap-3 sm:grid-cols-2">{([['cnic','Payee CNIC'],['bank_name','Bank name'],['account_title','Account title'],['iban','IBAN'],['method','Identity verification method'],['note','Verification note']] as const).map(([field,label])=><label key={field} className="text-xs font-semibold text-slate-600">{tx(label)}<input required={field!=="note"} maxLength={field==='note'?1000:255} value={p[field] || ""} onChange={e=>edit(p.id,field,e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 p-2 text-sm font-normal text-slate-900" /></label>)}</div>
        </fieldset>)}
        <div className="flex flex-wrap items-center gap-3"><button type="submit" disabled={busy || !workspace?.can.verify_payees} className="rounded-lg border border-blue-600 px-4 py-2 text-sm font-semibold text-blue-600 disabled:opacity-40">{tx("Save & verify payees")}</button>
          <button type="button" disabled={busy || dirty || !workspace?.can.authorize} onClick={()=>void act(()=>authorizeClaimDisbursement(policyId,claimId))} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{tx("Authorise Finance payment")}</button></div>
        {dirty && <p className="text-xs text-amber-700">{tx("Save and verify the changed payee details before authorising payment.")}</p>}
        {!workspace?.can.authorize && <p className="text-xs text-slate-500">{tx("Payment authorisation becomes available once every payee is verified and underwriting is cleared.")}</p>}
      </form>}
  </section>;
}
