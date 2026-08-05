"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getReinsurance, referToReinsurer, recordReinsurerResponse, applyReinsurerTerms, withdrawReferral,
  type ReinsuranceView, type ReinsurerDecision, type Reinsurer,
} from "@/app/services/reinsurance";

const fmtPKR = (n: number | null | undefined) =>
  n == null ? "-" : `PKR ${Math.round(n).toLocaleString()}`;

interface ReinsurancePanelProps {
  policyId: string;
  onChanged?: () => void;
}

export function ReinsurancePanel({ policyId, onChanged }: ReinsurancePanelProps) {
  const [data, setData] = useState<ReinsuranceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form states for submitting slip
  const [selectedReinsurer, setSelectedReinsurer] = useState<string>("");
  const [referralNote, setReferralNote] = useState<string>("");

  // Form states for recording response
  const [showResponseModal, setShowResponseModal] = useState(false);
  const [decision, setDecision] = useState<ReinsurerDecision>("Accept");
  const [reinsurerRef, setReinsurerRef] = useState<string>("");
  const [extraMortality, setExtraMortality] = useState<number>(0);
  const [extraPremium, setExtraPremium] = useState<number>(0);
  const [exclusions, setExclusions] = useState<string>("");
  const [conditions, setConditions] = useState<string>("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await getReinsurance(policyId);
      setData(res);
      if (res.panel.length > 0 && !selectedReinsurer) {
        const lead = res.panel.find((r) => r.is_lead) ?? res.panel[0];
        setSelectedReinsurer(lead.id);
      }
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load reinsurance status");
    } finally {
      setLoading(false);
    }
  }, [policyId, selectedReinsurer]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRefer = async () => {
    if (!selectedReinsurer) return;
    setBusy(true); setErr(null); setSuccess(null);
    try {
      await referToReinsurer(policyId, {
        reinsurer_id: selectedReinsurer,
        underwriter_note: referralNote,
      });
      setSuccess("Facultative slip submitted to reinsurer successfully.");
      await load();
      onChanged?.();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to submit referral to reinsurer");
    } finally {
      setBusy(false);
    }
  };

  const handleRecordResponse = async () => {
    setBusy(true); setErr(null); setSuccess(null);
    try {
      const exList = exclusions ? exclusions.split(",").map((s) => s.trim()).filter(Boolean) : [];
      await recordReinsurerResponse(policyId, {
        decision,
        reinsurer_reference: reinsurerRef || undefined,
        extra_mortality_pct: Number(extraMortality) || undefined,
        extra_premium_per_mille: Number(extraPremium) || undefined,
        exclusions: exList,
        conditions: conditions || undefined,
      });
      setSuccess("Reinsurer response recorded.");
      setShowResponseModal(false);
      await load();
      onChanged?.();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to record reinsurer response");
    } finally {
      setBusy(false);
    }
  };

  const handleApplyTerms = async () => {
    setBusy(true); setErr(null); setSuccess(null);
    try {
      await applyReinsurerTerms(policyId);
      setSuccess("Reinsurer terms applied and counter-offer generated for customer.");
      await load();
      onChanged?.();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to apply reinsurer terms");
    } finally {
      setBusy(false);
    }
  };

  const handleWithdraw = async () => {
    if (!confirm("Are you sure you want to withdraw this reinsurance referral?")) return;
    setBusy(true); setErr(null); setSuccess(null);
    try {
      await withdrawReferral(policyId, "Withdrawn by underwriter");
      setSuccess("Referral withdrawn.");
      await load();
      onChanged?.();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to withdraw referral");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="py-8 flex justify-center">
        <div className="animate-spin h-5 w-5 rounded-full border-2 border-slate-200 border-t-blue-600" />
      </div>
    );
  }

  if (!data) return null;

  const { cession, referral, panel, expected_terms } = data;
  const refStatus = referral?.status ?? (cession.referral_required ? "Required" : "NotRequired");

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4.5 bg-slate-50/70 border-b border-slate-100 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-700 font-black text-xs shrink-0">
            RE
          </div>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="font-bold text-slate-900 text-sm">
                Facultative Reinsurance Referral
              </h3>
              <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border shrink-0 ${
                refStatus === "Accepted" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                refStatus === "Submitted" || refStatus === "Quoted" ? "bg-amber-50 text-amber-700 border-amber-200" :
                refStatus === "Required" ? "bg-amber-50 text-amber-700 border-amber-200" :
                "bg-slate-100 text-slate-600 border-slate-200"
              }`}>
                {refStatus}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Cession positioning, risk placement with Munich Re / Swiss Re / Hannover Re &amp; terms integration.
            </p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {err && <div className="p-3.5 bg-red-50 border border-red-200 text-red-700 rounded-xl text-xs font-semibold">{err}</div>}
        {success && <div className="p-3.5 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl text-xs font-semibold">{success}</div>}

        {/* Cession Math Breakdown — 4 balanced cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-slate-50/80 border border-slate-200/80 rounded-xl p-4 flex flex-col justify-between">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap truncate">Sum Assured</p>
            <p className="font-extrabold text-slate-900 text-base mt-1.5">{fmtPKR(cession.total_sum_assured)}</p>
            <p className="text-[11px] text-slate-400 font-mono mt-1">Total policy sum</p>
          </div>
          <div className="bg-slate-50/80 border border-slate-200/80 rounded-xl p-4 flex flex-col justify-between">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap truncate">Retained Capacity</p>
            <p className="font-extrabold text-slate-800 text-base mt-1.5">{fmtPKR(cession.retained_amount)}</p>
            <p className="text-[11px] text-slate-400 font-mono mt-1 truncate">Limit: {fmtPKR(cession.retention_limit)}</p>
          </div>
          <div className="bg-slate-50/80 border border-slate-200/80 rounded-xl p-4 flex flex-col justify-between">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wider whitespace-nowrap truncate">Treaty Cession</p>
            <p className="font-extrabold text-slate-800 text-base mt-1.5">{fmtPKR(cession.treaty_ceded_amount)}</p>
            <p className="text-[11px] text-slate-400 font-mono mt-1 truncate">Treaty cap: {fmtPKR(cession.treaty_capacity)}</p>
          </div>
          <div className={`border rounded-xl p-4 flex flex-col justify-between ${cession.facultative_ceded_amount > 0 ? "bg-indigo-50/50 border-indigo-200" : "bg-slate-50/80 border-slate-200/80"}`}>
            <p className="text-xs font-bold text-indigo-700 uppercase tracking-wider whitespace-nowrap truncate">Facultative Cession</p>
            <p className="font-extrabold text-indigo-900 text-base mt-1.5">{fmtPKR(cession.facultative_ceded_amount)}</p>
            <p className="text-[11px] text-indigo-600 font-mono mt-1">Cession: {cession.cession_pct}%</p>
          </div>
        </div>

        {/* AI Expected Terms Hint */}
        {expected_terms && expected_terms.drivers && expected_terms.drivers.length > 0 && (
          <div className="bg-blue-50/70 border border-blue-200/80 rounded-xl p-4 space-y-2 text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <span className="font-bold text-blue-900 flex items-center gap-1.5 text-xs">
                <span aria-hidden>🤖</span> AI Reinsurance Guidance ({expected_terms.basis})
              </span>
              <span className="font-mono text-xs font-bold text-blue-700 bg-white px-2.5 py-1 rounded-lg border border-blue-200/80 shrink-0 self-start sm:self-auto">
                Expected: {expected_terms.expected_decision} (+{expected_terms.expected_extra_mortality_pct}% EMR)
              </span>
            </div>
            <ul className="list-disc pl-4 text-blue-800 space-y-1 text-xs">
              {expected_terms.drivers.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Existing Referral Details */}
        {referral ? (
          <div className="border border-slate-200 rounded-xl p-4 space-y-4 bg-slate-50/40">
            <div className="flex items-center justify-between flex-wrap gap-2 border-b border-slate-200/60 pb-3">
              <div>
                <p className="text-xs font-bold text-slate-800">
                  Reinsurer: <span className="text-blue-700 font-black">{referral.reinsurer?.name ?? "Reinsurer Panel"}</span>
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Submitted at: {referral.submitted_at ? new Date(referral.submitted_at).toLocaleString() : "Not submitted"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {referral.status === "Submitted" && (
                  <>
                    <button
                      onClick={() => setShowResponseModal(true)}
                      disabled={busy}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-lg transition-all"
                    >
                      Record Reinsurer Terms
                    </button>
                    <button
                      onClick={handleWithdraw}
                      disabled={busy}
                      className="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 font-bold text-xs rounded-lg hover:bg-slate-100 transition-all"
                    >
                      Withdraw
                    </button>
                  </>
                )}
                {referral.status === "Quoted" && !referral.terms_applied && (
                  <button
                    onClick={handleApplyTerms}
                    disabled={busy}
                    className="px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-bold text-xs rounded-xl shadow-xs hover:shadow transition-all"
                  >
                    Apply Reinsurer Terms to Policy
                  </button>
                )}
              </div>
            </div>

            {/* Reinsurer Response Details */}
            {referral.reinsurer_decision && (
              <div className="bg-white p-3.5 rounded-xl border border-slate-200 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-900">Decision: {referral.reinsurer_decision}</span>
                  {referral.reinsurer_reference && (
                    <span className="font-mono text-[10px] text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                      Ref: {referral.reinsurer_reference}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-600">
                  {referral.extra_mortality_pct != null && (
                    <p><span className="font-medium text-slate-400">EMR Loading:</span> +{referral.extra_mortality_pct}%</p>
                  )}
                  {referral.extra_premium_per_mille != null && (
                    <p><span className="font-medium text-slate-400">Extra Premium:</span> {referral.extra_premium_per_mille} ‰</p>
                  )}
                  {referral.imposed_exclusions && referral.imposed_exclusions.length > 0 && (
                    <p className="col-span-2"><span className="font-medium text-slate-400">Exclusions:</span> {referral.imposed_exclusions.join(", ")}</p>
                  )}
                  {referral.reinsurer_conditions && (
                    <p className="col-span-2"><span className="font-medium text-slate-400">Conditions:</span> {referral.reinsurer_conditions}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Referral Submission Form */
          <div className="border border-slate-200 rounded-xl p-4 space-y-4 bg-slate-50/50">
            <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Submit Slip to Reinsurer Panel</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Select Reinsurer</label>
                <select
                  value={selectedReinsurer}
                  onChange={(e) => setSelectedReinsurer(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 focus:ring-2 focus:ring-blue-500"
                >
                  {panel.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.code}) — Rating: {r.am_best_rating ?? "A+"} {r.is_lead ? "[LEAD TREATY]" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-600 mb-1">Underwriter Remarks</label>
                <input
                  type="text"
                  placeholder="e.g. Fac placement required due to high sum assured exceeding retention"
                  value={referralNote}
                  onChange={(e) => setReferralNote(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <button
              onClick={handleRefer}
              disabled={busy || !selectedReinsurer}
              className="w-full sm:w-auto px-5 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-xl shadow-xs hover:shadow transition-all disabled:opacity-40"
            >
              {busy ? "Submitting Slip…" : "Submit Slip to Reinsurer"}
            </button>
          </div>
        )}

        {/* Modal: Record Response */}
        {showResponseModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <h3 className="font-bold text-slate-900 text-sm">Record Reinsurer Response</h3>
                <button onClick={() => setShowResponseModal(false)} className="text-slate-400 hover:text-slate-600">✕</button>
              </div>
              <div className="p-5 space-y-3 text-xs">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Reinsurer Decision</label>
                  <select
                    value={decision}
                    onChange={(e) => setDecision(e.target.value as ReinsurerDecision)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-800"
                  >
                    <option value="Accept">Accept (Standard Terms)</option>
                    <option value="AcceptWithLoading">Accept with EMR Loading</option>
                    <option value="AcceptWithExclusion">Accept with Exclusions</option>
                    <option value="Postpone">Postpone</option>
                    <option value="Decline">Decline Cession</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Reinsurer Reference / Slip No.</label>
                  <input
                    type="text"
                    placeholder="e.g. MRE-PK-2026-992"
                    value={reinsurerRef}
                    onChange={(e) => setReinsurerRef(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2"
                  />
                </div>

                {decision === "AcceptWithLoading" && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">EMR % Loading</label>
                      <input
                        type="number"
                        placeholder="e.g. 50 (+50% EMR)"
                        value={extraMortality}
                        onChange={(e) => setExtraMortality(Number(e.target.value))}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Extra Premium (per mille)</label>
                      <input
                        type="number"
                        placeholder="e.g. 2.5 ‰"
                        value={extraPremium}
                        onChange={(e) => setExtraPremium(Number(e.target.value))}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2"
                      />
                    </div>
                  </div>
                )}

                {decision === "AcceptWithExclusion" && (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">Imposed Exclusions (comma separated)</label>
                    <input
                      type="text"
                      placeholder="e.g. Hazardous sports, Aviation except scheduled commercial flights"
                      value={exclusions}
                      onChange={(e) => setExclusions(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2"
                    />
                  </div>
                )}

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Reinsurer Special Conditions</label>
                  <textarea
                    rows={2}
                    placeholder="e.g. Subject to annual medical checkup report"
                    value={conditions}
                    onChange={(e) => setConditions(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2"
                  />
                </div>
              </div>

              <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 flex justify-end gap-2">
                <button
                  onClick={() => setShowResponseModal(false)}
                  className="px-4 py-2 bg-white border border-slate-200 text-slate-700 font-semibold rounded-lg text-xs hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRecordResponse}
                  disabled={busy}
                  className="px-4 py-2 bg-blue-600 text-white font-bold rounded-lg text-xs hover:bg-blue-700"
                >
                  {busy ? "Saving…" : "Save Terms"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
