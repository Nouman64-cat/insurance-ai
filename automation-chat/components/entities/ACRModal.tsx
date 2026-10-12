"use client";

import { useState } from "react";
import { saveACR, submitACR, type AgentConfidentialReport, type ACRRecommendation } from "@/app/services/agentConfidentialReport";

// Agent's Confidential Report modal — agent files moral hazard / financial
// standing / lifestyle observations + their own declaration (Pre-Underwriting).
// Shared between /case/[id] and /pre-underwriting.
export function ACRModal({ caseId, initial, onClose, onDone }: {
  caseId: string; initial: AgentConfidentialReport | null; onClose: () => void; onDone: () => void;
}) {
  const [form, setForm] = useState({
    known_proposer_since: initial?.known_proposer_since ?? "",
    relationship_to_proposer: initial?.relationship_to_proposer ?? "",
    purpose_of_insurance: initial?.purpose_of_insurance ?? "",
    financial_interest_explained: initial?.financial_interest_explained ?? true,
    adverse_info_known: initial?.adverse_info_known ?? false,
    adverse_info_details: initial?.adverse_info_details ?? "",
    occupation_verified: initial?.occupation_verified ?? true,
    income_source_verified: initial?.income_source_verified ?? true,
    estimated_income_opinion: initial?.estimated_income_opinion ?? undefined as number | undefined,
    income_consistency_note: initial?.income_consistency_note ?? "",
    health_appearance_note: initial?.health_appearance_note ?? "",
    hazardous_activity_known: initial?.hazardous_activity_known ?? false,
    terms_explained_to_proposer: initial?.terms_explained_to_proposer ?? false,
    identity_verified_kyc: initial?.identity_verified_kyc ?? false,
    signature_obtained_in_presence: initial?.signature_obtained_in_presence ?? false,
    recommendation: (initial?.recommendation ?? "Recommend") as ACRRecommendation,
    remarks: initial?.remarks ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await saveACR(caseId, form);
      await submitACR(caseId);
      onDone();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to submit ACR");
    } finally {
      setBusy(false);
    }
  };

  const label = "text-[11px] font-semibold text-slate-500 uppercase tracking-wide";
  const input = "mt-1 w-full text-sm border border-slate-200 rounded-lg px-3 py-2";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="bg-blue-600 px-5 py-3 flex-shrink-0">
          <p className="text-white/80 text-[11px] font-semibold uppercase tracking-wider">Pre-Underwriting</p>
          <h2 className="text-white text-lg font-bold">Agent's Confidential Report</h2>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <p className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2">Moral Hazard</p>
            <div className="space-y-2">
              <div>
                <label className={label}>How long have you known the proposer?</label>
                <input className={input} value={form.known_proposer_since} onChange={(e) => setForm({ ...form, known_proposer_since: e.target.value })} placeholder="e.g. 3 years" />
              </div>
              <div>
                <label className={label}>Relationship to proposer</label>
                <input className={input} value={form.relationship_to_proposer} onChange={(e) => setForm({ ...form, relationship_to_proposer: e.target.value })} placeholder="e.g. Family friend, referred client" />
              </div>
              <div>
                <label className={label}>Purpose of insurance</label>
                <input className={input} value={form.purpose_of_insurance} onChange={(e) => setForm({ ...form, purpose_of_insurance: e.target.value })} placeholder="e.g. Family protection, loan collateral" />
              </div>
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input type="checkbox" checked={form.financial_interest_explained} onChange={(e) => setForm({ ...form, financial_interest_explained: e.target.checked })} />
                I have explained the financial interest/insurable interest to the proposer
              </label>
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input type="checkbox" checked={form.adverse_info_known} onChange={(e) => setForm({ ...form, adverse_info_known: e.target.checked })} />
                I am aware of any adverse information about the proposer
              </label>
              {form.adverse_info_known && (
                <textarea className={input} rows={2} value={form.adverse_info_details} onChange={(e) => setForm({ ...form, adverse_info_details: e.target.value })} placeholder="Details" />
              )}
            </div>
          </div>

          <div>
            <p className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2">Financial Standing</p>
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input type="checkbox" checked={form.occupation_verified} onChange={(e) => setForm({ ...form, occupation_verified: e.target.checked })} />
                Occupation verified in person
              </label>
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input type="checkbox" checked={form.income_source_verified} onChange={(e) => setForm({ ...form, income_source_verified: e.target.checked })} />
                Source of income verified
              </label>
              <div>
                <label className={label}>Your estimate of the proposer's income (PKR/yr)</label>
                <input type="number" className={input} value={form.estimated_income_opinion ?? ""} onChange={(e) => setForm({ ...form, estimated_income_opinion: e.target.value ? Number(e.target.value) : undefined })} />
              </div>
              <div>
                <label className={label}>Income consistency note</label>
                <textarea className={input} rows={2} value={form.income_consistency_note} onChange={(e) => setForm({ ...form, income_consistency_note: e.target.value })} placeholder="Does declared income match lifestyle/occupation?" />
              </div>
            </div>
          </div>

          <div>
            <p className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2">General Lifestyle</p>
            <div className="space-y-2">
              <div>
                <label className={label}>Health / appearance note</label>
                <textarea className={input} rows={2} value={form.health_appearance_note} onChange={(e) => setForm({ ...form, health_appearance_note: e.target.value })} placeholder="Any visible health concerns at the time of meeting?" />
              </div>
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input type="checkbox" checked={form.hazardous_activity_known} onChange={(e) => setForm({ ...form, hazardous_activity_known: e.target.checked })} />
                Aware of hazardous activities/habits not disclosed elsewhere
              </label>
            </div>
          </div>

          <div>
            <p className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2">Agent Declaration</p>
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input type="checkbox" checked={form.terms_explained_to_proposer} onChange={(e) => setForm({ ...form, terms_explained_to_proposer: e.target.checked })} />
                I have explained all policy terms, benefits, and exclusions to the proposer
              </label>
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input type="checkbox" checked={form.identity_verified_kyc} onChange={(e) => setForm({ ...form, identity_verified_kyc: e.target.checked })} />
                I have verified the identity of the proposer (KYC compliance)
              </label>
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input type="checkbox" checked={form.signature_obtained_in_presence} onChange={(e) => setForm({ ...form, signature_obtained_in_presence: e.target.checked })} />
                I confirm the proposer's signature was obtained in my presence
              </label>
            </div>
          </div>

          <div>
            <label className={label}>Recommendation</label>
            <select className={input} value={form.recommendation} onChange={(e) => setForm({ ...form, recommendation: e.target.value as ACRRecommendation })}>
              <option value="Recommend">Recommend</option>
              <option value="RecommendWithCaution">Recommend with caution</option>
              <option value="DoNotRecommend">Do not recommend</option>
            </select>
          </div>
          <div>
            <label className={label}>Remarks</label>
            <textarea className={input} rows={2} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
          </div>

          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-100 flex-shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700">Cancel</button>
          <button onClick={submit} disabled={busy}
            className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40">
            {busy ? "Submitting…" : "Submit ACR"}
          </button>
        </div>
      </div>
    </div>
  );
}
