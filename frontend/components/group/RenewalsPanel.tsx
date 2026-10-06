"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import api from "@/app/services/api";
import { Chip, GroupRenewal, PanelProps, downloadPdf, errMsg, mpBase, pkr, premiumWord, signedPkr } from "./groupShared";

const LIVE = new Set(["Open", "Quoted", "Accepted"]);
const tone = (s: string) => (s === "Renewed" ? "Active" : s === "Accepted" ? "Accepted" : s === "Declined" || s === "Lapsed" ? "Declined" : s === "Quoted" ? "Quoted" : "Pending");

export default function RenewalsPanel({ tenantId, orgId, mp, reload }: PanelProps) {
  const base = mpBase(tenantId, orgId, mp.id);
  const word = premiumWord(mp.business_type);
  const live = mp.status === "Active" && !!mp.expiry_date;
  const [items, setItems] = useState<GroupRenewal[]>([]);
  const [detail, setDetail] = useState<GroupRenewal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [rows, setRows] = useState<Record<string, any>[] | null>(null);
  const [removeMissing, setRemoveMissing] = useState(false);
  const [refreshPreview, setRefreshPreview] = useState<any>(null);
  const [decidedBy, setDecidedBy] = useState("");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const file = useRef<HTMLInputElement>(null);

  const open = (r: GroupRenewal | null) => api.get<GroupRenewal>(`${base}/renewals/${r?.id}`).then((d) => setDetail(d.data));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = (await api.get<GroupRenewal[]>(`${base}/renewals`)).data;
      setItems(list);
      const current = list.find((r) => LIVE.has(r.status)) ?? list[0] ?? null;
      setDetail(current ? (await api.get<GroupRenewal>(`${base}/renewals/${current.id}`)).data : null);
    } catch (e: any) { setError(errMsg(e, "Could not load the renewals.")); }
    finally { setLoading(false); }
  }, [base]);
  useEffect(() => { if (live || mp.expiry_date) load(); else setLoading(false); }, [load, live, mp.expiry_date]);

  const quote = detail?.quotes?.[0] ?? null;
  useEffect(() => { if (quote) setAmount(String(quote.total_premium)); }, [quote]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(""); setNotice("");
    try { await fn(); } catch (e: any) { setError(errMsg(e, `Could not ${label.toLowerCase()}.`)); } finally { setBusy(""); }
  };

  const start = () => run("Start the renewal", async () => { await api.post(`${base}/renewals`, {}); await load(); });
  const refreshBody = (preview: boolean) => ({ employees: rows, remove_missing: removeMissing, preview });
  const onFile = (f: File) => run("Read the file", async () => {
    const form = new FormData(); form.append("file", f);
    const res = await api.post(`${base}/census/parse`, form, { headers: { "Content-Type": "multipart/form-data" } });
    setRows(res.data.rows); setRefreshPreview(null);
    if (file.current) file.current.value = "";
  });
  const previewRefresh = () => run("Preview the changes", async () => { setRefreshPreview((await api.post(`${base}/renewals/${detail!.id}/census-refresh`, refreshBody(true))).data); });
  const applyRefresh = () => run("Apply the changes", async () => {
    const res = await api.post(`${base}/renewals/${detail!.id}/census-refresh`, refreshBody(false));
    setNotice(`Workforce refreshed: ${res.data.added} added, ${res.data.changed} changed, ${res.data.removed} removed.`);
    setRows(null); setRefreshPreview(null); await load(); await reload();
  });
  const makeQuote = () => run("Price the renewal", async () => { await api.post(`${base}/renewals/${detail!.id}/quote`); await load(); });
  const decide = (verb: "accept" | "decline") => run(verb === "accept" ? "Accept" : "Decline", async () => {
    await api.post(`${base}/renewals/${detail!.id}/${verb}`, { decided_by: decidedBy.trim() || "Administrator" });
    await load();
  });
  const pay = () => run("Record the payment", async () => {
    await api.post(`${base}/renewals/${detail!.id}/payments`, { reference: reference.trim(), amount: parseFloat(amount) });
    setNotice("Renewal paid — the scheme now runs the new period."); setReference(""); await load(); await reload();
  });

  if (!live && items.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 py-12 px-6 text-center text-sm text-slate-500">
        A scheme renews once it is in force ({mp.status}). The renewal opens ahead of the expiry date.
      </div>
    );
  }

  const field = "border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-slate-50";
  const x = detail?.experience ?? {};
  const inProgress = !!detail && LIVE.has(detail.status);
  const prior = detail?.quotes?.find((q) => q.status === "Superseded");

  return (
    <div className="space-y-4">
      {(error || notice) && (
        <div className={`rounded-xl border p-3 text-sm font-medium ${error ? "bg-red-50 border-red-200 text-red-700" : "bg-blue-50 border-blue-200 text-blue-700"}`}>{error || notice}</div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-slate-500">Cover period {mp.effective_date} to {mp.expiry_date}. The renewal opens ahead of expiry and prices the next year from this group&apos;s own claims.</p>
        {live && !inProgress && <button onClick={start} disabled={!!busy} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg">{busy === "Start the renewal" ? "Starting…" : "Start the renewal"}</button>}
      </div>

      {loading ? <div className="py-10 text-center text-sm text-slate-400">Loading…</div> : !detail ? (
        <div className="bg-white rounded-xl border border-slate-200 py-10 text-center text-sm text-slate-400">No renewal has been started for this period.</div>
      ) : (
        <>
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <p className="text-sm font-semibold text-slate-800">Renewal {detail.period_no} · {detail.new_period_start} to {detail.new_period_end}</p>
                <p className="text-xs text-slate-500">Expiring period {detail.current_period_start} to {detail.current_period_end}{detail.source === "Scheduler" ? " · opened automatically" : ""}</p>
              </div>
              <Chip status={tone(detail.status)}>{detail.status}</Chip>
            </div>
            <dl className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
              {[
                [`${word[0].toUpperCase() + word.slice(1)} earned`, pkr(x.premium_earned)],
                ["Claims incurred", `${pkr(x.claims_incurred)} (${x.claim_count ?? 0})`],
                ["Loss ratio", x.claims_ratio != null ? `${(x.claims_ratio * 100).toFixed(1)}% · target ${((x.target_loss_ratio ?? 0.6) * 100).toFixed(0)}%` : "—"],
                ["Credibility", x.credibility != null ? `${(x.credibility * 100).toFixed(0)}% of ${x.member_count ?? "—"} lives` : "—"],
                ["Rate factor", `${detail.experience_factor.toFixed(3)}×`],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"><dt className="text-slate-400">{k}</dt><dd className="font-semibold text-slate-800 tabular-nums">{v}</dd></div>
              ))}
            </dl>
          </div>

          {["Open", "Quoted"].includes(detail.status) && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-3">
              <p className="text-sm font-semibold text-slate-700">1 · Refresh the workforce</p>
              <p className="text-xs text-slate-500">Upload the employer&apos;s current list. Joiners are added and changed salaries or grades applied, each as an endorsement priced pro rata. People missing from the file are only removed if you say so.</p>
              <div className="flex items-center gap-3 flex-wrap">
                <input ref={file} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
                <button onClick={() => file.current?.click()} className="px-3 py-1.5 text-xs font-semibold text-slate-700 border border-slate-200 rounded-lg hover:bg-slate-50">Upload CSV / Excel</button>
                {rows && <span className="text-xs text-slate-600">{rows.length} rows read</span>}
                {rows && <label className="text-xs text-slate-600 flex items-center gap-2"><input type="checkbox" checked={removeMissing} onChange={(e) => { setRemoveMissing(e.target.checked); setRefreshPreview(null); }} />Treat people missing from the file as leavers</label>}
              </div>
              {refreshPreview && (
                <p className="text-xs text-slate-700 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  {refreshPreview.added} to add · {refreshPreview.changed} to change · {refreshPreview.removed} to remove · {refreshPreview.unchanged} unchanged
                  {refreshPreview.not_in_file ? ` · ${refreshPreview.not_in_file} not in the file` : ""} · {word} {signedPkr(refreshPreview.premium_delta)}
                </p>
              )}
              {rows && (
                <div className="flex justify-end gap-2">
                  <button onClick={previewRefresh} disabled={!!busy} className="px-4 py-2 text-xs font-semibold text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50">Preview changes</button>
                  <button onClick={applyRefresh} disabled={!refreshPreview || !!busy} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg">Apply to the scheme</button>
                </div>
              )}
            </div>
          )}

          {["Open", "Quoted"].includes(detail.status) && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-sm font-semibold text-slate-700">2 · Renewal quote</p>
                <button onClick={makeQuote} disabled={!!busy} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg">{busy === "Price the renewal" ? "Pricing…" : quote ? "Re-price" : "Price the renewal"}</button>
              </div>
              {!quote && <p className="text-xs text-slate-400">Prices the new period from the current roster and the rate factor above.</p>}
            </div>
          )}

          {quote && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-sm font-semibold text-slate-700">Renewal quote v{quote.version}</p>
                <button onClick={() => run("Download", () => downloadPdf(`${base}/renewals/${detail.id}/quote/document`, `renewal-${mp.policy_number ?? "quote"}-${detail.period_no}.pdf`))} className="text-xs font-semibold text-blue-600 hover:text-blue-800">Download PDF</button>
              </div>
              <dl className="divide-y divide-slate-100 text-sm">
                {([
                  ["Members", String(quote.member_count)],
                  ["Total sum assured", pkr(quote.total_sum_assured)],
                  [`Rate per mille${detail.experience_factor !== 1 ? ` (incl. ${detail.experience_factor.toFixed(3)}× experience)` : ""}`, quote.rate_per_mille.toFixed(3)],
                  [`${word[0].toUpperCase() + word.slice(1)} before fees`, pkr(quote.risk_premium)],
                  ["Policy fee and stamp duty", pkr(quote.policy_fee + quote.stamp_duty)],
                  ...(quote.wakala_fee != null ? [["Wakala fee", pkr(quote.wakala_fee)], ["Participants' Takaful Fund", pkr(quote.ptf_allocation)]] : []),
                  ...(quote.retakaful_contribution != null ? [[`Ceded to retakaful (${quote.retakaful_share_pct}%)`, pkr(quote.retakaful_contribution)]] : []),
                ] as [string, string][]).map(([k, v]) => <div key={k} className="py-2 flex justify-between"><dt className="text-slate-500">{k}</dt><dd className="font-semibold text-slate-800 tabular-nums">{v}</dd></div>)}
                <div className="py-2 flex justify-between"><dt className="font-semibold text-slate-800">Total {word}</dt><dd className="font-bold text-slate-900 tabular-nums">{pkr(quote.total_premium)}</dd></div>
              </dl>
              {prior && <p className="text-xs text-slate-400">Replaces v{prior.version} ({pkr(prior.total_premium)}).</p>}

              {detail.status === "Quoted" && (
                <div className="flex items-end gap-3 flex-wrap border-t border-slate-100 pt-3">
                  <label className="text-xs font-semibold text-slate-600 space-y-1"><span className="block">Decided by (optional)</span>
                    <input className={`${field} w-52`} value={decidedBy} onChange={(e) => setDecidedBy(e.target.value)} placeholder="Employer's CFO" /></label>
                  <button onClick={() => decide("accept")} disabled={!!busy} className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 rounded-lg">Employer accepts</button>
                  <button onClick={() => decide("decline")} disabled={!!busy} className="px-4 py-2 text-xs font-semibold text-red-700 border border-red-200 hover:bg-red-50 disabled:opacity-60 rounded-lg">Employer declines</button>
                </div>
              )}
              {detail.status === "Accepted" && (
                <div className="flex items-end gap-3 flex-wrap border-t border-slate-100 pt-3">
                  <label className="text-xs font-semibold text-slate-600 space-y-1"><span className="block">Bank / transfer reference *</span>
                    <input className={`${field} w-56`} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="IBFT-123456" /></label>
                  <label className="text-xs font-semibold text-slate-600 space-y-1"><span className="block">Amount (PKR)</span>
                    <input className={`${field} w-40`} type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
                  <button onClick={pay} disabled={!!busy || !reference.trim() || !(parseFloat(amount) > 0)} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg">{busy === "Record the payment" ? "Recording…" : "Record payment"}</button>
                </div>
              )}
              {detail.status === "Declined" && <p className="text-xs text-red-600 font-medium">Declined{detail.decided_by ? ` by ${detail.decided_by}` : ""} — the scheme lapses at the end of the current period unless a revised renewal is started.</p>}
              {detail.status === "Renewed" && <p className="text-xs text-emerald-700 font-medium">Renewed — paid {pkr(detail.amount_paid)}{detail.payment_reference ? ` · ref ${detail.payment_reference}` : ""}.</p>}
            </div>
          )}
        </>
      )}

      {items.length > 1 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <p className="px-5 py-3 border-b border-slate-100 bg-slate-50 text-sm font-semibold text-slate-700">Renewal history</p>
          {items.map((r) => (
            <button key={r.id} onClick={() => open(r)} className="w-full px-5 py-2.5 flex items-center gap-4 text-left text-xs hover:bg-slate-50 border-b border-slate-100 last:border-0">
              <span className="w-8 text-slate-400">#{r.period_no}</span>
              <span className="text-slate-700 w-56">{r.new_period_start} to {r.new_period_end}</span>
              <Chip status={tone(r.status)}>{r.status}</Chip>
              <span className="ml-auto tabular-nums text-slate-500">{r.experience_factor.toFixed(3)}×</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
