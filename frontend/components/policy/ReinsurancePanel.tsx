"use client";

import { displayDateTime } from '../../lib/dateDisplay';
import { useCallback, useEffect, useState } from "react";
import {
  getReinsurance, referToReinsurer, recordReinsurerResponse, applyReinsurerTerms, withdrawReferral,
  type ReinsuranceView, type ReinsurerDecision, type Reinsurer,
} from "@/app/services/reinsurance";
import { tx } from "@/lib/i18n/tx";

const fmtPKR = (n: number | null | undefined) =>
  n == null ? "-" : `PKR ${Math.round(n).toLocaleString()}`;

// "PKR 45.6M" — the full figure is in the element's title.
const fmtShort = (n: number | null | undefined) => {
  if (n == null) return "-";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `PKR ${+(n / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 1_000) return `PKR ${+(n / 1_000).toFixed(1)}K`;
  return `PKR ${Math.round(n)}`;
};

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
      setSuccess(tx("Facultative slip submitted to reinsurer successfully."));
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
      setSuccess(tx("Reinsurer response recorded."));
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
      setSuccess(tx("Reinsurer terms applied and counter-offer generated for customer."));
      await load();
      onChanged?.();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to apply reinsurer terms");
    } finally {
      setBusy(false);
    }
  };

  const handleWithdraw = async () => {
    if (!confirm(tx("Are you sure you want to withdraw this reinsurance referral?"))) return;
    setBusy(true); setErr(null); setSuccess(null);
    try {
      await withdrawReferral(policyId, "Withdrawn by underwriter");
      setSuccess(tx("Referral withdrawn."));
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
  const total = cession.total_sum_assured || 1;
  const slices = [
    { key: "retained", label: tx("Retained"), amount: cession.retained_amount, note: tx("Limit {0}", { 0: fmtShort(cession.retention_limit) }), bar: "bg-slate-400", dot: "bg-slate-400" },
    { key: "treaty", label: tx("Treaty"), amount: cession.treaty_ceded_amount, note: tx("Cap {0}", { 0: fmtShort(cession.treaty_capacity) }), bar: "bg-blue-500", dot: "bg-blue-500" },
    { key: "fac", label: tx("Facultative"), amount: cession.facultative_ceded_amount, note: tx("{0}% of cover", { 0: cession.cession_pct }), bar: "bg-blue-600", dot: "bg-blue-600" },
  ];
  const statusTone =
    refStatus === "Accepted" ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : ["Submitted", "Quoted", "Required"].includes(refStatus) ? "bg-amber-50 text-amber-700 ring-amber-200"
        : "bg-slate-100 text-slate-600 ring-slate-200";

  return (
    <div className="space-y-4">
      {err && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700">{err}</div>}
      {success && <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-700">{success}</div>}

      {/* Where the cover sits: one bar for the whole sum assured */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{tx("Risk placement")}</p>
            <p className="mt-0.5 text-lg font-bold text-slate-900" title={fmtPKR(cession.total_sum_assured)}>
              {fmtShort(cession.total_sum_assured)} <span className="text-xs font-medium text-slate-400">{tx("sum assured")}</span>
            </p>
          </div>
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${statusTone}`}>
            {refStatus === "NotRequired" ? tx("Not required") : tx(refStatus)}
          </span>
        </div>
        <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-slate-100" role="img"
          aria-label={slices.map((sl) => `${sl.label} ${fmtPKR(sl.amount)}`).join(", ")}>
          {slices.map((sl) => sl.amount > 0 && (
            <div key={sl.key} className={`${sl.bar} h-full first:rounded-l-full last:rounded-r-full`} style={{ width: `${(sl.amount / total) * 100}%` }} />
          ))}
        </div>
        <dl className="mt-3 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
          {slices.map((sl) => (
            <div key={sl.key} className={`rounded-xl px-3 py-2 ${sl.key === "fac" && sl.amount > 0 ? "bg-blue-50 ring-1 ring-blue-100" : "bg-slate-50"}`}>
              <dt className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
                <span className={`h-2 w-2 rounded-full ${sl.dot}`} />{sl.label}
              </dt>
              <dd className={`mt-0.5 text-sm font-bold ${sl.key === "fac" && sl.amount > 0 ? "text-blue-900" : "text-slate-800"}`} title={fmtPKR(sl.amount)}>
                {fmtShort(sl.amount)}
              </dd>
              <dd className="text-[10px] text-slate-400">{sl.note}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* What the AI expects the reinsurer to come back with */}
      {expected_terms && expected_terms.drivers && expected_terms.drivers.length > 0 && (
        <section className="rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 to-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm font-bold text-blue-900">
              <span aria-hidden>✨</span>{tx("AI reinsurance guidance")}
            </p>
            <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-blue-800 ring-1 ring-blue-200">
              {tx("Expected:")} {expected_terms.expected_decision.replace(/([a-z])([A-Z])/g, "$1 $2")}
              {expected_terms.expected_extra_mortality_pct ? ` · +${expected_terms.expected_extra_mortality_pct}% EMR` : ""}
            </span>
          </div>
          <ul className="mt-3 space-y-1.5">
            {expected_terms.drivers.map((d, i) => (
              <li key={i} className="flex gap-2 text-xs text-slate-700">
                <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-400" />{d}
              </li>
            ))}
          </ul>
          {expected_terms.basis && (
            <p className="mt-3 border-t border-blue-100 pt-2 text-[11px] leading-relaxed text-slate-500">{expected_terms.basis}</p>
          )}
        </section>
      )}

      {referral ? (
        /* The slip that went out, and what came back */
        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{tx("Slip placed with")}</p>
              <p className="text-sm font-bold text-slate-900">{referral.reinsurer?.name ?? tx("Reinsurer Panel")}</p>
              <p className="text-[11px] text-slate-500">
                {referral.submitted_at ? tx("Submitted {0}", { 0: displayDateTime(referral.submitted_at) }) : tx("Not submitted")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {referral.status === "Submitted" && (
                <>
                  <button onClick={handleWithdraw} disabled={busy}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                    {tx("Withdraw")}
                  </button>
                  <button onClick={() => setShowResponseModal(true)} disabled={busy}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                    {tx("Record Reinsurer Terms")}
                  </button>
                </>
              )}
              {referral.status === "Quoted" && !referral.terms_applied && (
                <button onClick={handleApplyTerms} disabled={busy}
                  className="rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                  {tx("Apply Reinsurer Terms to Policy")}
                </button>
              )}
            </div>
          </div>
          {referral.reinsurer_decision && (
            <div className="rounded-xl bg-slate-50 p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-900">{referral.reinsurer_decision.replace(/([a-z])([A-Z])/g, "$1 $2")}</span>
                {referral.reinsurer_reference && (
                  <span className="rounded bg-white px-2 py-0.5 font-mono text-[10px] text-slate-500 ring-1 ring-slate-200">{referral.reinsurer_reference}</span>
                )}
              </div>
              <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-[11px] text-slate-600 sm:grid-cols-2">
                {referral.extra_mortality_pct != null && (
                  <div><dt className="inline text-slate-400">{tx("EMR loading")}: </dt><dd className="inline font-medium">+{referral.extra_mortality_pct}%</dd></div>
                )}
                {referral.extra_premium_per_mille != null && (
                  <div><dt className="inline text-slate-400">{tx("Extra premium")}: </dt><dd className="inline font-medium">{referral.extra_premium_per_mille} ‰</dd></div>
                )}
                {referral.imposed_exclusions && referral.imposed_exclusions.length > 0 && (
                  <div className="sm:col-span-2"><dt className="inline text-slate-400">{tx("Exclusions")}: </dt><dd className="inline font-medium">{referral.imposed_exclusions.join(", ")}</dd></div>
                )}
                {referral.reinsurer_conditions && (
                  <div className="sm:col-span-2"><dt className="inline text-slate-400">{tx("Conditions")}: </dt><dd className="inline font-medium">{referral.reinsurer_conditions}</dd></div>
                )}
              </dl>
            </div>
          )}
        </section>
      ) : (
        /* Choose a reinsurer and send the slip */
        <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-sm font-bold text-slate-900">{tx("Send the facultative slip")}</p>
          <fieldset>
            <legend className="mb-1.5 text-[11px] font-semibold text-slate-500">{tx("Reinsurer")}</legend>
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" }}>
              {panel.map((r) => {
                const chosen = selectedReinsurer === r.id;
                return (
                  <label key={r.id}
                    className={`relative flex cursor-pointer flex-col rounded-xl border px-3 py-2.5 transition-colors ${chosen ? "border-blue-500 bg-blue-50/60 ring-1 ring-blue-500" : "border-slate-200 hover:border-slate-300"}`}>
                    <input type="radio" name={`reinsurer-${policyId}`} value={r.id} checked={chosen}
                      onChange={() => setSelectedReinsurer(r.id)} className="sr-only" />
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-bold text-slate-800">{r.name}</span>
                      {chosen && <span className="text-xs text-blue-600" aria-hidden>●</span>}
                    </span>
                    <span className="mt-0.5 text-[10px] text-slate-500">
                      {r.code} · {tx("Rating")} {r.am_best_rating ?? "—"}
                    </span>
                    {r.is_lead && (
                      <span className="mt-1.5 self-start rounded-full bg-blue-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-blue-700">
                        {tx("Lead treaty")}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">{tx("Underwriter remarks")}</span>
            <textarea rows={2} value={referralNote} onChange={(e) => setReferralNote(e.target.value)}
              placeholder={tx("e.g. Fac placement required due to high sum assured exceeding retention")}
              className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-800 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100" />
          </label>
          <div className="flex justify-end">
            <button onClick={handleRefer} disabled={busy || !selectedReinsurer}
              className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-40">
              {busy ? tx("Submitting slip…") : tx("Submit slip to {0}", { 0: panel.find((r) => r.id === selectedReinsurer)?.name ?? tx("reinsurer") })}
            </button>
          </div>
        </section>
      )}

        {/* Modal: Record Response */}
        {showResponseModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <h3 className="font-bold text-slate-900 text-sm">{tx("Record Reinsurer Response")}</h3>
                <button onClick={() => setShowResponseModal(false)} className="text-slate-400 hover:text-slate-600">✕</button>
              </div>
              <div className="p-5 space-y-3 text-xs">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">{tx("Reinsurer Decision")}</label>
                  <select
                    value={decision}
                    onChange={(e) => setDecision(e.target.value as ReinsurerDecision)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-800"
                  >
                    <option value="Accept">{tx("Accept (Standard Terms)")}</option>
                    <option value="AcceptWithLoading">{tx("Accept with EMR Loading")}</option>
                    <option value="AcceptWithExclusion">{tx("Accept with Exclusions")}</option>
                    <option value="Postpone">{tx("Postpone")}</option>
                    <option value="Decline">{tx("Decline Cession")}</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">{tx("Reinsurer Reference / Slip No.")}</label>
                  <input
                    type="text"
                    placeholder={tx("e.g. MRE-PK-2026-992")}
                    value={reinsurerRef}
                    onChange={(e) => setReinsurerRef(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2"
                  />
                </div>

                {decision === "AcceptWithLoading" && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">{tx("EMR % Loading")}</label>
                      <input
                        type="number"
                        placeholder={tx("e.g. 50 (+50% EMR)")}
                        value={extraMortality}
                        onChange={(e) => setExtraMortality(Number(e.target.value))}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">{tx("Extra Premium (per mille)")}</label>
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
                    <label className="block font-semibold text-slate-700 mb-1">{tx("Imposed Exclusions (comma separated)")}</label>
                    <input
                      type="text"
                      placeholder={tx("e.g. Hazardous sports, Aviation except scheduled commercial flights")}
                      value={exclusions}
                      onChange={(e) => setExclusions(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2"
                    />
                  </div>
                )}

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">{tx("Reinsurer Special Conditions")}</label>
                  <textarea
                    rows={2}
                    placeholder={tx("e.g. Subject to annual medical checkup report")}
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
                  {tx("Cancel")}
                </button>
                <button
                  onClick={handleRecordResponse}
                  disabled={busy}
                  className="px-4 py-2 bg-blue-600 text-white font-bold rounded-lg text-xs hover:bg-blue-700"
                >
                  {busy ? tx("Saving…") : tx("Save Terms")}
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
