"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import api from "@/app/services/api";

export type ForgeryModel = {
  provider: string; model_name: string; has_key: boolean;
  input_per_million: number | null; output_per_million: number | null;
};
type Providers = {provider: string; model_name: string; has_key: boolean}[];
const field = "mt-2 w-full rounded-lg border border-slate-200 bg-white p-2.5 text-sm";

export default function DocumentForgeryModelCard({config, providers, onSaved}: {
  config: {primary: ForgeryModel | null}; providers: Providers; onSaved: () => void;
}) {
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    setProvider(config.primary?.provider || ""); setModel(config.primary?.model_name || "");
    setInput(config.primary?.input_per_million?.toString() ?? "");
    setOutput(config.primary?.output_per_million?.toString() ?? "");
  }, [config]);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setError(""); setMessage("");
    try {
      await api.put("/platform/llm-config/tasks/document-forgery", {primary: provider ? {
        provider, model_name: model.trim(), input_per_million: input === "" ? null : Number(input),
        output_per_million: output === "" ? null : Number(output),
      } : null});
      setMessage("Saved. New analyses use this configuration within 5 seconds."); onSaved();
    } catch(e) {setError(e instanceof Error ? e.message : "Could not save the model.");}
    finally {setSaving(false);}
  }
  return <form onSubmit={save} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6">
    <h2 className="font-bold text-slate-900">Document Forgery Detection model</h2>
    <p className="text-sm text-slate-500">Choose a vision-capable model for content and visual checks. It uses the encrypted provider key saved above. This selection is independent of chat and OCR; no environment key or automatic provider fallback is used. Local TruFor pixel analysis uses its own model.</p>
    <fieldset disabled={saving} className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm">Provider<select className={field} value={provider} onChange={e => {
        setProvider(e.target.value); setModel(providers.find(p => p.provider === e.target.value)?.model_name || "");
        setInput(""); setOutput(""); setMessage("");
      }}><option value="">Content analysis unconfigured</option>{providers.map(p => <option key={p.provider} value={p.provider} disabled={!p.has_key && p.provider !== provider}>{p.provider}{!p.has_key ? " — API key missing" : ""}</option>)}</select></label>
      <label className="text-sm">Model ID<input required={!!provider} disabled={!provider} maxLength={100} pattern="[a-zA-Z0-9./_-]+" className={field} value={model} onChange={e => setModel(e.target.value)} /></label>
      <label className="text-sm">Input cost · USD / 1M tokens<input type="number" min={0} max={10000} step="any" disabled={!provider} placeholder="Unpriced" className={field} value={input} onChange={e => setInput(e.target.value)} /></label>
      <label className="text-sm">Output cost · USD / 1M tokens<input type="number" min={0} max={10000} step="any" disabled={!provider} placeholder="Unpriced" className={field} value={output} onChange={e => setOutput(e.target.value)} /></label>
    </fieldset>
    {config.primary && !config.primary.has_key && <p role="alert" className="text-sm text-amber-700">The selected provider key was removed. Content analysis is unavailable until it is restored or a different model is selected.</p>}
    <p className="text-xs text-slate-500">Blank rates mean unpriced; zero means free. Actual reported tokens and these rates are saved per analysis. Costs are estimates at the configured input/output rates, without provider-specific cache discounts. Later rate changes preserve historical costs.</p>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
    <div className="flex flex-wrap items-center gap-5"><button disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">{saving ? "Saving…" : "Save forgery model"}</button><Link className="text-sm text-blue-600" href="/super-admin/tokens?tab=document-forgery">View separate costs in Token Economy →</Link></div>
  </form>;
}
