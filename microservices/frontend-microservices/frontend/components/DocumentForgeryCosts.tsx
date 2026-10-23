"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import api from "@/app/services/api";
import { tx } from "@/lib/i18n/tx";
interface Report {
  summary: {analyses: number; incomplete: number; input_tokens: number; output_tokens: number; pixel_pages: number; pixel_seconds: number; token_cost_usd: number; pixel_cost_usd: number; known_cost_usd: number; unpriced_components: number};
  by_model: Record<string, {calls: number; input_tokens: number; output_tokens: number}>;
}
export default function DocumentForgeryCosts({startDate,endDate}: {startDate:string;endDate:string}) {
  const [data,setData] = useState<Report | null>(null);
  const [error,setError] = useState("");
  const [revision,setRevision] = useState(0);
  useEffect(() => {
    let active = true; setData(null); setError("");
    api.get<Report>("/api/document-forgery/usage", {baseURL:"", params:{start_date:startDate,end_date:endDate}}).then(r => {if(active)setData(r.data);}).catch(e => {if(active)setError(e.message);});
    return () => {active=false;};
  },[startDate,endDate,revision]);
  const s=data?.summary;
  return <section className="space-y-6 py-6">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-xl font-semibold">{tx("Document Forgery Detection")}</h2><p className="mt-2 text-sm text-slate-500">{tx("Platform public testing · model tokens and local pixel inference · USD")}</p></div><div className="flex gap-4 text-sm text-blue-600"><Link href="/super-admin/document-forgery">{tx("Configure rates and thresholds")}</Link><button onClick={() => setRevision(n=>n+1)}>{tx("Refresh")}</button></div></div>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-red-700">{error}</p>}
    {!s && !error && <p>{tx("Loading costs…")}</p>}
    {s && <><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[
      [s.unpriced_components ? 'Known cost subtotal' : 'Estimated total cost',`$${s.known_cost_usd.toFixed(6)}`],
      ['Model token cost',`$${s.token_cost_usd.toFixed(6)}`],['Pixel inference cost',`$${s.pixel_cost_usd.toFixed(6)}`],['Analyses',s.analyses.toLocaleString()],
      ['Input tokens',s.input_tokens.toLocaleString()],['Output tokens',s.output_tokens.toLocaleString()],['Pixel pages',s.pixel_pages.toLocaleString()],['Pixel inference time',`${s.pixel_seconds.toFixed(1)} s`],
    ].map(([label,value]) => <div key={label} className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-xs text-slate-500">{tx(label)}</p><p className="mt-2 text-2xl font-semibold">{value}</p></div>)}</div>
    {s.unpriced_components > 0 && <p role="status" className="rounded-lg bg-amber-50 p-4 text-sm text-amber-800">{s.unpriced_components} {tx("usage components are unpriced or have unavailable token counts. The subtotal excludes their unknown cost; configure rates for future analyses.")}</p>}
    <p className="text-sm text-slate-500">{s.incomplete} {tx("incomplete analyses. Costs include measured work from partial analyses. Rates are snapshotted per analysis; inference time excludes loading and idle infrastructure. This ledger starts when metering is enabled and does not reconstruct earlier tests.")}</p>
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr>{['Model','Calls','Input tokens','Output tokens'].map(v=><th key={v} className="p-4">{tx(v)}</th>)}</tr></thead><tbody>{Object.entries(data!.by_model).map(([model,m])=><tr key={model} className="border-t border-slate-100"><td className="p-4">{model}</td><td className="p-4">{m.calls}</td><td className="p-4">{m.input_tokens}</td><td className="p-4">{m.output_tokens}</td></tr>)}</tbody></table>{!Object.keys(data!.by_model).length && <p className="p-4 text-slate-500">{tx("No model calls recorded in this date range.")}</p>}</div></>}
  </section>;
}
