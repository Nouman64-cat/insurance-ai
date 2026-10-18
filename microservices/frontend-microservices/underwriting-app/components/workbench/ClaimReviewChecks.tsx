"use client";
import { useState } from "react";
import { tx } from "@/lib/i18n/tx";

export type ClaimCheck = { finding: "Clear" | "Resolved" | "Concern"; note: string; updated_at: string; updated_by: string };
type Requirement = { key: string; label: string; detail?: string; status: string };
type Props = { requirements: Requirement[]; checks: Record<string, ClaimCheck>; disabled: boolean;
  onSave: (key: string, finding: ClaimCheck["finding"], note: string) => Promise<void>;
  onEvidence: (tab: "documents" | "applicant") => void };

export default function ClaimReviewChecks(p: Props) {
  const requirements = p.requirements.filter(r => r.key.startsWith("claim_"));
  if (!requirements.length) return null;
  return <section className="space-y-4" aria-label={tx("Claim review checks")}>
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="text-base font-semibold text-slate-900">{tx("Claim review checks")}</h2>
      <p className="mt-1 text-sm text-slate-500">{tx("Review the evidence and record your findings for each requirement before clearing this review.")}</p>
      <div className="mt-3 flex gap-4 text-sm font-semibold text-blue-700">
        <button onClick={() => p.onEvidence("documents")}>{tx("Review documents")} →</button>
        <button onClick={() => p.onEvidence("applicant")}>{tx("View applicant & policy")} →</button>
      </div>
    </div>
    {requirements.map(r => <CheckForm key={`${r.key}:${p.checks[r.key]?.updated_at ?? "new"}`} requirement={r} saved={p.checks[r.key]} disabled={p.disabled} onSave={p.onSave} />)}
  </section>;
}

function CheckForm({ requirement: r, saved, disabled, onSave }: { requirement: Requirement; saved?: ClaimCheck; disabled: boolean; onSave: Props["onSave"] }) {
  const [finding, setFinding] = useState<ClaimCheck["finding"] | "">(saved?.finding ?? "");
  const [note, setNote] = useState(saved?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return <form id={r.key} className="scroll-mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" onSubmit={async e => {
    e.preventDefault(); if (!finding || note.trim().length < 5 || disabled || saving) return;
    setSaving(true); setError("");
    try { await onSave(r.key, finding, note.trim()); }
    catch (error: any) { setError(error?.response?.data?.detail ?? error?.message ?? "Could not save this check."); }
    finally { setSaving(false); }
  }}>
    <div className="flex items-start justify-between gap-3"><h3 className="font-semibold text-slate-900">{tx(r.label)}</h3>
      <span className={`rounded-full px-2 py-1 text-xs ${r.status === "Completed" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{tx(r.status === "Completed" ? "Completed" : "Review required")}</span></div>
    {r.detail && <p className="mt-2 text-sm leading-6 text-slate-600">{tx(r.detail)}</p>}
    <fieldset disabled={disabled || saving} className="mt-4 space-y-4 disabled:opacity-60">
      <label className="block text-sm font-medium text-slate-700">{tx("Finding")}
        <select required value={finding} onChange={e => setFinding(e.target.value as ClaimCheck["finding"])} className="mt-1 block w-full rounded-lg border border-slate-200 p-2.5">
          <option value="">{tx("Select a finding")}</option>
          <option value="Clear">{tx("No concern identified")}</option>
          <option value="Resolved">{tx("Concern resolved with evidence")}</option>
          <option value="Concern">{tx("Concern requires referral")}</option>
        </select>
      </label>
      <label className="block text-sm font-medium text-slate-700">{tx("Evidence reviewed & rationale")}
        <textarea required minLength={5} maxLength={2000} rows={4} value={note} onChange={e => setNote(e.target.value)} placeholder={tx("Identify the documents, declarations or policy terms reviewed and explain your finding.")} className="mt-1 block w-full rounded-lg border border-slate-200 p-3" />
      </label>
      {finding === "Concern" && <p className="text-sm text-amber-800">{tx("An unresolved concern keeps this requirement open. Record a referred or declined review as appropriate.")}</p>}
      <button disabled={!finding || note.trim().length < 5} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{tx(saving ? "Saving…" : "Save finding")}</button>
    </fieldset>
    {saved && <p className="mt-3 text-xs text-slate-500">{tx("Finding saved")} · {saved.updated_at}</p>}
    {error && <p role="alert" className="mt-3 text-sm text-rose-600">{tx(error)}</p>}
  </form>;
}
