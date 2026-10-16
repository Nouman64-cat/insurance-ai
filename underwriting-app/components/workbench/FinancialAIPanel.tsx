"use client";

import { useState } from "react";
import api from "@/app/services/api";
import { fmtCoverage } from "@/lib/mock-data";
import { tx } from "@/lib/i18n/tx";
import { notify } from "./toast";

type Reason = { parameter?: string; observation?: string; risk_rating?: string } | string;
export type FinancialAI = {
  ready: boolean;
  blockers: string[];
  run_at: string | null;
  result: {
    score: number | null; reasons: Reason[]; financially_justified?: boolean; referral_required?: boolean;
    coverage_to_income_ratio?: number | null; maximum_supported_cover?: number | null; verified_income?: number | null;
  } | null;
};

const RATING_TONE: Record<string, string> = {
  low: "bg-emerald-50 text-emerald-700", moderate: "bg-amber-50 text-amber-800", medium: "bg-amber-50 text-amber-800",
  high: "bg-rose-50 text-rose-700", "very high": "bg-rose-50 text-rose-700", critical: "bg-rose-50 text-rose-700",
};

/** The financial counterpart of AI medical underwriting: runs once the financial requirements are in, and
 * informs the financial review — the underwriter still records the decision. */
export default function FinancialAIPanel({ tenantId, caseId, ai, disabled, onDone }: {
  tenantId: string; caseId: string; ai: FinancialAI | null; disabled: boolean; onDone: () => void;
}) {
  const [running, setRunning] = useState(false);
  if (!ai) return null;
  const result = ai.result;
  const run = async () => {
    setRunning(true);
    try {
      await api.post(`/tenants/${tenantId}/cases/${caseId}/financial-underwriting/run`, null, { timeout: 150000 });
      notify("success", tx("AI financial underwriting complete"), tx("Review the findings, then record your decision."));
      onDone();
    } catch (e: any) {
      notify("error", tx("AI financial underwriting failed"), e?.response?.data?.detail ?? e?.message);
    } finally { setRunning(false); }
  };
  const score = result?.score ?? null;
  const [scoreTone, barTone] = score == null ? ["text-slate-400", "bg-slate-300"] : score >= 60 ? ["text-rose-600", "bg-rose-500"] : score >= 35 ? ["text-amber-600", "bg-amber-500"] : ["text-emerald-600", "bg-emerald-500"];
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-base font-semibold text-slate-900">{tx("AI financial underwriting")}</h2>
        <p className="mt-0.5 text-xs text-slate-500">{ai.run_at ? `${tx("Last run")} ${new Date(ai.run_at).toLocaleString()}` : tx("Scores financial risk, works out the cover the income supports and whether a referral is needed.")}</p></div>
      {result && <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${result.referral_required ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-700"}`}>{tx(result.referral_required ? "Referral suggested" : "No referral needed")}</span>}
    </div>

    {result && <>
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3"><p className="text-xs text-slate-500">{tx("Financial risk score")}</p><p className={`mt-1 text-lg font-semibold tabular-nums ${scoreTone}`}>{score ?? "—"}<span className="text-xs font-normal text-slate-400"> / 100</span></p><div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200"><div className={`h-full ${barTone}`} style={{ width: `${Math.min(100, score ?? 0)}%` }} /></div></div>
        <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3"><p className="text-xs text-slate-500">{tx("Cover justified by income")}</p><p className={`mt-1 text-lg font-semibold ${result.financially_justified ? "text-emerald-600" : "text-rose-600"}`}>{tx(result.financially_justified ? "Yes" : "No")}</p></div>
        <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3"><p className="text-xs text-slate-500">{tx("Cover ÷ income")}</p><p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{result.coverage_to_income_ratio != null ? `${result.coverage_to_income_ratio.toFixed(1)}×` : "—"}</p></div>
        <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3"><p className="text-xs text-slate-500">{tx("Maximum supported cover")}</p><p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{result.maximum_supported_cover ? fmtCoverage(result.maximum_supported_cover) : "—"}</p></div>
      </div>
      {result.reasons?.length > 0 && <ul className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-100">{result.reasons.map((r, i) => { const reason = typeof r === "string" ? { observation: r } : r; const rating = (reason.risk_rating ?? "").toLowerCase(); return <li key={i} className="flex items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">{reason.parameter && <p className="text-sm font-semibold text-slate-900">{reason.parameter}</p>}<p className="text-sm text-slate-600">{reason.observation}</p></div>
        {reason.risk_rating && <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${RATING_TONE[rating] ?? "bg-slate-100 text-slate-600"}`}>{reason.risk_rating}</span>}
      </li>; })}</ul>}
    </>}

    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-900">{tx(ai.ready ? (result ? "Ready to run again" : "All financial requirements are in") : "Waiting for requirements")}</p>
        {ai.ready ? <p className="mt-0.5 text-xs text-slate-500">{tx(result ? "Run again after new evidence arrives." : "The AI reviews the e-application, income documents, existing cover and the agent's report.")}</p>
          : <ul className="mt-1 space-y-0.5">{ai.blockers.map((b) => <li key={b} className="flex items-start gap-1.5 text-xs text-slate-600"><span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-500" />{tx(b)}</li>)}</ul>}
      </div>
      <button disabled={disabled || running || !ai.ready} onClick={() => void run()} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">
        {running ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></svg>}
        {tx(running ? "Running…" : result ? "Re-run AI financial underwriting" : "Run AI financial underwriting")}</button>
    </div>
  </section>;
}
