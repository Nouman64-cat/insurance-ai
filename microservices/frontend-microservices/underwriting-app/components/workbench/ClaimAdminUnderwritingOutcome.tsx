"use client";
import { useCallback, useEffect, useState } from "react";
import api from "@/app/services/api";
import { tx } from "@/lib/i18n/tx";

type Outcome = { decision: "PROCEED" | "DECLINE"; reason: string; current: boolean };
export type ClaimOpinionState = { reviews_complete: boolean; assessment_id: string | null; ai_recommendation: string | null;
  on_hold?: boolean; resolved?: boolean; outcome: Outcome | null };
export default function ClaimAdminUnderwritingOutcome({ tenantId, caseId, role, refreshKey, onDone, initialState }: {
  tenantId: string; caseId: string; role: string | null; refreshKey?: string; onDone: () => void | Promise<void>; initialState?: ClaimOpinionState;
}) {
  const allowed = role === "Admin" || role === "SuperAdmin";
  const [state, setState] = useState<ClaimOpinionState | null>(initialState ?? null);
  const [decision, setDecision] = useState<"PROCEED" | "DECLINE" | "">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = `/tenants/${tenantId}/cases/${caseId}/claim-underwriting-outcome`;
  const refresh = useCallback(async () => {
    try { const response = await api.get(path); setState(response.data); setError(""); }
    catch (e: any) { setError(e?.response?.data?.detail ?? "Could not read the underwriting outcome."); }
  }, [path]);
  useEffect(() => { if (allowed) { setDecision(""); setReason(""); void refresh(); } }, [allowed, refresh, refreshKey]);
  if (!allowed) return null;
  const ready = Boolean(state?.reviews_complete && state.assessment_id && !state.on_hold && !state.resolved);
  return <section className="space-y-3 rounded-2xl border border-blue-200 bg-blue-50/60 p-5">
    <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold text-slate-900">{tx("Human underwriting outcome")}</h2>
      <button type="button" onClick={() => void refresh()} className="text-xs font-semibold text-blue-700">{tx("Refresh")}</button></div>
    <p className="text-sm text-slate-700">{tx("AI recommendation")}: <strong>{state?.ai_recommendation ?? tx("Not run")}</strong></p>
    <p className="text-xs text-slate-600">{tx("AI provides advice only. Choose your own underwriting outcome and rationale. The Claims Manager makes the final claim decision.")}</p>
    {state?.outcome && <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm"><p className="font-semibold">{tx("Your recorded outcome")}: {tx(state.outcome.decision === "PROCEED" ? "Proceed" : "Decline")}</p><p>{state.outcome.reason}</p>
      <p className="mt-1 text-xs text-slate-500">{tx(state.outcome.current ? "Sent to the Claims Manager for a claim decision." : "The evidence has changed. Review it and record a new outcome.")}</p></div>}
    {!state?.resolved && <form className="space-y-3" onSubmit={async event => {
      event.preventDefault(); if (!ready || !decision || reason.trim().length < 5 || busy) return;
      setBusy(true); setError("");
      try { await api.post(path, { decision, reason: reason.trim(), assessment_id: state!.assessment_id });
        setDecision(""); setReason(""); await refresh(); await onDone(); }
      catch (e: any) { setError(e?.response?.data?.detail ?? "Could not record the underwriting outcome."); }
      finally { setBusy(false); }
    }}>
      <fieldset disabled={!ready || busy} className="flex flex-wrap gap-2"><legend className="mb-2 text-xs font-semibold text-slate-600">{tx("Your decision")}</legend>
        <button type="button" aria-pressed={decision === "PROCEED"} onClick={() => setDecision("PROCEED")} className={`rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-40 ${decision === "PROCEED" ? "border-emerald-600 bg-emerald-100 text-emerald-900" : "border-slate-300 bg-white"}`}>{tx("Proceed")}</button>
        <button type="button" aria-pressed={decision === "DECLINE"} onClick={() => setDecision("DECLINE")} className={`rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-40 ${decision === "DECLINE" ? "border-rose-600 bg-rose-100 text-rose-900" : "border-slate-300 bg-white"}`}>{tx("Decline")}</button>
      </fieldset>
      <label className="block text-xs font-semibold text-slate-600">{tx("Your underwriting rationale")}<textarea required minLength={5} maxLength={2000} disabled={!ready || busy} rows={3} value={reason} onChange={e => setReason(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white p-3 text-sm" /></label>
      <button type="submit" disabled={!ready || !decision || reason.trim().length < 5 || busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{tx(busy ? "Saving…" : "Record outcome and send to Claims Manager")}</button>
    </form>}
    {!ready && !state?.resolved && <p className="text-xs text-amber-800">{tx(state?.on_hold ? "This referral is on hold." : "Complete both specialist reviews and run the final AI check first.")}</p>}
    {error && <p role="alert" className="text-sm text-rose-700">{tx(error)}</p>}
  </section>;
}
