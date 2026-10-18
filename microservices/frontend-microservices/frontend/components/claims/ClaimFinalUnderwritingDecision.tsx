"use client";
import { useEffect, useState } from "react";
import { getClaimDetail, resolveClaimUnderwriting, type Claim } from "@/app/services/claims";
import { tx } from "@/lib/i18n/tx";

const DECISIONS = [
  {value:"APPROVE_CONTINUE",label:"Cover confirmed: continue the claim"},
  {value:"APPROVE_WITH_EXCLUSION",label:"Continue, with an exclusion applied"},
  {value:"APPROVE_WITH_LOADING",label:"Continue, with a premium loading"},
  {value:"DECLINE_NON_DISCLOSURE",label:"Decline: non-disclosure at application"},
] as const;
type Decision = typeof DECISIONS[number]["value"];
export default function ClaimFinalUnderwritingDecision({claimId,role,disabled=false,initialClaim,onDone}: {
  claimId: string; role: string | null; disabled?: boolean; initialClaim?: Claim; onDone: () => void | Promise<void>;
}) {
  const [claim,setClaim]=useState<Claim | null>(initialClaim ?? null);
  const [open,setOpen]=useState(false);
  const [decision,setDecision]=useState<Decision>("APPROVE_CONTINUE");
  const [notes,setNotes]=useState("");
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{
    let alive=true;
    if(role!=="ClaimsManager") return;
    setError("");
    if(initialClaim){setClaim(initialClaim);return;}
    setClaim(null);
    getClaimDetail(claimId).then(data=>{if(alive)setClaim(data);}).catch(e=>{if(alive)setError(e?.message ?? "Could not read specialist reviews.");});
    return ()=>{alive=false;};
  },[claimId,role,initialClaim]);
  if(role!=="ClaimsManager") return null;
  if(claim && claim.status!=="Re-Underwriting Required") return null;
  const review=claim?.underwriting_review;
  const ready=Boolean(review?.ready);
  return <section className="space-y-3 rounded-xl border border-blue-200 bg-blue-50 p-4">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-bold text-slate-900">{tx("Final claim underwriting decision")}</h3>
    <button type="button" disabled={saving} className="text-xs font-semibold text-blue-700 disabled:opacity-40" onClick={async()=>{
      try{setClaim(await getClaimDetail(claimId));setError("");}catch(e:any){setError(e?.message ?? "Could not refresh the reviews.");}
    }}>{tx("Refresh reviews")}</button></div>
    {review && <div className="space-y-1 text-xs text-slate-600">{["medical","financial"].map(track=><p key={track}>{tx(track==="medical"?"Medical review":"Financial review")}: <strong>{tx(({CLEARED:"Cleared",REFERRED:"Referred",DECLINED:"Declined",IN_REVIEW:"In review",PENDING:"Pending"} as Record<string,string>)[review.reviews[track]?.status] ?? "Pending")}</strong></p>)}</div>}
    <button type="button" disabled={disabled || !ready || saving} onClick={()=>setOpen(true)} className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{tx("Record final decision")}</button>
    {!ready && <p className="text-xs text-slate-600">{tx(review?.on_hold?"The underwriting referral is on hold.":"Available once both the medical and financial reviews on the current referral are submitted.")}</p>}
    {error && <p role="alert" className="text-sm text-rose-700">{tx(error)}</p>}
    {open && <form role="dialog" aria-modal="true" aria-label={tx("Final claim underwriting decision")} className="space-y-3 rounded-xl bg-white p-4" onSubmit={async e=>{
      e.preventDefault();if(disabled || !ready || saving || !notes.trim())return;
      setSaving(true);setError("");
      try{await resolveClaimUnderwriting(claimId,decision,notes.trim());setOpen(false);setNotes("");await onDone();}
      catch(e:any){setError(e?.response?.data?.detail ?? e?.message ?? "Could not record the final decision.");}
      finally{setSaving(false);}
    }}>
      <label className="block text-xs font-semibold text-slate-600">{tx("Decision")}<select value={decision} onChange={e=>setDecision(e.target.value as Decision)} className="mt-1 block w-full rounded-lg border p-2">{DECISIONS.map(d=><option key={d.value} value={d.value}>{tx(d.label)}</option>)}</select></label>
      <label className="block text-xs font-semibold text-slate-600">{tx("Decision rationale")}<textarea required maxLength={2000} rows={4} value={notes} onChange={e=>setNotes(e.target.value)} className="mt-1 block w-full rounded-lg border p-2" /></label>
      <p className="text-xs text-slate-500">{tx("Continuing returns the claim to investigation; it does not approve a payment.")}</p>
      <div className="flex gap-3"><button type="button" disabled={saving} onClick={()=>setOpen(false)} className="rounded-lg border px-3 py-2 text-xs">{tx("Cancel")}</button><button disabled={saving || !notes.trim()} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{tx(saving?"Saving…":"Save final decision")}</button></div>
    </form>}
  </section>;
}
