"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import api from "@/app/services/api";
import { tx } from "@/lib/i18n/tx";

type Settings = {
  enabled: boolean; content_enabled: boolean; pixel_enabled: boolean; visual_enabled: boolean;
  provider: "gemini" | "groq"; gemini_model: string; groq_model: string;
  max_pages: number; pixel_timeout_seconds: number; threshold_mode: "reference" | "manual";
  t95: number; tmax: number;
  gemini_input_per_million: number | null; gemini_output_per_million: number | null;
  groq_input_per_million: number | null; groq_output_per_million: number | null;
  pixel_per_hour: number | null;
};
const field = "mt-2 w-full rounded-lg border border-slate-300 bg-white p-2.5 text-sm disabled:bg-slate-100";
const card = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-5";

export default function DocumentForgerySettings() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  useEffect(() => {
    const ok = localStorage.getItem("user_role") === "SuperAdmin"; setAllowed(ok);
    if (ok) api.get("/api/document-forgery/config", {baseURL:""}).then(r => {setDraft(r.data.settings); setSaved(r.data.settings);}).catch(e => setError(e.message));
  }, []);
  const update = (key: keyof Settings, value: string | number | boolean | null) => {setDraft(d => d ? {...d, [key]: value} : d); setSuccess("");};
  const save = async () => {
    if (!draft) return;
    setSaving(true); setError(""); setSuccess("");
    try {const r = await api.put("/api/document-forgery/config", draft, {baseURL:""}); setDraft(r.data.settings); setSaved(r.data.settings); setSuccess("Saved. New analyses use this policy within 5 seconds.");}
    catch(e) {setError(e instanceof Error ? e.message : "Could not save settings");}
    finally {setSaving(false);}
  };
  if (allowed === false) return <div className="p-8">{tx("Access Denied")}</div>;
  return <main className="mx-auto max-w-5xl space-y-6 p-6">
    <header><p className="text-xs font-semibold uppercase tracking-widest text-blue-600">{tx("SuperAdmin")}</p><h1 className="mt-1 text-2xl font-semibold">{tx("Document Forgery Detection")}</h1><p className="mt-2 text-sm text-slate-500">{tx("Manage analysis limits, pixel thresholds and cost rates for the public testing service.")}</p><Link href="/super-admin/tokens?tab=document-forgery" className="mt-3 inline-block text-sm text-blue-600">{tx("View costs in Token Economy")} →</Link></header>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-red-700">{error}</p>}
    {success && <p role="status" className="rounded-xl bg-emerald-50 p-4 text-emerald-700">{success}</p>}
    {!draft ? <p>{tx("Loading settings…")}</p> : <form className="space-y-6" onSubmit={e => {e.preventDefault(); void save();}}>
      <fieldset disabled={saving} className={card}><legend className="px-2 font-semibold">{tx("Analysis policy")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">{([['enabled','Service enabled'],['content_enabled','Allow content analysis (Layer 2)'],['pixel_enabled','Allow pixel forensics (Layer 3)'],['visual_enabled','Allow additional visual inspection']] as const).map(([key,label]) => <label key={key} className="flex items-center gap-3 text-sm"><input type="checkbox" checked={draft[key]} onChange={e => update(key,e.target.checked)} />{tx(label)}</label>)}</div>
        <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">{tx("Content provider")}<select className={field} value={draft.provider} onChange={e => update('provider',e.target.value)}><option value="gemini">Gemini</option><option value="groq">Groq</option></select></label>
        {(['gemini_model','groq_model'] as const).map(key => <label key={key} className="text-sm">{key === 'gemini_model' ? 'Gemini model' : 'Groq model'}<input required maxLength={100} pattern="[a-zA-Z0-9./_-]+" className={field} value={draft[key]} onChange={e => update(key,e.target.value)} /></label>)}
        <label className="text-sm">{tx("Maximum pages per analysis")}<input type="number" required min={1} max={40} className={field} value={draft.max_pages} onChange={e => update('max_pages',Number(e.target.value))} /></label>
        <label className="text-sm">{tx("Pixel worker timeout (seconds)")}<input type="number" required min={30} max={540} className={field} value={draft.pixel_timeout_seconds} onChange={e => update('pixel_timeout_seconds',Number(e.target.value))} /></label></div>
        <p className="text-xs leading-5 text-slate-500">{tx("Layer 1 always runs. Layers 2 and 3 remain opt-in for each upload. Provider credentials come from the service environment; keys are never exposed here. Public test usage is charged to the platform.")}</p>
      </fieldset>
      <fieldset disabled={saving} className={card}><legend className="px-2 font-semibold">{tx("Pixel anomaly thresholds")}</legend>
        <label className="block text-sm">{tx("Threshold source")}<select className={field} value={draft.threshold_mode} onChange={e => update('threshold_mode',e.target.value)}><option value="reference">{tx("Packaged reference baseline")}</option><option value="manual">{tx("SuperAdmin manual override")}</option></select></label>
        <div className="grid gap-4 sm:grid-cols-2">{(['t95','tmax'] as const).map(key => <label key={key} className="text-sm">{key === 't95' ? 'INFO threshold (t95)' : 'LOW threshold (tmax)'}<input type="number" required min={key === 'tmax' ? draft.t95 : 0} max={1} step="any" disabled={draft.threshold_mode !== 'manual'} className={field} value={draft.threshold_mode === 'reference' ? (key === 't95' ? 0.5256373882293701 : 0.7155507206916809) : draft[key]} onChange={e => update(key,Number(e.target.value))} /></label>)}</div>
        <p className="rounded-lg bg-amber-50 p-4 text-sm leading-6 text-amber-800">{tx("Reference cutoffs use 21 genuine calibration pages and 9 held-out genuine pages. They are provisional. Manual cutoffs have no calibration or validation claim. Scores are anomaly indicators, not forgery probabilities; pixel findings are capped at LOW severity.")}</p>
      </fieldset>
      <fieldset disabled={saving} className={card}><legend className="px-2 font-semibold">{tx("Cost rates · USD")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">{([['gemini_input_per_million','Gemini input / 1M tokens'],['gemini_output_per_million','Gemini output / 1M tokens'],['groq_input_per_million','Groq input / 1M tokens'],['groq_output_per_million','Groq output / 1M tokens'],['pixel_per_hour','Pixel inference / worker hour']] as const).map(([key,label]) => <label key={key} className="text-sm">{tx(label)}<input type="number" min={0} max={10000} step="any" placeholder="Unpriced" className={field} value={draft[key] ?? ''} onChange={e => update(key,e.target.value === '' ? null : Number(e.target.value))} /></label>)}</div>
        <p className="text-xs leading-5 text-slate-500">{tx("Enter your provider and infrastructure rates. Blank means unpriced; zero means explicitly free. Rates are saved with each analysis, so later changes do not reprice history. Pixel cost uses measured inference time, excluding queueing, loading and idle infrastructure. No tokens are invented for local inference.")}</p>
      </fieldset>
      <button disabled={saving || JSON.stringify(draft) === JSON.stringify(saved)} className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40">{saving ? tx("Saving…") : tx("Save changes")}</button>
    </form>}
  </main>;
}
