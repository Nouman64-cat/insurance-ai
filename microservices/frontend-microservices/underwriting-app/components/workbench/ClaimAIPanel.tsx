"use client";

import { useState } from "react";
import api from "@/app/services/api";
import { tx } from "@/lib/i18n/tx";
import { notify } from "./toast";

export type ClaimAI = {
  ready: boolean; blockers: string[]; run_at: string | null;
  result: {
    recommendation: "Proceed" | "Refer" | "Decline"; summary: string;
    findings: { requirement: string; observation: string; evidence: string[] }[];
    missing_evidence: string[]; advisory: boolean;
  } | null;
};

export default function ClaimAIPanel({ tenantId, caseId, track, ai, disabled, onDone }: {
  tenantId: string; caseId: string; track: "medical" | "financial";
  ai: ClaimAI | null; disabled: boolean; onDone: () => void;
}) {
  const [running, setRunning] = useState(false);
  const run = async () => {
    if (running || disabled || !ai?.ready) return;
    setRunning(true);
    try {
      await api.post(`/tenants/${tenantId}/cases/${caseId}/claim-underwriting/${track}/run`, null, { timeout: 150000 });
      notify("success", tx("AI claim recommendation saved"), tx("Review the findings, then record your decision."));
      onDone();
    } catch (e: any) {
      notify("error", tx("AI claim underwriting failed"), e?.response?.data?.detail ?? e?.message);
    } finally { setRunning(false); }
  };
  const result = ai?.result;
  const label = track === "medical" ? "Run AI medical underwriting" : "Run AI financial underwriting";
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-busy={running}>
    <h2 className="text-base font-semibold text-slate-900">{tx(track === "medical" ? "AI medical underwriting" : "AI financial underwriting")}</h2>
    <p className="mt-1 text-xs text-slate-500">{tx("Reviews this claim's evidence and plan terms. Advisory only — record your own findings and review. The Claims Manager decides the claim.")}</p>
    {ai?.run_at && <p className="mt-2 text-xs text-slate-400">{tx("Last run")} {new Date(ai.run_at).toLocaleString()}</p>}
    {result && <div className="mt-4 space-y-3" aria-live="polite">
      <p className="text-sm font-semibold text-slate-900">{tx("AI recommendation")}: {tx(result.recommendation)}</p>
      <p className="whitespace-pre-wrap text-sm text-slate-700">{result.summary}</p>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">{result.findings.map((f, i) => <li key={i} className="p-3 text-sm">
        <p className="font-semibold text-slate-900">{f.requirement}</p><p className="whitespace-pre-wrap text-slate-600">{f.observation}</p>
        {f.evidence.length > 0 && <p className="mt-1 text-xs text-slate-500">{tx("Evidence")}: {f.evidence.join("; ")}</p>}
      </li>)}</ul>
      {result.missing_evidence.length > 0 && <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900"><p className="font-semibold">{tx("Missing evidence")}</p><ul className="list-disc ps-5">{result.missing_evidence.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
    </div>}
    {(ai?.blockers ?? []).length > 0 && <ul className="mt-4 list-disc ps-5 text-xs text-amber-800">{ai!.blockers.map(b => <li key={b}>{tx(b)}</li>)}</ul>}
    <button type="button" disabled={disabled || running || !ai?.ready} onClick={() => void run()}
      className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">
      {running && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
      {tx(running ? "Running…" : label)}
    </button>
  </section>;
}
