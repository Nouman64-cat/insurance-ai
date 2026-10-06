"use client";

import { useCallback, useEffect, useState } from "react";
import api from "@/app/services/api";
import { Chip, GroupQuote, PanelProps, downloadPdf, errMsg, mpBase, pkr, premiumWord } from "./groupShared";

export default function QuotePanel({ tenantId, orgId, mp, reload }: PanelProps) {
  const base = mpBase(tenantId, orgId, mp.id);
  const word = premiumWord(mp.business_type);
  const Word = word[0].toUpperCase() + word.slice(1);
  const [quotes, setQuotes] = useState<GroupQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [decidedBy, setDecidedBy] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try { setQuotes((await api.get<GroupQuote[]>(`${base}/quotes`)).data); }
    catch (e: any) { setError(errMsg(e, "Could not load the quotes.")); }
    finally { setLoading(false); }
  }, [base]);
  useEffect(() => { load(); }, [load, mp.status]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(""); setNotice("");
    try { await fn(); } catch (e: any) { setError(errMsg(e, `Could not ${label.toLowerCase()}.`)); } finally { setBusy(""); }
  };

  const generate = () => run("Generate", async () => {
    const res = await api.post<GroupQuote>(`${base}/quotes`);
    setNotice(`Quote v${res.data.version} generated.`);
    await load(); await reload();
  });
  const decide = (q: GroupQuote, action: "accept" | "decline") => run(action === "accept" ? "Accept" : "Decline", async () => {
    await api.post(`${base}/quotes/${q.id}/${action}`, { decided_by: decidedBy.trim() || undefined, notes: notes.trim() || undefined });
    setNotice(action === "accept" ? `Quote v${q.version} accepted — the scheme can now be issued.` : `Quote v${q.version} declined.`);
    setNotes(""); await load(); await reload();
  });

  const latest = quotes[0];
  const open = quotes.find((q) => q.status === "Open");
  const canQuote = ["Proposed", "Quoted", "Declined"].includes(mp.status);

  return (
    <div className="space-y-4">
      {(error || notice) && (
        <div className={`rounded-xl border p-3 text-sm font-medium ${error ? "bg-red-50 border-red-200 text-red-700" : "bg-blue-50 border-blue-200 text-blue-700"}`}>{error || notice}</div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-slate-500">
          {canQuote ? `The scheme is priced as one pool. Generating again supersedes the open quote.` : mp.status === "Pending" ? "Enrol the census first — a quote needs members." : "This scheme is past quoting."}
        </p>
        <button onClick={generate} disabled={!canQuote || !!busy}
          className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg">
          {busy === "Generate" ? "Pricing…" : latest ? "Generate revised quote" : "Generate quote"}
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-slate-400">Loading…</div>
      ) : !latest ? (
        <div className="bg-white rounded-xl border border-slate-200 py-12 text-center text-sm text-slate-400">No quote yet.</div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm font-semibold text-slate-700">Quote v{latest.version} <Chip status={latest.status}>{latest.status}</Chip></p>
            <button onClick={() => run("Download", () => downloadPdf(`${base}/quotes/${latest.id}/document`, `quote-v${latest.version}.pdf`))}
              className="text-xs font-semibold text-blue-600 hover:text-blue-800">Download PDF</button>
          </div>
          <dl className="divide-y divide-slate-100 text-sm">
            {([
              ["Members", `${latest.member_count}${latest.dependent_count ? ` + ${latest.dependent_count} dependants` : ""}`],
              ["Total sum assured", pkr(latest.total_sum_assured)],
              ["Effective rate", `PKR ${latest.rate_per_mille} per 1,000 sum assured`],
              [`Risk ${word}`, pkr(latest.risk_premium)],
              ["Policy fee", pkr(latest.policy_fee)],
              ["Stamp duty", pkr(latest.stamp_duty)],
            ] as [string, string][]).map(([k, v]) => (
              <div key={k} className="px-5 py-2.5 flex justify-between"><dt className="text-slate-500">{k}</dt><dd className="font-medium text-slate-800">{v}</dd></div>
            ))}
            {latest.wakala_fee_pct != null && (
              <>
                <div className="px-5 py-2.5 flex justify-between"><dt className="text-slate-500">Wakala fee ({latest.wakala_fee_pct}% of risk {word})</dt><dd className="font-medium text-slate-800">{pkr(latest.wakala_fee)}</dd></div>
                <div className="px-5 py-2.5 flex justify-between"><dt className="text-slate-500">Participants&apos; Takaful Fund (PTF)</dt><dd className="font-medium text-slate-800">{pkr(latest.ptf_allocation)}</dd></div>
              </>
            )}
            <div className="px-5 py-3 flex justify-between bg-slate-50"><dt className="font-semibold text-slate-700">Annual {word}</dt><dd className="font-bold text-slate-900">{pkr(latest.total_premium)}</dd></div>
          </dl>
          <p className="px-5 py-2 text-[11px] text-slate-400">Valid until {latest.valid_until}{latest.decided_by ? ` · decided by ${latest.decided_by}` : ""}</p>
          {latest.breakdown?.adjusted_members?.length > 0 && (
            <p className="px-5 pb-3 text-xs text-amber-700">{latest.breakdown.adjusted_members.length} member(s) carry underwriting adjustments (loading or cover restricted to the Free Cover Limit).</p>
          )}
        </div>
      )}

      {open && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-3">
          <div>
            <p className="text-sm font-semibold text-slate-800">Employer&apos;s decision</p>
            <p className="text-xs text-slate-500">Record what the employer told you. Accepting locks the roster and dependants.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input value={decidedBy} onChange={(e) => setDecidedBy(e.target.value)} placeholder="Decided by (employer contact)" className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-slate-50" />
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-slate-50" />
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => decide(open, "decline")} disabled={!!busy} className="px-4 py-2 text-xs font-semibold text-red-700 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-60">Decline</button>
            <button onClick={() => decide(open, "accept")} disabled={!!busy} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg">
              {busy === "Accept" ? "Recording…" : `Accept — ${pkr(open.total_premium)}`}
            </button>
          </div>
        </div>
      )}

      {quotes.length > 1 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <p className="px-5 py-3 border-b border-slate-100 bg-slate-50 text-sm font-semibold text-slate-700">History</p>
          <table className="w-full text-sm">
            <thead><tr className="text-xs font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-100">
              <th className="px-5 py-2 text-left">Version</th><th className="px-5 py-2 text-left">Status</th><th className="px-5 py-2 text-right">{Word}</th><th className="px-5 py-2 text-left">Valid until</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {quotes.map((q) => (
                <tr key={q.id}>
                  <td className="px-5 py-2.5 font-semibold">v{q.version}</td>
                  <td className="px-5 py-2.5"><Chip status={q.status}>{q.status}</Chip></td>
                  <td className="px-5 py-2.5 text-right tabular-nums">{pkr(q.total_premium)}</td>
                  <td className="px-5 py-2.5 text-slate-500">{q.valid_until}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
