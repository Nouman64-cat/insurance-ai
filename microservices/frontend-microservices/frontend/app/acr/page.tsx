"use client";
import { useEffect, useState } from "react";
import { useACRRequests } from "@/components/ACRRequestsProvider";
import { ACRModal } from "@/components/entities/ACRModal";
import { getACR, listMyACRRequests, type ACRRequest, type AgentConfidentialReport } from "@/app/services/agentConfidentialReport";
import { tx } from "@/lib/i18n/tx";

export default function ACRPage() {
  const { requests, refresh } = useACRRequests();
  const [items, setItems] = useState<ACRRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ id: string; report: AgentConfidentialReport } | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    listMyACRRequests().then((rows) => { if (active) setItems(rows); })
      .catch(() => { if (active) setError("Couldn't load confidential report requests."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [requests, reload]);
  async function open(id: string) {
    setOpening(id); setError("");
    try { setSelected({ id, report: await getACR(id) }); }
    catch { setError("Couldn't open the confidential report."); }
    finally { setOpening(null); }
  }
  return <div className="p-6 space-y-5">
    <h1 className="text-xl font-bold text-slate-900">{tx("Agent's Confidential Reports")}</h1>
    <p className="text-sm text-slate-600">{tx("Reports requested from you for individual, family, and corporate cases.")}</p>
    {error && <div role="alert" className="text-red-700">{tx(error)} <button className="underline" onClick={() => setReload((n) => n + 1)}>{tx("Retry")}</button></div>}
    {loading ? <p role="status">{tx("Loading…")}</p> : !error && items.length === 0 ? <p>{tx("No confidential reports requested.")}</p> : <div className="divide-y rounded-lg border border-slate-200 bg-white">
      {items.map((r) => <div key={r.case_id} className="flex items-center justify-between gap-4 p-4">
        <div><p className="font-semibold">{r.applicant_name || r.case_number}</p><p className="text-sm text-slate-500">{r.case_number} {r.group_name} ({r.segment})</p></div>
        <button disabled={opening !== null} onClick={() => open(r.case_id)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{tx(opening === r.case_id ? "Loading…" : r.status === "Draft" ? "Continue ACR" : "File ACR")}</button>
      </div>)}
    </div>}
    {selected && <ACRModal key={selected.id} caseId={selected.id} initial={selected.report} onClose={() => setSelected(null)} onDone={() => { setSelected(null); refresh(); setReload((n) => n + 1); }} />}
  </div>;
}
