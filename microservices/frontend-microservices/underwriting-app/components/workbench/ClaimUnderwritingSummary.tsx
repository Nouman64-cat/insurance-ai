"use client";
import { tx } from "@/lib/i18n/tx";
import { fmtCoverage } from "@/lib/mock-data";

type Claim = { claim_number: string | null; claim_type: string; submitted_amount: number; incident_date: string | null;
  ai_recommendation?: string | null; underwriting_outcome?: {decision:string;reason:string;current:boolean} | null;
  referral_reason: string | null; ready: boolean; reviews: Record<string, { status: string; note: string | null }> };
const STATUS: Record<string, string> = {PENDING:"Pending",IN_REVIEW:"In review",CLEARED:"Cleared",REFERRED:"Referred",DECLINED:"Declined"};

/** Specialists submit their own review; final claim resolution belongs to the Claims Manager. */
export default function ClaimUnderwritingSummary({ claim }: { claim: Claim }) {
  return <section className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50/60 p-5">
    <div className="flex items-center gap-2"><span className="rounded-md border border-blue-200 bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase text-blue-700">{tx("Claim UW")}</span><h3 className="text-sm font-bold text-slate-900">{claim.claim_number} · {claim.claim_type}</h3></div>
    <p className="text-xs text-slate-600">{tx("Claimed")} {fmtCoverage(claim.submitted_amount)}{claim.incident_date ? ` · ${tx("Incident")} ${claim.incident_date}` : ""}</p>
    {claim.referral_reason && <p className="text-xs text-slate-600"><span className="font-semibold">{tx("Why Claims referred it")}:</span> {claim.referral_reason}</p>}
    <ul className="space-y-1 text-xs text-slate-600">{Object.entries(claim.reviews).map(([t,r]) => <li key={t}>{tx(t === "medical" ? "Medical review" : "Financial review")}: <span className="font-semibold">{tx(STATUS[r.status] ?? r.status)}</span></li>)}</ul>
    {claim.ai_recommendation && <p className="text-xs text-slate-600">{tx("AI recommendation")}: <strong>{claim.ai_recommendation}</strong> · {tx("Advisory only")}</p>}
    {claim.underwriting_outcome && <p className="text-xs text-slate-600">{tx("Admin underwriting outcome")}: <strong>{tx(claim.underwriting_outcome.decision === "PROCEED" ? "Proceed" : "Decline")}</strong> · {claim.underwriting_outcome.reason}</p>}
    <p className="text-xs text-blue-800">{tx(claim.ready ? "The human underwriting outcome is recorded. The Claims Manager records the final decision in the claims workbench." : "Submit your specialist review when ready. Admin then records a human underwriting outcome after the AI check; the Claims Manager makes the final claim decision.")}</p>
  </section>;
}
