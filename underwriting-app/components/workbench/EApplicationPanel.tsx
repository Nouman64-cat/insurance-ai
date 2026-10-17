"use client";

import { useEffect, useState } from "react";
import { getEApplication, type EApplication } from "@/app/services/eApplication";
import { tx } from "@/lib/i18n/tx";
import { requirementState, statusLabel, STATE_TONE } from "./requirementStatus";

// Resending is possible until the customer submits; a new link replaces the old one.
const SENDABLE = new Set(["NotSent", "Sent", "InProgress", "Expired"]);

/** This track's e-application questionnaire: the medical one or the financial one, each sent and signed on its own. */
export default function EApplicationPanel({ caseId, track, refreshKey, onSend, onWaive, waived, sending, canSend, onViewAnswers }: {
  caseId: string; track: "medical" | "financial"; refreshKey: unknown;
  onSend: () => void; sending: boolean; canSend: boolean; onViewAnswers: () => void;
  /** Waive this track's questionnaire instead of waiting on the customer (recorded on the review). */
  onWaive?: () => void; waived?: boolean;
}) {
  const [app, setApp] = useState<EApplication | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { getEApplication(caseId).then((a) => { setApp(a); setFailed(false); }, () => setFailed(true)); }, [caseId, refreshKey]);
  // An e-application sent before the split has no parts: its combined progress stands for both.
  const mine = app?.parts?.[track];
  const progress = mine ?? app;
  // A waiver is recorded on the review, not on the questionnaire, so the review says so.
  const status = waived ? "Waived" : app?.status === "Verified" ? "Submitted" : progress?.status ?? "NotSent";
  const tone = STATE_TONE[requirementState(status)];
  const steps: [string, string | null | undefined][] = [["Sent", progress?.sent_at], ["Started", progress?.started_at], ["Submitted", progress?.submitted_at], ["Verified", app?.verified_at]];
  const signature = mine ? mine.signature_name : app?.declaration?.signature_name;
  const fp = app?.financial_profile ?? {};
  const money = (v: unknown) => { const n = Number(v); return v && Number.isFinite(n) ? `PKR ${n.toLocaleString()}` : tx("Not given"); };
  const mq = app?.medical_questionnaire ?? {};
  const conditions = (Array.isArray(mq.conditions) ? mq.conditions : []).filter((c: any) => c.checked);
  const existing = app?.existing_insurance ?? {};
  const highlights: [string, string, boolean][] = track === "medical"
    ? [["Declared conditions", conditions.length ? conditions.map((c: any) => c.label).join(", ") : tx("None"), conditions.length > 0],
       ["Surgeries", (mq.surgeries ?? []).length ? `${mq.surgeries.length}` : tx("None"), (mq.surgeries ?? []).length > 0],
       ["Hospital stays", (mq.hospitalizations ?? []).length ? `${mq.hospitalizations.length}` : tx("None"), (mq.hospitalizations ?? []).length > 0],
       ["Tobacco", tx(mq.tobacco_use ? "Yes" : "No"), Boolean(mq.tobacco_use)]]
    : [["Annual income", `${money(fp.income?.annual_income)}${fp.income?.income_basis ? ` · ${tx(fp.income.income_basis)}` : ""}`, false],
       ["Employment", [fp.employment?.employment_type, fp.employment?.occupation].filter(Boolean).join(" · ") || tx("Not given"), false],
       ["Loans or debts", tx(fp.commitments?.has_loans ? "Yes" : "No"), Boolean(fp.commitments?.has_loans)],
       ["Existing policies", (existing.policies ?? []).length ? `${existing.policies.length}` : tx("None"), (existing.policies ?? []).length > 0]];
  const submitted = Boolean(progress?.submitted_at);
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
      <div><h2 className="text-base font-semibold text-slate-900">{tx(track === "medical" ? "Medical e-application" : "Financial e-application")}</h2>
        <p className="mt-0.5 text-xs text-slate-500">{submitted && signature ? `${tx("Signed by")} ${signature}` : tx(track === "medical" ? "Health, family history and lifestyle, completed by the customer." : "Employment, income, commitments, premium funding and existing cover, completed by the customer.")}</p></div>
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${tone.pill}`}><span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />{tx(statusLabel(status))}</span>
    </header>
    <ol className="grid grid-cols-4 border-b border-slate-100">{steps.map(([label, at], i) => <li key={label} className={`px-5 py-3 ${i ? "border-s border-slate-100" : ""}`}>
      <p className={`flex items-center gap-1.5 text-xs font-semibold ${at ? "text-emerald-700" : "text-slate-400"}`}><span className={`h-1.5 w-1.5 rounded-full ${at ? "bg-emerald-500" : "bg-slate-300"}`} />{tx(label)}</p>
      <p className="mt-0.5 truncate text-xs text-slate-500">{at ? new Date(at).toLocaleString() : "—"}</p></li>)}</ol>
    {failed ? <p className="px-5 py-5 text-sm text-rose-700">{tx("Could not load the e-application.")}</p>
      : submitted ? <dl className="grid gap-px bg-slate-100 sm:grid-cols-2 xl:grid-cols-4">{highlights.map(([label, value, flag]) => <div key={label} className="bg-white px-5 py-4"><dt className="text-xs text-slate-500">{tx(label)}</dt><dd className={`mt-1 text-sm font-semibold ${flag ? "text-amber-700" : "text-slate-900"}`}>{value}</dd></div>)}</dl>
      : status === "Waived" ? <p className="px-5 py-5 text-sm text-slate-500">{tx(`The ${track} e-application was waived — the review goes on without the customer's questionnaire.`)}</p>
      : <p className="px-5 py-5 text-sm text-slate-500">{tx(status === "NotSent" ? `Email the customer a secure link to complete their ${track} e-application.` : status === "Expired" ? "The link expired before the customer submitted. Send a fresh link." : "Waiting for the customer to submit. Their answers appear here as soon as they do.")}</p>}
    <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
      {submitted && <button onClick={onViewAnswers} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-blue-700 hover:bg-blue-50">{tx("View all answers")} →</button>}
      {SENDABLE.has(status) && onWaive && <button disabled={!canSend || sending} onClick={onWaive} title={canSend ? tx("Waive this questionnaire instead of waiting on the customer") : tx("Start your review to waive it.")} className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">{tx("Waive")}</button>}
      {SENDABLE.has(status) && <button disabled={!canSend || sending} onClick={onSend} title={canSend ? undefined : tx("Start your review to email the customer.")} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">{tx(sending ? "Sending…" : status === "NotSent" ? "Email to customer" : "Resend email")}</button>}
    </footer>
  </section>;
}
